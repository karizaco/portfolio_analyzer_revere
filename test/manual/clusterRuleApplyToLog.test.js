'use strict';

// The corroboration rule applied to a PRODUCTION log, in place.
//
// The production scan of 20230522 and 20230523 under the corroboration rule
// timed out -- those two videos are the slowest, and the run was competing
// with the test suite for the CPU. But the question the scan answers does
// not need a re-scan: the log records the clusters the production run
// formed, so the rule can be applied to them directly.
//
// This is the SAME arithmetic the production audit uses, applied to a
// named log, and it reports what the merged list would have been.
//
//   node --test test/manual/clusterRuleApplyToLog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

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

// The shipped rule's canonical, re-derived from the log's own cluster table.
function shippedCanonical(cluster) {
  const members = cluster.members.map((m) => String(m).toUpperCase());
  return String(cluster.canonical || '').toUpperCase();
}

// The corroboration rule: a CORRECTED canonical (one that is not a member
// of its cluster) must be within edit distance 1 of some member, or the
// cluster is discarded. A canonical the VIDEO read counts as corroborated.
function applyCorroboration(clusters, readTokens) {
  const kept = [];
  const dropped = [];
  for (const cluster of clusters) {
    const members = cluster.members.map((m) => String(m).toUpperCase());
    const canonical = shippedCanonical(cluster);
    if (!canonical || !members.length) continue;

    // A READING -- the canonical IS a member.
    if (members.includes(canonical)) {
      kept.push({ canonical, reason: 'reading' });
      continue;
    }
    // A CORRECTION -- it has to be corroborated.
    let closest = Infinity;
    for (const m of members) {
      const d = lev(m, canonical);
      if (d < closest) closest = d;
    }
    const videoRead = readTokens.has(canonical);
    if (closest <= 1 || videoRead) {
      kept.push({ canonical, reason: videoRead && closest > 1 ? 'corroborated by the video' : 'corroborated by proximity' });
    } else {
      dropped.push({ canonical, members, closest });
    }
  }
  return { kept, dropped };
}

// The tokens the video read, from the log's own readings.
function readTokensOf(log) {
  const tokens = new Set();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      const cleaned = String(t).toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (cleaned.length >= 2) tokens.add(cleaned);
    }
  };
  for (const capture of log.captures || []) {
    add(capture.chart_stream && capture.chart_stream.position_list);
    add(capture.tickers);
    for (const word of (capture.ocr_words || [])) {
      const cleaned = String(word.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (cleaned.length >= 2) tokens.add(cleaned);
    }
  }
  for (const candidate of log.top_candidates || []) {
    add(candidate.chart_stream && candidate.chart_stream.position_list);
    add(candidate.tickers);
  }
  for (const candidate of log.top_rejected_candidates || []) {
    add(candidate.chart_stream && candidate.chart_stream.position_list);
    add(candidate.tickers);
  }
  return tokens;
}

test('the corroboration rule applied to the shipped-rule production logs', () => {
  const gt = loadQmgGroundTruth();
  const dir = path.join(
    ROOT, 'data', 'video_scan_test', '_rerun', 'qmg-easyocr-20261102-era-prefilter',
    'ocr_probe', 'logs'
  );

  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^2023052[23]_/.test(name)) continue;
    const log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const date = log.date_key;
    const clusters = log.merged_raw_token_clusters || [];
    const shipped = new Set((log.merged_position_list || []).map((t) => String(t).toUpperCase()));

    const { kept, dropped } = applyCorroboration(clusters, readTokensOf(log));
    const ruled = new Set(kept.map((k) => k.canonical));

    const held = new Set();
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }

    const shippedHits = [...shipped].filter((t) => held.has(t));
    const shippedFp = [...shipped].filter((t) => !held.has(t));
    const ruledHits = [...ruled].filter((t) => held.has(t));
    const ruledFp = [...ruled].filter((t) => !held.has(t));
    const lost = [...held].filter((t) => !ruled.has(t));

    // The rule must not lose a holding THE SHIPPED RULE PUBLISHED. A
    // holding the shipped rule ALSO misses is not the rule's fault -- the
    // shipped rule missed it too, and the comparison that matters is
    // between the two rules, not against the ground truth alone.
    //
    // This distinction matters: 20230522's `LI` is held by the video and
    // MISSED by BOTH rules (the clusterer absorbed it into a neighbour --
    // the defect CLAUDE.md records for 20230523). Blaming the rule for it
    // would be wrong, and the first version of this test did exactly that.
    const shippedPublished = [...shipped];
    const lostByTheRule = shippedPublished.filter((t) => !ruled.has(t));
    const missedByBoth = [...held].filter(
      (t) => !shipped.has(t) && !ruled.has(t)
    );

    console.log(`\n=== ${date} (${name}) ===`);
    console.log(`  shipped : ${shippedHits.length}/${held.size} hits, ${shippedFp.length} FP [${shippedFp.join(' ')}]`);
    console.log(`  ruled   : ${ruledHits.length}/${held.size} hits, ${ruledFp.length} FP [${ruledFp.join(' ')}]`);
    console.log(`  held but published by NEITHER rule: [${missedByBoth.join(' ')}]`);
    console.log(`  clusters dropped: ${dropped.length}`);
    for (const d of dropped) {
      console.log(`    ${d.canonical} from [${d.members.join(', ')}] (closest ${d.closest}) -- ${held.has(d.canonical) ? 'a real holding' : 'a false positive'}`);
    }

    assert.deepEqual(lostByTheRule, [],
      `${date}: the rule must not drop a holding the shipped rule published`);
  }
});
