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

function ocrFromCandidate(candidate, log, cropWidth, arm) {
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
    _columnGate: arm.gate,
  };
  if (TOLERANCE) ocr._columnGateTolerance = TOLERANCE;
  if (MIN_TOKENS) ocr._columnGateMinTokens = MIN_TOKENS;
  if (arm.trust) ocr._columnTrust = true;
  if (arm.trustMinLeft) ocr._columnTrustMinLeft = arm.trustMinLeft;
  if (arm.trustRaw) ocr._columnTrustRaw = true;
  if (arm.trustNeedNumber) ocr._columnTrustNeedNumber = true;
  if (arm.numberMinDigits) ocr._columnTrustNumberMinDigits = arm.numberMinDigits;
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

function mergedFor(log, arm) {
  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  let gateFrames = 0;
  let gateActiveFrames = 0;
  let trustActiveFrames = 0;
  for (const c of log.top_candidates || []) {
    const ocr = ocrFromCandidate(c, log, cropWidth, arm);
    if (!ocr || !ocr.text) continue;
    const parsed = parseChartStreamPositionList({ ocr });
    if (parsed.column_filter) {
      gateFrames++;
      if (parsed.column_filter.column_gate_active) gateActiveFrames++;
      if (parsed.column_filter.column_trust_active) trustActiveFrames++;
    }
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
  }
  const merged = frameLists.length
    ? clusterRawOcrTokens(frameLists, {
      maxDistance: 1, minTokenLength: 2, minFrequency: 2,
      keepUnknown: arm.keepUnknown === true,
      keepUnknownMinFrames: arm.keepUnknownMinFrames || 3,
    }).merged_list || []
    : [];
  return { merged, gateFrames, gateActiveFrames, trustActiveFrames };
}

const ARMS = [
  { key: 'base', gate: false },
  { key: 'post', gate: 'post' },
  { key: 'inloop', gate: 'inloop' },
  // Trusted-column arms: the accept path trusts the detected LEFT-ALIGNED
  // ticker column, so a token in it is accepted even when it is neither in
  // the seed lexicon nor next to a readable price. `trustMinLeft` is how
  // many words must share the column's left edge before it is trusted.
  { key: 'trust3', gate: 'inloop', trust: true, trustMinLeft: 3 },
  { key: 'trust4', gate: 'inloop', trust: true, trustMinLeft: 4 },
  { key: 'trust6', gate: 'inloop', trust: true, trustMinLeft: 6 },
  { key: 'trust4ng', gate: false, trust: true, trustMinLeft: 4 },
  // `trustRaw` keeps the token the OCR actually read instead of replacing
  // it with an edit-distance near-miss; `trustNeedNumber` additionally
  // requires the row to carry a 2+ digit number to the right of the
  // ticker, which is what separates a position row from the panel's
  // column-header row.
  { key: 'traw4', gate: 'inloop', trust: true, trustMinLeft: 4, trustRaw: true },
  { key: 'tnum4', gate: 'inloop', trust: true, trustMinLeft: 4, trustRaw: true, trustNeedNumber: true },
  { key: 'tnum6', gate: 'inloop', trust: true, trustMinLeft: 6, trustRaw: true, trustNeedNumber: true },
  { key: 'tnum2', gate: 'inloop', trust: true, trustMinLeft: 2, trustRaw: true, trustNeedNumber: true },
  // Same as tnum but keeping the edit-distance correction (which recovers
  // garbled reads like "GuSH" -> "GUSH"). The numbered-row rule is what
  // keeps the panel header "Sym" out of the band, so the correction no
  // longer turns SYM into SPYM.
  { key: 'tcor4', gate: 'inloop', trust: true, trustMinLeft: 4, trustNeedNumber: true },
  { key: 'tcor6', gate: 'inloop', trust: true, trustMinLeft: 6, trustNeedNumber: true },
  { key: 'tcor3', gate: 'inloop', trust: true, trustMinLeft: 3, trustNeedNumber: true },
  // `keepUnknown` lets the clusterer keep a token that is not in the seed
  // lexicon (GUSH, KOLD, AGQ) when it is seen in enough distinct frames,
  // instead of dropping it or rewriting it to a near-miss (VERU→VERV).
  { key: 'tcor6k3', gate: 'inloop', trust: true, trustMinLeft: 6, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3 },
  { key: 'tcor6k4', gate: 'inloop', trust: true, trustMinLeft: 6, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 4 },
  { key: 'tnum6k3', gate: 'inloop', trust: true, trustMinLeft: 6, trustRaw: true, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3 },
  { key: 'tcor4k3', gate: 'inloop', trust: true, trustMinLeft: 4, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3 },
  // `numberMinDigits` raises the bar for "this row carries data": the
  // panel header row has a stray 2-digit number on it ("Sym 50 Change"),
  // while a real position row always has a 3+ digit shares value.
  { key: 'tnum6k3d3', gate: 'inloop', trust: true, trustMinLeft: 6, trustRaw: true, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3, numberMinDigits: 3 },
  { key: 'tnum6k3d4', gate: 'inloop', trust: true, trustMinLeft: 6, trustRaw: true, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3, numberMinDigits: 4 },
  { key: 'tnum6k3d2', gate: 'inloop', trust: true, trustMinLeft: 6, trustRaw: true, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3, numberMinDigits: 2 },
  { key: 'tnum4k3d3', gate: 'inloop', trust: true, trustMinLeft: 4, trustRaw: true, trustNeedNumber: true, keepUnknown: true, keepUnknownMinFrames: 3, numberMinDigits: 3 },
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
  stats[arm.key] = { hits: 0, fp: 0, size: 0, changed: 0, activeLogs: 0, trustActiveLogs: 0 };
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
    results[arm.key] = mergedFor(log, arm);
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
    if (r.trustActiveFrames > 0) stats[arm.key].trustActiveLogs++;
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
console.log('[gate] logs with the trusted column active on >=1 frame: ' +
  ARMS.map((a) => `${a.key} ${stats[a.key].trustActiveLogs}`).join(', '));
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
