'use strict';

// The SWALLOWED-HOLDING rule, measured through the real implementation.
//
// The corpus replay's `rebuilt` arm clusters the log's SELECTED captures.
// The swallowed holding is a cluster whose member was read in frames the
// selection did not keep, so the replay does not reproduce it -- the rule
// shows no change there.
//
// The PRODUCTION cluster tables are the right measurement: they are the
// clusters the production run actually formed, over every OCR'd frame.
//
// This applies the REAL implementation -- the same `clusterRawOcrTokens` the
// scan tool runs -- to the recorded production cluster tables' inputs, and
// scores the result.
//
// It needs no OCR.
//
//   node --test test/manual/clusterSwallowedRule.test.js

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
const { clusterRawOcrTokens } = require(path.join(ROOT, 'src', 'parse', 'parseChartStream'));

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

// The clusterer's input, as the production run built it: every OCR'd
// candidate frame's reading.
function clusterInputOf(log) {
  const frames = [];
  const push = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    frames.push(list.join(' '));
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

test('the swallowed-holding rule, over the production cluster tables', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  const byDate = new Map();
  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const clusters = log.merged_raw_token_clusters;
    if (!Array.isArray(clusters) || !clusters.length) continue;
    const date = log.date_key;
    if (!byDate.has(date)) byDate.set(date, { shipped: new Set(), frames: [], logs: [] });
    const row = byDate.get(date);
    for (const t of (log.merged_position_list || [])) row.shipped.add(String(t).toUpperCase());
    row.logs.push(log);
    row.frames.push(...clusterInputOf(log));
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

  console.log('\n===== THE SWALLOWED-HOLDING RULE, OVER THE PRODUCTION CLUSTERS =====\n');

  const results = [];
  for (const threshold of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let hits = 0; let fp = 0; let gt = 0;
    let gained = 0; let fpAdded = 0; let datesChanged = 0;
    const detail = [];

    for (const [date, row] of byDate.entries()) {
      const held = truth.get(date);
      if (!held) continue;
      if (!row.frames.length) continue;

      const out = clusterRawOcrTokens(row.frames, {
        maxDistance: 1,
        minTokenLength: 2,
        minFrequency: Math.min(2, Math.max(1, row.frames.length)),
        lexicon,
        publishSwallowedHoldings: true,
        swallowedHoldingMinFrames: threshold,
      });
      const published = new Set(out.merged_list);

      const h = [...published].filter((t) => held.has(t));
      const f = [...published].filter((t) => !held.has(t));
      hits += h.length; fp += f.length; gt += held.size;
      const g = h.filter((t) => !row.shipped.has(t));
      const fa = f.filter((t) => !row.shipped.has(t));
      gained += g.length; fpAdded += fa.length;
      if (g.length || fa.length) {
        datesChanged += 1;
        detail.push({ date, g, fa });
      }
    }

    results.push({ threshold, hits, fp, gt, gained, fpAdded, datesChanged, detail });
    console.log(
      `  threshold ${String(threshold).padStart(2)}: ${String(hits).padStart(4)}/${String(gt).padEnd(3)} hits, `
      + `${String(fp).padStart(3)} FP   gained ${String(gained).padStart(2)}   FP added ${String(fpAdded).padStart(2)}   dates ${datesChanged}`
    );
  }

  // The shipped baseline, computed the same way -- the SAME clusterer, with
  // the rule off -- so the comparison is like for like.
  let shipHits = 0; let shipFp = 0; let shipGt = 0;
  for (const [date, row] of byDate.entries()) {
    const held = truth.get(date);
    if (!held || !row.frames.length) continue;
    const out = clusterRawOcrTokens(row.frames, {
      maxDistance: 1,
      minTokenLength: 2,
      minFrequency: Math.min(2, Math.max(1, row.frames.length)),
      lexicon,
    });
    const published = new Set(out.merged_list);
    shipHits += [...published].filter((t) => held.has(t)).length;
    shipFp += [...published].filter((t) => !held.has(t)).length;
    shipGt += held.size;
  }
  console.log('');
  console.log(`  shipped (same clusterer, rule off): ${shipHits}/${shipGt} hits, ${shipFp} FP`);
  console.log('');

  const best = results.find((r) => r.threshold === 4);
  if (best && best.detail.length) {
    console.log('  at threshold 4, the dates that changed:');
    for (const d of best.detail) {
      console.log(`    ${d.date}: gained [${d.g.join(' ')}]  new FP [${d.fa.join(' ')}]`);
    }
    console.log('');
  }

  assert.ok(shipGt > 0, 'the corpus was scored');
});
