'use strict';

/**
 * The `position_table` SWEEP.
 *
 * WHY THIS IS ITS OWN TOOL
 *
 * The Qullamaggie corpus has two position layouts: the chart-stream
 * overlay (the `chart_stream` profile) and the TradingView TABLE (the
 * `position_table` profile). The batch runner drives the first one --
 * `tools/runQmgOcrBatch.js` builds its flags from the production
 * chart-stream profile -- and the table profile is a different scan:
 *
 *   - the source frame is read at NATIVE resolution, because the
 *     table's glyphs are ~6.8 source px tall and at 1280 they are
 *     ~4.5 px and unreadable;
 *   - each frame costs TWO EasyOCR batches, because the reader feeds
 *     an upscaled narrow strip;
 *   - and the profile REFUSES `--ocr-frame-width` and any
 *     `--output-kind` other than `snapshot`, because in table mode they
 *     can only produce a silently wrong result.
 *
 * So the sweep is a loop over the table profile's own invocation, and
 * this tool is that loop.
 *
 * THE RULES IT FOLLOWS (and they are not optional)
 *
 *   - **ONE video first.** The table profile costs 162-257 s a frame,
 *     so a video is 8-13 minutes. The first run of a sweep is one
 *     video, and the chunk after it is only started when that one has
 *     written a probe log with non-empty captures.
 *   - **A CHUNK, NOT A SWEEP.** Five to ten videos, never forty.
 *   - **LOW CPU ALWAYS.** EasyOCR without `--low-cpu` saturates every
 *     core and the machine stops.
 *   - **THE TIMEOUT KILLS THE PROCESS TREE.** A scan tool's ffmpeg and
 *     EasyOCR grandchildren do not die with their parent on Windows,
 *     and the orphans stall the next video's I/O.
 *
 *   node tools/runQmgPositionTableSweep.js --dates 20230608,20230609
 *   node tools/runQmgPositionTableSweep.js --dates 20230608 --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { findMediaForDate } = require('../src/video/mediaRoots');
const { superviseChild, lowCpuEnv } = require('./qmg_scan_daemon_support');

const ROOT = path.resolve(__dirname, '..');
const SCAN_TOOL = path.join(__dirname, 'scanVideoWithOcr.js');

const options = {
  dates: '',
  runTag: 'qmg-table',
  timeoutMinutes: 40,
  parallel: 1,
  dryRun: false,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === '--dates') options.dates = process.argv[++i] || '';
  else if (a === '--run-tag') options.runTag = process.argv[++i] || options.runTag;
  else if (a === '--timeout-minutes') options.timeoutMinutes = Number(process.argv[++i]) || options.timeoutMinutes;
  else if (a === '--parallel') options.parallel = Math.max(1, Number(process.argv[++i]) || 1);
  else if (a === '--dry-run') options.dryRun = true;
}

const dates = options.dates.split(',').map((d) => d.trim()).filter(Boolean);
if (!dates.length) {
  console.error('usage: node tools/runQmgPositionTableSweep.js --dates <YYYYMMDD,...> [--run-tag <tag>] [--parallel <n>] [--dry-run]');
  process.exit(2);
}

/**
 * The scan tool's arguments for one video.
 *
 * @param {string} dateKey
 * @param {string} video
 * @returns {string[]}
 */
function scanArgs(dateKey, video) {
  return [
    SCAN_TOOL,
    '--video', video,
    '--date', dateKey,
    '--prefilter-profile', 'position_table',
    '--basename', 'qmg',
    '--output-kind', 'snapshot',
    '--run-tag', options.runTag,
    '--output-root', path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ];
}

async function main() {
  const env = { ...process.env, ...lowCpuEnv() };
  const results = [];

  for (const dateKey of dates) {
    // `findMediaForDate` returns a hit OBJECT -- { file, dir, path,
    // resolution, videoId, date } -- and not a path.
    const hit = findMediaForDate(dateKey);
    const video = hit ? hit.path : null;
    if (!video) {
      console.log(`[qmg-table] ${dateKey}: no media on disk -- skipped`);
      results.push({ date: dateKey, status: 'no_media' });
      continue;
    }
    const args = scanArgs(dateKey, video);
    if (options.dryRun) {
      console.log(`[qmg-table] ${dateKey}: ${hit.file} (${hit.resolution})`);
      console.log(`             node ${args.join(' ')}`);
      results.push({ date: dateKey, status: 'dry_run', video });
      continue;
    }
    const started = Date.now();
    console.log(`[qmg-table] ${dateKey}: scanning ${hit.file} (${hit.resolution}) ...`);
    const out = await superviseChild(['node', ...args], env, {
      timeoutMs: options.timeoutMinutes * 60 * 1000,
      cwd: ROOT,
      onTimeout: () => console.log(`[qmg-table] ${dateKey}: TIMEOUT after ${options.timeoutMinutes} min -- the tree was killed`),
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[qmg-table] ${dateKey}: ${out.status} in ${seconds}s`);
    if (out.stderr) {
      const tail = out.stderr.split(/\r?\n/).filter(Boolean).slice(-4);
      for (const line of tail) console.log(`             ${line}`);
    }
    results.push({ date: dateKey, status: out.status, seconds, video });
  }

  const summary = {
    run_tag: options.runTag,
    profile: 'position_table',
    dates,
    results,
  };
  const outPath = path.join(ROOT, 'data', 'video_scan_test', '_rerun', `${options.runTag}_sweep.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[qmg-table] wrote ${path.relative(ROOT, outPath)}`);
}

main().catch((error) => {
  console.error(`[qmg-table] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
