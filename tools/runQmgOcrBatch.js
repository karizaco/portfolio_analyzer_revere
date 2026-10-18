'use strict';

/**
 * QMG EasyOCR batch runner.
 *
 * Runs scanVideoWithOcr.js on QMG videos with EasyOCR engine, designed for
 * the 22+ unscanned/poorly-scanned QMG dates. Uses a worker pool with
 * configurable parallelism. Each video gets a generous timeout since
 * EasyOCR takes ~60-90s/frame.
 *
 * Usage:
 *   node tools/runQmgOcrBatch.js --dates 20220218,20220318,20220321,20220323,20220330 --parallel 4
 *   node tools/runQmgOcrBatch.js --chunk 1 --parallel 4
 *   node tools/runQmgOcrBatch.js --all-unscanned --parallel 4
 */

const fs = require('node:fs');
const path = require('path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR_1080 = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const VIDEO_DIR_HIRES = path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

// Per-video timeout: EasyOCR at ~60-90s/frame × 6 frames = 360-540s; give 40 min for longer videos
const PER_VIDEO_TIMEOUT_MS = 40 * 60 * 1000;

const DEFAULT_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg',
  '--output-kind', 'snapshot',
  '--ocr-engine', 'easyocr',
  '--fps', '0.25',
  '--prefilter-max-frames', '12',
  '--max-captures', '3',
  '--batch-snapshots',
  '--batch-count', '8',
  '--batch-window', '4',
  '--temporal-decay', '0',   // Disable temporal boost — was causing intro cards at ts=2 to beat position-list frames at ts=158
];

// 2023-era videos use a wider position-list table that overflows the default crop
// (x=0.86, w=0.14). The ticker column starts further left, so we widen the crop
// to capture the full table. Dates confirmed to need wide crop: 20230518, 20230522,
// 20230523, 20230602, 20230605, 20230608, 20230609. Additional nearby dates are
// included based on layout era (mid-2023 onward). See qmg_ground_truth.json _meta.
const WIDE_CROP_DATES = new Set([
  '20230518', '20230521', '20230522', '20230523', '20230524',
  '20230525', '20230526', '20230527', '20230531',
  '20230601', '20230602', '20230605', '20230606', '20230607',
  '20230608', '20230609', '20230613', '20230614',
  '20230615', '20230616', '20230620', '20230621', '20230622',
  '20230623', '20230626', '20230627', '20230628', '20230629', '20230630',
]);

function getFlagsForDate(dateKey) {
  const extraFlags = [];
  if (WIDE_CROP_DATES.has(dateKey)) {
    extraFlags.push('--phash-region-fraction', '0.83,0.55,0.17,0.45');
  }
  return extraFlags;
}

function parseArgs(argv) {
  const args = {
    parallel: 1,
    dates: null,
    chunk: null,
    allUnscanned: false,
    dryRun: false,
    lowCpu: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--dates') args.dates = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--chunk') args.chunk = parseInt(argv[++i] || '1', 10);
    else if (a === '--all-unscanned') args.allUnscanned = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--low-cpu') args.lowCpu = true;
  }
  return args;
}

function findVideo(dateKey) {
  // Prefer 1080p
  const files1080 = fs.readdirSync(VIDEO_DIR_1080);
  const match1080 = files1080.find(f => f.startsWith(dateKey + '_') && f.endsWith('.mp4'));
  if (match1080) return { file: match1080, dir: VIDEO_DIR_1080, resolution: '1080p' };

  const filesHires = fs.readdirSync(VIDEO_DIR_HIRES);
  const matchHires = filesHires.find(f => f.startsWith(dateKey + '_') && f.endsWith('.mp4'));
  if (matchHires) return { file: matchHires, dir: VIDEO_DIR_HIRES, resolution: '720p' };

  return null;
}

function loadGT() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
}

function getUnscannedDates(gt) {
  // Dates that have files on disk but no EasyOCR scan
  const scanDirs = [];
  try {
    walkDir(OUT_ROOT, scanDirs);
  } catch {}

  const scanned = new Set();
  for (const dir of scanDirs) {
    const logsDir = path.join(dir, 'ocr_probe', 'logs');
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) {
        if (f.endsWith('.json')) {
          const m = f.match(/^(\d{8})_/);
          if (m) scanned.add(m[1]);
        }
      }
    }
  }

  return Object.keys(gt)
    .filter(k => !k.startsWith('_') && !scanned.has(k))
    .filter(k => findVideo(k) !== null)
    .sort();
}

function walkDir(dir, out) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkDir(path.join(dir, e.name), out);
      else if (e.name.endsWith('.json') && e.name.includes('_snapshot.json')) {
        out.push(path.dirname(path.join(dir, e.name)));
      }
    }
  } catch {}
}

function scoreResult(log, gtEntry) {
  const gtSet = new Set(Object.values(gtEntry).flat());
  const merged = new Set(log.merged_position_list || []);
  const hit = [...merged].filter(t => gtSet.has(t));
  const miss = [...gtSet].filter(t => !merged.has(t));
  const fp = [...merged].filter(t => !gtSet.has(t));
  return {
    recall: hit.length + '/' + gtSet.size,
    recallPct: Math.round(100 * hit.length / gtSet.size),
    hit: hit.length,
    miss: miss.length,
    fp: fp.length,
    hitTickers: hit,
    missTickers: miss,
    fpTickers: fp,
  };
}

async function runScan(dateKey, video, runTag, extraFlags = []) {
  const videoPath = path.join(video.dir, video.file);
  const env = {
    ...process.env,
    KMP_DUPLICATE_LIB_OK: 'TRUE',
    OMP_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
  };

  const cmd = [
    'node',
    path.join(ROOT, 'tools', 'scanVideoWithOcr.js'),
    '--video', videoPath,
    '--date', dateKey,
    '--output-root', OUT_ROOT,
    '--run-tag', runTag,
    ...DEFAULT_FLAGS,
    ...extraFlags,
  ];

  return new Promise((resolve) => {
    console.log(`[${dateKey}] Starting ${video.file} (${video.resolution})`);
    const start = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let killed = false;
    const killTimer = setTimeout(() => {
      console.log(`[${dateKey}] TIMEOUT after ${PER_VIDEO_TIMEOUT_MS/1000}s — killing`);
      killed = true;
      // On Windows, kill process tree
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
      child.kill('SIGTERM');
    }, PER_VIDEO_TIMEOUT_MS);

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const status = killed ? 'TIMEOUT' : code === 0 ? 'OK' : 'ERROR';

      if (killed || code !== 0) {
        console.log(`[${dateKey}] ${status} after ${elapsed}s (code=${code})`);
        resolve({ dateKey, status, elapsed: parseInt(elapsed), error: stderr.slice(0, 200) });
        return;
      }

      // Read result
      const logFile = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
      let log = null;
      try {
        const files = fs.readdirSync(logFile).filter(f => f.startsWith(dateKey + '_'));
        if (files.length) {
          log = JSON.parse(fs.readFileSync(path.join(logFile, files[0]), 'utf8'));
        }
      } catch {}

      console.log(`[${dateKey}] OK after ${elapsed}s | captures=${log?.captured_count || '?'}`);
      resolve({ dateKey, status: 'OK', elapsed: parseInt(elapsed), log });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      console.log(`[${dateKey}] SPAWN ERROR: ${err.message}`);
      resolve({ dateKey, status: 'ERROR', error: err.message });
    });
  });
}

// Semaphore-based worker pool
async function runPool(jobs, limit, mkJob) {
  const results = [];
  let cursor = 0;
  async function pump() {
    while (cursor < jobs.length) {
      const idx = cursor++;
      if (idx >= jobs.length) break;
      results[idx] = await mkJob(jobs[idx], idx);
    }
  }
  const pumps = [];
  for (let i = 0; i < Math.min(limit, jobs.length); i++) pumps.push(pump());
  await Promise.all(pumps);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gt = loadGT();

  // Build date list
  let dates;
  if (args.dates) {
    dates = args.dates;
  } else if (args.allUnscanned) {
    dates = getUnscannedDates(gt);
  } else if (args.chunk) {
    const unscanned = getUnscannedDates(gt);
    const chunkSize = 5;
    const start = (args.chunk - 1) * chunkSize;
    dates = unscanned.slice(start, start + chunkSize);
  } else {
    console.error('Usage: node runQmgOcrBatch.js --dates d1,d2 [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --all-unscanned [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --chunk N [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --low-cpu --chunk N [--parallel N]');
    process.exit(1);
  }

  // Cap parallelism when --low-cpu is set (single-threaded EasyOCR can't benefit from more)
  const parallel = args.lowCpu
    ? Math.min(args.parallel, 2)
    : args.parallel;

  const runTag = `qmg-easyocr-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  console.log(`\n=== QMG EasyOCR Batch ===`);
  console.log(`Run tag: ${runTag}`);
  console.log(`Dates: ${dates.join(', ')}`);
  console.log(`Parallelism: ${parallel}${args.lowCpu ? ' (low-cpu mode)' : ''}`);
  console.log(`Output: ${OUT_ROOT}/${runTag}/\n`);

  if (args.dryRun) {
    for (const d of dates) {
      const v = findVideo(d);
      console.log(`  ${d}: ${v ? v.file + ' (' + v.resolution + ')' : 'NOT FOUND'}`);
    }
    return;
  }

  // Ensure output dir exists
  fs.mkdirSync(path.join(OUT_ROOT, runTag), { recursive: true });

  const jobs = dates.map(d => ({ date: d, video: findVideo(d) }))
    .filter(j => j.video !== null);

  const results = await runPool(jobs, parallel, async ({ date, video }, idx) => {
    return runScan(date, video, runTag, getFlagsForDate(date));
  });

  // Report
  console.log(`\n=== Results ===`);
  let totalHit = 0, totalGt = 0, totalFp = 0;
  for (const r of results) {
    if (r.status !== 'OK' || !r.log) {
      console.log(`  ${r.date}: ${r.status}`);
      continue;
    }
    const gtEntry = gt[r.date];
    if (!gtEntry) continue;
    const s = scoreResult(r.log, gtEntry);
    totalHit += s.hit;
    totalGt += s.hit + s.miss;
    totalFp += s.fp;
    console.log(`  ${r.date}: recall=${s.recall} (${s.recallPct}%) | FP=${s.fpTickers.join(',') || 'none'} | time=${r.elapsed}s`);
  }
  console.log(`\nOverall: ${totalHit}/${totalGt} = ${Math.round(100*totalHit/totalGt)}% recall, ${totalFp} FPs`);
}

main().catch(e => { console.error(e); process.exit(1); });
