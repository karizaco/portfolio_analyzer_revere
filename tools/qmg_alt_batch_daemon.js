'use strict';
// QMG Alt Batch Daemon — alternative settings for comparison
// Settings: maxCaptures=3, fps=1, maxFrames=12, short-crop=0.86,0.62,0.14,0.22, minFrequency=3
// Usage: node tools/qmg_alt_batch_daemon.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { checkFreeSpace, lowCpuEnv } = require('./qmg_scan_daemon_support');

const ROOT = path.resolve(__dirname, '..');
const BATCH = process.argv[2] || 'alt';
const BATCH_FILE = path.join(ROOT, 'data', `qmg_alt_batch.json`);
const RESULTS_FILE = path.join(ROOT, 'data', `qmg_alt_batch_results.json`);
const LOG_FILE = path.join(ROOT, 'data', `qmg_alt_batch.log`);

const { videos } = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf-8'));
const total = videos.length;

console.log(`=== Alt batch ${BATCH}: ${total} videos ===`);
console.log('Settings: maxCaptures=2, fps=0.25, maxFrames=6, parallel=2 (vs baseline: 1, 0.25, 6, 4)');

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
console.log(`Remaining: ${remaining.length} videos\n`);

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.write(`\n=== Alt batch ${BATCH} started at ${new Date().toISOString()} ===\n`);

const TIMEOUT_MS = 900 * 1000;

// ALTERNATIVE SETTINGS: baseline-ish but 2 captures instead of 1
// Baseline: --fps 0.25 --max-captures 1 --prefilter-max-frames 6
// Alt:      --fps 0.25 --max-captures 2 --prefilter-max-frames 6  (~2× baseline time)
// LOW-CPU: runs at --parallel 2 (vs daemon default 4)
const SCAN_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg-alt',
  '--output-kind', 'snapshot',
  '--output-root', path.join(ROOT, 'data/video_scan_test/_rerun'),
  '--run-tag', `qmg-alt-${BATCH}`,
  '--max-captures', '2',
  '--fps', '0.25',
  '--prefilter-max-frames', '6',
  '--ocr-engine', 'easyocr',
];

const VIDEO_DIR_1080 = path.join(ROOT, 'data/video_pipeline/downloads_1080p');
const VIDEO_DIR_HIRES = path.join(ROOT, 'data/video_pipeline/downloads_hires');

function findVideoFile(videoId) {
  for (const dir of [VIDEO_DIR_1080, VIDEO_DIR_HIRES]) {
    const files = fs.readdirSync(dir);
    const found = files.find((f) => {
      const m = f.match(/^(?:\d{8}|NA)_(.+)\.mp4$/);
      return m && m[1] === videoId;
    });
    if (found) return path.join(dir, found);
  }
  return null;
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

async function runScan(video) {
  const { video_id, date } = video;
  const file = findVideoFile(video_id);
  if (!file) {
    log(`ERROR ${date} ${video_id} — file not found`);
    return { videoId: video_id, date, status: 'not_found', error: 'file not found' };
  }

  log(`Starting ${date} ${path.basename(file)}`);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn('node', [
      path.join(ROOT, 'tools', 'scanVideoWithOcr.js'),
      '--video', file,
      '--date', date,
      ...SCAN_FLAGS,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: lowCpuEnv() });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      log(`TIMEOUT ${date} ${video_id} — exceeded ${TIMEOUT_MS}ms`);
      resolve({ videoId: video_id, date, status: 'timeout' });
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      if (code === 0) {
        log(`OK ${date} ${video_id} after ${elapsed}s`);
        resolve({ videoId: video_id, date, status: 'ok', elapsed: Number(elapsed) });
      } else {
        log(`ERROR ${date} ${video_id} exit ${code}`);
        resolve({ videoId: video_id, date, status: 'error', error: `exit ${code}`, stderr: stderr.slice(-500) });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`ERROR ${date} ${video_id} ${err.message}`);
      resolve({ videoId: video_id, date, status: 'error', error: err.message });
    });
  });
}

async function main() {
  const PARALLEL = 2; // low-CPU mode: max 2 concurrent scans
  let idx = 0;

  // Fail loudly before burning an hour of OCR on a disk that cannot hold
  // the extracted frames. A mid-run disk-full surfaces as a misleading
  // ffmpeg "No space left on device" io_error on the affected videos.
  checkFreeSpace(path.join(ROOT, 'data/video_scan_test/_rerun'));

  while (idx < remaining.length) {
    const chunk = remaining.slice(idx, idx + PARALLEL);
    const chunkResults = await Promise.all(chunk.map(runScan));

    for (const r of chunkResults) {
      const existing = results.findIndex((x) => x.videoId === r.videoId);
      if (existing >= 0) results[existing] = r;
      else results.push(r);
    }

    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));
    idx += PARALLEL;
    log(`Progress: ${Math.min(idx, remaining.length)}/${remaining.length}`);
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  log(`\n=== Alt batch COMPLETE: ${ok}/${total} ok, ${total - ok} errored of ${total} ===`);
  logStream.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
