'use strict';

// Every capture's reading against the panel's own row count.
//
// The footer is read from the FIRST capture's frame, so the count describes
// THAT panel. This lists, per date, what each capture read and what the
// panel says -- which is the only per-frame truth available.
//
//   node tools/reportCapturePanelCounts.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RERUN = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const PROBE = path.join(ROOT, 'data', 'video_ocr_probe');
const ERA_CROPS = new Set(['0.86,0.6,0.14,0.28', '0.82,0.6,0.18,0.32']);

const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));

function gtSet(date) {
  const entry = gt[date] || {};
  const out = new Set();
  for (const [key, value] of Object.entries(entry)) {
    if (!/^\d+$/.test(key)) continue;
    const seq = Array.isArray(value) ? value : (value.tickers || []);
    for (const t of seq) out.add(String(t).toUpperCase());
  }
  return out;
}

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

const files = [];
walk(RERUN, files, 0);
walk(PROBE, files, 0);

const best = new Map();
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const date = String(j.date_key || '');
  if (!/^\d{8}$/.test(date) || j.status !== 'done') continue;
  if (!ERA_CROPS.has(regionKey(j))) continue;
  const m = fs.statSync(f).mtimeMs;
  if (!best.has(date) || m > best.get(date).m) best.set(date, { m, j, f });
}

for (const [date, { j, f }] of [...best.entries()].sort()) {
  const g = gtSet(date);
  if (!g.size) continue;
  const panel = j.panel_row_count;
  if (panel == null) continue;
  const rows = (j.captures || []).map((c, i) => {
    const list = [...new Set((((c.chart_stream || {}).position_list) || []).map((t) => String(t).toUpperCase()))];
    const extras = list.filter((t) => !g.has(t));
    return { i, ts: c.timestamp, n: list.length, list, extras };
  });
  const allExtras = [...new Set(rows.flatMap((r) => r.extras))];
  console.log(`\n${date}  panel=${panel}  gt_union=${g.size}  ${f.parent.parent.name}`);
  for (const r of rows) {
    console.log(`  cap${r.i} ts=${String(r.ts).padStart(5)}  n=${r.n}  ${r.list.join(',')}`);
    if (r.extras.length) console.log(`        extras vs gt union: ${r.extras.join(',')}`);
  }
  if (allExtras.length) console.log(`  union of extras: ${allExtras.join(',')}`);
}
