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

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
if (fs.existsSync(RESULTS_FILE)) {
  try {
    const prior = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    results = prior.results || [];
    done = new Set(results.filter((r) => r.status === 'ok').map((r) => r.videoId));
    console.log(`Resuming: ${done.size}/${total} already done`);
  } catch (_) {}
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
    } catch (_) {}
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

  return new Promise((resolve) => {
    const child = spawn('node', [
      path.join(ROOT, 'tools/scanVideoWithOcr.js'),
      '--video', videoPath,
      '--date', date,
      ...SCAN_FLAGS,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ videoId, date, status: 'timeout', elapsed: (Date.now() - started) / 1000 });
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (code !== 0) {
        resolve({ videoId, date, status: `exit_${code}`, elapsed: Number(elapsed) });
      } else {
        resolve({ videoId, date, status: 'ok', elapsed: Number(elapsed) });
      }
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ videoId, date, status: `error_${err.message}`, elapsed: (Date.now() - started) / 1000 });
    });
  });
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
