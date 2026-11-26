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
const { mediaVideoId } = require('./mediaVideoId.js');

function readFlag(flag, argv = process.argv.slice(2)) {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] || '');
}

const ROOT = path.resolve(__dirname, '..');
// The media lives OUTSIDE the git working tree since the 2026-10-21 loss —
// see CLAUDE.md. The old in-tree paths are kept only as a fallback so this
// runner still works on a machine that has never been cleaned out.
const MEDIA_ROOT = readFlag('--media-root')
  || 'C:/Users/Admin/Projects/portfolio_analyzer_revere_media';
const VIDEO_DIR_1080 = path.join(MEDIA_ROOT, 'downloads_1080p');
const VIDEO_DIR_720 = path.join(MEDIA_ROOT, 'downloads_720p');
const VIDEO_DIR_HIRES = path.join(MEDIA_ROOT, 'downloads_720p');
const OUT_ROOT = readFlag('--output-root') || path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const RUN_TAG = readFlag('--run-tag');

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
  '--temporal-decay', '1800', // Boost early frames — verified better on 20220218 (6/10 vs 4/7)
];

/**
 * Flags for one scan.
 *
 * `--batch-snapshots` overrides `--max-captures`: it OCRs exactly
 * `--batch-count` frames around the best prefilter timestamp, so the OCR
 * frame count per video is `--batch-count`, not `--max-captures`. At ~60 s
 * per EasyOCR frame that is the knob that decides how many videos an hour.
 */
function flagsForScan(opts) {
  const flags = DEFAULT_FLAGS.slice();
  const set = (flag, value) => {
    const i = flags.indexOf(flag);
    if (i === -1) { flags.push(flag, String(value)); return; }
    flags[i + 1] = String(value);
  };
  if (opts.batchCount != null) set('--batch-count', opts.batchCount);
  if (opts.batchWindow != null) set('--batch-window', opts.batchWindow);
  if (opts.fps != null) set('--fps', opts.fps);
  if (opts.prefilterMaxFrames != null) set('--prefilter-max-frames', opts.prefilterMaxFrames);
  return flags;
}

// The position-list overlay layout drifts left over time, so the default crop
// (x=0.86, w=0.14) stops covering the ticker column. Measured on the frames
// themselves, the ticker column sits at:
//
//   2022-era          frame x ~= 0.90 - 0.93   -> default crop is fine
//   mid-2023          frame x ~= 0.846          -> needs x=0.83
//   Dec-2023          frame x ~= 0.827 - 0.839  -> needs x=0.80
//
// A crop that starts to the left of the ticker column also pulls in chart
// area, which is where the false positives come from — hence the narrowest
// crop that still covers the column.
//
// See also qmg_ground_truth.json _meta: "20230518+ videos use wider table
// layout — default crop (0.86,0.14) may cut off left edge".
const CROP_2022 = null;                       // default crop
const CROP_2023_MID = '0.83,0.55,0.17,0.45';  // May 2023 - Nov 2023
const CROP_2023_LATE = '0.80,0.60,0.20,0.26'; // Dec 2023 onward

/** The crop fraction to use for a date-key, or null for the default. */
function cropForDate(dateKey) {
  if (dateKey >= '20231201') return CROP_2023_LATE;
  if (dateKey >= '20230501') return CROP_2023_MID;
  return CROP_2022;
}

// 2022-era (pre-mid-2023): position lists appear early in the stream (ts=40-390).
// 2023-era (mid-2023+): position lists appear later (ts=1940-5627).
// Use --temporal-decay 1800 for 2022-era (boost early frames) and
// --temporal-decay 0 for 2023-era (no bias, let prefilter score decide).
function getFlagsForDate(dateKey) {
  const extraFlags = [];
  const crop = cropForDate(dateKey);
  if (crop) {
    extraFlags.push('--phash-region-fraction', crop);
    extraFlags.push('--temporal-decay', '0'); // 2023-era: position list appears late
  }
  // 2022-era gets the default --temporal-decay 1800 from DEFAULT_FLAGS
  return extraFlags;
}

function parseArgs(argv) {
  const args = {
    parallel: 1,
    dates: null,
    videos: null,
    chunk: null,
    allUnscanned: false,
    dryRun: false,
    lowCpu: false,
    batchCount: null,
    batchWindow: null,
    fps: null,
    prefilterMaxFrames: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--dates') args.dates = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--videos') args.videos = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--chunk') args.chunk = parseInt(argv[++i] || '1', 10);
    else if (a === '--all-unscanned') args.allUnscanned = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--low-cpu') args.lowCpu = true;
    else if (a === '--batch-count') args.batchCount = parseInt(argv[++i] || '8', 10);
    else if (a === '--batch-window') args.batchWindow = parseInt(argv[++i] || '4', 10);
    else if (a === '--fps') args.fps = argv[++i];
    else if (a === '--prefilter-max-frames') args.prefilterMaxFrames = parseInt(argv[++i] || '12', 10);
  }
  return args;
}

/**
 * Map a date-key to the video file on disk.
 *
 * The re-downloaded files are named `<date>_<id>.mp4` only when the date was
 * known at download time; most are bare `<id>.mp4`. `data/qmg_video_recovery_manifest.json`
 * records the date for every one of the 718 videos, so use it to resolve the
 * bare names. Falls back to the date-prefixed filename.
 */
const manifest = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'qmg_video_recovery_manifest.json'), 'utf8')
    ).videos || [];
  } catch (_) {
    return [];
  }
})();

const byDate = new Map();
for (const v of manifest) {
  if (!v.date || v.channel !== 'qullamaggie') continue;
  if (!byDate.has(v.date)) byDate.set(v.date, []);
  byDate.get(v.date).push(v.video_id);
}

// Videos with no date on file get one interpolated from the playlist order
// (tools/qmgVideoDates.js). That covers the majority of the channel, which
// is what makes it possible to OCR videos that have no ground truth.
const DATE_FILE = readFlag('--date-file')
  || 'data/qmg_video_dates.json';
let dateOf = new Map();   // video_id -> YYYYMMDD
try {
  const inferred = JSON.parse(
    fs.readFileSync(path.join(ROOT, DATE_FILE), 'utf8')
  );
  for (const [id, entry] of Object.entries(inferred)) {
    const d = typeof entry === 'string' ? entry : entry.date;
    if (!d || !/^\d{8}$/.test(d)) continue;
    dateOf.set(id, d);
    if (!byDate.has(d)) byDate.set(d, []);
    if (!byDate.get(d).includes(id)) byDate.get(d).push(id);
  }
} catch (_) {
  console.error('[batch] no ' + DATE_FILE + ' — run tools/qmgVideoDates.js ' +
    'to reach videos that have no date on file.');
}

/** Every video_id on disk, per directory, keyed by bare id. */
function indexDir(dir) {
  const m = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return m;
  }
  for (const f of entries) {
    if (!f.endsWith('.mp4')) continue;
    // Only an 8-digit upload_date is ever prefixed; a video id may itself
    // start with digits, so `^\d+_` would truncate it.
    const id = mediaVideoId(f);
    m.set(id, f);
  }
  return m;
}

let index1080 = null;
let index720 = null;

function findVideo(dateKey) {
  if (index1080 === null) {
    index1080 = indexDir(VIDEO_DIR_1080);
    index720 = indexDir(VIDEO_DIR_720);
  }

  const ids = byDate.get(dateKey) || [];
  for (const id of ids) {
    if (index1080.has(id)) {
      return { file: index1080.get(id), dir: VIDEO_DIR_1080, resolution: '1080p', videoId: id };
    }
  }
  for (const id of ids) {
    if (index720.has(id)) {
      return { file: index720.get(id), dir: VIDEO_DIR_720, resolution: '720p', videoId: id };
    }
  }

  // Fall back to a date-prefixed filename (e.g. for videos not in the manifest).
  const files1080 = fs.existsSync(VIDEO_DIR_1080) ? fs.readdirSync(VIDEO_DIR_1080) : [];
  const match1080 = files1080.find(f => f.startsWith(dateKey + '_') && f.endsWith('.mp4'));
  if (match1080) return { file: match1080, dir: VIDEO_DIR_1080, resolution: '1080p' };

  const filesHires = fs.existsSync(VIDEO_DIR_HIRES) ? fs.readdirSync(VIDEO_DIR_HIRES) : [];
  const matchHires = filesHires.find(f => f.startsWith(dateKey + '_') && f.endsWith('.mp4'));
  if (matchHires) return { file: matchHires, dir: VIDEO_DIR_HIRES, resolution: '720p' };

  return null;
}

function loadGT() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
}

/** Locate a video_id on disk, preferring the 1080p copy. */
function findVideoById(videoId) {
  if (index1080 === null) {
    index1080 = indexDir(VIDEO_DIR_1080);
    index720 = indexDir(VIDEO_DIR_720);
  }
  if (index1080.has(videoId)) {
    return { file: index1080.get(videoId), dir: VIDEO_DIR_1080, resolution: '1080p', videoId };
  }
  if (index720.has(videoId)) {
    return { file: index720.get(videoId), dir: VIDEO_DIR_720, resolution: '720p', videoId };
  }
  return null;
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

async function runScan(dateKey, video, runTag, extraFlags = [], baseFlags = DEFAULT_FLAGS) {
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
    ...baseFlags,
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
    // Drain stdout. scanVideoWithOcr.js prints the whole scan result as one
    // JSON blob, which is larger than the 64 KB pipe buffer — if nobody reads
    // it the child blocks on write() and never exits. Two videos hung this
    // way on 2026-10-24: the OCR completed and the log was written, but the
    // process sat there until the timeout killed it.
    child.stdout.on('data', () => {});

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const status = killed ? 'TIMEOUT' : code === 0 ? 'OK' : 'ERROR';

      // Read result
      const logFile = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
      let log = null;
      try {
        // Several videos can share an interpolated date, so match the log by
        // video id, not just by the date prefix.
        const stem = video.videoId.toLowerCase();
        const files = fs.readdirSync(logFile).filter((f) =>
          f.startsWith(dateKey + '_') && f.toLowerCase().includes(stem));
        const picked = files[0] ||
          fs.readdirSync(logFile).filter((f) => f.startsWith(dateKey + '_'))[0];
        if (picked) {
          log = JSON.parse(fs.readFileSync(path.join(logFile, picked), 'utf8'));
        }
      } catch {}

      // A scan that wrote its log but then hung (see the stdout-drain note
      // above) is a SUCCESS, not a failure — the OCR result is on disk. Only
      // report TIMEOUT/ERROR when there is no usable log.
      if (log && log.status !== 'error') {
        console.log(`[${dateKey}] OK after ${elapsed}s | captures=${log.captured_count || '?'}` +
          (killed ? ' (recovered: log was written before the timeout)' : ''));
        resolve({ dateKey, status: 'OK', elapsed: parseInt(elapsed), log });
        return;
      }

      if (killed || code !== 0) {
        console.log(`[${dateKey}] ${status} after ${elapsed}s (code=${code})`);
        resolve({ dateKey, status, elapsed: parseInt(elapsed), error: stderr.slice(0, 200) });
        return;
      }

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

  // Build the work list. A job is (dateKey, video) — several videos can share
  // an interpolated date, so targeting by date alone only ever reaches one of
  // them. --videos takes explicit ids; --dates keeps the older behaviour of
  // scanning the first on-disk match for each date.
  let jobs = [];
  if (args.videos) {
    for (const id of args.videos) {
      const video = findVideoById(id);
      const dateKey = dateOf.get(id);
      if (!video) { console.error('  ' + id + ': not on disk'); continue; }
      if (!dateKey) { console.error('  ' + id + ': no date'); continue; }
      jobs.push({ date: dateKey, video });
    }
  } else if (args.dates) {
    for (const d of args.dates) {
      const video = findVideo(d);
      if (video) jobs.push({ date: d, video });
    }
  } else if (args.allUnscanned) {
    jobs = getUnscannedDates(gt)
      .map((d) => ({ date: d, video: findVideo(d) }))
      .filter((j) => j.video !== null);
  } else if (args.chunk) {
    const unscanned = getUnscannedDates(gt);
    const chunkSize = 5;
    const start = (args.chunk - 1) * chunkSize;
    jobs = unscanned.slice(start, start + chunkSize)
      .map((d) => ({ date: d, video: findVideo(d) }))
      .filter((j) => j.video !== null);
  } else {
    console.error('Usage: node runQmgOcrBatch.js --dates d1,d2 [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --videos id1,id2 [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --all-unscanned [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --chunk N [--parallel N]');
    console.error('   or: node runQmgOcrBatch.js --low-cpu --chunk N [--parallel N]');
    process.exit(1);
  }
  const dates = jobs.map((j) => j.date);

  // Cap parallelism when --low-cpu is set (single-threaded EasyOCR can't benefit from more)
  const parallel = args.lowCpu
    ? Math.min(args.parallel, 2)
    : args.parallel;

  const runTag = RUN_TAG || `qmg-easyocr-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  console.log(`\n=== QMG EasyOCR Batch ===`);
  console.log(`Run tag: ${runTag}`);
  console.log(`Dates: ${dates.join(', ')}`);
  console.log(`Parallelism: ${parallel}${args.lowCpu ? ' (low-cpu mode)' : ''}`);
  console.log(`Output: ${OUT_ROOT}/${runTag}/\n`);

  if (args.dryRun) {
    for (const j of jobs) {
      console.log(`  ${j.date}  ${j.video.videoId}  ${j.video.file} (${j.video.resolution})`);
    }
    return;
  }

  // Ensure output dir exists
  fs.mkdirSync(path.join(OUT_ROOT, runTag), { recursive: true });

  const baseFlags = flagsForScan(args);
  const results = await runPool(jobs, parallel, async ({ date, video }, idx) => {
    return runScan(date, video, runTag, getFlagsForDate(date), baseFlags);
  });

  // Report
  console.log(`\n=== Results ===`);
  let totalHit = 0, totalGt = 0, totalFp = 0;
  for (const r of results) {
    if (r.status !== 'OK' || !r.log) {
      console.log(`  ${r.dateKey}: ${r.status}`);
      continue;
    }
    const gtEntry = gt[r.dateKey];
    if (!gtEntry) {
      // No ground truth for this date — still report what was read. The
      // tickers are the point; the score is simply not computable yet.
      const merged = r.log.merged_position_list || [];
      console.log(`  ${r.dateKey}: (no GT) ${merged.length} ticker(s): ` +
        (merged.join(',') || 'none') + ` | time=${r.elapsed}s`);
      continue;
    }
    const s = scoreResult(r.log, gtEntry);
    totalHit += s.hit;
    totalGt += s.hit + s.miss;
    totalFp += s.fp;
    console.log(`  ${r.dateKey}: recall=${s.recall} (${s.recallPct}%) | miss=${s.missTickers.join(',') || 'none'} | FP=${s.fpTickers.join(',') || 'none'} | time=${r.elapsed}s`);
  }
  console.log(`\nOverall: ${totalHit}/${totalGt} = ${Math.round(100*totalHit/totalGt)}% recall, ${totalFp} FPs`);
}

main().catch(e => { console.error(e); process.exit(1); });
