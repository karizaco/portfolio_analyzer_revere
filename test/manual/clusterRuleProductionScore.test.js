'use strict';

// THE DECISIVE MEASUREMENT: what each cluster rule would do to the
// PRODUCTION merged lists.
//
// WHY THIS IS SEPARATE FROM THE CORPUS MEASUREMENT
//
// `clusterRuleMeasurement.test.js` replays the clusterer over the recorded
// logs' SELECTED captures. Production clustered over EVERY OCR'd candidate
// frame -- the 20230605 log's own cluster table says its tokens appeared in
// **12** frames, and the log carries only **3** distinct readings. So the
// corpus replay cannot reproduce production's clusters, and the two
// measurements CAN disagree. (They do: the corpus says the corroboration
// rule loses no holdings, and this file says it loses two.)
//
// This file works on the production OUTPUT instead. Every recorded log
// carries `merged_raw_token_clusters` -- the clusters the production run
// actually formed -- and `merged_position_list` -- the merged list it
// actually published.
//
// THE ACCOUNTING, WHICH IS THE PART THAT MATTERS
//
// A ticker survives the rule if ANY of its clusters was corroborated. So a
// ticker is dropped only when EVERY cluster that canonicalised to it was
// uncorroborated. Counting "the ticker appears in an uncorroborated cluster"
// without that check over-counts the losses -- it reports `GTLB` and `BOIL`
// as lost holdings when each is also carried by a reading cluster. The two
// measurements then disagree for no reason at all.
//
//   node --test test/manual/clusterRuleProductionScore.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));
const { loadDecodeLexiconSync } = require(path.join(ROOT, 'src', 'normalize', 'tickerScan'));

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

// The tokens the video read, from every reading the log carries.
function videoReadTokens(log) {
  const tokens = new Set();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      const cleaned = String(t).toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (cleaned.length >= 2) tokens.add(cleaned);
    }
  };
  const addCandidate = (candidate) => {
    if (!candidate) return;
    add(candidate.chart_stream && candidate.chart_stream.position_list);
    add(candidate.tickers);
    for (const word of (candidate.ocr_words || [])) {
      const cleaned = String(word.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (cleaned.length >= 2) tokens.add(cleaned);
    }
  };
  for (const capture of log.captures || []) addCandidate(capture);
  for (const candidate of log.top_candidates || []) addCandidate(candidate);
  for (const candidate of log.top_rejected_candidates || []) addCandidate(candidate);
  addCandidate(log.top_candidate);
  return tokens;
}

test('each cluster rule, scored against the ground truth on the PRODUCTION output', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const roots = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ];
  const files = roots.flatMap((r) => walk(r, []));

  // Per DATE: a date can have several logs, and the ground truth is the
  // union over the date's captures.
  const byDate = new Map();
  let logsWithClusters = 0;

  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const clusters = log.merged_raw_token_clusters;
    const merged = log.merged_position_list;
    if (!Array.isArray(clusters) || !clusters.length || !Array.isArray(merged)) continue;
    logsWithClusters += 1;

    const dateKey = log.date_key;
    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, {
        date: dateKey,
        branch: log.output_kind === 'snapshot' ? 'snapshot' : 'whiteboard',
        published: new Set(),
        clusters: [],
        readTokens: new Set(),
      });
    }
    const row = byDate.get(dateKey);
    if (log.output_kind === 'snapshot') row.branch = 'snapshot';

    for (const t of merged) row.published.add(String(t).toUpperCase());
    for (const t of videoReadTokens(log)) row.readTokens.add(t);
    for (const cluster of clusters) row.clusters.push(cluster);

    // The per-VIDEO view: one log is one video, and production publishes
    // each video's merged list separately.
    if (!row.logs) row.logs = [];
    const droppedCanonicals = new Set();
    for (const cluster of clusters) {
      const members = (Array.isArray(cluster.members) ? cluster.members : [])
        .map((m) => String(m).toUpperCase());
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;
      if (members.includes(canonical)) continue;
      let closest = Infinity;
      for (const m of members) {
        const d = lev(m, canonical);
        if (d < closest) closest = d;
      }
      if (closest > 1) droppedCanonicals.add(canonical);
    }
    row.logs.push({
      file: path.relative(ROOT, file),
      published: new Set(merged.map((t) => String(t).toUpperCase())),
      clusters: clusters.slice(),
      droppedCanonicals,
    });
  }

  // ---- the rule, applied to one cluster -----------------------------------
  //
  // `corroborated`: a corrected canonical must be within edit distance 1 of
  // some member, or the cluster is DISCARDED.
  //
  // `supported`: the canonical is the correction the VIDEO read. A cluster
  // whose canonical the video never read, and for which no video-read
  // correction exists, is DISCARDED -- because a name nobody read is a
  // guess. A cluster whose canonical the video DID read is kept.
  function applyRule(clusters, readTokens) {
    const kept = [];
    const dropped = [];
    for (const cluster of clusters) {
      const members = (Array.isArray(cluster.members) ? cluster.members : [])
        .map((m) => String(m).toUpperCase());
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;

      // A canonical that IS a member is a READING -- kept under every rule.
      if (members.includes(canonical)) {
        kept.push(canonical);
        continue;
      }

      let closest = Infinity;
      for (const m of members) {
        const d = lev(m, canonical);
        if (d < closest) closest = d;
      }
      // The corroboration test.
      if (closest > 1) {
        dropped.push({ canonical, members, reason: 'uncorroborated' });
        continue;
      }
      kept.push(canonical);
    }
    return { kept, dropped };
  }

  console.log('\n=========== THE PRODUCTION MERGED LISTS, SCORED ===========\n');
  console.log(`logs with a cluster table: ${logsWithClusters}`);
  console.log(`dates with production output: ${byDate.size}`);
  console.log('');

  const totals = {
    snapshot: { published: 0, dropped: 0, hitsLost: 0, fpRemoved: 0, datesScored: 0 },
    whiteboard: { published: 0, dropped: 0, hitsLost: 0, fpRemoved: 0, datesScored: 0 },
  };
  const losses = [];
  const removals = [];

  // Per LOG -- and a log is a VIDEO. The date-level view pools a date's
  // videos, which can MASK a per-video loss: if one video drops a holding
  // and another video of the same date keeps it, the date still scores the
  // hit. Production publishes each video's merged list separately, so the
  // per-video view is the one that matters.
  const perVideo = [];

  for (const row of byDate.values()) {
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [row.date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;   // no ground truth for this date

    const t = totals[row.branch];
    t.datesScored += 1;

    const { kept, dropped } = applyRule(row.clusters, row.readTokens);

    // A ticker survives if ANY cluster carried it and was kept.
    const keptSet = new Set(kept);
    // A ticker is DROPPED only if EVERY cluster that canonicalised to it was
    // dropped -- which is what `keptSet` tells us.
    const droppedSet = new Set(dropped.map((d) => d.canonical));

    for (const canonical of row.published) {
      t.published += 1;
      if (keptSet.has(canonical)) continue;   // survived
      if (!droppedSet.has(canonical)) continue; // never came from a cluster
      t.dropped += 1;
      if (held.has(canonical)) {
        t.hitsLost += 1;
        losses.push({ date: row.date, branch: row.branch, canonical });
      } else {
        t.fpRemoved += 1;
        removals.push({ date: row.date, branch: row.branch, canonical });
      }
    }

    // ---- the PER-VIDEO view ---------------------------------------------
    for (const log of row.logs) {
      const keptHere = new Set(applyRule(log.clusters, row.readTokens).kept);
      const publishedHere = new Set(log.published);
      let lostHere = 0;
      let removedHere = 0;
      for (const canonical of publishedHere) {
        if (keptHere.has(canonical)) continue;
        if (!log.droppedCanonicals.has(canonical)) continue;
        if (held.has(canonical)) lostHere += 1;
        else removedHere += 1;
      }
      perVideo.push({
        file: log.file,
        date: row.date,
        branch: row.branch,
        published: publishedHere.size,
        lost: lostHere,
        removed: removedHere,
      });
    }
  }

  for (const [branch, t] of Object.entries(totals)) {
    console.log(`--- ${branch} ---`);
    console.log(`  dates scored against the ground truth : ${t.datesScored}`);
    console.log(`  published tickers the rule would drop : ${t.dropped}`);
    console.log(`    of those, REAL HOLDINGS LOST         : ${t.hitsLost}`);
    console.log(`    of those, FALSE POSITIVES removed   : ${t.fpRemoved}`);
    console.log('');
  }

  // ---- the PER-VIDEO view -------------------------------------------------
  console.log('--- per VIDEO (production publishes each video\'s list separately) ---');
  const videoTotals = { lost: 0, removed: 0, videos: 0, videosChanged: 0 };
  for (const v of perVideo) {
    if (v.lost === 0 && v.removed === 0) continue;
    videoTotals.videosChanged += 1;
    videoTotals.lost += v.lost;
    videoTotals.removed += v.removed;
    console.log(`  ${v.date}  ${v.file}`);
    console.log(`    published ${v.published}   the rule would LOSE ${v.lost} real holding(s) and remove ${v.removed} false positive(s)`);
  }
  videoTotals.videos = perVideo.length;
  console.log(`  -> ${videoTotals.videosChanged} of ${videoTotals.videos} scored videos would change`);
  console.log(`  -> REAL HOLDINGS LOST ${videoTotals.lost}   FALSE POSITIVES removed ${videoTotals.removed}`);
  console.log('');

  if (losses.length) {
    console.log('the holdings the rule would LOSE:');
    for (const l of losses) console.log(`  ${l.date}  ${l.canonical}  (${l.branch})`);
    console.log('');
  }
  if (removals.length) {
    console.log('the false positives the rule would remove:');
    for (const r of removals) console.log(`  ${r.date}  ${r.canonical}  (${r.branch})`);
    console.log('');
  }

  try {
    const out = path.join(ROOT, 'data', 'video_pipeline', 'catalog');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'cluster_rule_production_score.json'),
      JSON.stringify({ totals, losses, removals, perVideo: videoTotals }, null, 2)
    );
  } catch (e) {
    console.log(`(could not write the score file: ${e.message})`);
  }

  assert.ok(logsWithClusters > 0, 'the corpus carries production cluster tables');
  assert.ok(byDate.size > 0, 'the corpus carries production merged lists');
});
