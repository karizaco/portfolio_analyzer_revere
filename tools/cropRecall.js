'use strict';

/**
 * GT recall grouped by the OCR crop the log was scanned with.
 *
 * The chart-stream crop region is a fraction of the frame (x, y, w, h). Two
 * crops have been used:
 *
 *   0.86,0.62,0.14,0.22  the current default — position rows only
 *   0.86,0.55,0.14,0.45  the older, taller default — also covers the chart
 *
 * The taller crop contains all 20 position rows of a full panel; the short
 * one truncates the bottom rows. This script measures what that costs on
 * the ground-truth corpus, replaying the stored OCR (no EasyOCR).
 *
 * Usage:
 *   node tools/cropRecall.js
 *   node tools/cropRecall.js --verbose
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  parseChartStreamPositionList,
  clusterRawOcrTokens,
} = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

function collectLogFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectLogFiles(p, out);
    else if (e.name.endsWith('.json') && e.name.includes('_snapshot.json')) out.push(p);
  }
  return out;
}

function cropWidthFor(log) {
  const region = log.phash_region_fraction || log.phash_region;
  if (!region || !Number.isFinite(region.w)) return null;
  return Math.round(region.w * 1920 * 5);
}

function ocrFromCandidate(candidate, log, cropWidth) {
  const words = Array.isArray(candidate.ocr_words) ? candidate.ocr_words : [];
  const text = candidate.ocr_text || '';
  if (!words.length) return { text, lines: text ? text.split(/\r?\n/) : [], words: [] };
  const linesByIndex = new Map();
  for (const w of words) {
    const line = Number.isFinite(w.line) ? w.line : 0;
    if (!linesByIndex.has(line)) linesByIndex.set(line, []);
    linesByIndex.get(line).push(w.text);
  }
  const lines = [...linesByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, texts]) => texts.join(' '));
  return {
    text: text || lines.join('\n'),
    lines,
    words,
    _cropWidth: cropWidth,
    _engine: (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine) || null,
  };
}

const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
function gtTickersForDate(dateKey) {
  const entry = gt[dateKey];
  if (!entry || typeof entry !== 'object') return null;
  const all = new Set();
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) for (const t of value) all.add(t);
  }
  return all.size ? [...all] : null;
}

const roots = [
  path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  path.join(ROOT, 'data'),
];
const files = [];
for (const r of roots) collectLogFiles(r, files);
const seen = new Set();
const unique = files.filter((f) => {
  const k = path.resolve(f);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const groups = new Map();
for (const file of unique) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    continue;
  }
  if (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine !== 'easyocr') continue;
  const dateKey = String(log.date_key || '').slice(0, 8);
  const gtTickers = gtTickersForDate(dateKey);
  if (!gtTickers) continue;

  const region = log.phash_region_fraction || log.phash_region;
  const cropKey = region
    ? `${region.x},${region.y},${region.w},${region.h}`
    : '(none)';

  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  for (const c of log.top_candidates || []) {
    const ocr = ocrFromCandidate(c, log, cropWidth);
    if (!ocr || !ocr.text) continue;
    const parsed = parseChartStreamPositionList({ ocr });
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
  }
  const merged = frameLists.length
    ? clusterRawOcrTokens(frameLists, {
      maxDistance: 1, minTokenLength: 2, minFrequency: 2,
    }).merged_list || []
    : [];

  if (!groups.has(cropKey)) {
    groups.set(cropKey, {
      logs: 0, hits: 0, size: 0, fp: 0, mergedSize: 0,
      perLog: [],
    });
  }
  const g = groups.get(cropKey);
  const hit = gtTickers.filter((t) => merged.includes(t)).length;
  g.logs++;
  g.hits += hit;
  g.size += gtTickers.length;
  g.fp += merged.filter((t) => !gtTickers.includes(t)).length;
  g.mergedSize += merged.length;
  g.perLog.push({ dateKey, hit, size: gtTickers.length, fp: merged.length - hit, file: path.basename(file) });
}

console.log('[crop] GT recall grouped by the crop the log was scanned with:');
for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`   ${key.padEnd(22)} logs=${String(g.logs).padStart(4)}  recall ${g.hits}/${g.size}` +
    ` = ${Math.round(100 * g.hits / g.size)}%   FP ${g.fp}   avg list ${(g.mergedSize / g.logs).toFixed(2)}`);
}

if (VERBOSE) {
  for (const [key, g] of groups) {
    console.log('');
    console.log('--- ' + key + ' ---');
    for (const r of g.perLog.sort((a, b) => (a.hit / a.size) - (b.hit / b.size))) {
      console.log(`   ${r.dateKey}  ${r.hit}/${r.size}  fp${r.fp}  ${r.file.slice(0, 40)}`);
    }
  }
}
