'use strict';

// Run the chart-stream scan on every Quullamaggie video that has
// ground-truth annotations in data/qmg_ground_truth.json. Each video's
// output is written to a unique run-tag directory under
// data/video_scan_test/_rerun/<runTag>/.
//
// Outputs:
//   - OCR probe logs (per-video scan JSON)
//   - This script aggregates the per-video results and prints a summary
//     of recall / FP rate before and after.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getGroundTruthForCapture,
  getGroundTruthMode,
  loadQmgGroundTruth,
} = require('../src/qmg/qmgGroundTruth');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

function parseArgs(argv) {
  const args = {
    parallel: 1,
    fps: 0.25,
    maxCaptures: 1,
    prefilterMaxFrames: 12,
    dates: null,
    modes: null,
    ocrEngine: 'easyocr',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dates') args.dates = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--modes') args.modes = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--fps') args.fps = parseFloat(argv[++i] || '1');
    else if (a === '--max-captures') args.maxCaptures = parseInt(argv[++i] || '3', 10);
    else if (a === '--prefilter-max-frames') args.prefilterMaxFrames = parseInt(argv[++i] || '12', 10);
    else if (a === '--ocr-engine') args.ocrEngine = String(argv[++i] || 'easyocr').trim().toLowerCase();
  }
  if (!['tesseract', 'easyocr'].includes(args.ocrEngine)) {
    throw new Error(`Unsupported --ocr-engine ${args.ocrEngine}. Use tesseract or easyocr.`);
  }
  return args;
}

function findVideo(dateKey) {
  const files = fs.readdirSync(VIDEO_DIR);
  return files.find((f) => f.startsWith(dateKey));
}

function runScan(dateKey, videoFile, runTag, options) {
  const cmd = [
    'node',
    path.join(ROOT, 'tools', 'scanVideoWithOcr.js'),
    '--video', path.join(VIDEO_DIR, videoFile),
    '--date', dateKey,
    '--prefilter-profile', 'chart_stream',
    '--chart-stream-parser',
    '--basename', 'qmg',
    '--output-kind', 'snapshot',
    '--output-root', OUT_ROOT,
    '--run-tag', runTag,
    '--max-captures', String(options.maxCaptures),
    '--fps', String(options.fps),
    '--prefilter-max-frames', String(options.prefilterMaxFrames),
    '--ocr-engine', String(options.ocrEngine),
  ];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ stdout, stderr, status: -1, timedOut: true });
    }, 300 * 1000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr, status: code, timedOut: false });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr: stderr + (err.message || ''), status: -1, timedOut: false });
    });
  });
}

function loadSummary(runTag, dateKey) {
  const logDir = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
  if (!fs.existsSync(logDir)) return null;
  const files = fs.readdirSync(logDir).filter((f) => f.startsWith(dateKey));
  if (!files.length) return null;
  const logPath = path.join(logDir, files[0]);
  return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
}

function summarizeLog(log, gt, dateKey) {
  const captures = log.captures || [];
  const perCapture = captures.map((capture, captureIndex) => {
    const gtCapture = getGroundTruthForCapture(gt, dateKey, captureIndex);
    const gtTickers = gtCapture.tickers.map((ticker) => String(ticker).toUpperCase());
    const gtSet = new Set(gtTickers);
    const detected = Array.isArray(capture.tickers) ? capture.tickers.map((ticker) => String(ticker).toUpperCase()) : [];
    const hitCount = gtTickers.filter((ticker) => detected.includes(ticker)).length;
    const fpCount = detected.filter((ticker) => !gtSet.has(ticker)).length;
    return {
      captureIndex,
      fpCount,
      gtCount: gtTickers.length,
      hitCount,
      recall: gtTickers.length ? hitCount / gtTickers.length : 0,
    };
  });
  const captureRecalls = perCapture.map((capture) => capture.recall);
  const captureFps = perCapture.map((capture) => capture.fpCount);
  return {
    captured: captures.length,
    meanFp: captureFps.length ? captureFps.reduce((sum, value) => sum + value, 0) / captureFps.length : 0,
    meanRecall: captureRecalls.length ? captureRecalls.reduce((sum, value) => sum + value, 0) / captureRecalls.length : 0,
    mode: getGroundTruthMode(dateKey),
    perCapture,
  };
}

// Tiny semaphore-based worker pool. Caps concurrency at `limit` even
// when the input array is much longer.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function pump() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const pumps = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) pumps.push(pump());
  await Promise.all(pumps);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gt = loadQmgGroundTruth(path.join(ROOT, 'data', 'qmg_ground_truth.json'));
  let dates = Object.keys(gt).filter((k) => !k.startsWith('_') && !k.includes('(batch'));
  if (opts.dates) dates = dates.filter((d) => opts.dates.includes(d));
  if (opts.modes) dates = dates.filter((d) => opts.modes.includes(getGroundTruthMode(d)));
  console.log(`Re-running scan on ${dates.length} Quullamaggie videos with new chart_stream prefilter`);
  console.log(`Parallelism: ${opts.parallel} workers; fps=${opts.fps}; max-captures=${opts.maxCaptures}; prefilter-max-frames=${opts.prefilterMaxFrames}; ocr-engine=${opts.ocrEngine}`);
  console.log(`Output: ${OUT_ROOT}`);
  console.log('');

  const jobs = [];
  for (const d of dates) {
    const video = findVideo(d);
    if (!video) {
      console.log(`${d}: VIDEO NOT FOUND — skipping`);
      continue;
    }
    jobs.push({ date: d, video });
  }

  const startedAt = Date.now();
  const results = await runWithConcurrency(jobs, opts.parallel, async (job) => {
    const runTag = `rerun_${job.date}`;
    const t0 = Date.now();
    const r = await runScan(job.date, job.video, runTag, opts);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status !== 0) {
      console.log(`${job.date}: SCAN FAILED (status=${r.status} timedOut=${r.timedOut}) in ${elapsed}s`);
      return { date: job.date, error: `status=${r.status} timedOut=${r.timedOut}`, elapsed };
    }
    const log = loadSummary(runTag, job.date);
    if (!log) {
      console.log(`${job.date}: NO LOG in ${elapsed}s`);
      return { date: job.date, error: 'no-log', elapsed };
    }
    const sum = summarizeLog(log, gt, job.date);
    const gtTotals = sum.perCapture.reduce((acc, capture) => acc + capture.gtCount, 0);
    const gtHits = sum.perCapture.reduce((acc, capture) => acc + capture.hitCount, 0);
    console.log(
      `${job.date} (${sum.mode}): ${sum.captured} captures, `
      + `mean recall ${(sum.meanRecall * 100).toFixed(0)}%, mean FP ${sum.meanFp.toFixed(1)} `
      + `[${gtHits}/${gtTotals} GT hits across aligned captures, ${elapsed}s]`
    );
    return { date: job.date, gtHits, gtTotals, ...sum, elapsed };
  });
  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('');
  console.log('=========================================');
  console.log(`SUMMARY (per-video, aligned per-capture GT) — total ${totalElapsed}s wall`);
  console.log('=========================================');
  console.log('Date       | Mode         | GT | Hits | Mean FP | Mean Recall | Wall');
  console.log('-----------|--------------|----|------|---------|-------------|------');
  let totalHits = 0, totalGt = 0, totalMeanFp = 0, totalMeanRecall = 0, totalVideos = 0;
  for (const r of results.filter((x) => !x.error).sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(
      `${r.date} | ${r.mode.padEnd(12)} | ${String(r.gtTotals).padStart(2)} | ${String(r.gtHits).padStart(4)} | `
      + `${r.meanFp.toFixed(1).padStart(7)} | ${(r.meanRecall * 100).toFixed(1).padStart(10)}% | ${r.elapsed}s`
    );
    totalHits += r.gtHits;
    totalGt += r.gtTotals;
    totalMeanFp += r.meanFp;
    totalMeanRecall += r.meanRecall;
    totalVideos += 1;
  }
  const errs = results.filter((x) => x.error);
  if (errs.length) {
    console.log('--- errors ---');
    for (const r of errs) console.log(`  ${r.date}: ${r.error} [${r.elapsed}s]`);
  }
  console.log('-----------|--------------|----|------|---------|-------------');
  console.log(
    `TOTAL      | ${''.padEnd(12)} | ${String(totalGt).padStart(2)} | ${String(totalHits).padStart(4)} | `
    + `${(totalVideos ? totalMeanFp / totalVideos : 0).toFixed(1).padStart(7)} | `
    + `${(totalGt ? (totalHits / totalGt * 100) : 0).toFixed(1).padStart(10)}%`
  );

  const byMode = new Map();
  for (const r of results.filter((x) => !x.error)) {
    if (!byMode.has(r.mode)) byMode.set(r.mode, []);
    byMode.get(r.mode).push(r);
  }
  if (byMode.size) {
    console.log('');
    console.log('MODE SUMMARY');
    console.log('Mode         | Videos | Mean FP | Mean Recall');
    console.log('-------------|--------|---------|------------');
    for (const [mode, modeRows] of [...byMode.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const meanFp = modeRows.reduce((sum, row) => sum + row.meanFp, 0) / modeRows.length;
      const meanRecall = modeRows.reduce((sum, row) => sum + row.meanRecall, 0) / modeRows.length;
      console.log(
        `${mode.padEnd(12)} | ${String(modeRows.length).padStart(6)} | `
        + `${meanFp.toFixed(1).padStart(7)} | ${(meanRecall * 100).toFixed(1).padStart(10)}%`
      );
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
