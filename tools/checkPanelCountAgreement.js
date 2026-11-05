'use strict';

// Do the remaining "false positives" disagree with the PANEL's own row count?
//
// The ground truth's notes record that a twelve-row frame carrying `GUSH`
// exists on 20220412 at a LATER moment than the anchor frame the ground
// truth was read from. So a reading that publishes GUSH may be exact for the
// moment it captured, and the union score calls it a false positive.
//
// The panel's own footer is the tie-break: it says how many rows are on
// screen. A reading whose length matches the panel's count is a reading of
// THAT panel.
//
//   node tools/checkPanelCountAgreement.js

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

console.log('A reading whose length matches the panel\'s own count is a reading of THAT panel.');
console.log(`\n${'date':10} {'panel':>6} {'list':>5} {'gt':>4}  agrees  extras-not-in-gt`);
let exact = 0;
let total = 0;
for (const [date, { j, f }] of [...best.entries()].sort()) {
  const g = gtSet(date);
  if (!g.size) continue;
  const merged = new Set((j.merged_position_list || []).map((t) => String(t).toUpperCase()));
  if (!merged.size) continue;
  const panel = j.panel_row_count;
  const extras = [...merged].filter((t) => !g.has(t));
  if (!extras.length && panel == null) continue;
  total += 1;
  const agrees = panel != null && panel === merged.size;
  if (agrees) exact += 1;
  console.log(`${date} ${String(panel).padStart(6)} ${String(merged.size).padStart(5)} ${String(g.size).padStart(4)}`
    + `  ${agrees ? 'YES' : 'no '}    ${extras.join(',') || '-'}`);
  if (!agrees && extras.length && panel != null) {
    console.log(`         panel says ${panel}, the reading has ${merged.size}; the extras are ${extras.join(',')}`);
    console.log(`         footer: ${JSON.stringify(j.panel_row_count_text || '')}`);
  }
}
console.log(`\n${exact}/${total} dates have a reading whose length matches the panel's own count`);
