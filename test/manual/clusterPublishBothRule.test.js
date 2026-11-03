'use strict';

// THE ABSORBED-HOLDING RULE: publish EVERY lexicon ticker in a cluster.
//
// The clusterer names ONE canonical per cluster. When a cluster holds two
// DISTINCT lexicon tickers that are one edit apart, the second is
// swallowed -- and on 20230522/20230523 the swallowed one is `LI`, a real
// holding of those videos.
//
// The census (clusterAbsorbedHolding.test.js) found five such clusters over
// the corpus: two swallow a real holding (`LI`), three swallow noise
// (`NFU`, a one-off garble). So a rule that publishes both would recover
// two holdings and add one false positive.
//
// This MEASURES that rule, the same way the corroboration rule was
// measured: over the recorded logs, scored against the pixel-verified
// ground truth, per date.
//
// It needs no OCR.
//
//   node --test test/manual/clusterPublishBothRule.test.js

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

test('the publish-both rule, scored over the corpus', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  // Per DATE: the shipped merged list, and the publish-both list.
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

    if (!byDate.has(date)) {
      byDate.set(date, { shipped: new Set(), both: new Set(), added: [] });
    }
    const row = byDate.get(date);
    for (const t of merged) row.shipped.add(String(t).toUpperCase());

    for (const cluster of clusters) {
      const canonical = String(cluster.canonical || '').toUpperCase();
      const members = (cluster.members || []).map((m) => String(m).toUpperCase());
      if (!canonical) continue;
      row.both.add(canonical);
      // The rule: publish EVERY lexicon ticker in the cluster.
      for (const m of new Set(members)) {
        if (m === canonical) continue;
        if (!lexicon.tickerSet.has(m)) continue;
        row.both.add(m);
        row.added.push({ date, canonical, added: m });
      }
    }
  }

  let shipHits = 0; let shipFp = 0; let shipGt = 0;
  let bothHits = 0; let bothFp = 0; let bothGt = 0;
  const changes = [];

  for (const [date, row] of [...byDate.entries()].sort()) {
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    const sh = [...row.shipped].filter((t) => held.has(t));
    const sf = [...row.shipped].filter((t) => !held.has(t));
    const bh = [...row.both].filter((t) => held.has(t));
    const bf = [...row.both].filter((t) => !held.has(t));
    shipHits += sh.length; shipFp += sf.length; shipGt += held.size;
    bothHits += bh.length; bothFp += bf.length; bothGt += held.size;

    const gained = bh.filter((t) => !sh.includes(t));
    const lost = sh.filter((t) => !bh.includes(t));
    const newFp = bf.filter((t) => !sf.includes(t));
    if (gained.length || lost.length || newFp.length) {
      changes.push({ date, shipped: sh.length, both: bh.length, gained, lost, newFp });
    }
  }

  console.log('\n============== THE PUBLISH-BOTH RULE, SCORED ==============\n');
  console.log(`dates scored: ${[...byDate.keys()].length}`);
  console.log(`  shipped   : ${shipHits}/${shipGt} hits, ${shipFp} FP  (${(100 * shipHits / shipGt).toFixed(1)}% / ${(100 * shipHits / (shipHits + shipFp)).toFixed(1)}%)`);
  console.log(`  both      : ${bothHits}/${bothGt} hits, ${bothFp} FP  (${(100 * bothHits / bothGt).toFixed(1)}% / ${(100 * bothHits / (bothHits + bothFp)).toFixed(1)}%)`);
  console.log('');
  console.log('per date that changed:');
  console.log('date        shipped -> both    gained            lost              new FP');
  console.log('-'.repeat(80));
  for (const c of changes) {
    console.log(
      `${c.date}  ${String(c.shipped).padStart(3)} -> ${String(c.both).padEnd(4)}  `
      + `${(c.gained.join(' ') || '-').padEnd(17)} ${(c.lost.join(' ') || '-').padEnd(17)} ${c.newFp.join(' ') || '-'}`
    );
  }
  console.log('');

  const gained = changes.reduce((s, c) => s + c.gained.length, 0);
  const lost = changes.reduce((s, c) => s + c.lost.length, 0);
  const newFp = changes.reduce((s, c) => s + c.newFp.length, 0);
  console.log(`holdings gained: ${gained}   holdings lost: ${lost}   new false positives: ${newFp}`);
  console.log('');

  assert.ok(shipGt > 0, 'the corpus was scored');
});
