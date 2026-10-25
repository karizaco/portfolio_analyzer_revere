'use strict';

/**
 * Where do the ground-truth tickers go missing?
 *
 * For every GT-scored log, for every ground-truth ticker that does NOT
 * appear in the merged position list, report where it was lost:
 *
 *   ocr     — the ticker never appears in the raw OCR text (an OCR miss)
 *   frame   — the OCR read it, but the per-frame parser dropped it
 *   cluster — the per-frame parser kept it, but the clusterer dropped it
 *   gate    — the per-frame parser kept it, but the column gate dropped it
 *
 * The distinction matters: `ocr` misses need a better crop or a better
 * engine, while `frame` / `cluster` / `gate` misses are parser bugs that
 * can be fixed offline for every video already scanned.
 *
 * Usage:
 *   node tools/gtMissAnalysis.js
 *   node tools/gtMissAnalysis.js --verbose
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseChartStreamPositionList, clusterRawOcrTokens } = require('../src/parse/parseChartStream');

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

function ocrFromCandidate(candidate, log, cropWidth, columnGate) {
  const words = Array.isArray(candidate.ocr_words) ? candidate.ocr_words : [];
  const text = candidate.ocr_text || '';
  if (!words.length) {
    return { text, lines: text ? text.split(/\r?\n/) : [], words: [] };
  }
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
    _columnGate: columnGate,
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

const tally = { ocr: 0, frame: 0, cluster: 0, gate: 0, found: 0 };
const detail = [];

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

  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  const perFrameLists = [];
  const perFrameGateOff = [];
  for (const c of log.top_candidates || []) {
    const ocr = ocrFromCandidate(c, log, cropWidth, 'inloop');
    if (!ocr || !ocr.text) continue;
    const on = parseChartStreamPositionList({ ocr });
    const off = parseChartStreamPositionList(
      Object.assign({}, ocr, { _columnGate: false }));
    perFrameLists.push(on.position_list || []);
    perFrameGateOff.push(off.position_list || []);
    if ((on.position_list || []).length) frameLists.push(on.position_list.join(' '));
  }
  const merged = frameLists.length
    ? clusterRawOcrTokens(frameLists, {
      maxDistance: 1, minTokenLength: 2, minFrequency: 2,
    }).merged_list || []
    : [];

  const foundSet = new Set(merged);
  const frameSet = new Set(perFrameLists.flat());
  const gateOffSet = new Set(perFrameGateOff.flat());
  const rawText = (log.top_candidates || [])
    .map((c) => c.ocr_text || '')
    .join(' ')
    .toUpperCase();

  for (const t of gtTickers) {
    if (foundSet.has(t)) {
      tally.found++;
      continue;
    }
    let where;
    if (!rawText.includes(t)) where = 'ocr';
    else if (gateOffSet.has(t) && !frameSet.has(t)) where = 'gate';
    else if (frameSet.has(t)) where = 'cluster';
    else where = 'frame';
    tally[where]++;
    detail.push({ dateKey, ticker: t, where, file: path.basename(file) });
  }
}

console.log('[gt-miss] ground-truth tickers by where they were lost:');
console.log('   found   ' + tally.found);
console.log('   ocr     ' + tally.ocr + '   (never read by the OCR engine)');
console.log('   frame   ' + tally.frame + '   (read, then dropped by the per-frame parser)');
console.log('   gate    ' + tally.gate + '   (read, kept without the column gate, dropped with it)');
console.log('   cluster ' + tally.cluster + '   (kept per-frame, dropped by the clusterer)');

if (VERBOSE) {
  console.log('');
  const byKind = {};
  for (const d of detail) {
    byKind[d.where] = byKind[d.where] || [];
    byKind[d.where].push(d);
  }
  for (const kind of ['ocr', 'frame', 'gate', 'cluster']) {
    if (!byKind[kind]) continue;
    console.log('--- ' + kind + ' (' + byKind[kind].length + ') ---');
    for (const d of byKind[kind]) {
      console.log('   ' + d.dateKey + '  ' + d.ticker.padEnd(6) + ' ' + d.file.slice(0, 46));
    }
  }
}
