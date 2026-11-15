'use strict';

// The catalog write behind `videos.analysis_state`.
//
// The column is a CACHE of two things that already exist: a done probe
// log naming the video, and a date in the ground-truth fixture manifest.
// This module writes the cache. It does not decide the flag (that is
// `decideAnalysisState`) and it never deletes a file.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ANALYSIS_STATE_VALUES,
  catalogDateOf,
  decideAnalysisState,
  videoIdFromMediaPath,
} = require('./analysisState');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const DEFAULT_MANIFEST = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');

/**
 * Add the column to a database that predates it.
 *
 * schema.sql creates it for a fresh database. The shipped catalog is not
 * fresh, and `CREATE TABLE IF NOT EXISTS` does not add a column to a
 * table that already exists, so the ALTER is what an existing database
 * needs. Safe to call more than once.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureAnalysisStateColumn(db) {
  const columns = db.prepare('PRAGMA table_info(videos)').all();
  if (columns.some((column) => column.name === 'analysis_state')) return false;
  db.exec("ALTER TABLE videos ADD COLUMN analysis_state TEXT NOT NULL DEFAULT ''");
  return true;
}

/**
 * Write one video's flag. Refuses a value the vocabulary does not have,
 * because a typo here is a video marked deletable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} videoId
 * @param {string} state
 * @returns {number} rows changed
 */
function writeAnalysisState(db, videoId, state) {
  if (!ANALYSIS_STATE_VALUES.includes(state)) {
    throw new Error(`analysis_state "${state}" is not one of ${ANALYSIS_STATE_VALUES.join(', ')}`);
  }
  if (!videoId) return 0;
  ensureAnalysisStateColumn(db);
  const result = db.prepare(
    'UPDATE videos SET analysis_state = ? WHERE video_id = ?',
  ).run(state, videoId);
  return result.changes || 0;
}

/**
 * Dates the fixture manifest pins. A missing manifest pins nothing, so
 * a scan cannot mark a video disposable by accident.
 *
 * @param {string} manifestPath
 * @returns {Set<string>}
 */
function loadPinnedDates(manifestPath) {
  const dates = new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const row of manifest.cases || []) {
      const date = catalogDateOf(row && row.date);
      if (date) dates.add(date);
    }
  } catch {
    return dates;
  }
  return dates;
}

/**
 * Record the flag for a video a scan just finished reading.
 *
 * The scan succeeded, so `scannedDone` is true. Disposable only if the
 * date is pinned. Opens the catalog itself and always closes it; a
 * failure here must not fail the scan (the caller catches).
 *
 * @param {string} videoPath
 * @param {string} dateKey
 * @param {{ dbPath?: string, manifestPath?: string, pinnedDates?: Set<string> }} [options]
 */
function flagScannedVideo(videoPath, dateKey, options = {}) {
  const videoId = videoIdFromMediaPath(videoPath);
  if (!videoId) return { videoId: '', state: '', written: 0 };
  const pinned = options.pinnedDates || loadPinnedDates(options.manifestPath || DEFAULT_MANIFEST);
  const state = decideAnalysisState({
    scannedDone: true,
    datePinned: pinned.has(catalogDateOf(dateKey)),
  });
  const db = new DatabaseSync(options.dbPath || DEFAULT_DB);
  try {
    return { videoId, state, written: writeAnalysisState(db, videoId, state) };
  } finally {
    db.close();
  }
}

module.exports = {
  ensureAnalysisStateColumn,
  flagScannedVideo,
  loadPinnedDates,
  writeAnalysisState,
};
