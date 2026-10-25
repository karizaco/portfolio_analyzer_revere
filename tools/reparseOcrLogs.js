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
// Skip any log whose path contains this substring. Used to leave a
// concurrently-running sweep's own output alone (the sweep writes each log
// once, when its video finishes; rewriting one at the same moment would
// lose the sweep's result).
const EXCLUDE = flag('--exclude', null);
// Write the re-derived results to this JSON file instead of rewriting the
// logs in place. Non-destructive: the sidecar maps each log path to its
// re-derived merged list, so applying it is a separate, reviewable step.
const OUT = flag('--out', null);

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
 * `framesReproved` reports whether the CURRENT parser reproduces the per-frame
 * position lists the log already stores. It is informational only: the parser
 * has changed since those logs were written (the column gate, the blocklist,
 * the left-edge column band), so a mismatch is expected and is exactly the
 * point of the re-parse.
 *
 * `faithful` is a DATA check, not an output check: every candidate must carry
 * enough OCR to replay it. Older runs stored no word boxes, so those frames
 * are replayed through the legacy text-only path — which is exactly what the
 * pipeline did at the time, so the replay stays faithful.
 */
function reparse(log) {
  const candidates = Array.isArray(log.top_candidates) ? log.top_candidates : [];
  const cropWidth = cropWidthFor(log);
  const frameLists = [];
  const perFrame = [];
  let framesReproved = 0;
  let framesCompared = 0;
  let framesWithData = 0;
  for (const c of candidates) {
    const ocr = ocrFromCandidate(c, log, cropWidth);
    if (!ocr || !ocr.text) continue;
    framesWithData++;
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
    // Every candidate carried OCR text, so every frame can be replayed.
    faithful: framesWithData === candidates.length && candidates.length > 0,
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
// The roots overlap (`data/` contains `data/video_scan_test/_rerun/`), so the
// same log can be collected twice. De-duplicate by resolved path.
const seenPaths = new Set();
const uniqueFiles = files.filter((f) => {
  const key = path.resolve(f);
  if (seenPaths.has(key)) return false;
  seenPaths.add(key);
  return !EXCLUDE || !key.includes(EXCLUDE);
});
const gt = loadGT();

let nParsed = 0;
let nChanged = 0;
let nUnfaithful = 0;
let nSkippedEmpty = 0;
let nScored = 0;
let hits = 0;
let gtSize = 0;
let fps = 0;
const rows = [];
const outPayload = {};

for (const file of uniqueFiles) {
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
    // The stored OCR for this log is missing data for at least one frame.
    // Re-deriving it would replace a good result with a guess.
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

  if (OUT) {
    outPayload[path.relative(ROOT, file).split(path.sep).join('/')] = {
      date_key: dateKey,
      before: log.merged_position_list || [],
      after: result.merged,
      changed,
      per_frame: result.perFrame.map((f) => ({
        frame_index: f.frameIndex,
        timestamp: f.timestamp,
        position_list: f.positionList,
        parse_status: f.parseStatus,
      })),
      clusters: result.clusters,
    };
  }

  if (WRITE && changed) {
    // Never regress: a re-parse that yields an EMPTY merged list would
    // replace a good result with nothing. Keep the previous value instead.
    if (result.merged.length === 0 && (log.merged_position_list || []).length > 0) {
      nSkippedEmpty++;
      continue;
    }
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

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(outPayload, null, 1));
  console.log('[reparse] wrote ' + Object.keys(outPayload).length + ' re-derived results to ' + OUT);
}

console.log('[reparse] ' + nParsed + ' logs replayed faithfully' +
  (WRITE ? ' (writing changes)' : ' (dry run)'));
console.log('[reparse] ' + nChanged + ' merged lists differ from the stored value');
if (nUnfaithful) {
  console.log('[reparse] ' + nUnfaithful + ' logs skipped: at least one frame has no stored OCR text');
}
if (nSkippedEmpty) {
  console.log('[reparse] ' + nSkippedEmpty + ' logs kept their previous merged list ' +
    '(the re-parse produced an empty list)');
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
