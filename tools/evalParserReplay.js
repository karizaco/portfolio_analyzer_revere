'use strict';

// Replay every captured EasyOCR/Tesseract snapshot log through the CURRENT
// parser and score it against data/qmg_ground_truth.json.
//
// This is the offline counterpart to a full re-scan: the logs already contain
// the raw `ocr_text` + `ocr_words` + `ocr_engine`, so parser changes can be
// measured in seconds instead of ~12 min/video of EasyOCR time.
//
// Usage:
//   node tools/evalParserReplay.js [globRoot...]
//   node tools/evalParserReplay.js data/video_ocr_probe/qmg-easyocr-20261018
//
// Exit code is always 0 — this is a report, not a gate.

const fs = require('node:fs');
const path = require('node:path');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const GT_PATH = path.resolve(__dirname, '..', 'data', 'qmg_ground_truth.json');
const DEFAULT_ROOTS = [
  'data/video_ocr_probe/qmg-easyocr-20261018',
  'data/video_ocr_probe/qmg-easyocr-20261017',
  'data/video_ocr_probe/qmg-1080p-batch1',
  'data/video_ocr_probe/qmg-1080p-batch2',
  'data/video_ocr_probe/qmg-1080p-test',
  'data/video_ocr_probe/batch15-v2',
  'data/video_ocr_probe/easyocr-test2',
  'data/video_ocr_probe/fix-verify-2022',
];

function collectLogFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('_snapshot.json')) out.push(full);
    }
  };
  walk(root);
  return out;
}

// Ground truth entries are keyed by capture index; for scoring we take the
// union of every listed capture for the date (a position list is stable
// within a video, and the GT file records per-capture variants).
function gtForDate(gt, dateKey) {
  const entry = gt[dateKey];
  if (!entry) return null;
  const all = new Set();
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) for (const t of value) all.add(String(t).toUpperCase());
  }
  return all.size ? all : null;
}

function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;
  const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));

  let totalHit = 0;
  let totalGt = 0;
  let totalPred = 0;
  let scoredDates = 0;
  const perDate = [];

  for (const root of roots) {
    for (const file of collectLogFiles(root)) {
      let log;
      try {
        log = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const dateKey = log.date_key;
      if (!dateKey) continue;
      const expected = gtForDate(gt, dateKey);
      if (!expected) continue;

      const captures = Array.isArray(log.captures) ? log.captures : [];
      const predicted = new Set();
      for (const capture of captures) {
        const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
        if (!words.length) continue;
        // Reuse the crop width the scan recorded when available so the column
        // gate sees the same coordinate space it saw live.
        const cropWidth = log.phash_region_fraction
          ? Math.round(log.phash_region_fraction.w * 1920 * 5)
          : null;
        const result = parseChartStreamPositionList({
          ocr: { text: capture.ocr_text || '', words, _cropWidth: cropWidth },
        });
        for (const t of result.position_list || []) predicted.add(String(t).toUpperCase());
      }
      if (!predicted.size) continue;

      const hit = [...predicted].filter((t) => expected.has(t));
      totalHit += hit.length;
      totalGt += expected.size;
      totalPred += predicted.size;
      scoredDates += 1;
      perDate.push({
        date: dateKey,
        root: path.basename(root),
        hit: hit.length,
        gt: expected.size,
        pred: predicted.size,
        missed: [...expected].filter((t) => !predicted.has(t)).join(' '),
        fp: [...predicted].filter((t) => !expected.has(t)).join(' '),
      });
    }
  }

  perDate.sort((a, b) => (b.hit / b.gt) - (a.hit / a.gt) || a.date.localeCompare(b.date));
  for (const row of perDate) {
    console.log(
      `${row.date}  ${String(row.hit).padStart(2)}/${String(row.gt).padEnd(2)}`
      + `  pred=${String(row.pred).padStart(2)}`
      + `  recall=${((row.hit / row.gt) * 100).toFixed(0).padStart(3)}%`
      + `  precision=${((row.hit / Math.max(row.pred, 1)) * 100).toFixed(0).padStart(3)}%`
      + `  missed=[${row.missed}]  fp=[${row.fp}]`
    );
  }

  console.log('');
  console.log(`dates scored     : ${scoredDates}`);
  console.log(`micro recall     : ${totalGt ? ((totalHit / totalGt) * 100).toFixed(1) : '0.0'}%  (${totalHit}/${totalGt})`);
  console.log(`micro precision  : ${totalPred ? ((totalHit / totalPred) * 100).toFixed(1) : '0.0'}%  (${totalHit}/${totalPred})`);
}

main();