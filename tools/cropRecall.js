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
// Restrict to logs that stored OCR WORD BOXES.
//
// This matters more than it looks: the trusted-column accept path needs
// word boxes to know where a token sits. Older runs (qmg-batch-a,
// qmg-batch2, qmg-batch3) stored OCR text only, so they score 0 under
// the current parser no matter which crop they used. Including them
// conflates "this crop is worse" with "this run could not use the
// column at all" — and the runs that stored text-only are ALSO the runs
// that used the tall crop, so the confound runs straight through the
// comparison.
const REQUIRE_WORDS = !process.argv.includes('--all-logs');

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
  const engine = (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine) || null;
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
  const ocr = {
    text: text || lines.join('\n'),
    lines,
    words,
    _cropWidth: cropWidth,
    _engine: engine,
  };
  // Mirror the production accept path (tools/scanVideoWithOcr.js). Without
  // this the crop comparison measures the OLD parser, which no longer runs.
  if (engine === 'easyocr') {
    ocr._columnTrust = true;
    ocr._columnTrustMinLeft = 6;
    ocr._columnTrustRaw = true;
    ocr._columnTrustNeedNumber = true;
    ocr._columnTrustNumberMinDigits = 3;
  }
  return ocr;
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
  if (REQUIRE_WORDS) {
    const hasWords = (log.top_candidates || []).some((c) => (c.ocr_words || []).length > 0);
    if (!hasWords) continue;
  }
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
      keepUnknown: true, keepUnknownMinFrames: 3,
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

// --- Paired comparison -------------------------------------------------------
//
// The per-crop numbers above are CONFOUNDED: the crops were used on
// different videos (different run dates), so a crop can look better just
// because the videos it ran on were easier. The only clean comparison is
// over the DATES that were scanned with BOTH crops.
//
// For each date, take the best recall achieved under each crop (a date can
// have several logs per crop from repeated runs) and compare those.
const byCropByDate = new Map();
for (const [key, g] of groups) {
  const m = new Map();
  for (const r of g.perLog) {
    const prev = m.get(r.dateKey);
    if (!prev || r.hit > prev.hit) m.set(r.dateKey, r);
  }
  byCropByDate.set(key, m);
}

const cropKeys = [...byCropByDate.keys()];
const paired = [];
for (let i = 0; i < cropKeys.length; i++) {
  for (let j = i + 1; j < cropKeys.length; j++) {
    const a = byCropByDate.get(cropKeys[i]);
    const b = byCropByDate.get(cropKeys[j]);
    let aHits = 0, bHits = 0, size = 0, aFp = 0, bFp = 0, n = 0;
    const perDate = [];
    for (const [dateKey, ra] of a) {
      const rb = b.get(dateKey);
      if (!rb) continue;
      n++;
      aHits += ra.hit; bHits += rb.hit; size += ra.size;
      aFp += ra.fp; bFp += rb.fp;
      perDate.push({ dateKey, aHit: ra.hit, bHit: rb.hit, size: ra.size });
    }
    if (!n) continue;
    paired.push({ a: cropKeys[i], b: cropKeys[j], n, aHits, bHits, size, aFp, bFp, perDate });
  }
}

if (paired.length) {
  console.log('');
  console.log('[crop] PAIRED comparison over dates scanned with BOTH crops:');
  for (const p of paired.sort((x, y) => y.size - x.size)) {
    console.log(`   ${p.a}`);
    console.log(`   ${p.b}`);
    console.log(`   ${p.n} shared dates, ${p.size} GT tickers`);
    console.log(`      ${p.a}: ${p.aHits}/${p.size} = ${Math.round(100 * p.aHits / p.size)}%   FP ${p.aFp}`);
    console.log(`      ${p.b}: ${p.bHits}/${p.size} = ${Math.round(100 * p.bHits / p.size)}%   FP ${p.bFp}`);
    console.log(`      winner: ${p.aHits === p.bHits ? 'tie' : (p.aHits > p.bHits ? p.a : p.b)}` +
      ` (+${Math.abs(p.aHits - p.bHits)} tickers, ${Math.round(100 * p.aHits / p.size) - Math.round(100 * p.bHits / p.size)} points)`);
    if (VERBOSE) {
      for (const d of p.perDate.sort((x, y) => (x.aHit - x.bHit) || (x.dateKey < y.dateKey ? -1 : 1))) {
        const mark = d.aHit === d.bHit ? '   ' : (d.aHit > d.bHit ? ' A ' : ' B ');
        console.log(`      ${mark} ${d.dateKey}  A=${d.aHit}/${d.size}  B=${d.bHit}/${d.size}`);
      }
    }
    console.log('');
  }
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
