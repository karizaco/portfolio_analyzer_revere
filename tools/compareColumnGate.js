'use strict';

/**
 * A/B the optional accept-path column gate in parseChartStream.js.
 *
 * The gate (`ocr._columnGate`) rejects a token that passes the text-based
 * accept path (in-lexicon OR price-nearby) when the column detector has
 * confidently located the position-list ticker column — i.e. the token is
 * physically in the SHARES column or the PRICE column of the overlay, not
 * in the ticker column.
 *
 * Both arms run the full pipeline over the OCR already stored in the scan
 * logs (no video, no EasyOCR):
 *
 *   per frame: parseChartStreamPositionList({ ocr })
 *   then:      clusterRawOcrTokens(frame position lists)
 *
 * so the only difference between the arms is the gate itself.
 *
 * Usage:
 *   node tools/compareColumnGate.js
 *   node tools/compareColumnGate.js --run-tag qmg-sweep-20261025
 *   node tools/compareColumnGate.js --verbose
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseChartStreamPositionList, clusterRawOcrTokens } = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const RUN_TAG = flag('--run-tag', null);
const VERBOSE = argv.includes('--verbose');
const DETAIL = argv.includes('--detail');
const LIMIT = parseInt(flag('--limit', '0'), 10) || 0;
const TOLERANCE = parseInt(flag('--tol', '0'), 10) || 0;
const MIN_TOKENS = parseInt(flag('--min-tokens', '0'), 10) || 0;
const ALL_ENGINES = argv.includes('--all-engines');

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

/**
 * The canonical OCR crop width for a chart-stream scan: the overlay region
 * is scaled to `round(w * 1920 * 5)` pixels wide, so word coordinates live
 * in that space — not in `ocr_frame_width`.
 */
function cropWidthFor(log) {
  const region = log.phash_region_fraction || log.phash_region;
  if (!region || !Number.isFinite(region.w)) return null;
  return Math.round(region.w * 1920 * 5);
}

function ocrFromCandidate(candidate, log, cropWidth, columnGate) {
  const words = Array.isArray(candidate.ocr_words) ? candidate.ocr_words : [];
  const text = candidate.ocr_text || '';
  if (!words.length) {
    // Older runs stored no word boxes; the pipeline still parsed them through
    // the legacy text-only path. Reproduce that so the arms stay comparable.
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
  const ocr = {
    text: text || lines.join('\n'),
    lines,
    words,
    _cropWidth: cropWidth,
    _engine: (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine) || null,
    _columnGate: columnGate,
  };
  if (TOLERANCE) ocr._columnGateTolerance = TOLERANCE;
  if (MIN_TOKENS) ocr._columnGateMinTokens = MIN_TOKENS;
  return ocr;
}

function loadGT() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}
function gtTickersForDate(gt, dateKey) {
  const entry = gt[dateKey];
  if (!entry || typeof entry !== 'object') return null;
  const all = new Set();
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) for (const t of value) all.add(t);
  }
  return all.size ? [...all] : null;
}

function mergedFor(log, columnGate) {
  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  let gateFrames = 0;
  let gateActiveFrames = 0;
  for (const c of log.top_candidates || []) {
    const ocr = ocrFromCandidate(c, log, cropWidth, columnGate);
    if (!ocr || !ocr.text) continue;
    const parsed = parseChartStreamPositionList({ ocr });
    if (parsed.column_filter) {
      gateFrames++;
      if (parsed.column_filter.column_gate_active) gateActiveFrames++;
    }
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
  }
  const merged = frameLists.length
    ? clusterRawOcrTokens(frameLists, {
      maxDistance: 1, minTokenLength: 2, minFrequency: 2,
    }).merged_list || []
    : [];
  return { merged, gateFrames, gateActiveFrames };
}

const ARMS = [
  { key: 'base', gate: false },
  { key: 'post', gate: 'post' },
  { key: 'inloop', gate: 'inloop' },
];

const roots = [path.join(ROOT, 'data')];
roots.unshift(RUN_TAG
  ? path.join(ROOT, 'data', 'video_scan_test', '_rerun', RUN_TAG)
  : path.join(ROOT, 'data', 'video_scan_test', '_rerun'));

const files = [];
for (const r of roots) collectLogFiles(r, files);
if (LIMIT) files.length = Math.min(files.length, LIMIT);
const gt = loadGT();

let nScored = 0;
let nLogs = 0;
const stats = {};
for (const arm of ARMS) {
  stats[arm.key] = { hits: 0, fp: 0, size: 0, changed: 0, activeLogs: 0 };
}
let gtSize = 0;
const rows = [];

for (const file of files) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    continue;
  }
  if (!ALL_ENGINES && log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine !== 'easyocr') continue;

  const results = {};
  let any = false;
  for (const arm of ARMS) {
    results[arm.key] = mergedFor(log, arm.gate);
    if (results[arm.key].merged.length) any = true;
  }
  if (!any) continue;
  nLogs++;

  const dateKey = String(log.date_key || '').slice(0, 8);
  const gtTickers = gtTickersForDate(gt, dateKey);
  let line = `${dateKey}  ${path.basename(file).slice(0, 42).padEnd(44)}`;
  const parts = [];
  for (const arm of ARMS) {
    const r = results[arm.key];
    stats[arm.key].size += r.merged.length;
    if (arm.key !== 'base' &&
        JSON.stringify(results.base.merged) !== JSON.stringify(r.merged)) {
      stats[arm.key].changed++;
    }
    if (r.gateActiveFrames > 0) stats[arm.key].activeLogs++;
    if (gtTickers) {
      const hit = gtTickers.filter((t) => r.merged.includes(t)).length;
      stats[arm.key].hits += hit;
      stats[arm.key].fp += r.merged.filter((t) => !gtTickers.includes(t)).length;
      parts.push(`${arm.key} ${hit}/${gtTickers.length} fp${r.merged.length - hit}`);
    }
  }
  if (gtTickers) {
    gtSize += gtTickers.length;
    nScored++;
    if (DETAIL) {
      const base = results.base.merged;
      for (const arm of ARMS) {
        if (arm.key === 'base') continue;
        const cur = results[arm.key].merged;
        const lost = gtTickers.filter((t) => base.includes(t) && !cur.includes(t));
        const gained = gtTickers.filter((t) => !base.includes(t) && cur.includes(t));
        const removedFp = base.filter((t) => !gtTickers.includes(t) && !cur.includes(t));
        const addedFp = cur.filter((t) => !gtTickers.includes(t) && !base.includes(t));
        if (lost.length || gained.length || removedFp.length || addedFp.length) {
          console.log(`${dateKey} ${arm.key.padEnd(6)} ${path.basename(file).slice(0, 30)}` +
            ` lost[${lost.join('|')}] gained[${gained.join('|')}]` +
            ` -fp[${removedFp.join('|')}] +fp[${addedFp.join('|')}]`);
        }
      }
    }
    line += '  ' + parts.join('  |  ');
  }
  if (VERBOSE) {
    for (const arm of ARMS) {
      line += `\n     ${arm.key.padEnd(6)}: ${results[arm.key].merged.join(',') || '(none)'}`;
    }
  }
  rows.push(line);
}

console.log('[gate] ' + nLogs + ' logs compared');
console.log('[gate] average list size: ' +
  ARMS.map((a) => `${a.key} ${(nLogs ? (stats[a.key].size / nLogs).toFixed(2) : '-')}`).join(', '));
console.log('[gate] merged lists changed vs base: ' +
  ARMS.map((a) => `${a.key} ${stats[a.key].changed}`).join(', '));
console.log('[gate] logs with the gate active on >=1 frame: ' +
  ARMS.map((a) => `${a.key} ${stats[a.key].activeLogs}`).join(', '));
if (nScored) {
  console.log('[gate] against ground truth over ' + nScored + ' logs:');
  for (const arm of ARMS) {
    console.log('   ' + arm.key.padEnd(7) + ': ' + stats[arm.key].hits + '/' + gtSize +
      ' recall = ' + Math.round(100 * stats[arm.key].hits / gtSize) + '%, ' +
      stats[arm.key].fp + ' FP');
  }
}
if (VERBOSE) {
  console.log('');
  for (const row of rows) console.log(row);
}
