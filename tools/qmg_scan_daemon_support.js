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

const fs = require('node:fs');
const path = require('node:path');

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
  checkFreeSpace,
  freeSpaceGb,
  lowCpuEnv,
  writeResults
};
