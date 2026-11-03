'use strict';

// THE LI DEFECT: a cluster that swallows a second, real holding.
//
// The clusterer names ONE canonical per cluster. When two members of a
// cluster are DISTINCT lexicon tickers one edit apart, the clusterer picks
// one of them and the other is LOST.
//
// The recorded instance is 20230523, where the log's own cluster table says
//
//   { canonical: "AI", members: ["AI", "LI"], frequency: 7 }
//
// `AI` and `LI` are BOTH holdings of that video -- they are one edit apart,
// so the clusterer merged them and published `AI`. `LI` was never published
// at all: the merged list for that date has 10 hits against 11 holdings,
// and `LI` is the one missing.
//
// This measures the QUESTION behind it, over the whole corpus: when a
// cluster's canonical is a lexicon ticker and ANOTHER member is a
// different lexicon ticker, is that other member a real holding or noise?
//
// It needs no OCR -- the logs record the clusters the production runs
// formed.
//
//   node --test test/manual/clusterAbsorbedHolding.test.js

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

test('a cluster with TWO distinct lexicon tickers: is the second one a holding?', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  // Per date: the ground truth, and the clusters production formed.
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
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(...clusters);
  }

  console.log('\n===== A CLUSTER WITH TWO DISTINCT LEXICON TICKERS =====\n');
  console.log('The clusterer names ONE canonical. A second, different lexicon');
  console.log('ticker in the same cluster is one edit away, and is either a');
  console.log('real holding the cluster swallowed, or noise.\n');
  console.log('date        canonical  swallowed   in the GT?  the video read it?  cluster frequency');
  console.log('-' + '-'.repeat(88));

  let swallowed = 0;
  let swallowedIsHolding = 0;
  let swallowedIsNoise = 0;
  let unknown = 0;
  const detail = [];

  for (const [date, clusters] of [...byDate.entries()].sort()) {
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    for (const cluster of clusters) {
      const members = (cluster.members || []).map((m) => String(m).toUpperCase());
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;

      // The OTHER lexicon tickers in this cluster -- the ones the canonical
      // suppressed.
      const others = [...new Set(members)].filter(
        (m) => m !== canonical && lexicon.tickerSet.has(m)
      );
      if (!others.length) continue;

      for (const other of others) {
        swallowed += 1;
        const isHolding = held.has(other);
        if (isHolding) swallowedIsHolding += 1;
        else swallowedIsNoise += 1;
        detail.push({ date, canonical, other, isHolding, frequency: cluster.frequency });
        console.log(
          `${date}  ${canonical.padEnd(9)}  ${other.padEnd(10)}  `
          + `${(isHolding ? 'YES' : 'no').padEnd(10)}  ${'-'.padEnd(17)}  ${cluster.frequency}`
        );
      }
    }
  }

  console.log('');
  console.log(`clusters that swallowed a second lexicon ticker: ${swallowed}`);
  console.log(`  the swallowed ticker IS a real holding : ${swallowedIsHolding}`);
  console.log(`  the swallowed ticker is noise           : ${swallowedIsNoise}`);
  console.log('');

  if (detail.length) {
    console.log('the ones that are REAL HOLDINGS -- these are what a fix must recover:');
    for (const d of detail.filter((x) => x.isHolding)) {
      console.log(`  ${d.date}  ${d.canonical} swallowed ${d.other} (cluster frequency ${d.frequency})`);
    }
    console.log('');
    console.log('the ones that are NOISE -- these are what a fix must NOT publish:');
    for (const d of detail.filter((x) => !x.isHolding)) {
      console.log(`  ${d.date}  ${d.canonical} swallowed ${d.other} (cluster frequency ${d.frequency})`);
    }
    console.log('');
  }

  assert.ok(swallowed > 0, 'the corpus contains the case this measures');
});
