'use strict';

// Re-parse the recorded OCR words of a probe log with the CURRENT parser, and
// report the per-capture reading. No OCR, so it measures the parser on real
// frames.
//
//   node tools/reparseCaptures.js <run-tag-or-log-dir> [dateKey]
//
// With no arguments it takes the newest log per date under
// data/video_scan_test/_rerun.

const fs = require('node:fs');
const path = require('node:path');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
const { layoutAliasEraForDate } = require('../src/video/chartStreamCrop');

const ROOT = path.resolve(__dirname, '..');
const RERUN = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

function findLogs(target) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'frames' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('_snapshot.json')) out.push(full);
    }
  };
  if (!target) {
    walk(RERUN, 0);
    // newest log per date
    const best = new Map();
    for (const f of out) {
      let j;
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const d = String(j.date_key || '');
      if (!/^\d{8}$/.test(d)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best.has(d) || m > best.get(d).m) best.set(d, { m, f, j });
    }
    return [...best.values()].sort((a, b) => a.f.localeCompare(b.f));
  }
  const dir = path.isAbsolute(target) ? target : path.join(RERUN, target);
  const dirLog = path.join(dir, 'ocr_probe', 'logs');
  const base = fs.existsSync(dirLog) ? dirLog : dir;
  const files = fs.readdirSync(base).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const full = path.join(base, f);
    let j;
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    out.push({ f: full, j });
  }
  return out;
}

const target = process.argv[2] || null;
const onlyDate = process.argv[3] || null;

for (const entry of findLogs(target)) {
  const j = entry.j || JSON.parse(fs.readFileSync(entry.f, 'utf8'));
  const date = String(j.date_key || '');
  if (onlyDate && date !== onlyDate) continue;
  const era = layoutAliasEraForDate(date);
  const merged = (j.merged_position_list || []).map((t) => String(t).toUpperCase());
  console.log(`\n${date}  era=${era}  merged(${merged.length})=${merged.join(',')}`);
  for (const c of j.captures || []) {
    const result = parseChartStreamPositionList({
      ocr: {
        text: c.ocr_text || '',
        words: c.ocr_words || [],
        _cropWidth: 1345,
        _engine: 'easyocr',
      },
      layoutEra: era,
    });
    const list = (result.position_list || []).map((t) => String(t).toUpperCase());
    console.log(`  ts=${c.timestamp}  ${list.join(',')}`);
  }
}
