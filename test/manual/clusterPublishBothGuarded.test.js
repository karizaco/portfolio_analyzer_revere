'use strict';

// The publish-both rule, with a GUARD: publish the swallowed ticker only
// when the video read it in ENOUGH frames.
//
// The blunt rule -- publish every lexicon ticker in a cluster -- was
// measured and REJECTED: over the corpus it gained 5 holdings and added 24
// false positives.
//
// But the damage is entirely on ONE date. On 20230522 and 20230523 the
// rule gained `LI` with ZERO new false positives, and on 20220607 it
// gained 24. So the rule is right for two dates and wrong for one, and
// what differs is visible in the numbers:
//
//   20230522  AI swallowed LI     LI read in 7 frames, cluster frequency 15
//   20230523  AI swallowed LI     LI read in ? frames, cluster frequency 7
//   20220607  NFLX swallowed NFU  NFU read in 1 frame, cluster frequency 3
//
// The guard this measures: publish the swallowed ticker only if the VIDEO
// read it in at least N frames on its own -- i.e. it is attested
// independently of the cluster that swallowed it.
//
// It needs no OCR.
//
//   node --test test/manual/clusterPublishBothGuarded.test.js

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

// The frames the video read, from the log's own readings.
function frameReadings(log) {
  const frames = [];
  const push = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    frames.push(new Set(list.map((t) => String(t).toUpperCase())));
  };
  for (const capture of log.captures || []) {
    push(capture.chart_stream && capture.chart_stream.position_list);
  }
  for (const candidate of log.top_candidates || []) {
    push(candidate.chart_stream && candidate.chart_stream.position_list);
  }
  for (const candidate of log.top_rejected_candidates || []) {
    push(candidate.chart_stream && candidate.chart_stream.position_list);
  }
  return frames;
}

// How many DISTINCT FRAMES read the token, counted across EVERY log of the
// date -- the video's own evidence for a ticker.
//
// The log's SELECTED captures are not enough: the clusterer saw every OCR'd
// candidate frame, and a token can appear in the cluster table without
// appearing in any selected capture. So the count is taken from the cluster
// table itself: a token that is a MEMBER of a cluster was read in that
// cluster's frames, and a cluster's `frequency` is the number of frames it
// spans.
function framesReadingToken(clusters, token) {
  let n = 0;
  for (const cluster of clusters) {
    const members = (cluster.members || []).map((m) => String(m).toUpperCase());
    if (members.includes(token)) {
      // The cluster's own frequency is the sum over its members' frame
      // counts, so a member's own count is at most that.
      n = Math.max(n, Number(cluster.frequency) || 0);
    }
  }
  return n;
}

test('the guarded publish-both rule, over a sweep of thresholds', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  // Per DATE: the logs, and the shipped merged list.
  const byDate = new Map();
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
    const date = log.date_key;
    if (!byDate.has(date)) byDate.set(date, { logs: [], shipped: new Set(), clusters: [] });
    const row = byDate.get(date);
    row.logs.push(log);
    for (const t of merged) row.shipped.add(String(t).toUpperCase());
    for (const c of clusters) row.clusters.push(c);
  }

  // The ground truth per date.
  const truth = new Map();
  for (const date of byDate.keys()) {
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (scored) truth.set(date, held);
  }

  console.log('\n===== THE GUARDED PUBLISH-BOTH RULE =====\n');
  console.log('threshold = how many DISTINCT FRAMES of the video must read the');
  console.log('swallowed ticker for it to be published alongside the canonical.\n');
  console.log('threshold   hits/gt   FP   hits gained   FP added   dates changed');
  console.log('-'.repeat(78));

  const results = [];
  for (const threshold of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let hits = 0; let fp = 0; let gt = 0;
    let gained = 0; let fpAdded = 0; let datesChanged = 0;

    for (const [date, row] of byDate.entries()) {
      const held = truth.get(date);
      if (!held) continue;

      const published = new Set(row.shipped);
      for (const cluster of row.clusters) {
        const canonical = String(cluster.canonical || '').toUpperCase();
        const members = (cluster.members || []).map((m) => String(m).toUpperCase());
        if (!canonical) continue;
        for (const m of new Set(members)) {
          if (m === canonical) continue;
          if (!lexicon.tickerSet.has(m)) continue;
          if (framesReadingToken(row.clusters, m) < threshold) continue;
          published.add(m);
        }
      }

      const h = [...published].filter((t) => held.has(t));
      const f = [...published].filter((t) => !held.has(t));
      hits += h.length; fp += f.length; gt += held.size;
      const g = h.filter((t) => !row.shipped.has(t)).length;
      const fa = f.filter((t) => !row.shipped.has(t)).length;
      gained += g; fpAdded += fa;
      if (g || fa) datesChanged += 1;
    }

    results.push({ threshold, hits, fp, gt, gained, fpAdded, datesChanged });
    console.log(
      `${String(threshold).padStart(9)}   ${String(hits).padStart(4)}/${String(gt).padEnd(3)}  `
      + `${String(fp).padStart(3)}   ${String(gained).padStart(12)}   ${String(fpAdded).padStart(8)}   ${String(datesChanged).padStart(13)}`
    );
  }

  // The shipped baseline, for the comparison.
  let shipHits = 0; let shipFp = 0; let shipGt = 0;
  for (const [date, row] of byDate.entries()) {
    const held = truth.get(date);
    if (!held) continue;
    shipHits += [...row.shipped].filter((t) => held.has(t)).length;
    shipFp += [...row.shipped].filter((t) => !held.has(t)).length;
    shipGt += held.size;
  }
  console.log('');
  console.log(`  shipped    ${shipHits}/${shipGt} hits, ${shipFp} FP`);
  console.log('');

  assert.ok(shipGt > 0, 'the corpus was scored');
});
