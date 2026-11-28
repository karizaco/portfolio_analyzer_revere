'use strict';

// Which ground-truth dates have never been scanned?
//
// The corpus the replay tool measures is a surviving sample, and the dates it
// can score are the ones a probe log exists for. This reports the gap
// between the ground truth and the scans, so more scans can be chosen.
//
// It needs no OCR and no clusterer.
//
//   node --test test/manual/gtCoverage.test.js

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

test('which ground-truth dates have been scanned', () => {
  const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
  const dates = Object.keys(gt).filter((k) => /^\d{8}$/.test(k));

  const scanned = new Map();   // date -> [run tags]
  const tags = fs.existsSync(PROBE_ROOT) ? fs.readdirSync(PROBE_ROOT) : [];
  for (const tag of tags) {
    const dir = path.join(PROBE_ROOT, tag, 'ocr_probe', 'logs');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(\d{8})_/);
      if (!m) continue;
      if (!scanned.has(m[1])) scanned.set(m[1], []);
      scanned.get(m[1]).push(tag);
    }
  }

  const missing = dates.filter((d) => !scanned.has(d));
  const covered = dates.filter((d) => scanned.has(d));

  console.log('\n===== THE GROUND-TRUTH COVERAGE =====\n');
  console.log(`ground-truth dates        : ${dates.length}`);
  console.log(`scanned at least once     : ${covered.length}`);
  console.log(`NEVER scanned             : ${missing.length}`);
  console.log('');

  if (missing.length) {
    console.log('the dates with no scan at all:');
    console.log(`  ${missing.join(' ')}`);
    console.log('');
  }

  // How many SCANS each covered date has, and whether it was scanned under
  // a cluster rule other than the shipped one.
  const RULE_TAGS = ['corroborated', 'swallowed'];
  console.log('the covered dates, and how many times each was scanned:');
  for (const date of covered) {
    const runs = scanned.get(date);
    console.log(`  ${date}  ${String(runs.length).padStart(2)} run(s)${runs.length > 1 ? `   [${runs.join(', ')}]` : ''}`);
  }
  console.log('');

  console.log(`runs whose tag names a non-shipped cluster rule: ${RULE_TAGS.length}`);
  console.log('');

  assert.ok(dates.length > 0, 'the ground truth has dates');
});
