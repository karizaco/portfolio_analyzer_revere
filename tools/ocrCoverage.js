'use strict';

/**
 * Report which date-keys have surviving OCR logs, and which do not.
 *
 * Useful for choosing the next OCR targets: a date-key that already has an
 * EasyOCR log does not need re-scanning, and one that has only a Tesseract
 * log is a candidate for an EasyOCR re-run (EasyOCR reads ~3x better on the
 * QMG chart-stream position lists).
 *
 * Usage:
 *   node tools/ocrCoverage.js
 *   node tools/ocrCoverage.js --root data --root data/video_scan_test/_rerun
 */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const roots = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') roots.push(argv[i + 1]);
}
if (!roots.length) {
  roots.push('data', 'data/video_scan_test/_rerun');
}

const seen = new Map();   // dateKey -> { engine: count }

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!e.name.endsWith('.json') || !e.name.includes('_snapshot.json')) continue;
    const m = e.name.match(/^(\d{8})_/);
    if (!m) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      continue;
    }
    const engine = j.ocr_engine_metadata?.ocr_engine
      || j._engine || j.ocr_engine || 'unknown';
    if (!seen.has(m[1])) seen.set(m[1], new Map());
    const per = seen.get(m[1]);
    per.set(engine, (per.get(engine) || 0) + 1);
  }
}

for (const r of roots) walk(r);

let gt = {};
try {
  gt = JSON.parse(fs.readFileSync('data/qmg_ground_truth.json', 'utf8'));
} catch (_) {
  console.error('WARNING: cannot read data/qmg_ground_truth.json');
}
const gtDates = Object.keys(gt).filter((k) => !k.startsWith('_')).sort();

console.log('date-keys with surviving logs: ' + seen.size);
const easy = [...seen.keys()].filter((k) => seen.get(k).has('easyocr'));
console.log('  with at least one EasyOCR log: ' + easy.length);
console.log('  Tesseract-only               : ' +
  [...seen.keys()].filter((k) => !seen.get(k).has('easyocr')).length);

console.log('\nGT dates: ' + gtDates.length);
const noEasy = gtDates.filter((d) => !seen.has(d) || !seen.get(d).has('easyocr'));
console.log('GT dates WITHOUT an EasyOCR log (' + noEasy.length + '):');
for (const d of noEasy) {
  const per = seen.get(d);
  console.log('  ' + d + '  ' + (per ? [...per].map(([e, n]) => e + ':' + n).join(',') : 'no logs at all'));
}
