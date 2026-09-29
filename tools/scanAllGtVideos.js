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

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

function parseArgs(argv) {
  const args = { parallel: 1, fps: 1, maxCaptures: 3, prefilterMaxFrames: 12, dates: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dates') args.dates = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--fps') args.fps = parseFloat(argv[++i] || '1');
    else if (a === '--max-captures') args.maxCaptures = parseInt(argv[++i] || '3', 10);
    else if (a === '--prefilter-max-frames') args.prefilterMaxFrames = parseInt(argv[++i] || '12', 10);
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
    '--prefilter-max-frames', String(options.prefilterMaxFrames)
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

function parseGT(gtEntry) {
  if (!gtEntry) return [];
  if (Array.isArray(gtEntry)) return gtEntry;
  if (Array.isArray(gtEntry.tickers)) return gtEntry.tickers;
  return [];
}

function loadSummary(runTag, dateKey) {
  const logDir = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
  if (!fs.existsSync(logDir)) return null;
  const files = fs.readdirSync(logDir).filter((f) => f.startsWith(dateKey));
  if (!files.length) return null;
  const logPath = path.join(logDir, files[0]);
  return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
}

function summarizeLog(log, gtList) {
  const captures = log.captures || [];
  const gtSet = new Set((gtList || []).map((t) => String(t).toUpperCase()));
  const allTickers = new Set();
  const correctTickers = new Set();
  let totalFp = 0;
  for (const c of captures) {
    for (const t of c.tickers || []) {
      const up = String(t).toUpperCase();
      allTickers.add(up);
      if (gtSet.has(up)) correctTickers.add(up);
    }
  }
  // FPs = unique tickers NOT in GT
  for (const t of allTickers) {
    if (!gtSet.has(t)) totalFp += 1;
  }
  return {
    captured: captures.length,
    detectedUnique: allTickers.size,
    correctUnique: correctTickers.size,
    totalFp
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
  const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf-8'));
  let dates = Object.keys(gt).filter((k) => !k.startsWith('_') && !k.includes('(batch'));
  if (opts.dates) dates = dates.filter((d) => opts.dates.includes(d));
  console.log(`Re-running scan on ${dates.length} Quullamaggie videos with new chart_stream prefilter`);
  console.log(`Parallelism: ${opts.parallel} workers; fps=${opts.fps}; max-captures=${opts.maxCaptures}; prefilter-max-frames=${opts.prefilterMaxFrames}`);
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
    const gtForVideo = gt[job.date] && gt[job.date][Object.keys(gt[job.date])[0]];
    const gtList = parseGT(gtForVideo);
    const t0 = Date.now();
    const r = await runScan(job.date, job.video, runTag, opts);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status !== 0) {
      console.log(`${job.date}: SCAN FAILED (status=${r.status} timedOut=${r.timedOut}) in ${elapsed}s`);
      return { date: job.date, error: `status=${r.status} timedOut=${r.timedOut}`, elapsed, gtTotal: gtList.length };
    }
    const log = loadSummary(runTag, job.date);
    if (!log) {
      console.log(`${job.date}: NO LOG in ${elapsed}s`);
      return { date: job.date, error: 'no-log', elapsed, gtTotal: gtList.length };
    }
    const sum = summarizeLog(log, gtList);
    const gtTotal = gtList.length;
    console.log(`${job.date}: ${sum.captured} captures, ${sum.correctUnique}/${gtTotal} GT correct (best single capture, deduped), ${sum.totalFp} total FPs [${elapsed}s]`);
    return { date: job.date, gtTotal, ...sum, elapsed };
  });
  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('');
  console.log('=========================================');
  console.log(`SUMMARY (per-video, deduplicated across captures) — total ${totalElapsed}s wall`);
  console.log('=========================================');
  console.log('Date       | GT | Correct | FP | Recall | Wall');
  console.log('-----------|----|---------|----|--------|------');
  let totalCorrect = 0, totalFp = 0, totalGt = 0;
  for (const r of results.filter((x) => !x.error).sort((a, b) => a.date.localeCompare(b.date))) {
    const recall = r.gtTotal ? (r.correctUnique / r.gtTotal * 100).toFixed(0) : '-';
    console.log(
      `${r.date} | ${String(r.gtTotal).padStart(2)} | ${String(r.correctUnique).padStart(7)} | ${String(r.totalFp).padStart(2)} | ${String(recall).padStart(3)}% | ${r.elapsed}s`
    );
    totalCorrect += r.correctUnique;
    totalFp += r.totalFp;
    totalGt += r.gtTotal;
  }
  const errs = results.filter((x) => x.error);
  if (errs.length) {
    console.log('--- errors ---');
    for (const r of errs) console.log(`  ${r.date}: ${r.error} [${r.elapsed}s]`);
  }
  console.log('-----------|----|---------|----|--------');
  console.log(`TOTAL      | ${String(totalGt).padStart(2)} | ${String(totalCorrect).padStart(7)} | ${String(totalFp).padStart(2)} | ${totalGt ? (totalCorrect / totalGt * 100).toFixed(0) : '-'}%`);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
