'use strict';

// What the corroboration rule would have done to the PRODUCTION output.
//
// WHY THIS IS SEPARATE FROM THE CORPUS MEASUREMENT
//
// The corpus measurement (`clusterRuleMeasurement.test.js`) replays the
// clusterer over the recorded logs' SELECTED captures. Production clustered
// over EVERY OCR'd candidate frame, and the logs do not record that input --
// so the corpus's `rebuilt` arm is a PROXY for production, not production.
//
// This audit works on the production OUTPUT instead: every recorded log
// carries `merged_raw_token_clusters`, which is the production cluster table
// -- the actual clusters the production run formed, with the actual
// canonicals it published. So for each cluster the question can be asked
// directly:
//
//   "is this canonical within edit distance 1 of one of its members?"
//
// A canonical that is not is a CORRECTION nobody corroborated -- and the
// corroboration rule would have DISCARDED that cluster. So the audit can
// count, over every production run ever recorded:
//
//   - how many clusters would have been discarded
//   - whether the discarded canonical was a FALSE POSITIVE (not in the
//     ground truth) or a REAL HOLDING (in the ground truth)
//
// The second half is what decides whether the rule is safe to ship.
//
//   node --test test/manual/clusterRuleProductionAudit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function lev(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// The ground truth, read with the project's own reader.
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

test('the corroboration rule, applied to the recorded production output', () => {
  const gt = loadQmgGroundTruth();
  const roots = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ];
  const files = roots.flatMap((r) => walk(r, []));

  let logsWithClusters = 0;
  let totalClusters = 0;
  let correctedClusters = 0;
  let corroborated = 0;
  let uncorroborated = 0;

  // What the uncorroborated clusters published, and whether the ground truth
  // says it was a holding.
  const wouldDrop = [];
  let wouldDropFalsePositives = 0;
  let wouldDropRealHoldings = 0;
  let wouldDropUnknown = 0;

  // The same counts, per branch. The clusterer's INPUT differs between
  // them -- column-filtered readings vs raw OCR text -- and that difference
  // is what decides whether the rule is safe.
  const byBranch = {};

  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const clusters = log.merged_raw_token_clusters;
    if (!Array.isArray(clusters) || !clusters.length) continue;
    logsWithClusters += 1;

    // The branch: the clusterer reads column-filtered readings for a
    // chart_stream scan, and raw OCR text for a whiteboard scan.
    const isSnapshot = log.output_kind === 'snapshot';
    const branch = isSnapshot ? 'snapshot (chart_stream)' : 'whiteboard';
    if (!byBranch[branch]) {
      byBranch[branch] = {
        logs: 0, total: 0, readings: 0, corrections: 0,
        corroborated: 0, uncorroborated: 0, fp: 0, real: 0, unknown: 0,
      };
    }
    const b = byBranch[branch];
    b.logs += 1;

    const dateKey = log.date_key;
    // The ground truth for a date is the UNION over its captures -- the
    // replay tool scores against that union, so the audit does too.
    const held = new Set();
    let expected = null;
    for (const capture of listGroundTruthCaptures(gt, { dates: [dateKey] })) {
      expected = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }

    for (const cluster of clusters) {
      totalClusters += 1;
      b.total += 1;
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;

      // A canonical that IS a member is a READING. A canonical that is not
      // is a CORRECTION -- the clusterer naming a ticker no frame read.
      if (members.map((m) => String(m).toUpperCase()).includes(canonical)) {
        b.readings += 1;
        continue;
      }
      correctedClusters += 1;
      b.corrections += 1;

      let closest = Infinity;
      for (const m of members) {
        const d = lev(String(m).toUpperCase(), canonical);
        if (d < closest) closest = d;
      }
      if (closest <= 1) {
        corroborated += 1;
        b.corroborated += 1;
        continue;
      }
      uncorroborated += 1;
      b.uncorroborated += 1;

      // The cluster would be DISCARDED by the rule. What did it publish?
      const isHolding = held.has(canonical);
      const entry = {
        file: path.relative(ROOT, file),
        date: dateKey,
        branch,
        canonical,
        members,
        closest,
        groundTruthKnown: Boolean(expected),
        isHolding,
      };
      wouldDrop.push(entry);
      if (!expected) { wouldDropUnknown += 1; b.unknown += 1; }
      else if (isHolding) { wouldDropRealHoldings += 1; b.real += 1; }
      else { wouldDropFalsePositives += 1; b.fp += 1; }
    }
  }

  console.log('\n================ THE PRODUCTION OUTPUT, AUDITED ================\n');
  console.log(`logs with a cluster table : ${logsWithClusters}`);
  console.log(`clusters total            : ${totalClusters}`);
  console.log(`  of which READINGS       : ${totalClusters - correctedClusters}`);
  console.log(`  of which CORRECTIONS    : ${correctedClusters}`);
  console.log(`    corroborated (d<=1)   : ${corroborated}`);
  console.log(`    UNCORROBORATED (d>1)  : ${uncorroborated}   <- the rule would discard these`);
  console.log('');
  console.log('what the uncorroborated clusters published:');
  console.log(`  FALSE POSITIVES (not in the ground truth) : ${wouldDropFalsePositives}`);
  console.log(`  REAL HOLDINGS (in the ground truth)      : ${wouldDropRealHoldings}`);
  console.log(`  unknown (the date has no ground truth)   : ${wouldDropUnknown}`);
  console.log('');

  // ---- the breakdown that decides the question --------------------------
  //
  // The two branches are different worlds, and the clusterer's INPUT is
  // what differs:
  //
  //   snapshot (chart_stream, QMG) -- the clusterer is fed the per-frame
  //     `position_list` readings, which are already ticker-shaped and
  //     column-filtered. A member that is not a lexicon ticker is a garble
  //     of a holding, so a correction has to earn its place.
  //
  //   whiteboard (Revere) -- the clusterer is fed RAW OCR TEXT, where the
  //     chart's own ink is present. A member that is not a lexicon ticker
  //     is very often chart annotation, and its "correction" is very often
  //     a real ticker that happens to be nearby.
  //
  // So the same rule has to be measured on each branch separately, and it
  // is the ratio that matters: how many of the uncorroborated clusters
  // published a REAL HOLDING.
  console.log('--- by branch: the clusterer\'s INPUT decides everything ---');
  for (const [branch, stats] of Object.entries(byBranch)) {
    console.log(`  ${branch}:`);
    console.log(`    logs ${stats.logs}   clusters ${stats.total}   readings ${stats.readings}   corrections ${stats.corrections}`);
    console.log(`    corroborated ${stats.corroborated}   UNCORROBORATED ${stats.uncorroborated}`);
    console.log(`    of the uncorroborated: FALSE POSITIVES ${stats.fp}   REAL HOLDINGS ${stats.real}   unknown ${stats.unknown}`);
    console.log(`    -> the rule would discard ${stats.uncorroborated} clusters, of which ${stats.real} held a REAL holding`);
    console.log('');
  }

  if (wouldDrop.length) {
    console.log('every uncorroborated cluster, by date:');
    const byDate = new Map();
    for (const e of wouldDrop) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    for (const [date, entries] of [...byDate.entries()].sort()) {
      console.log(`  ${date}:`);
      for (const e of entries) {
        const verdict = !e.groundTruthKnown ? 'unknown' : (e.isHolding ? 'REAL HOLDING' : 'false positive');
        console.log(`    ${e.canonical} from [${e.members.join(', ')}] (closest ${e.closest}) -- ${verdict}`);
      }
    }
    console.log('');
  }

  try {
    const out = path.join(ROOT, 'data', 'video_pipeline', 'catalog');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'cluster_rule_production_audit.json'),
      JSON.stringify({
        logsWithClusters,
        totalClusters,
        correctedClusters,
        corroborated,
        uncorroborated,
        wouldDropFalsePositives,
        wouldDropRealHoldings,
        wouldDropUnknown,
        byBranch,
        wouldDrop,
      }, null, 2)
    );
  } catch (e) {
    console.log(`(could not write the audit file: ${e.message})`);
  }

  // ---- the assertions (structural) ---------------------------------------
  assert.ok(logsWithClusters > 0, 'the corpus carries production cluster tables');
  assert.ok(totalClusters > 0, 'the cluster tables carry clusters');
  assert.equal(
    corroborated + uncorroborated,
    correctedClusters,
    'every correction is either corroborated or not'
  );
});
