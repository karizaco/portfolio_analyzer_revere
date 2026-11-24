'use strict';

/**
 * Resumable EasyOCR sweep over the QMG videos that have no ground truth.
 *
 * The user asked for OCR on more videos, "including those where you don't
 * know the GTs". The curated benchmark only covers a handful of dates, so
 * the widest source of signal is simply running the pipeline over the whole
 * restored catalogue and reading the tickers off the frames.
 *
 * The work list comes from tools/listOcrTargets.js `collectTargets()`:
 * a video that is on disk, has a date, has no ground truth, and has no
 * surviving EasyOCR log yet. Because that selection is derived from what is
 * on disk, the sweep is naturally resumable — a video that has been scanned
 * drops out of the list on the next pass.
 *
 * Videos that fail are recorded in the state file so a failing video does
 * not spin the loop forever.
 *
 * Each chunk is a separate `tools/runQmgOcrBatch.js` invocation, which owns
 * the per-date crop/temporal-decay logic. This process only decides WHAT to
 * run and records WHAT came back.
 *
 * Usage:
 *   node tools/qmgOcrSweep.js --dry-run
 *   node tools/qmgOcrSweep.js --chunk 8 --batch-count 4 --batch-window 30
 *   node tools/qmgOcrSweep.js --max-videos 40
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { collectTargets } = require('./listOcrTargets.js');
const { checkFreeSpace, lowCpuEnv } = require('./qmg_scan_daemon_support.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const STATE_FILE = path.join(ROOT, 'data', 'qmg_ocr_sweep.json');
const LOCK_FILE = path.join(ROOT, 'data', 'qmg_ocr_sweep.lock');

function flag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

const ARGS = {
  chunk: parseInt(flag('--chunk', '8'), 10),
  maxVideos: parseInt(flag('--max-videos', '0'), 10),
  batchCount: parseInt(flag('--batch-count', '4'), 10),
  batchWindow: parseInt(flag('--batch-window', '30'), 10),
  parallel: parseInt(flag('--parallel', '2'), 10),
  fps: flag('--fps', null),
  prefilterMaxFrames: flag('--prefilter-max-frames', null),
  runTag: flag('--run-tag', null),
  dryRun: process.argv.includes('--dry-run'),
  minFreeGb: parseInt(flag('--min-free-gb', '12'), 10),
};

const RUN_TAG = ARGS.runTag || ('qmg-sweep-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));

// --- State ------------------------------------------------------------------

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      runTag: j.runTag || null,
      done: j.done || {},
      failed: j.failed || {},
    };
  } catch (_) {
    return { runTag: null, done: {}, failed: {} };
  }
}

function saveState(state) {
  state.updated = new Date().toISOString();
  state.runTag = RUN_TAG;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

/**
 * Merge one video's result into the state, never regressing a good result.
 *
 * A re-run whose leg failed must keep the previous success rather than
 * overwrite it with a failure.
 */
function recordResult(state, videoId, entry) {
  if (entry.ok) {
    state.done[videoId] = entry;
    delete state.failed[videoId];
    return;
  }
  const prev = state.done[videoId];
  if (prev && prev.ok) return;          // keep the earlier success
  state.failed[videoId] = entry;
}

// --- Lock -------------------------------------------------------------------

function acquireLock() {
  // A stale lock (process gone) must not block the sweep forever.
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    let alive = false;
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { stdio: 'pipe' }).toString();
      // tasklist exits 0 even when NOTHING matches the filter — it prints
      // "INFO: No tasks are running which match the specified criteria."
      // to stdout. Testing only the exit status therefore reports a dead
      // pid as alive, and the lock can never be cleared. A crashed sweep
      // then blocks every later run forever.
      alive = !/No tasks are running/i.test(out) && /\S/.test(out.trim());
    } catch (_) {}
    if (alive) {
      console.error('[sweep] another sweep is running (pid ' + pid + ')');
      process.exit(1);
    }
    console.log('[sweep] clearing a stale lock from pid ' + pid);
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

// --- Reading results back ----------------------------------------------------

/**
 * Pull the merged ticker list for each video of a chunk out of the run's
 * logs. Several videos can share an interpolated date, so the log is matched
 * by video id.
 */
function readChunkResults(chunk, runTag) {
  const logDir = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
  let files = [];
  try {
    files = fs.readdirSync(logDir);
  } catch (_) {
    return new Map();
  }
  const out = new Map();
  for (const c of chunk) {
    const stem = c.id.toLowerCase();
    const hit = files.find((f) =>
      f.startsWith(c.date + '_') && f.toLowerCase().includes(stem));
    if (!hit) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(logDir, hit), 'utf8'));
      if (!j || j.status === 'error') continue;
      out.set(c.id, {
        ok: true,
        date: c.date,
        tickers: j.merged_position_list || [],
        captures: j.captured_count || 0,
        ocrFrames: j.ocr_frame_count || 0,
        log: path.relative(ROOT, path.join(logDir, hit)).replace(/\\/g, '/'),
      });
    } catch (_) {}
  }
  return out;
}

// --- Running one chunk ---------------------------------------------------------

function runChunk(chunk) {
  const ids = chunk.map((c) => c.id).join(',');
  const cmd = [
    'node',
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    '--videos', ids,
    '--run-tag', RUN_TAG,
    '--parallel', String(ARGS.parallel),
    '--batch-count', String(ARGS.batchCount),
    '--batch-window', String(ARGS.batchWindow),
    '--low-cpu',
  ];
  if (ARGS.fps) cmd.push('--fps', String(ARGS.fps));
  if (ARGS.prefilterMaxFrames) {
    cmd.push('--prefilter-max-frames', String(ARGS.prefilterMaxFrames));
  }

  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      env: lowCpuEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: ROOT,
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      console.error('[sweep] spawn failed: ' + err.message);
      resolve(false);
    });
  });
}

// --- Main ---------------------------------------------------------------------

async function main() {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });

  const state = loadState();
  console.log('[sweep] run tag: ' + RUN_TAG);
  console.log('[sweep] state: ' + Object.keys(state.done).length + ' done, ' +
    Object.keys(state.failed).length + ' failed');

  let scanned = 0;
  while (true) {
    const { candidates, stats } = collectTargets();
    const fresh = candidates.filter((c) => !state.failed[c.id]);
    if (!fresh.length) {
      console.log('[sweep] nothing left to scan (' + candidates.length +
        ' candidates, all previously failed)');
      break;
    }
    if (ARGS.maxVideos && scanned >= ARGS.maxVideos) {
      console.log('[sweep] reached --max-videos ' + ARGS.maxVideos);
      break;
    }

    let chunk = fresh.slice(0, ARGS.chunk);
    if (ARGS.maxVideos) {
      chunk = chunk.slice(0, ARGS.maxVideos - scanned);
    }

    console.log('\n[sweep] --- chunk of ' + chunk.length + ' (' +
      stats.onDisk + ' on disk, ' + stats.scanned + ' already scanned) ---');
    for (const c of chunk) {
      console.log('[sweep]   ' + c.date + '  ' + c.id + '  ' + c.resolution +
        '  ' + c.confidence);
    }

    if (ARGS.dryRun) {
      console.log('[sweep] dry run — not scanning');
      break;
    }

    if (!checkFreeSpace(ROOT, ARGS.minFreeGb)) {
      console.error('[sweep] not enough free disk — stopping');
      break;
    }

    const ok = await runChunk(chunk);
    const results = readChunkResults(chunk, RUN_TAG);
    for (const c of chunk) {
      const r = results.get(c.id);
      if (r) {
        recordResult(state, c.id, r);
        console.log('[sweep]   OK  ' + c.date + '  ' + c.id + '  ' +
          (r.tickers.length ? r.tickers.join(',') : '(no tickers)'));
      } else {
        recordResult(state, c.id, {
          ok: false,
          date: c.date,
          reason: ok ? 'scan produced no log' : 'scan runner exited non-zero',
        });
        console.log('[sweep]   FAIL ' + c.date + '  ' + c.id);
      }
      scanned++;
    }
    saveState(state);

    const done = Object.keys(state.done).length;
    const failed = Object.keys(state.failed).length;
    console.log('[sweep] progress: ' + done + ' done, ' + failed + ' failed, ' +
      scanned + ' this run');
  }

  // --- Summary ---------------------------------------------------------------
  const done = Object.values(state.done);
  const withTickers = done.filter((d) => d.tickers && d.tickers.length);
  console.log('\n=== Sweep summary ===');
  console.log('run tag      : ' + RUN_TAG);
  console.log('videos done  : ' + done.length);
  console.log('with tickers : ' + withTickers.length);
  console.log('total tickers: ' +
    done.reduce((n, d) => n + (d.tickers ? d.tickers.length : 0), 0));

  // Ticker frequency across the whole sweep — the most useful output when
  // there is no ground truth to score against.
  const freq = new Map();
  for (const d of withTickers) {
    for (const t of d.tickers) freq.set(t, (freq.get(t) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n[tickers] ' + top.length + ' distinct across ' +
    withTickers.length + ' videos');
  console.log(top.map(([t, n]) => t + ':' + n).join('  '));

  saveState(state);
  releaseLock();
}

main().catch((e) => {
  console.error(e);
  releaseLock();
  process.exit(1);
});
