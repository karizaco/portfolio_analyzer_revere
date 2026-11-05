'use strict';

// Score the CURRENT parser against the ground truth, using the recorded OCR
// words of the newest probe log per date. No OCR runs: this measures the
// parser on real frames.
//
//   node tools/scoreCurrentParser.js [run-tag] [dateKey]
//
// With no arguments it walks every run under data/video_scan_test/_rerun and
// scores the newest log per date that used a shipped era crop.

const fs = require('node:fs');
const path = require('node:path');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
const { layoutAliasEraForDate } = require('../src/video/chartStreamCrop');
const { loadQmgGroundTruth, listGroundTruthCaptures } = require('../src/qmg/qmgGroundTruth');

const ROOT = path.resolve(__dirname, '..');
const RERUN = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const ERA_CROPS = new Set(['0.86,0.60,0.14,0.28', '0.82,0.60,0.18,0.32']);

function walk(dir, out, depth) {
  if (depth > 5) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'frames' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.name.endsWith('_snapshot.json')) out.push(full);
  }
}

function regionKey(j) {
  const c = j.phash_region_fraction || {};
  return `${c.x},${c.y},${c.w},${c.h}`;
}

function newestLogs(runTag) {
  const files = [];
  if (runTag) {
    const base = path.join(RERUN, runTag, 'ocr_probe', 'logs');
    const dir = fs.existsSync(base) ? base : path.join(RERUN, runTag);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) files.push(path.join(dir, f));
    }
  } else {
    walk(RERUN, files, 0);
  }
  const best = new Map();
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const d = String(j.date_key || '');
    if (!/^\d{8}$/.test(d)) continue;
    const m = fs.statSync(f).mtimeMs;
    if (!best.has(d) || m > best.get(d).m) best.set(d, { m, f, j });
  }
  return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const runTag = process.argv[2] || null;
const onlyDate = process.argv[3] || null;
const gt = loadQmgGroundTruth();
const gtByDate = new Map();
for (const c of listGroundTruthCaptures(gt)) {
  const d = c.date || c.dateKey;
  if (!gtByDate.has(d)) gtByDate.set(d, new Set());
  for (const t of c.tickers || []) gtByDate.get(d).add(String(t).toUpperCase());
}

let totHit = 0;
let totGt = 0;
let totFp = 0;
let dates = 0;

for (const [date, entry] of newestLogs(runTag)) {
  if (onlyDate && date !== onlyDate) continue;
  const g = gtByDate.get(date);
  if (!g || !g.size) continue;
  if (runTag === null && !ERA_CROPS.has(regionKey(entry.j))) continue;
  const era = layoutAliasEraForDate(date);
  const merged = new Set();
  for (const c of entry.j.captures || []) {
    const r = parseChartStreamPositionList({
      ocr: {
        text: c.ocr_text || '',
        words: c.ocr_words || [],
        _cropWidth: 1345,
        _engine: 'easyocr',
      },
      layoutEra: era,
    });
    for (const t of r.position_list || []) merged.add(String(t).toUpperCase());
  }
  const hit = [...g].filter((t) => merged.has(t)).length;
  const fp = [...merged].filter((t) => !g.has(t));
  totHit += hit; totGt += g.size; totFp += fp.length; dates += 1;
  console.log(`${date}  ${hit}/${g.size}  miss=${[...g].filter((t) => !merged.has(t)).join(',') || '-'}  fp=${fp.join(',') || '-'}  era=${era}`);
}

console.log(`\ndates ${dates}  hit/gt ${totHit}/${totGt} = ${totHit / totGt * 100}%  fp ${totFp}`);
