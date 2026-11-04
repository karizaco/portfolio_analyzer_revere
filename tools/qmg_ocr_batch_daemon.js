'use strict';

/**
 * QMG OCR batch daemon — detach-friendly wrapper around qmg_ocr_batch.js.
 * Exits immediately after spawning the child, so the OS keeps the child alive
 * after the parent process dies (e.g. after a 30-min Claude Code limit).
 *
 * Progress is saved after every video to:
 *   data/video_scan_batch_{BATCH}_results.json
 * Re-running picks up where it left off.
 *
 * Usage (Unix/bash):
 *   node tools/qmg_ocr_batch_daemon.js a
 *   node tools/qmg_ocr_batch_daemon.js b
 */

const fs = require('node:fs');
const path = require('node:path');
const { readExistingJson, superviseChild } = require('./qmg_scan_daemon_support');

const ROOT = path.resolve(__dirname, '..');
const BATCH = process.argv[2] || 'a';
const BATCH_FILE = path.join(ROOT, 'data', `video_scan_batch_${BATCH}.json`);
const RESULTS_FILE = path.join(ROOT, 'data', `video_scan_batch_${BATCH}_results.json`);
const LOG_FILE = path.join(ROOT, 'data', `video_scan_batch_${BATCH}.log`);

const { videos } = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf-8'));
const total = videos.length;

console.log(`Daemon batch ${BATCH}: ${total} videos — PID ${process.pid}`);

// Load prior results to resume
let done = new Set();
let results = [];
const prior = readExistingJson(RESULTS_FILE);
if (prior) {
  results = prior.results || [];
  done = new Set(results.filter((r) => r.status === 'ok').map((r) => r.videoId));
  console.log(`Resuming: ${done.size}/${total} already done`);
}

const remaining = videos.filter((v) => !done.has(v.video_id));
console.log(`Remaining: ${remaining.length} videos`);

// Pipe stdout+stderr to log file
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.write(`\n=== Daemon batch ${BATCH} started at ${new Date().toISOString()} ===\n`);

// Per-video timeout: 5 min (allows EasyOCR to finish even on slower frames)
const TIMEOUT_MS = 600 * 1000;

const SCAN_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg',
  '--output-kind', 'snapshot',
  '--output-root', path.join(ROOT, 'data/video_scan_test/_rerun'),
  '--run-tag', `qmg-batch-${BATCH}`,
  '--max-captures', '1',
  '--fps', '0.25',
  '--prefilter-max-frames', '6',
  '--ocr-engine', 'easyocr',
];

// Filenames are YYYYMMDD_<videoId>.mp4 or NA_<videoId>.mp4.
// Anything after the first '_' is the videoId (which may itself contain '_').
// Search downloads_1080p first, then downloads_hires as fallback.
// Returns just the filename (for scanVideoWithOcr.js to join with VIDEO_DIR).
function findVideoFile(videoId) {
  const dirs = [
    path.join(ROOT, 'data/video_pipeline/downloads_1080p'),
    path.join(ROOT, 'data/video_pipeline/downloads_hires'),
  ];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir);
      const found = files.find((f) => {
        const m = f.match(/^(?:\d{8}|NA)_(.+)\.mp4$/);
        return m && m[1] === videoId;
      });
      if (found) return found;
    } catch (error) {
      // A missing download directory is "not here". Anything else (permissions,
      // a path that is not a directory) is a real failure and must not look
      // like "this video is not on disk".
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

async function runScan(videoId, date) {
  const videoFile = findVideoFile(videoId);
  if (!videoFile) return { videoId, date, status: 'not_found', elapsed: 0 };

  const videoPath = path.join(ROOT, 'data/video_pipeline/downloads_1080p', videoFile);
  const started = Date.now();

  // superviseChild() DRAINS the child's stdout. The scan tool prints its
  // whole result object to stdout at the very end -- hundreds of kilobytes --
  // and a Windows pipe holds about 64 KB. An undrained stdout blocks the
  // child AFTER it has written a complete probe log and BEFORE its `finally`
  // block runs, so the child never exits and this daemon records a timeout
  // for a video that was read successfully. See tools/qmg_scan_daemon_support.js.
  const { status, code, stdoutTail, stderr } = await superviseChild(
    ['node', path.join(ROOT, 'tools/scanVideoWithOcr.js'), '--video', videoPath, '--date', date, ...SCAN_FLAGS],
    process.env,
    { timeoutMs: TIMEOUT_MS }
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (status === 'OK') {
    return { videoId, date, status: 'ok', elapsed: Number(elapsed) };
  }
  if (status === 'TIMEOUT') {
    return { videoId, date, status: 'timeout', elapsed: Number(elapsed) };
  }
  return {
    videoId,
    date,
    status: code === null ? `error_${stderr.slice(0, 80)}` : `exit_${code}`,
    elapsed: Number(elapsed),
    stdoutTail: stdoutTail.slice(-2000),
  };
}

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ batch: BATCH, results }, null, 2));
}

async function main() {
  for (const v of remaining) {
    const { video_id: videoId, date } = v;
    const r = await runScan(videoId, date);
    const icon = r.status === 'ok' ? '✓' : r.status === 'timeout' ? '⏱' : '✗';
    log(`${icon} ${date} ${videoId} — ${r.status} [${r.elapsed}s]`);
    results.push(r);
    saveResults();

    // 500ms stagger to let disk I/O settle between videos
    await new Promise((res) => setTimeout(res, 500));
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const err = results.filter((r) => r.status !== 'ok').length;
  log(`\nBatch ${BATCH.toUpperCase()} COMPLETE: ${ok} ok, ${err} errored of ${total}`);
  logStream.end();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  logStream.end();
  process.exit(1);
});
