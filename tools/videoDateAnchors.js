'use strict';

/**
 * Extract (video_id -> upload_date) anchors.
 *
 * Three sources, in decreasing order of trust:
 *
 *   1. `data/qmg_upload_dates.json` — dumped from state.sqlite's `upload_date`
 *      column by tools/dumpUploadDates.py. Authoritative: it is what the
 *      catalog recorded from YouTube metadata, and it is what the downloader
 *      used to name files `<date>_<id>.mp4`.
 *   2. The recovery manifest (`data/qmg_video_recovery_manifest.json`) —
 *      same origin, a subset.
 *   3. Surviving scan logs — ONLY when the log's video filename starts with
 *      `<date_key>_`. A scan log records the date_key the scan *ran under*,
 *      which is the upload date only when the file was named after it. The
 *      Oct-2026 batches ran videos whose upload date was unknown under an
 *      arbitrary date, so those logs carry a scan date, not an upload date.
 *      Mixing them in poisons the interpolation — that bug dated 449 of the
 *      588 catalogued videos to 2026-10-0x.
 *
 * These anchors feed `tools/qmgVideoDates.js`, which interpolates dates for
 * the remaining videos from the reverse-chronological playlist order.
 *
 * Usage:
 *   node tools/videoDateAnchors.js
 *   node tools/videoDateAnchors.js --write data/qmg_date_anchors.json
 */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const writeIdx = argv.indexOf('--write');
const OUT = writeIdx === -1 ? null : argv[writeIdx + 1];

const ROOT = path.resolve(__dirname, '..');
const anchors = new Map();   // video_id -> date_key
let logCount = 0;
let logAnchors = 0;

// --- 1. SQLite upload_date (authoritative) ----------------------------------
let sqliteCount = 0;
try {
  const j = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'qmg_upload_dates.json'), 'utf8')
  );
  for (const [id, d] of Object.entries(j)) {
    if (/^\d{8}$/.test(d)) { anchors.set(id, d); sqliteCount++; }
  }
} catch (_) {
  console.log('[anchors] no data/qmg_upload_dates.json — run tools/dumpUploadDates.py');
}

// --- 2. Recovery manifest ----------------------------------------------------
let manifestCount = 0;
try {
  const man = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'qmg_video_recovery_manifest.json'), 'utf8')
  ).videos;
  for (const v of man) {
    if (!/^\d{8}$/.test(v.date || '')) continue;
    if (anchors.has(v.video_id)) continue;
    anchors.set(v.video_id, v.date);
    manifestCount++;
  }
} catch (_) {}

// --- 3. Scan logs, filename-prefix rule only --------------------------------
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.json') || !e.name.includes('_snapshot.json')) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      continue;
    }
    logCount++;
    const dateKey = j.date_key;
    const vp = j.video_path;
    if (!dateKey || !vp || !/^\d{8}$/.test(dateKey)) continue;
    // The filename carries the date only if the downloader knew it.
    const base = path.basename(String(vp));
    if (!base.startsWith(dateKey + '_')) continue;
    const m = base.match(/([A-Za-z0-9_-]{11})\.mp4$/);
    if (!m) continue;
    if (anchors.has(m[1])) continue;
    anchors.set(m[1], dateKey);
    logAnchors++;
  }
}

for (const r of ['data', 'data/video_scan_test/_rerun']) walk(path.join(ROOT, r));

const byDate = new Map();
for (const [id, d] of anchors) {
  if (!byDate.has(d)) byDate.set(d, []);
  byDate.get(d).push(id);
}

console.log('[anchors] read ' + logCount + ' scan logs');
console.log('[anchors] ' + anchors.size + ' dated video_ids across ' + byDate.size + ' dates');
console.log('[anchors]   from sqlite upload_date: ' + sqliteCount);
console.log('[anchors]   from recovery manifest: ' + manifestCount);
console.log('[anchors]   from date-named scan logs: ' + logAnchors);
if (byDate.size) {
  const dates = [...byDate.keys()].sort();
  console.log('[anchors] span ' + dates[0] + ' .. ' + dates[dates.length - 1]);
}

if (OUT) {
  const out = {};
  for (const [id, d] of anchors) out[id] = d;
  fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(out, null, 1));
  console.log('[anchors] wrote ' + Object.keys(out).length + ' anchors to ' + OUT);
}
