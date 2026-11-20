'use strict';

// OCR scan outcomes in the catalog (state.sqlite).
//
// WHY THIS IS NOT videos.analysis_state
//
// analysis_state answers only whether the ORIGINAL FILE is still needed
// ('' | scanned | disposable). Overloading it for "did OCR succeed with
// the production profile" would either hide media from downloaders or
// mark disposable videos whose OCR reading is not production-grade.
//
// WHY THIS IS NOT filename archaeology
//
// The work queue used to treat "any log whose name starts with the
// upload date" as coverage. That mixed failed runs, Tesseract-only
// probes, old cluster rules, and production EasyOCR into one bit.
// Outcomes record the profile, engine, cluster rule, status and ticker
// count for each finished run.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROFILE_ID } = require('./qmgProductionOcrProfile');
const { videoIdFromMediaPath } = require('./analysisState');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

const OUTCOME_STATUSES = Object.freeze([
  'ok',
  'timeout',
  'error',
  'missing_media',
  'partial',
]);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ocr_scan_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  upload_date TEXT NOT NULL DEFAULT '',
  run_tag TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  cluster_rule TEXT NOT NULL DEFAULT '',
  max_captures INTEGER,
  status TEXT NOT NULL DEFAULT 'error'
    CHECK (status IN ('ok', 'timeout', 'error', 'missing_media', 'partial')),
  ticker_count INTEGER NOT NULL DEFAULT 0,
  tickers_json TEXT NOT NULL DEFAULT '[]',
  log_path TEXT NOT NULL DEFAULT '',
  elapsed_ms INTEGER,
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  detail TEXT NOT NULL DEFAULT '',
  UNIQUE (video_id, run_tag)
);
`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_video_status
  ON ocr_scan_outcomes(video_id, status);
CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_date_status
  ON ocr_scan_outcomes(upload_date, status);
CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_profile_status
  ON ocr_scan_outcomes(profile_id, status);
`;

/**
 * Create the outcomes table on a database that predates it.
 * Safe to call more than once.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean} true when the table was created in this call
 */
function ensureOcrScanOutcomesTable(db) {
  const before = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ocr_scan_outcomes'",
  ).get();
  db.exec(CREATE_SQL);
  db.exec(INDEX_SQL);
  return !before;
}

function normalizeUploadDate(value) {
  const digits = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^20\d{6}$/.test(digits) ? digits : '';
}

function normalizeTickers(tickers) {
  if (!Array.isArray(tickers)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tickers) {
    const t = String(raw || '').trim().toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Persist one finished OCR run.
 *
 * Replaces any previous row for the same (video_id, run_tag). A failure
 * here must not fail the scan; callers should catch.
 *
 * @param {object} outcome
 * @param {{ dbPath?: string, db?: import('node:sqlite').DatabaseSync }} [options]
 * @returns {{ written: number, videoId: string }}
 */
function writeOcrScanOutcome(outcome, options = {}) {
  const videoId = String(outcome.videoId || outcome.video_id || '').trim();
  if (!videoId) return { written: 0, videoId: '' };

  const status = String(outcome.status || 'error');
  if (!OUTCOME_STATUSES.includes(status)) {
    throw new Error(`ocr_scan_outcomes status "${status}" is not one of ${OUTCOME_STATUSES.join(', ')}`);
  }

  const tickers = normalizeTickers(outcome.tickers || outcome.merged_position_list);
  const runTag = String(outcome.runTag || outcome.run_tag || '').trim();
  const row = {
    video_id: videoId,
    upload_date: normalizeUploadDate(outcome.uploadDate || outcome.upload_date || outcome.dateKey),
    run_tag: runTag,
    profile_id: String(outcome.profileId || outcome.profile_id || ''),
    engine: String(outcome.engine || ''),
    cluster_rule: String(outcome.clusterRule || outcome.cluster_rule || ''),
    max_captures: outcome.maxCaptures != null
      ? Number(outcome.maxCaptures)
      : (outcome.max_captures != null ? Number(outcome.max_captures) : null),
    status,
    ticker_count: outcome.tickerCount != null
      ? Number(outcome.tickerCount)
      : tickers.length,
    tickers_json: JSON.stringify(tickers),
    log_path: String(outcome.logPath || outcome.log_path || ''),
    elapsed_ms: outcome.elapsedMs != null
      ? Number(outcome.elapsedMs)
      : (outcome.elapsed_ms != null ? Number(outcome.elapsed_ms) : null),
    finished_at: String(outcome.finishedAt || outcome.finished_at || new Date().toISOString()),
    detail: String(outcome.detail || ''),
  };

  const ownsDb = !options.db;
  const db = options.db || new DatabaseSync(options.dbPath || DEFAULT_DB);
  try {
    ensureOcrScanOutcomesTable(db);
    const result = db.prepare(`
      INSERT INTO ocr_scan_outcomes (
        video_id, upload_date, run_tag, profile_id, engine, cluster_rule,
        max_captures, status, ticker_count, tickers_json, log_path,
        elapsed_ms, finished_at, detail
      ) VALUES (
        @video_id, @upload_date, @run_tag, @profile_id, @engine, @cluster_rule,
        @max_captures, @status, @ticker_count, @tickers_json, @log_path,
        @elapsed_ms, @finished_at, @detail
      )
      ON CONFLICT(video_id, run_tag) DO UPDATE SET
        upload_date = excluded.upload_date,
        profile_id = excluded.profile_id,
        engine = excluded.engine,
        cluster_rule = excluded.cluster_rule,
        max_captures = excluded.max_captures,
        status = excluded.status,
        ticker_count = excluded.ticker_count,
        tickers_json = excluded.tickers_json,
        log_path = excluded.log_path,
        elapsed_ms = excluded.elapsed_ms,
        finished_at = excluded.finished_at,
        detail = excluded.detail
    `).run(row);
    return { written: result.changes || 0, videoId };
  } finally {
    if (ownsDb) db.close();
  }
}

/**
 * Best-effort write used by scan/batch tools. Never throws.
 */
function recordOcrScanOutcome(outcome, options = {}) {
  try {
    return writeOcrScanOutcome(outcome, options);
  } catch (error) {
    return {
      written: 0,
      videoId: String(outcome.videoId || outcome.video_id || ''),
      error: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * Resolve a video id from an outcome payload or a media path.
 */
function resolveOutcomeVideoId(outcome = {}, mediaPath = '') {
  return String(outcome.videoId || outcome.video_id || videoIdFromMediaPath(mediaPath) || '').trim();
}

/**
 * Dates (YYYYMMDD) that already have a successful outcome for the given
 * profile. Used by the work queue instead of log-filename archaeology.
 *
 * @param {{ dbPath?: string, profileId?: string, db?: import('node:sqlite').DatabaseSync }} [options]
 * @returns {Set<string>}
 */
function listSuccessfulOutcomeDates(options = {}) {
  const profileId = options.profileId || PROFILE_ID;
  const ownsDb = !options.db;
  const db = options.db || new DatabaseSync(options.dbPath || DEFAULT_DB, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT DISTINCT upload_date AS d
      FROM ocr_scan_outcomes
      WHERE status = 'ok'
        AND profile_id = ?
        AND upload_date GLOB '20[0-9][0-9][0-9][0-9][0-9][0-9]'
    `).all(profileId);
    return new Set(rows.map((r) => r.d).filter(Boolean));
  } catch {
    // Missing table => no production outcomes yet.
    return new Set();
  } finally {
    if (ownsDb) db.close();
  }
}

/**
 * Video ids with a successful modern-profile outcome.
 *
 * @param {{ dbPath?: string, profileId?: string, db?: import('node:sqlite').DatabaseSync }} [options]
 * @returns {Set<string>}
 */
function listSuccessfulOutcomeVideoIds(options = {}) {
  const profileId = options.profileId || PROFILE_ID;
  const ownsDb = !options.db;
  const db = options.db || new DatabaseSync(options.dbPath || DEFAULT_DB, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT DISTINCT video_id AS id
      FROM ocr_scan_outcomes
      WHERE status = 'ok' AND profile_id = ?
    `).all(profileId);
    return new Set(rows.map((r) => r.id).filter(Boolean));
  } catch {
    return new Set();
  } finally {
    if (ownsDb) db.close();
  }
}

module.exports = {
  DEFAULT_DB,
  OUTCOME_STATUSES,
  ensureOcrScanOutcomesTable,
  listSuccessfulOutcomeDates,
  listSuccessfulOutcomeVideoIds,
  recordOcrScanOutcome,
  resolveOutcomeVideoId,
  writeOcrScanOutcome,
};
