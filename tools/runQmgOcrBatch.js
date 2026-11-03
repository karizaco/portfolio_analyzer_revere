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
 *
 *   --cluster-rule shipped|corroborated|corroborated-strict|supported
 *                  |supported+corroborated|video-supported
 *                  |video-supported+corroborated
 *     Which canonical-selection rule the clusterer runs. The names are the
 *     ones `tools/evalParserReplay.js --cluster-rule` uses, so a measurement
 *     and the scan that follows it are named the same way. Default `shipped`
 *     -- every other rule is OFF until it has been measured.
 */

const fs = require('node:fs');
const path = require('path');
const { isRightSidebarDate } = require('../src/video/chartStreamCrop');
// The child supervisor lives in the shared daemon-support module, so every
// tool that spawns the scan tool drains its stdout the same way. It was
// duplicated here first, and the three sibling daemons still had the
// stderr-only drain that causes the deadlock.
const { superviseChild, STDOUT_TAIL_CHARS } = require('./qmg_scan_daemon_support');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR_1080 = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const VIDEO_DIR_HIRES = path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

// Per-video timeout: EasyOCR at ~60-90s/frame × 6 frames = 360-540s; give 40 min for longer videos
const PER_VIDEO_TIMEOUT_MS = 40 * 60 * 1000;

const BASE_FLAGS = [
  '--prefilter-profile', 'chart_stream',
  '--chart-stream-parser',
  '--basename', 'qmg',
  '--output-kind', 'snapshot',
  '--ocr-engine', 'easyocr',
  '--fps', '0.25',
  '--prefilter-max-frames', '12',
  '--max-captures', '3',
];

// Batch-snapshot mode extracts N frames within a window of the PREFILTER'S
// BEST-SCORING FRAME and REPLACES the uniform selection with them. That is
// only sound when the best-scoring frame is the frame the position list is
// visible on — and MEASURED, it is not.
//
// On 20230609 (production scan, 2026-11-02) the prefilter's best frame was
// ts=3100, score 25.9, and it read ZERO holdings. The frame that read the
// date's 13 ground-truth holdings exactly was ts=1944, whose prefilter score
// was -3.36 — near the bottom of the six candidates. Batch mode would have
// centred on ts=3100 and OCR'd a window around it, and because it REPLACES
// the selected rows, the good frame would never have been read at all.
//
// The 2022-era measurement says the same thing: on 20220218 the best-scoring
// prefilter frame (t=40) read 7 tickers while t=912 read 12.
//
// So the uniform selection is what actually finds the list, and batch mode
// is what would throw it away. Batch mode stays OFF for the 2023-era sidebar
// dates, where the measurement above was taken.
const BATCH_SNAPSHOT_FLAGS = [
  '--batch-snapshots',
  '--batch-count', '8',
  '--batch-window', '4',
];

// 2022-era (pre-mid-2023): position lists appear early in the stream (ts=40-390).
// 2023-era (mid-2023+): position lists appear later (ts=1940-5627).
// Use --temporal-decay 1800 for 2022-era (boost early frames) and
// --temporal-decay 0 for 2023-era (no bias, let prefilter score decide).
//
// The CROP is no longer set here. It used to be, with a hand-listed set of
// 29 dates and the rectangle `0.83,0.55,0.17,0.45` — but that list missed
// 20231201 and 20231215, whose ticker column starts further LEFT still (source
// x 1586-1613, so x=0.83 shaves the first glyph off every ticker). The crop is
// now derived from the upload date inside the scan tool itself
// (src/video/chartStreamCrop.js), so the era rule lives in ONE place and a
// date cannot be mis-classified by a stale list.
//
// The era question here comes from the SAME function the crop uses, so a date
// can never get the sidebar crop and the floating-panel flags. An unknown
// date is the sidebar era for both — the safer of the two, because the
// sidebar rectangle still contains the 2022-era floating panel.
function getFlagsForDate(dateKey) {
  const extraFlags = [];
  if (isRightSidebarDate(dateKey)) {
    extraFlags.push('--temporal-decay', '0'); // 2023-era: position list appears late
  }
  // 2022-era gets the default --temporal-decay 1800, which is the tool's own
  // default (src/video/ocrScanArgs.js) rather than something set here.
  return extraFlags;
}

// The cluster rules the batch runner can ask the scan tool for.
//
// The NAMES are the ones `tools/evalParserReplay.js --cluster-rule` uses, so
// the measurement and the production scan are named the same way and cannot
// drift apart. Every rule is OFF in production until it is measured -- the
// batch runner produces the corpus every other measurement is taken against,
// so it changes only when a rule has been MEASURED and chosen.
//
// The corroboration rule is the DEFAULT now, so `shipped` (the rule as it
// was before 2026-11-03) has to turn it OFF explicitly -- otherwise
// `--cluster-rule shipped` would silently run the corroborated rule.
const CLUSTER_RULE_FLAGS = {
  shipped: ['--no-cluster-corroboration'],
  corroborated: [],
  'corroborated-strict': ['--cluster-strict-corroboration'],
  supported: ['--cluster-supported', '--no-cluster-corroboration'],
  'supported+corroborated': ['--cluster-supported'],
  'video-supported': ['--cluster-video-supported', '--no-cluster-corroboration'],
  'video-supported+corroborated': ['--cluster-video-supported'],
  swallowed: ['--cluster-swallowed-holdings', '--no-cluster-corroboration'],
  'corroborated+swallowed': ['--cluster-swallowed-holdings'],
};

// The full flag list for one date.
function flagsForDate(dateKey, clusterRule = 'shipped') {
  const flags = [...BASE_FLAGS, ...getFlagsForDate(dateKey)];
  // Batch-snapshot mode is OFF for the 2023-era sidebar dates — see
  // BATCH_SNAPSHOT_FLAGS above for the measurement that decided it. The
  // 2022-era dates keep the behaviour they were scanned with.
  if (!isRightSidebarDate(dateKey)) {
    flags.push(...BATCH_SNAPSHOT_FLAGS);
  }
  flags.push(...(CLUSTER_RULE_FLAGS[clusterRule] || []));
  return flags;
}

function parseArgs(argv) {
  const args = {
    parallel: 1,
    dates: null,
    chunk: null,
    allUnscanned: false,
    dryRun: false,
    lowCpu: false,
    runTag: null,
    clusterRule: 'shipped',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--dates') args.dates = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--chunk') args.chunk = parseInt(argv[++i] || '1', 10);
    else if (a === '--all-unscanned') args.allUnscanned = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--low-cpu') args.lowCpu = true;
    else if (a === '--run-tag') args.runTag = argv[++i] || null;
    else if (a === '--cluster-rule') args.clusterRule = argv[++i] || 'shipped';
  }
  if (!Object.prototype.hasOwnProperty.call(CLUSTER_RULE_FLAGS, args.clusterRule)) {
    throw new Error(
      `unknown --cluster-rule: ${args.clusterRule} `
      + `(expected one of: ${Object.keys(CLUSTER_RULE_FLAGS).join(', ')})`
    );
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

/**
 * Spawn a child and supervise it until it exits or the timeout fires.
 *
 * The child's stdout MUST be drained here. A Windows pipe holds about 64 KB,
 * and the scan tool prints its whole result object to stdout at the end --
 * hundreds of kilobytes. An undrained stdout blocks the child AFTER it has
 * written a complete probe log and BEFORE its `finally` block runs, so the
 * child never exits, `close` never fires, the kill timer fires instead, and
 * the batch records a TIMEOUT for a video that was read successfully.
 *
 * The implementation is shared with the other scan daemons -- see
 * tools/qmg_scan_daemon_support.js.
 *
 * Returns { status, code, stdoutTail, stderr }.
 */

async function runScan(dateKey, video, runTag, clusterRule = 'shipped') {
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
    ...flagsForDate(dateKey, clusterRule),
  ];

  console.log(`[${dateKey}] Starting ${video.file} (${video.resolution})`);
  const start = Date.now();

  const { status, code, stdoutTail, stderr } = await superviseChild(cmd, env, {
    timeoutMs: PER_VIDEO_TIMEOUT_MS,
    onTimeout: () => console.log(`[${dateKey}] TIMEOUT after ${PER_VIDEO_TIMEOUT_MS/1000}s — killing`),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  if (status !== 'OK') {
    console.log(`[${dateKey}] ${status} after ${elapsed}s (code=${code})`);
    return { dateKey, status, elapsed: parseInt(elapsed), error: stderr.slice(0, 200), stdoutTail: stdoutTail.slice(-2000) };
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
  return { dateKey, status: 'OK', elapsed: parseInt(elapsed), log };
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
    console.error('   --run-tag <tag>   names the output directory (default qmg-easyocr-<date>)');
    process.exit(1);
  }

  // Cap parallelism when --low-cpu is set (single-threaded EasyOCR can't benefit from more)
  const parallel = args.lowCpu
    ? Math.min(args.parallel, 2)
    : args.parallel;

  // The run tag names the RUN, and a re-run with different parameters has to
  // be distinguishable from the one it supersedes without opening the
  // directory (CLAUDE.md, § 'Scan output directories'). The default is the
  // date; `--run-tag` overrides it for a run whose parameters differ.
  const runTag = args.runTag || `qmg-easyocr-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
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
    return runScan(date, video, runTag, args.clusterRule);
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

// Only run the batch when this file is the entry point. A test that requires
// the module to reach `superviseChild` must not start a scan.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { superviseChild, STDOUT_TAIL_CHARS };
