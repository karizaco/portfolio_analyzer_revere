'use strict';

/**
 * Re-run the chart-stream parser over the OCR output already saved in scan
 * logs.
 *
 * Every scan log stores the raw OCR of each captured frame
 * (`top_candidates[].ocr_text` and `top_candidates[].ocr_words`), so the
 * parser and the multi-frame clusterer can be re-run over that data without
 * touching the video again. That makes a parser change cheap to evaluate:
 * no EasyOCR, no ffmpeg, seconds instead of minutes per video.
 *
 * It also means a parser fix can be applied retroactively to every video the
 * sweep has already processed.
 *
 * The re-parse mirrors tools/scanVideoWithOcr.js exactly for `snapshot`
 * (QMG chart-stream) mode:
 *
 *   1. per frame: parseChartStreamPositionList({ ocr })
 *   2. the clusterer is fed the per-frame position_list (NOT the raw OCR
 *      text) — that is the chart-area-bleed fix from commit d824431
 *   3. clusterRawOcrTokens(..., { maxDistance: 1, minTokenLength: 2,
 *      minFrequency: 2 }) -> merged_position_list
 *
 * Usage:
 *   node tools/reparseOcrLogs.js --dry-run
 *   node tools/reparseOcrLogs.js --run-tag qmg-sweep-20261025 --write
 *   node tools/reparseOcrLogs.js --gt            # score against ground truth
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
const WRITE = argv.includes('--write');
const GT_ONLY = argv.includes('--gt');
const RUN_TAG = flag('--run-tag', null);
const LIMIT = parseInt(flag('--limit', '0'), 10) || 0;

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
 * The canonical OCR crop width for a chart-stream scan.
 *
 * tools/scanVideoWithOcr.js extracts the overlay region with an ffmpeg crop
 * filter that scales it to `round(w * 1920 * 5)` pixels wide, so the word
 * coordinates are in that space — NOT in `ocr_frame_width` (which is the width
 * of the full frame the crop was taken from). Getting this wrong scales the
 * parser's X_POSITION_LIST_MIN threshold and changes every result.
 */
function cropWidthFor(log) {
  const region = log.phash_region_fraction || log.phash_region;
  const w = region && Number.isFinite(region.w) ? region.w : null;
  if (w == null) return null;
  return Math.round(w * 1920 * 5);
}

/** Rebuild the OCR result shape the parser expects from a stored candidate. */
function ocrFromCandidate(candidate, log, cropWidth) {
  const words = Array.isArray(candidate.ocr_words) ? candidate.ocr_words : [];
  const text = candidate.ocr_text || '';
  if (!words.length) {
    // The pipeline still parsed this frame, through the legacy text-only
    // path. Reproduce that so the replay matches frame-for-frame.
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
  };
}

/**
 * Re-derive the merged position list for one log.
 *
 * `framesReproved` reports whether the fresh parse reproduces the per-frame
 * position lists the log already stores. A log whose stored OCR is incomplete
 * (older runs wrote no word boxes) cannot be re-derived faithfully, so the
 * caller skips it rather than writing a bogus result.
 */
function reparse(log) {
  const candidates = Array.isArray(log.top_candidates) ? log.top_candidates : [];
  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  const perFrame = [];
  let framesReproved = 0;
  let framesCompared = 0;
  for (const c of candidates) {
    const ocr = ocrFromCandidate(c, log, cropWidth);
    if (!ocr || !ocr.text) continue;
    const parsed = parseChartStreamPositionList({ ocr });
    const stored = c.chart_stream && Array.isArray(c.chart_stream.position_list)
      ? c.chart_stream.position_list
      : null;
    if (stored) {
      framesCompared++;
      if (JSON.stringify(stored) === JSON.stringify(parsed.position_list || [])) {
        framesReproved++;
      }
    }
    perFrame.push({
      frameIndex: c.frame_index,
      timestamp: c.timestamp,
      positionList: parsed.position_list || [],
      parseStatus: parsed.parse_status,
      columnFilter: parsed.column_filter,
    });
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
  }
  if (!perFrame.length) return null;
  const clusterResult = clusterRawOcrTokens(frameLists, {
    maxDistance: 1,
    minTokenLength: 2,
    minFrequency: 2,
  });
  return {
    merged: clusterResult.merged_list || [],
    clusters: clusterResult.clusters || [],
    perFrame,
    framesCompared,
    framesReproved,
    faithful: framesCompared === 0 || framesReproved === framesCompared,
  };
}

// --- Ground truth ------------------------------------------------------------

function loadGT() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * The GT store is keyed by date and then by capture index. The capture index
 * in the log is the frame_index of the candidate; the snapshot file naming
 * convention uses captureIndex + 1. Match on the union of all captures for
 * the date so a re-parse can be scored without knowing which frame the GT
 * was drawn from.
 */
function gtTickersForDate(gt, dateKey) {
  const entry = gt[dateKey];
  if (!entry || typeof entry !== 'object') return null;
  const all = new Set();
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) for (const t of value) all.add(t);
  }
  return all.size ? [...all] : null;
}

// --- Main --------------------------------------------------------------------

const roots = [path.join(ROOT, 'data')];
if (RUN_TAG) roots.unshift(path.join(ROOT, 'data', 'video_scan_test', '_rerun', RUN_TAG));
else roots.unshift(path.join(ROOT, 'data', 'video_scan_test', '_rerun'));

const files = [];
for (const r of roots) collectLogFiles(r, files);
const gt = loadGT();

let nParsed = 0;
let nChanged = 0;
let nUnfaithful = 0;
let nScored = 0;
let hits = 0;
let gtSize = 0;
let fps = 0;
const rows = [];

for (const file of files) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    continue;
  }
  const dateKey = String(log.date_key || '').slice(0, 8);
  if (GT_ONLY && !gt[dateKey]) continue;
  if (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine !== 'easyocr') continue;
  const result = reparse(log);
  if (!result) continue;
  if (!result.faithful) {
    // The stored OCR for this log cannot reproduce its own per-frame parse,
    // so the log is missing data (older runs wrote no word boxes). Re-deriving
    // it would replace a good result with a guess.
    nUnfaithful++;
    continue;
  }
  nParsed++;

  const before = (log.merged_position_list || []).join(',');
  const after = result.merged.join(',');
  const changed = before !== after;
  if (changed) nChanged++;

  const gtTickers = gtTickersForDate(gt, dateKey);
  let line = `${dateKey}  ${path.basename(file).slice(0, 44).padEnd(46)}`;
  if (gtTickers) {
    const found = new Set(result.merged);
    const hit = gtTickers.filter((t) => found.has(t)).length;
    hits += hit;
    gtSize += gtTickers.length;
    fps += result.merged.filter((t) => !gtTickers.includes(t)).length;
    nScored++;
    line += ` recall=${hit}/${gtTickers.length} fp=${result.merged.filter((t) => !gtTickers.includes(t)).length}`;
  }
  if (changed) line += '  CHANGED';
  line += `\n     old: ${before || '(none)'}\n     new: ${after || '(none)'}`;
  rows.push(line);

  if (WRITE && changed) {
    // Keep the log's structure: update the per-candidate position lists and
    // the merged list so downstream tooling sees the re-parsed values.
    const byFrame = new Map(result.perFrame.map((f) => [f.frameIndex, f]));
    for (const c of log.top_candidates || []) {
      const f = byFrame.get(c.frame_index);
      if (!f || !c.chart_stream) continue;
      c.chart_stream.position_list = f.positionList;
      c.tickers = f.positionList;
    }
    log.merged_position_list = result.merged;
    log.merged_raw_token_clusters = result.clusters;
    fs.writeFileSync(file, JSON.stringify(log, null, 1));
  }
}

console.log('[reparse] ' + nParsed + ' logs replayed faithfully' +
  (WRITE ? ' (writing changes)' : ' (dry run)'));
console.log('[reparse] ' + nChanged + ' merged lists differ from the stored value');
if (nUnfaithful) {
  console.log('[reparse] ' + nUnfaithful + ' logs skipped: stored OCR cannot reproduce ' +
    'its own per-frame parse (incomplete word boxes)');
}
if (nScored) {
  console.log('[reparse] against ground truth: ' + hits + '/' + gtSize +
    ' recall = ' + Math.round(100 * hits / gtSize) + '%, ' +
    fps + ' false positives');
}
if (!GT_ONLY) {
  console.log('');
  for (const row of rows) console.log(row);
}
