'use strict';
// Shared helpers for the QMG scan daemons (alt batch, comparison batch).
//
// These exist because three daemon bugs bit us in the 2026-10-19/20 runs:
//
//   1. A full disk killed two videos mid-run with a bare
//      "No space left on device" ffmpeg error that looks like an OCR bug.
//      → checkFreeSpace() is a preflight that fails loudly BEFORE the run.
//
//   2. A daemon wrote its results file unconditionally, so a run that was
//      mostly failures (every alt leg died on an unrelated code bug)
//      overwrote a good hand-curated results file.
//      → writeResults() never regresses: the best-known result per video wins.
//
//   3. The daemons spawned EasyOCR without the low-CPU thread caps that
//      CLAUDE.md mandates, saturating every core on the machine.
//      → lowCpuEnv() is applied at the Python spawn inside
//      src/ocr/easyocrAdapter.js (the single choke point), and is also
//      available here for daemons that spawn Python directly.
//
//   4. A daemon spawned the scan tool with a PIPED stdout and drained
//      stderr ONLY. The scan tool prints its whole result object to stdout
//      at the very end (the last statement in its `try`), and that object is
//      the same one the probe log holds -- hundreds of kilobytes. A Windows
//      pipe holds about 64 KB, so the child's final console.log blocked
//      FOREVER, after it had written a complete probe log and before its
//      `finally` block ran. The child never exited, `close` never fired, the
//      kill timer fired instead, and the daemon recorded a TIMEOUT for a
//      video that had in fact been read successfully.
//      → superviseChild() DRAINS stdout and keeps a bounded rolling tail.
//
// The 2026-11-02 production run is what proved guard 4: four sidebar-era
// videos, all four reported TIMEOUT, all four with `"status": "done"` in a
// complete probe log. Every one of them burned the full 40-minute budget.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

/** Minimum free disk (GB) required to start a scan batch. */
const MIN_FREE_GB = 20;

/**
 * Free space in GB on the volume holding `targetPath`.
 * Returns null if the platform cannot report it.
 */
function freeSpaceGb(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    return (stats.bavail * stats.bsize) / 1e9;
  } catch (_) {
    return null;
  }
}

/**
 * Preflight disk check. Throws with an actionable message if the volume is
 * too close to full — a mid-run disk-full kills ffmpeg and produces a
 * misleading "io_error" for the affected videos.
 */
function checkFreeSpace(targetPath, minFreeGb = MIN_FREE_GB) {
  const free = freeSpaceGb(targetPath);
  if (free === null) {
    console.warn(`[preflight] Could not determine free space for ${targetPath} — continuing.`);
    return null;
  }
  if (free < minFreeGb) {
    throw new Error(
      `Only ${free.toFixed(1)} GB free on the volume holding ${targetPath}, `
      + `need at least ${minFreeGb} GB. Free space (e.g. delete the regenerable `
      + `data/video_scan_test/_rerun/*/ocr_probe/frames directories) before running.`
    );
  }
  console.log(`[preflight] Free space OK: ${free.toFixed(1)} GB (need ${minFreeGb} GB)`);
  return free;
}

/**
 * Env for a child process that may run EasyOCR / PyTorch.
 * CLAUDE.md mandates these on every EasyOCR invocation.
 */
function lowCpuEnv(base = process.env) {
  return {
    ...base,
    OMP_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
    KMP_DUPLICATE_LIB_OK: 'TRUE',
  };
}

/**
 * How much of the child's stdout to keep for diagnostics. The child's stdout
 * is the whole result object, so it is large; the probe log on disk is the
 * authoritative record and this is only a tail for a failure report.
 */
const STDOUT_TAIL_CHARS = 16 * 1024;

/**
 * Spawn a child and supervise it until it exits or the timeout fires.
 *
 * The child's stdout MUST be drained here. A Windows pipe holds about 64 KB,
 * and the scan tool prints its whole result object to stdout at the end --
 * hundreds of kilobytes. An undrained stdout blocks the child AFTER it has
 * written a complete probe log and BEFORE its `finally` block runs, so the
 * child never exits, `close` never fires, the kill timer fires instead, and
 * the supervisor records a TIMEOUT for a video that was read successfully.
 *
 * The timeout also kills the whole PROCESS TREE (`taskkill /T` on Windows),
 * because a scan tool's ffmpeg and EasyOCR children do not die with their
 * parent on Windows -- CLAUDE.md records the orphaned grandchildren, and they
 * stall the next video's I/O.
 *
 * Returns { status, code, stdoutTail, stderr } where status is one of
 * 'OK', 'ERROR' or 'TIMEOUT'.
 *
 * Exported so the behaviour can be pinned by a test with a fake child.
 */
function superviseChild(cmd, env, { timeoutMs = 40 * 60 * 1000, onTimeout, onExit, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      if (onTimeout) onTimeout();
      // On Windows, kill the process tree: a scan tool's ffmpeg and EasyOCR
      // grandchildren do not die with their parent.
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch (_) { /* not Windows, or the process is already gone */ }
      child.kill('SIGTERM');
    }, timeoutMs);

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Keep only a rolling tail for diagnostics: the authoritative record is
    // the probe log on disk, and the child's stdout is the whole result
    // object, so it is large.
    let stdoutTail = '';
    child.stdout.on('data', (d) => {
      stdoutTail = (stdoutTail + d.toString()).slice(-STDOUT_TAIL_CHARS);
    });
    child.stdout.on('error', () => { /* the pipe was closed by the killer */ });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (onExit) onExit(code);
      resolve({
        status: killed ? 'TIMEOUT' : code === 0 ? 'OK' : 'ERROR',
        code,
        stdoutTail,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        status: 'ERROR',
        code: null,
        stdoutTail,
        stderr: String((err && err.message) || err),
      });
    });
  });
}

/**
 * Write a results payload without ever losing better data.
 *
 * `scored` is a function that maps one result row to a numeric score; the
 * highest score per key wins. `keyOf` identifies the row (e.g. videoId).
 * Rows only present in the new payload are appended.
 *
 * This means a re-run that fails on a video the previous run succeeded on
 * keeps the previous success instead of downgrading it.
 */
function writeResults(resultsFile, payload, { keyOf, scored, mode = 'w' }) {
  const tmpFile = `${resultsFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));

  if (mode !== 'merge' || !fs.existsSync(resultsFile)) {
    fs.renameSync(tmpFile, resultsFile);
    return payload;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  } catch (_) { /* unreadable prior file — overwrite with the new payload */ }

  if (!existing || typeof existing !== 'object') {
    fs.renameSync(tmpFile, resultsFile);
    return payload;
  }

  const merged = { ...existing };
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const existingRows = Array.isArray(existing.results) ? existing.results : [];
  const byKey = new Map();
  for (const row of existingRows) byKey.set(keyOf(row), row);

  for (const row of rows) {
    const key = keyOf(row);
    const prior = byKey.get(key);
    if (!prior || scored(row) >= scored(prior)) {
      byKey.set(key, row);
    }
  }
  merged.results = Array.from(byKey.values());
  fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2));
  fs.renameSync(tmpFile, resultsFile);
  return merged;
}

module.exports = {
  MIN_FREE_GB,
  STDOUT_TAIL_CHARS,
  checkFreeSpace,
  freeSpaceGb,
  lowCpuEnv,
  superviseChild,
  writeResults
};
