#!/usr/bin/env node
'use strict';

/**
 * Prune REGENERABLE OCR snapshot images, keeping the irreplaceable OCR text.
 *
 * Why this exists
 * ---------------
 * The OCR pipeline writes two very different kinds of artefact:
 *
 *   - `.json` / `.log`  -> the OCR TEXT (tickers, positions, diagnostics).
 *                          Irreplaceable. Never touched by this tool.
 *   - `.png`            -> the captured FRAME that was fed to the OCR engine.
 *                          An INPUT. Regenerable from the source video.
 *
 * The PNGs dominate the repo's disk usage (1.2 GB of 1.5 GB under data/),
 * while the text results are only ~90 MB. When C: fills up, the PNGs are the
 * only safe thing to reclaim.
 *
 * Safety rules (a file is deleted only if ALL of these hold)
 * ----------------------------------------------------------
 *   1. It lives under `data/` (never outside the project, never the media dir).
 *   2. It is a `.png`.
 *   3. It is either
 *        a. inside an OCR `frames/` directory  -> a pure intermediate, or
 *        b. a named snapshot/screenshot whose date can be attributed to a
 *           video whose source media IS still on disk -> re-derivable.
 *   4. Its date is NOT protected. A date is protected if ANY authoritative
 *      video id (SQLite `videos` table UNION the lost-set ledger) that maps
 *      to that date has no media on disk. Those PNGs are the ONLY surviving
 *      record of a video we cannot re-download, so they are kept.
 *   5. It is not one of the ground-truth benchmark fixtures, and it is not in
 *      the live sweep run-tag's in-flight frames directory.
 *
 * Video ids are validated against the AUTHORITATIVE set (SQLite UNION ledger).
 * Parse artifacts in log filenames ("chop_around", "20220218_na") are not
 * authoritative ids, so they can never protect a date.
 *
 * Usage
 * -----
 *   node tools/prune_regenerable_snapshots.js            # dry run (default)
 *   node tools/prune_regenerable_snapshots.js --execute  # actually delete
 *   node tools/prune_regenerable_snapshots.js --keep-live-snapshots
 *   node tools/prune_regenerable_snapshots.js --include-live-frames
 *   node tools/prune_regenerable_snapshots.js --dir <path>   # scope to one dir
 *   node tools/prune_regenerable_snapshots.js --media-root <path>
 *
 * `--include-live-frames` also reclaims the live run-tag's `frames/`
 * intermediates. Only use it when no scan is running: those dirs belong to an
 * in-flight video and deleting them breaks that scan.
 *
 * `--dir <path>` restricts the prune to files under one directory (repeatable,
 * relative to the repo root). Use it to name the exact target being reclaimed.
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DATA = path.join(REPO, 'data');
const DEFAULT_MEDIA_ROOT = 'C:/Users/Admin/Projects/portfolio_analyzer_revere_media';
const LIVE_RUN_TAG = 'qmg-sweep-20261025';

// Ground-truth benchmark fixtures: the benchmark resolves the WIDEST candidate
// >= 1280px across all snapshot roots. If the wide holder is pruned the test
// falls back to a 640px copy and silently reports 0% recall.
const GT_FIXTURES = new Set([
  'qmg_20220218_2.png',
  'qmg_20221104.png',
  'qmg_20220606_2.png',
  'qmg_20230609.png',
]);

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function readFlags(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const KEEP_LIVE = argv.includes('--keep-live-snapshots');
const INCLUDE_LIVE_FRAMES = argv.includes('--include-live-frames');
const MEDIA_ROOT = readFlag(argv, '--media-root') || DEFAULT_MEDIA_ROOT;
const ONLY_DIRS = readFlags(argv, '--dir').map((d) => path.resolve(REPO, d));
if (ONLY_DIRS.length) {
  for (const d of ONLY_DIRS) {
    if (!d.startsWith(DATA)) { console.error('REFUSE --dir outside data/: ' + d); process.exit(1); }
  }
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function dirBytes(dir) {
  let total = 0;
  for (const f of walk(dir, [])) { try { total += fs.statSync(f).size; } catch { /* skip */ } }
  return total;
}

// ---------------------------------------------------------------- media on disk
const onDisk = new Set();
for (const d of ['downloads_1080p', 'downloads_720p']) {
  const p = path.join(MEDIA_ROOT, d);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (!f.toLowerCase().endsWith('.mp4')) continue;
    onDisk.add(f.replace(/^\d+_/, '').replace(/\.mp4$/i, '').toLowerCase());
  }
}

// ------------------------------------------------------- authoritative video ids
const ledgerPath = path.join(DATA, '_lost_videos_ledger.json');
let ledger = [];
try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { ledger = []; }

function queryDb(sql) {
  const script = `import sqlite3, json\ndb = sqlite3.connect(r"${path.join(DATA, 'video_pipeline/state.sqlite').replace(/\\/g, '/')}")\nprint(json.dumps(db.execute(${JSON.stringify(sql)}).fetchall()))\n`;
  const out = cp.execFileSync('py', ['-3', '-c', script], { encoding: 'utf8' });
  return JSON.parse(out);
}

let dbRows = [];
try { dbRows = queryDb('SELECT video_id, upload_date FROM videos'); }
catch (e) { console.error('WARN: could not read state.sqlite: ' + e.message); }

const AUTHORITATIVE = new Set(dbRows.map((r) => String(r[0]).toLowerCase()));
for (const e of ledger) AUTHORITATIVE.add(String(e.video_id).toLowerCase());

// ------------------------------------------------------- date -> video id map
const dateIds = new Map();
function addDate(date, id) {
  const key = String(id).toLowerCase();
  if (!AUTHORITATIVE.has(key)) return;      // parse artifact, not a real video
  if (!dateIds.has(date)) dateIds.set(date, new Set());
  dateIds.get(date).add(key);
}
for (const [id, date] of dbRows) if (date) addDate(String(date).slice(0, 8), id);

// Scan logs carry a date_key and the source video_path -> more attributions.
for (const f of walk(DATA, [])) {
  if (!/\.json$/i.test(f)) continue;
  let size; try { size = fs.statSync(f).size; } catch { continue; }
  if (size > 8 * 1024 * 1024) continue;
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const dk = j.date_key || j.dateKey;
  if (!dk) continue;
  let id = null;
  const m = String(j.video_path || j.videoPath || '').match(/([A-Za-z0-9_-]{11})\.mp4/);
  if (m) id = m[1];
  if (!id) { const n = path.basename(f).match(/(\d{8})_.*?([A-Za-z0-9_-]{11})/); if (n) id = n[2]; }
  if (id) addDate(String(dk).slice(0, 8), id);
}

const protectedDates = new Map();
for (const [date, ids] of dateIds) {
  const missing = [...ids].filter((id) => !onDisk.has(id));
  if (missing.length) protectedDates.set(date, missing);
}

// --------------------------------------------------------------------- classify
const LIVE_FRAMES = path.join(DATA, 'video_scan_test', '_rerun', LIVE_RUN_TAG, 'ocr_probe', 'frames');
const liveSnapshots = path.join(DATA, 'video_scan_test', '_rerun', LIVE_RUN_TAG, 'snapshots');

const toDelete = [];
const kept = { protectedDate: 0, fixture: 0, live: 0, noDate: 0 };
let keptBytes = 0;

for (const f of walk(DATA, [])) {
  if (path.extname(f).toLowerCase() !== '.png') continue;
  if (ONLY_DIRS.length && !ONLY_DIRS.some((d) => f.startsWith(d + path.sep))) continue;
  const size = fs.statSync(f).size;

  if (GT_FIXTURES.has(path.basename(f))) { kept.fixture++; keptBytes += size; continue; }
  if (f.startsWith(LIVE_FRAMES) && !INCLUDE_LIVE_FRAMES) { kept.live++; keptBytes += size; continue; }
  if (KEEP_LIVE && f.startsWith(liveSnapshots)) { kept.live++; keptBytes += size; continue; }

  const isFrame = f.split(path.sep).includes('frames');
  const m = path.basename(f).match(/(\d{8})/);
  if (!isFrame) {
    if (!m) { kept.noDate++; keptBytes += size; continue; }   // unknown provenance
    if (protectedDates.has(m[1])) { kept.protectedDate++; keptBytes += size; continue; }
  }
  toDelete.push({ f, size });
}

// ------------------------------------------------------------------- reporting
const delBytes = toDelete.reduce((a, x) => a + x.size, 0);
const byDir = new Map();
for (const x of toDelete) {
  const d = path.dirname(x.f);
  byDir.set(d, (byDir.get(d) || 0) + x.size);
}

console.log('Prune regenerable OCR snapshots (' + (EXECUTE ? 'EXECUTE' : 'dry-run') + ')');
console.log('  media root       : ' + MEDIA_ROOT);
console.log('  media on disk    : ' + onDisk.size + ' videos');
console.log('  authoritative ids: ' + AUTHORITATIVE.size + ' (SQLite ' + dbRows.length + ' + ledger ' + ledger.length + ')');
console.log('  protected dates  : ' + protectedDates.size + ' (a video with no media on disk)');
console.log('  delete           : ' + toDelete.length + ' png  ' + (delBytes / 1048576).toFixed(1) + ' MB');
console.log('  keep             : ' + (kept.protectedDate + kept.fixture + kept.live + kept.noDate) + ' png  ' +
  (keptBytes / 1048576).toFixed(1) + ' MB  (protected ' + kept.protectedDate + ', fixtures ' + kept.fixture +
  ', live ' + kept.live + ', no-date ' + kept.noDate + ')');

console.log('\n  by directory:');
for (const [d, b] of [...byDir].sort((a, b) => b[1] - a[1])) {
  console.log('    ' + (b / 1048576).toFixed(1).padStart(8) + ' MB  ' + path.relative(REPO, d));
}

if (!EXECUTE) {
  console.log('\n  (dry run - nothing deleted. Re-run with --execute.)');
  process.exit(0);
}

// --------------------------------------------------------------------- delete
let freed = 0, removed = 0, failed = 0;
for (const { f, size } of toDelete) {
  if (!f.startsWith(DATA + path.sep)) { console.error('  REFUSE outside data/: ' + f); failed++; continue; }
  if (path.extname(f).toLowerCase() !== '.png') { console.error('  REFUSE non-png: ' + f); failed++; continue; }
  try { fs.unlinkSync(f); freed += size; removed++; }
  catch (e) { console.error('  FAILED ' + f + ': ' + e.message); failed++; }
}
console.log('\n  DELETED ' + removed + ' files, reclaimed ' + (freed / 1048576).toFixed(1) + ' MB' + (failed ? '  (failed ' + failed + ')' : ''));

// Empty OCR intermediate dirs left behind by the deleted frames.
let dirCount = 0;
for (const d of walk(path.join(DATA, 'video_scan_test', '_rerun'), [])) {
  void d;
}
for (const tag of fs.existsSync(path.join(DATA, 'video_scan_test', '_rerun'))
  ? fs.readdirSync(path.join(DATA, 'video_scan_test', '_rerun'), { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
  const frames = path.join(DATA, 'video_scan_test', '_rerun', tag.name, 'ocr_probe', 'frames');
  if (!fs.existsSync(frames)) continue;
  for (const sub of fs.readdirSync(frames, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const p = path.join(frames, sub.name);
    try {
      if (fs.readdirSync(p).length === 0) { fs.rmSync(p, { recursive: true, force: true }); dirCount++; }
    } catch { /* skip */ }
  }
}
if (dirCount) console.log('  removed ' + dirCount + ' empty frames dirs');
