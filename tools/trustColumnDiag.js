'use strict';

/**
 * Why does the trusted-column accept path not recover the missing GT tickers?
 *
 * For every GT ticker that is missing from the merged position list, report
 * for each stored frame:
 *   text      — the ticker string appears in the frame's raw OCR text
 *   col       — the ticker is in the detected ticker column (inColumnTickers)
 *   trust     — the column was trusted on that frame (columnLeftCount >= N)
 *   list      — the ticker is in inListTickers (price-aligned column)
 *   lex       — the ticker is in the seed lexicon
 *   price     — the ticker has a price-like token near it in the text
 *
 * A ticker that is `text` but not `col` can never be recovered by the column
 * logic — the column detector picked a different column, or the ticker's
 * word box was read at the wrong x.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  parseChartStreamPositionList,
  clusterRawOcrTokens,
} = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const TRUST_MIN = parseInt((argv[argv.indexOf('--min-left') + 1] || '4'), 10);

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

const tally = {};
const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };
const rows = [];

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
  const frames = [];
  for (const c of log.top_candidates || []) {
    const ocr = ocrFromCandidate(c, log, cropWidth);
    if (!ocr || !ocr.text) continue;
    const parsed = parseChartStreamPositionList({ ocr });
    const cf = parsed.column_filter;
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
    // Which ticker-shaped words land in the detected column? Recompute the
    // band membership the same way the parser does (left edge within
    // leftTolerance of the dominant left).
    const inColumn = new Set();
    if (cf && cf.dominant_left != null) {
      const tol = 25;
      for (const w of ocr.words || []) {
        const up = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
        if (!up || !/^[A-Z][A-Z0-9.]{1,4}$/.test(up)) continue;
        if (Math.abs(w.left - cf.dominant_left) <= tol) inColumn.add(up);
      }
    }
    frames.push({
      text: ocr.text.toUpperCase(),
      inColumn,
      colLeftCount: cf ? cf.column_left_count : null,
      colTrust: cf ? cf.column_left_count >= TRUST_MIN : false,
      parsed: parsed.position_list || [],
    });
  }
  const merged = frameLists.length
    ? clusterRawOcrTokens(frameLists, {
      maxDistance: 1, minTokenLength: 2, minFrequency: 2,
    }).merged_list || []
    : [];
  const found = new Set(merged);

  for (const t of gtTickers) {
    if (found.has(t)) { bump('found'); continue; }
    const inAnyText = frames.some((f) => f.text.includes(t));
    const inAnyParsed = frames.some((f) => f.parsed.includes(t));
    const inAnyCol = frames.some((f) => f.inColumn.has(t));
    const inAnyTrustedCol = frames.some((f) => f.colTrust && f.inColumn.has(t));
    let kind;
    if (!inAnyText) kind = 'ocr';
    else if (inAnyParsed) kind = 'cluster';
    else if (inAnyTrustedCol) kind = 'frame-trustable';
    else if (inAnyCol) kind = 'frame-incol-notrusted';
    else kind = 'frame-nocolumn';
    bump(kind);
    rows.push({
      dateKey, ticker: t, kind,
      file: path.basename(file),
      frames: frames.length,
      colLeftCounts: frames.map((f) => f.colLeftCount).join(','),
    });
  }
}

console.log('[trust-diag] trust threshold columnLeftCount >= ' + TRUST_MIN);
for (const k of Object.keys(tally).sort()) {
  console.log('   ' + k.padEnd(22) + tally[k]);
}
console.log('');
for (const r of rows.filter((r) => r.kind.startsWith('frame')).slice(0, 80)) {
  console.log(`   ${r.dateKey}  ${r.ticker.padEnd(6)} ${r.kind.padEnd(20)} ${r.file.slice(0, 34).padEnd(36)} lefts=[${r.colLeftCounts}]`);
}
