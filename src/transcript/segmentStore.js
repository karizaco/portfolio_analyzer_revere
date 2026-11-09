'use strict';

// The transcript SEGMENTS store.
//
// `transcript_segments` is the pipeline's largest table -- 698,450 rows, about
// 98 MB -- and it is a CACHE: every row is derived from the transcript JSON
// under `data/video_pipeline/transcripts/`, which is tracked, and the
// extractors rebuild it from those files.
//
// It therefore lives in its OWN database file, `transcript_segments.sqlite`,
// which is NOT tracked. The catalog (`state.sqlite`) is the irreplaceable
// part and stays tracked; the cache does not, because keeping it there made
// the tracked file exceed GitHub's 100 MB limit.
//
// THE MECHANISM IS AN ATTACH, so the tools' SQL does not change:
//
//   const db = new DatabaseSync(CATALOG_DB_PATH);
//   attachSegments(db);
//   db.prepare('SELECT ... FROM transcript_segments ...')
//
// An unqualified `transcript_segments` resolves to the ATTACHED file, and an
// unqualified INSERT lands there too. Both were verified before this module
// was written (see `test/transcriptSegmentStore.test.js`).
//
// The catalog database keeps `video_transcripts`, whose `segment_count` is
// the authoritative per-transcript count; the migration checks the two agree.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const CATALOG_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SEGMENTS_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'transcript_segments.sqlite');
const SEGMENTS_SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema_transcript_segments.sql');

/**
 * Create the segments table in the segments FILE if it is not there yet.
 *
 * THIS RUNS ON A SEPARATE CONNECTION, AND THAT IS THE WHOLE POINT.
 *
 * `CREATE TABLE` is unqualified DDL, and SQLite puts unqualified DDL in the
 * MAIN database of the connection that runs it. Running the schema on a
 * connection whose main is the CATALOG would therefore create the table back
 * in the tracked file -- exactly the thing this split exists to prevent. A
 * connection opened directly on the segments file has that file as its main,
 * so the table lands where it belongs.
 *
 * @param {string} segmentsPath
 */
function ensureSegmentsSchema(segmentsPath) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const segmentsDb = new DatabaseSync(segmentsPath);
  try {
    segmentsDb.exec(fs.readFileSync(SEGMENTS_SCHEMA_PATH, 'utf8'));
  } finally {
    segmentsDb.close();
  }
}

/**
 * Attach the segments database to a catalog connection.
 *
 * The ATTACH is what makes the tools' existing SQL work unchanged: an
 * unqualified `transcript_segments` resolves to the attached file -- PROVIDED
 * the catalog does not also have that table, because an unqualified name
 * resolves to MAIN first. `tools/migrateTranscriptSegments.js` drops the
 * catalog's copy.
 *
 * @param {import('node:sqlite').DatabaseSync} db the catalog connection
 * @param {{segmentsPath?: string, createSchema?: boolean}} [options]
 *   `segmentsPath` overrides the default file. Tests point this at a temp
 *   directory so they exercise the real mechanism without touching production
 *   data. `createSchema: false` skips the DDL, for a read-only connection.
 * @returns {import('node:sqlite').DatabaseSync} the same connection
 */
function attachSegments(db, options = {}) {
  const segmentsPath = options.segmentsPath || SEGMENTS_DB_PATH;
  if (options.createSchema !== false) {
    ensureSegmentsSchema(segmentsPath);
  }
  db.prepare('ATTACH DATABASE ? AS seg').run(segmentsPath);
  return db;
}

/**
 * Open the catalog database with the segments database attached.
 *
 * @param {{readOnly?: boolean, segmentsPath?: string, createSchema?: boolean}} [options]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openCatalogWithSegments(options = {}) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  // Node 24 rejects `undefined` here ("options must be an object"), so the
  // writable form passes an empty object.
  const db = new DatabaseSync(CATALOG_DB_PATH, options.readOnly
    ? { readOnly: true }
    : {});
  attachSegments(db, {
    segmentsPath: options.segmentsPath,
    // A read-only connection must not go and create a schema.
    createSchema: options.createSchema !== undefined
      ? options.createSchema
      : !options.readOnly,
  });
  return db;
}

module.exports = {
  CATALOG_DB_PATH,
  SEGMENTS_DB_PATH,
  SEGMENTS_SCHEMA_PATH,
  attachSegments,
  ensureSegmentsSchema,
  openCatalogWithSegments,
};
