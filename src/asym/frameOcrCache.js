/**
 * The cache of OCR'd sector panels.
 *
 * WHY IT EXISTS
 *
 * Reading the sector table out of a frame is the slowest thing in this
 * pipeline: every frame is cropped, enlarged 4x and read by Tesseract,
 * and 192 frames is about five minutes of work. The frames do not
 * change between runs -- they are PNG files on disk -- so the reading
 * of a frame is the same reading every time, and re-doing it is pure
 * waste.
 *
 * The cache is keyed by the frame's PATH, and it is only valid when
 * the file is byte-for-byte the same file (same size, same mtime) AND
 * the parser is the same version. So a frame that is re-grabbed, or a
 * parser that changes, invalidates its own entry and nothing else.
 *
 * The parser version is part of the key on purpose: a fix to the
 * number repair has to re-read every frame, or the corpus would end up
 * with a mix of two parsers' readings and no way to tell which is which.
 */
const fs = require('node:fs');

/**
 * The cache table.
 *
 * @type {string}
 */
const FRAME_OCR_DDL = `CREATE TABLE IF NOT EXISTS asym_frame_ocr (
    frame_path TEXT PRIMARY KEY,
    file_bytes INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL DEFAULT '',
    rows_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0,
    parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

/**
 * Make sure the cache table exists.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureFrameOcrTable(db) {
  try {
    db.exec(FRAME_OCR_DDL);
  } catch {
    // The table is already there.
  }
}

/**
 * The size and mtime of a file, in the units the cache stores.
 *
 * @param {string} filePath
 * @returns {{bytes: number, mtime: number}}
 */
function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { bytes: Number(stat.size) || 0, mtime: Math.floor(Number(stat.mtimeMs) || 0) };
  } catch {
    return { bytes: 0, mtime: 0 };
  }
}

/**
 * The cached reading of a frame, when it is still valid.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} framePath - the path, as the catalog stores it
 * @param {string} parserVersion
 * @returns {{rows: Array<object>, confidence: number}|null}
 */
function cachedFrameOcr(db, framePath, parserVersion) {
  let row = null;
  try {
    row = db.prepare(
      'SELECT file_bytes, file_mtime, parser_version, rows_json, confidence FROM asym_frame_ocr WHERE frame_path = ?'
    ).get(framePath);
  } catch {
    return null;
  }
  if (!row) return null;
  if (row.parser_version !== parserVersion) return null;

  const stamp = fileStamp(framePath);
  if (Number(row.file_bytes) !== stamp.bytes) return null;
  if (Number(row.file_mtime) !== stamp.mtime) return null;

  try {
    const rows = JSON.parse(row.rows_json || '[]');
    return { rows: Array.isArray(rows) ? rows : [], confidence: Number(row.confidence) || 0 };
  } catch {
    return null;
  }
}

/**
 * Remember the reading of a frame.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} framePath
 * @param {string} parserVersion
 * @param {{rows: Array<object>, confidence: number}} parsed
 * @returns {void}
 */
function storeFrameOcr(db, framePath, parserVersion, parsed) {
  const stamp = fileStamp(framePath);
  db.prepare(`
    INSERT INTO asym_frame_ocr (
      frame_path, file_bytes, file_mtime, parser_version, rows_json, confidence, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(frame_path) DO UPDATE SET
      file_bytes = excluded.file_bytes,
      file_mtime = excluded.file_mtime,
      parser_version = excluded.parser_version,
      rows_json = excluded.rows_json,
      confidence = excluded.confidence,
      parsed_at = datetime('now')
  `).run(
    framePath,
    stamp.bytes,
    stamp.mtime,
    parserVersion,
    JSON.stringify((parsed && parsed.rows) || []),
    Number(parsed && parsed.confidence) || 0
  );
}

/**
 * How many frames are cached, and how many of them are still valid.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} parserVersion
 * @returns {{cached: number, valid: number, stale: number}}
 */
function frameOcrStats(db, parserVersion) {
  let rows = [];
  try {
    rows = db.prepare('SELECT frame_path, file_bytes, file_mtime, parser_version FROM asym_frame_ocr').all();
  } catch {
    return { cached: 0, valid: 0, stale: 0 };
  }
  let valid = 0;
  for (const row of rows) {
    if (row.parser_version !== parserVersion) continue;
    const stamp = fileStamp(row.frame_path);
    if (Number(row.file_bytes) === stamp.bytes && Number(row.file_mtime) === stamp.mtime) valid += 1;
  }
  return { cached: rows.length, valid, stale: rows.length - valid };
}

module.exports = {
  FRAME_OCR_DDL,
  cachedFrameOcr,
  ensureFrameOcrTable,
  fileStamp,
  frameOcrStats,
  storeFrameOcr,
};
