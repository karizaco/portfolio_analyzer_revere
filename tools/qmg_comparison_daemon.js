'use strict';
// QMG Comparison Daemon — runs same 10 videos with baseline (maxCaptures=1) vs alt (maxCaptures=2)
// Then compares merged_position_list output
// Usage: node tools/qmg_comparison_daemon.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BATCH_FILE = path.join(ROOT, 'data', 'qmg_comparison_batch.json');
const RESULTS_FILE = path.join(ROOT, 'data', 'qmg_comparison_results.json');
const LOG_FILE = path.join(ROOT, 'data', 'qmg_comparison.log');

const { videos } = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));
const total = videos.length;

const TIMEOUT_MS = 900 * 1000;

const BASELINE_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg-base',
  '--output-kind', 'snapshot',
  '--output-root', path.join(ROOT, 'data/video_scan_test/_rerun'),
  '--run-tag', 'qmg-compare-base',
  '--max-captures', '1',
  '--fps', '0.25',
  '--prefilter-max-frames', '6',
  '--ocr-engine', 'easyocr',
];

const ALT_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg-alt2',
  '--output-kind', 'snapshot',
  '--output-root', path.join(ROOT, 'data/video_scan_test/_rerun'),
  '--run-tag', 'qmg-compare-alt2',
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

async function runScan(video, flags, label) {
  const { video_id, date } = video;
  const file = findVideoFile(video_id);
  if (!file) {
    console.log(`[${label}] ERROR ${date} ${video_id} — file not found`);
    return { videoId: video_id, date, status: 'not_found' };
  }

  console.log(`[${label}] Starting ${date} ${path.basename(file)}`);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'tools', 'scanVideoWithOcr.js'), '--video', file, '--date', date, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      console.log(`[${label}] TIMEOUT ${date} ${video_id}`);
      resolve({ videoId: video_id, date, status: 'timeout', label });
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      if (code === 0) {
        console.log(`[${label}] OK ${date} ${video_id} after ${elapsed}s`);
        resolve({ videoId: video_id, date, status: 'ok', elapsed: Number(elapsed), label });
      } else {
        console.log(`[${label}] ERROR ${date} ${video_id} exit ${code}`);
        resolve({ videoId: video_id, date, status: 'error', label, error: `exit ${code}`, stderr: stderr.slice(-200) });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.log(`[${label}] SPAWN ERR ${date} ${video_id} ${err.message}`);
      resolve({ videoId: video_id, date, status: 'error', label, error: err.message });
    });
  });
}

async function getMergedList(logPath) {
  try {
    const d = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return d.merged_position_list || [];
  } catch {
    return null;
  }
}

async function main() {
  console.log(`=== QMG Comparison: ${total} videos ===\n`);
  const results = { baseline: [], alt: [], comparison: [] };

  // Run baseline (2 at a time — low CPU)
  console.log('\n--- BASELINE (maxCaptures=1) ---');
  for (let i = 0; i < videos.length; i += 2) {
    const chunk = videos.slice(i, i + 2);
    const r = await Promise.all(chunk.map(v => runScan(v, BASELINE_FLAGS, 'BASE')));
    results.baseline.push(...r);
  }

  // Run alt (2 at a time)
  console.log('\n--- ALT (maxCaptures=2) ---');
  for (let i = 0; i < videos.length; i += 2) {
    const chunk = videos.slice(i, i + 2);
    const r = await Promise.all(chunk.map(v => runScan(v, ALT_FLAGS, 'ALT2')));
    results.alt.push(...r);
  }

  // Compare
  console.log('\n--- COMPARISON ---');
  for (const video of videos) {
    const baseResult = results.baseline.find(r => r.videoId === video.video_id);
    const altResult = results.alt.find(r => r.videoId === video.video_id);
    const baseOk = baseResult && baseResult.status === 'ok';
    const altOk = altResult && altResult.status === 'ok';

    let baseList = [], altList = [];
    if (baseOk) {
      const logFile = `data/video_scan_test/_rerun/qmg-compare-base/ocr_probe/logs/${video.date}_${video.date}_${video.video_id.toLowerCase()}_*_snapshot.json`;
      // find the log file
      const logs = fs.readdirSync('data/video_scan_test/_rerun/qmg-compare-base/ocr_probe/logs/').filter(f => f.startsWith(video.date + '_'));
      if (logs.length > 0) baseList = await getMergedList(`data/video_scan_test/_rerun/qmg-compare-base/ocr_probe/logs/${logs[0]}`);
    }
    if (altOk) {
      const logs = fs.readdirSync('data/video_scan_test/_rerun/qmg-compare-alt2/ocr_probe/logs/').filter(f => f.startsWith(video.date + '_'));
      if (logs.length > 0) altList = await getMergedList(`data/video_scan_test/_rerun/qmg-compare-alt2/ocr_probe/logs/${logs[0]}`);
    }

    const overlap = baseList.filter(t => altList.includes(t));
    const onlyBase = baseList.filter(t => !altList.includes(t));
    const onlyAlt = altList.filter(t => !baseList.includes(t));

    results.comparison.push({
      date: video.date,
      videoId: video.video_id,
      baseStatus: baseResult ? baseResult.status : 'not_run',
      altStatus: altResult ? altResult.status : 'not_run',
      baseList,
      altList,
      overlap,
      onlyBase,
      onlyAlt,
      baseCount: baseList.length,
      altCount: altList.length,
    });

    console.log(`${video.date}: BASE=${baseList.length} ALT=${altList.length} OVERLAP=${overlap.length} BASE-only=${onlyBase.length} ALT-only=${onlyAlt.length}`);
    if (onlyAlt.length > 0) console.log(`  ALT-only: ${onlyAlt.join(', ')}`);
    if (onlyBase.length > 0) console.log(`  BASE-only: ${onlyBase.join(', ')}`);
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${RESULTS_FILE}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
