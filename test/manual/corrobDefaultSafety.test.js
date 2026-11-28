'use strict';

// The HONEST comparison: the corroborated rule against the shipped rule,
// DATE BY DATE, on the same scans.
//
// WHY THIS FILE EXISTS
//
// The aggregate numbers can mislead. The `corroborated` production scan
// scored 65/67 and the `shipped` production scan scored 39/41 -- but they
// did NOT cover the same dates (6 logs against 4), so that difference is
// NOT attributable to the rule. Comparing two different scans of different
// date sets is not a measurement.
//
// This compares the two scans on the dates they SHARE, date by date, so the
// only difference is the rule.
//
// It needs no OCR.
//
//   node --test test/manual/corrobDefaultSafety.test.js

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

function mergedByDate(runTag) {
  const dir = path.join(PROBE_ROOT, runTag, 'ocr_probe', 'logs');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let log;
    try {
      log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const date = log.date_key;
    if (!date) continue;
    if (!out.has(date)) out.set(date, { merged: new Set(), rules: new Set(), logs: 0 });
    const row = out.get(date);
    for (const t of (log.merged_position_list || [])) row.merged.add(String(t).toUpperCase());
    row.rules.add(log.cluster_rule || 'shipped');
    row.logs += 1;
  }
  return out;
}

function heldFor(date) {
  const held = new Set();
  let scored = false;
  for (const capture of listGroundTruthCaptures(loadQmgGroundTruth(), { dates: [date] })) {
    scored = true;
    for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
  }
  return scored ? held : null;
}

function score(runTag) {
  const rows = [];
  for (const [date, row] of [...mergedByDate(runTag)].sort()) {
    const held = heldFor(date);
    if (!held) continue;
    const hits = [...held].filter((t) => row.merged.has(t));
    const fp = [...row.merged].filter((t) => !held.has(t));
    const missed = [...held].filter((t) => !row.merged.has(t));
    rows.push({ date, hits, fp, missed, gt: held.size, rules: [...row.rules] });
  }
  return rows;
}

test('the corroborated rule against the shipped rule, on the dates they SHARE', () => {
  const SHIPPED = 'qmg-easyocr-20261102-era-prefilter';
  const CORROB = 'qmg-easyocr-20261103-corroborated';
  const SWALLOWED = 'qmg-easyocr-20261103-swallowed';

  const shippedRows = new Map(score(SHIPPED).map((r) => [r.date, r]));
  const corrobRows = new Map(score(CORROB).map((r) => [r.date, r]));
  const swallowedRows = new Map(score(SWALLOWED).map((r) => [r.date, r]));

  const shared = [...corrobRows.keys()].filter((d) => shippedRows.has(d)).sort();

  console.log('\n===== THE CORROBORATED RULE vs THE SHIPPED RULE, DATE BY DATE =====\n');
  console.log('Only the dates BOTH scans covered -- two different scans of different');
  console.log('date sets cannot be compared in aggregate.\n');
  console.log('date        shipped            corroborated        changed');
  console.log('-'.repeat(76));

  let sharedHitsS = 0; let sharedHitsC = 0; let sharedGt = 0;
  let fpRemoved = 0; let fpAdded = 0; let holdingsLost = 0; let holdingsGained = 0;
  const changed = [];

  for (const date of shared) {
    const s = shippedRows.get(date);
    const c = corrobRows.get(date);
    sharedHitsS += s.hits.length;
    sharedHitsC += c.hits.length;
    sharedGt += s.gt;

    const removed = s.fp.filter((t) => !c.fp.includes(t));
    const added = c.fp.filter((t) => !s.fp.includes(t));
    const lost = s.hits.filter((t) => !c.hits.includes(t));
    const gained = c.hits.filter((t) => !s.hits.includes(t));

    fpRemoved += removed.length;
    fpAdded += added.length;
    holdingsLost += lost.length;
    holdingsGained += gained.length;

    const differs = removed.length || added.length || lost.length || gained.length;
    if (differs) changed.push({ date, removed, added, lost, gained });
    console.log(
      `${date}  ${String(s.hits.length).padStart(2)}/${s.gt} fp=${s.fp.length}   `
      + `${String(c.hits.length).padStart(2)}/${c.gt} fp=${c.fp.length}   `
      + `${differs ? 'FP -' + removed.join(',') + (added.length ? ' FP +' + added.join(',') : '') + (lost.length ? ' LOST ' + lost.join(',') : '') + (gained.length ? ' GAINED ' + gained.join(',') : '') : '—'}`
    );
  }

  console.log('');
  console.log(`dates compared on the same scan set: ${shared.length}`);
  console.log(`  shipped     : ${sharedHitsS}/${sharedGt} hits`);
  console.log(`  corroborated: ${sharedHitsC}/${sharedGt} hits`);
  console.log(`  false positives REMOVED: ${fpRemoved}`);
  console.log(`  false positives ADDED  : ${fpAdded}`);
  console.log(`  holdings LOST          : ${holdingsLost}`);
  console.log(`  holdings GAINED        : ${holdingsGained}`);
  console.log('');

  if (changed.length) {
    console.log('the dates that changed:');
    for (const c of changed) {
      console.log(`  ${c.date}: FP removed [${c.removed.join(' ') || '-'}]  FP added [${c.added.join(' ') || '-'}]  lost [${c.lost.join(' ') || '-'}]  gained [${c.gained.join(' ') || '-'}]`);
    }
    console.log('');
  }

  // The swallowed rule, on the dates it and the corroborated rule share.
  const swShared = [...swallowedRows.keys()].filter((d) => corrobRows.has(d)).sort();
  if (swShared.length) {
    console.log('--- the swallowed rule on top of the corroborated one ---');
    let hitsC = 0; let hitsS = 0; let gt = 0; let lost = 0; let gained = 0;
    for (const date of swShared) {
      const c = corrobRows.get(date);
      const s = swallowedRows.get(date);
      hitsC += c.hits.length; hitsS += s.hits.length; gt += c.gt;
      lost += c.hits.filter((t) => !s.hits.includes(t)).length;
      gained += s.hits.filter((t) => !c.hits.includes(t)).length;
      console.log(`  ${date}  corroborated ${c.hits.length}/${c.gt}  ->  swallowed ${s.hits.length}/${c.gt}`);
    }
    console.log(`  totals: corroborated ${hitsC}/${gt}  ->  swallowed ${hitsS}/${gt}   holdings lost ${lost}  gained ${gained}`);
    console.log('');
  }
});
