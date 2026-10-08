'use strict';

/**
 * QMG OCR batch scanner — runs scanVideoWithOcr.js over a list of videos
 * defined in data/video_scan_batch_{a,b}.json.
 *
 * Usage:
 *   node tools/qmg_ocr_batch.js a    # Agent A — 57 videos
 *   node tools/qmg_ocr_batch.js b    # Agent B — 108 videos
 *
 * Output goes to data/video_scan_test/_rerun/qmg-batch-{a,b}/
 */

const fs = require('node:fs');
const path = require('path:posix');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

const BATCH = process.argv[2] || 'a';
const BATCH_FILE = path.join(ROOT, 'data', `video_scan_batch_${BATCH}.json`);
const RUN_TAG = `qmg-batch-${BATCH}`;

const { videos } = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf-8'));
console.log(`Batch ${BATCH.toUpperCase()}: ${videos.length} videos to scan`);

// Standard flags (tuned for speed + safety)
const SCAN_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg',
  '--output-kind', 'snapshot',
  '--output-root', OUT_ROOT,
  '--run-tag', RUN_TAG,
  '--max-captures', '1',
  '--fps', '0.25',
  '--prefilter-max-frames', '6',
  '--ocr-engine', 'easyocr',
];

// Per-video timeout: 5 min (covers ~60s EasyOCR/frame × up to 4 frames in worst case)
const TIMEOUT_MS = 5 * 60 * 1000;

function findVideoFile(videoId) {
  const files = fs.readdirSync(VIDEO_DIR);
  return files.find((f) => {
    const m = f.match(/^([\w-]+)_([\w-]+)\.mp4$/);
    return m && m[2] === videoId;
  });
}

async function runScan(videoId, date) {
  const videoFile = findVideoFile(videoId);
  if (!videoFile) return { videoId, date, status: 'not_found', elapsed: 0 };

  const videoPath = path.join(VIDEO_DIR, videoFile);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn('node', [
      path.join(ROOT, 'tools', 'scanVideoWithOcr.js'),
      '--video', videoPath,
      '--date', date,
      ...SCAN_FLAGS,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
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

async function main() {
  const results = [];
  for (const v of videos) {
    const { video_id: videoId, date } = v;
    const r = await runScan(videoId, date);
    const icon = r.status === 'ok' ? '✓' : r.status === 'timeout' ? '⏱' : '✗';
    console.log(`${icon} ${date} ${videoId} — ${r.status} [${r.elapsed}s]`);
    results.push(r);

    // Small stagger to avoid hammering the disk I/O with concurrent ffmpegs
    await new Promise((res) => setTimeout(res, 500));
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const err = results.filter((r) => r.status !== 'ok').length;
  console.log(`\nBatch ${BATCH.toUpperCase()} done: ${ok} ok, ${err} errored`);

  if (err > 0) {
    console.log('Errored:');
    for (const r of results.filter((r) => r.status !== 'ok')) {
      console.log(`  ${r.date} ${r.videoId}: ${r.status}`);
    }
  }

  fs.writeFileSync(
    path.join(ROOT, 'data', `video_scan_batch_${BATCH}_results.json`),
    JSON.stringify({ batch: BATCH, results }, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
