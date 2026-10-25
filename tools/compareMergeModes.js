'use strict';

/**
 * Compare the current merged position list against the multi-frame clusterer.
 *
 * The live pipeline feeds the clusterer `c.chartStream?.position_list`, but
 * `summarizeCandidate` writes the summary under the snake_case key
 * `chart_stream`. The filter therefore drops every candidate, the clusterer
 * runs on an empty input, and `merged_position_list` ends up being just the
 * single phash-deduped capture's tickers — no multi-frame voting at all.
 *
 * This script measures what the fix would change, using the OCR word boxes
 * already stored in the scan logs (no video, no OCR):
 *
 *   current  — the stored merged_position_list (single capture)
 *   clustered — clusterRawOcrTokens over every frame's per-frame position list
 *
 * Usage:
 *   node tools/compareMergeModes.js
 *   node tools/compareMergeModes.js --run-tag qmg-sweep-20261025
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseChartStreamPositionList, clusterRawOcrTokens } = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const RUN_TAG = (() => {
  const i = argv.indexOf('--run-tag');
  return i === -1 ? null : argv[i + 1];
})();

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

function parseCandidate(candidate, log, cropWidth) {
  const words = Array.isArray(candidate.ocr_words) ? candidate.ocr_words : [];
  if (!words.length) return null;
  const linesByIndex = new Map();
  for (const w of words) {
    const line = Number.isFinite(w.line) ? w.line : 0;
    if (!linesByIndex.has(line)) linesByIndex.set(line, []);
    linesByIndex.get(line).push(w.text);
  }
  const lines = [...linesByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.join(' '));
  return parseChartStreamPositionList({
    ocr: {
      text: candidate.ocr_text || lines.join('\n'),
      lines,
      words,
      _cropWidth: cropWidth,
      _engine: (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine) || null,
    },
  });
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

const roots = [path.join(ROOT, 'data')];
roots.unshift(RUN_TAG
  ? path.join(ROOT, 'data', 'video_scan_test', '_rerun', RUN_TAG)
  : path.join(ROOT, 'data', 'video_scan_test', '_rerun'));

const files = [];
for (const r of roots) collectLogFiles(r, files);
const gt = loadGT();

let nScored = 0;
let curHits = 0;
let cluHits = 0;
let gtSize = 0;
let curFp = 0;
let cluFp = 0;
let curSize = 0;
let cluSize = 0;
let nLogs = 0;
let nClustered = 0;
const rows = [];

for (const file of files) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    continue;
  }
  if (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine !== 'easyocr') continue;
  const cropWidth = cropWidthFor(log);
  const candidates = Array.isArray(log.top_candidates) ? log.top_candidates : [];
  if (!candidates.length) continue;

  const frameLists = [];
  let reproduced = 0;
  let compared = 0;
  for (const c of candidates) {
    const parsed = parseCandidate(c, log, cropWidth);
    if (!parsed) continue;
    const stored = c.chart_stream && Array.isArray(c.chart_stream.position_list)
      ? c.chart_stream.position_list : null;
    if (stored) {
      compared++;
      if (JSON.stringify(stored) === JSON.stringify(parsed.position_list || [])) reproduced++;
    }
    if (parsed.position_list && parsed.position_list.length) {
      frameLists.push(parsed.position_list.join(' '));
    }
  }
  if (!frameLists.length) continue;
  nLogs++;

  const clustered = clusterRawOcrTokens(frameLists, {
    maxDistance: 1, minTokenLength: 2, minFrequency: 2,
  }).merged_list;

  const current = log.merged_position_list || [];
  curSize += current.length;
  cluSize += clustered.length;
  if (JSON.stringify(current) !== JSON.stringify(clustered)) nClustered++;

  const dateKey = String(log.date_key || '').slice(0, 8);
  const gtTickers = gtTickersForDate(gt, dateKey);
  let line = `${dateKey}  ${path.basename(file).slice(0, 40).padEnd(42)}`;
  if (gtTickers) {
    const curHit = gtTickers.filter((t) => current.includes(t)).length;
    const cluHit = gtTickers.filter((t) => clustered.includes(t)).length;
    curHits += curHit; cluHits += cluHit; gtSize += gtTickers.length;
    curFp += current.filter((t) => !gtTickers.includes(t)).length;
    cluFp += clustered.filter((t) => !gtTickers.includes(t)).length;
    nScored++;
    line += ` GT ${gtTickers.length}: current ${curHit}/${gtTickers.length} fp${current.length - curHit}` +
      `  ->  clustered ${cluHit}/${gtTickers.length} fp${clustered.length - cluHit}`;
  }
  line += `\n     current  : ${current.join(',') || '(none)'}` +
    `\n     clustered: ${clustered.join(',') || '(none)'}`;
  if (compared && reproduced !== compared) {
    line += `\n     (per-frame parse reproduced ${reproduced}/${compared})`;
  }
  rows.push(line);
}

console.log('[compare] ' + nLogs + ' logs with per-frame position lists');
console.log('[compare] ' + nClustered + ' would change under the clusterer');
console.log('[compare] average list size: current ' +
  (nLogs ? (curSize / nLogs).toFixed(2) : '-') + ', clustered ' +
  (nLogs ? (cluSize / nLogs).toFixed(2) : '-'));
if (nScored) {
  console.log('[compare] against ground truth over ' + nScored + ' logs:');
  console.log('   current  : ' + curHits + '/' + gtSize + ' recall = ' +
    Math.round(100 * curHits / gtSize) + '%, ' + curFp + ' FP');
  console.log('   clustered: ' + cluHits + '/' + gtSize + ' recall = ' +
    Math.round(100 * cluHits / gtSize) + '%, ' + cluFp + ' FP');
}
console.log('');
for (const row of rows) console.log(row);
