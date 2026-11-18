'use strict';

// Run the QMG OCR backlog unattended, in small chunks.
//
// WHY A QUEUE RUNNER
//
// The backlog is large: 254 catalogued dates have media on disk and no OCR
// log. EasyOCR takes 10-18 minutes per video, so that is days of wall clock.
// CLAUDE.md's rule is "chunks of 5-10 videos, never 40 in one shot" -- a
// chunk that hangs must be abortable, and a chunk that fails must not take
// the rest of the queue with it.
//
// So this runner does exactly what the manual runbook does, unattended:
//   1. work out which dates still need a scan (media on disk, no OCR log);
//   2. take the next CHUNK of them;
//   3. run tools/runQmgOcrBatch.js on that chunk and WAIT for it;
//   4. re-derive the remaining list and go again.
//
// Re-deriving after every chunk is what makes it safe to leave running: a
// date that fails is still in the list next time, and a date that succeeds
// has a log and drops out. Nothing is remembered that could go stale.
//
// IT DOES NOT USE THE GROUND TRUTH.
//
// runQmgOcrBatch.js --all-unscanned picks from data/qmg_ground_truth.json --
// the 56 curated benchmark dates. The real backlog is the whole catalog, so
// this runner passes explicit --dates instead.
//
// Usage:
//   node tools/qmgOcrQueueRunner.js --chunk-size 5 --max-chunks 0
//   node tools/qmgOcrQueueRunner.js --dry-run
//
//   --chunk-size N   dates per chunk (default 5)
//   --max-chunks N   stop after N chunks; 0 = run until the queue empties
//   --parallel N     OCR parallelism (default 2; --low-cpu caps it at 2)
//   --run-tag TAG    output run tag (default qmg-ocr-queue-<date>)
//   --dry-run        print the first chunks and exit

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { findMediaForDate } = require('../src/video/mediaRoots');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const DB = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const PROGRESS = path.join(ROOT, 'data', 'qmg_ocr_queue_progress.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const chunkSize = Number(flag('--chunk-size', 5)) || 5;
const maxChunks = Number(flag('--max-chunks', 0)) || 0;
const parallel = Number(flag('--parallel', 2)) || 2;
const dryRun = argv.includes('--dry-run');
// Earliest date worth scanning. The positions panel is first pinned in the
// ground truth on 20220128. 2020 uploads show a Twitter window or a
// watchlist (measured 2026-11-17: 20200428 is a browser tab; 20201109 reads a
// watchlist), and the 2021 docked panel has no measured crop. Scanning them
// costs ~90 min of EasyOCR per video for readings nobody can score.
// Override with --from-date YYYYMMDD once a crop exists for that layout.
const fromDate = String(flag('--from-date', '20220128'));
const timeoutMinutes = flag('--timeout-minutes', null);
const runTag = flag('--run-tag', `qmg-ocr-queue-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);

/**
 * Every catalogued QMG date, with the channel's own upload_date.
 * @returns {string[]}
 */
function catalogDates() {
  const py = process.platform === 'win32' ? 'py' : 'python3';
  const script = `
import json, sqlite3, sys
c = sqlite3.connect(r"${DB.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute("SELECT DISTINCT upload_date FROM videos WHERE channel='qullamaggie' AND upload_date IS NOT NULL AND upload_date != ''").fetchall()
json.dump(sorted({r["upload_date"] for r in rows}), sys.stdout)
`;
  const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[ocrqueue] catalog query failed: ${r.stderr}`);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

/**
 * Dates that already have an OCR log in any run directory.
 * @returns {Set<string>}
 */
function scannedDates() {
  const scanned = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(OUT_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return scanned; }
  for (const d of dirs) {
    const logsDir = path.join(OUT_ROOT, d, 'ocr_probe', 'logs');
    if (!fs.existsSync(logsDir)) continue;
    for (const f of fs.readdirSync(logsDir)) {
      const m = f.match(/^(\d{8})_/);
      if (m) scanned.add(m[1]);
    }
  }
  return scanned;
}

/**
 * The remaining work: media on disk, no OCR log yet.
 * @returns {string[]}
 */
function pendingDates() {
  const scanned = scannedDates();
  const out = [];
  for (const date of catalogDates()) {
    if (date < fromDate) continue;           // before the readable-panel era
    if (scanned.has(date)) continue;
    if (!findMediaForDate(date)) continue;   // no media yet -- nothing to scan
    out.push(date);
  }
  return out;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function readProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); }
  catch { return { chunks_done: 0, dates_done: [], failed: {} }; }
}

function writeProgress(p) {
  try { fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2)); } catch { /* not fatal */ }
}

const pending = pendingDates();
const plan = chunks(pending, chunkSize);

console.log(`[ocrqueue] media-without-a-scan dates: ${pending.length}`);
console.log(`[ocrqueue] chunk size ${chunkSize} -> ${plan.length} chunk(s)`);
console.log(`[ocrqueue] run tag: ${runTag}`);

if (dryRun) {
  for (const c of plan.slice(0, 5)) console.log(`[ocrqueue]   would run: ${c.join(',')}`);
  if (plan.length > 5) console.log(`[ocrqueue]   ... and ${plan.length - 5} more chunks`);
  process.exit(0);
}

const progress = readProgress();
progress.started_at = progress.started_at || new Date().toISOString();
progress.run_tag = runTag;
progress.chunk_size = chunkSize;

for (let i = 0; i < plan.length; i++) {
  if (maxChunks > 0 && progress.chunks_done >= maxChunks) {
    console.log(`[ocrqueue] stopping: reached --max-chunks ${maxChunks}`);
    break;
  }
  const dates = plan[i];
  console.log(`[ocrqueue] chunk ${progress.chunks_done + 1}/${plan.length}: ${dates.join(',')}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    '--dates', dates.join(','),
    '--parallel', String(parallel),
    '--low-cpu',
    '--run-tag', runTag,
    ...(timeoutMinutes ? ['--timeout-minutes', String(timeoutMinutes)] : []),
  ], { encoding: 'utf8', stdio: 'inherit' });
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  // A chunk that dies in seconds did not fail a scan -- the environment is
  // broken (2026-11-17: exit 0xC000026B, DLL init failure, 38 chunks "failed"
  // in 0 s each). Stop instead of burning the queue and recording false failures.
  if (r.status !== 0 && Number(elapsed) < 30) {
    console.log(`[ocrqueue] chunk died in ${elapsed}s (exit ${r.status}) -- environment problem, aborting the queue without recording it as a failure`);
    process.exit(2);
  }
  if (r.status === 0) {
    progress.dates_done = [...new Set([...progress.dates_done, ...dates])];
  } else {
    progress.failed[dates.join(',')] = { exit_code: r.status, at: new Date().toISOString(), elapsed_s: Number(elapsed) };
    console.log(`[ocrqueue] chunk FAILED (exit ${r.status}) in ${elapsed}s -- continuing with the next chunk`);
  }
  progress.chunks_done += 1;
  progress.last_chunk = { dates, exit_code: r.status, elapsed_s: Number(elapsed), at: new Date().toISOString() };
  writeProgress(progress);
}

const remaining = pendingDates();
progress.finished_at = new Date().toISOString();
progress.remaining_dates = remaining.length;
writeProgress(progress);
console.log(`[ocrqueue] chunks done=${progress.chunks_done} remaining dates=${remaining.length}`);
