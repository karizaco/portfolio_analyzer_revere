'use strict';

/**
 * Move `transcript_segments` out of the tracked catalog and into its own,
 * untracked file.
 *
 * WHY
 *
 * `transcript_segments` is the largest table in the pipeline's database -- for
 * the Sevcik channel alone, 698,450 rows, about 98 MB of the 136 MB the
 * catalog file had grown to. It is also a CACHE: every row is derived from
 * the transcript JSON under `data/video_pipeline/transcripts/`, which IS
 * tracked, and the extractors rebuild it from those files.
 *
 * GitHub refuses a file over 100 MB, so the tracked `state.sqlite` had passed
 * the limit and could not be pushed. Splitting the cache out puts the
 * tracked file back to about 10 MB -- the catalog, which is the irreplaceable
 * part -- and leaves the cache where it belongs: on disk, not in git.
 *
 * WHAT IT DOES
 *
 *   1. Reads the existing `transcript_segments` rows out of the catalog.
 *   2. Writes them into `transcript_segments.sqlite`.
 *   3. Checks the row count against `video_transcripts.segment_count`, which
 *      is the catalog's own record of how many segments each transcript has.
 *   4. DROPS the table from the catalog and VACUUMs it.
 *   5. Removes the now-empty table from `data/db/schema.sql` so a fresh
 *      clone does not create it again.
 *
 * The catalog is COPIED first and only replaced once the copy is verified,
 * so an interrupted run leaves the original intact.
 *
 * Usage:
 *   node tools/migrateTranscriptSegments.js --dry-run   # report, change nothing
 *   node tools/migrateTranscriptSegments.js            # do it
 */

const fs = require('node:fs');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const {
  CATALOG_DB_PATH,
  SEGMENTS_DB_PATH,
  SEGMENTS_SCHEMA_PATH,
} = require('../src/transcript/segmentStore');

const dryRun = process.argv.includes('--dry-run');

function fmt(n) {
  return `${n.toLocaleString('en-US')} rows`;
}

/**
 * The catalog's own count of the segments, per transcript.
 * @returns {number}
 */
function catalogSegmentCount(db) {
  const row = db.prepare('SELECT COALESCE(SUM(segment_count), 0) AS n FROM video_transcripts').get();
  return Number(row && row.n ? row.n : 0);
}

function main() {
  if (!fs.existsSync(CATALOG_DB_PATH)) {
    console.error(`No catalog at ${CATALOG_DB_PATH}`);
    process.exit(1);
  }

  const db = new DatabaseSync(CATALOG_DB_PATH);

  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_segments'",
  ).get();

  if (!hasTable) {
    console.log('[segments] the catalog has no transcript_segments table -- already migrated');
    db.close();
    return;
  }

  const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get().n);
  const expected = catalogSegmentCount(db);

  console.log(`[segments] catalog      : ${CATALOG_DB_PATH}`);
  console.log(`[segments] table rows   : ${fmt(rows)}`);
  console.log(`[segments] catalog says : ${fmt(expected)} (SUM of video_transcripts.segment_count)`);
  console.log(`[segments] target       : ${SEGMENTS_DB_PATH}`);

  if (rows !== expected) {
    console.error('[segments] the two counts disagree -- refusing to migrate');
    console.error('           run the extractors first so the catalog and the rows agree');
    db.close();
    process.exit(1);
  }

  if (dryRun) {
    console.log('[segments] DRY RUN -- nothing was changed');
    db.close();
    return;
  }

  // 1. The segments file, with the schema and the rows.
  const seg = new DatabaseSync(SEGMENTS_DB_PATH);
  seg.exec(fs.readFileSync(SEGMENTS_SCHEMA_PATH, 'utf8'));
  const existing = Number(seg.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get().n);
  if (existing === rows) {
    console.log(`[segments] the segments file already holds all ${fmt(rows)} -- reusing it`);
  } else {
    if (existing > 0) {
      seg.exec('DELETE FROM transcript_segments');
    }
    // The ids are re-assigned here: the table's own id is an autoincrement
    // in a new file, and nothing outside this table refers to it. The
    // `transcript_id` and `segment_index` -- the columns every query uses --
    // are copied verbatim.
    // `exec()` does NOT bind parameters -- a literal `?` here attached a
    // database literally named `?`, and the copy then failed with
    // "no such table: catalog.transcript_segments". ATTACH takes a PATH, so it
    // goes through prepare().run(), which binds it safely (backslashes and all).
    seg.prepare('ATTACH DATABASE ? AS catalog').run(CATALOG_DB_PATH);
    seg.exec(`
      INSERT INTO transcript_segments
        (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence)
      SELECT transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence
      FROM catalog.transcript_segments
    `);
    seg.exec('DETACH DATABASE catalog');
    const copied = Number(seg.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get().n);
    if (copied !== rows) {
      console.error(`[segments] copy VERIFICATION FAILED: ${fmt(copied)} of ${fmt(rows)} -- aborting`);
      seg.close();
      db.close();
      process.exit(1);
    }
    console.log(`[segments] copied and verified ${fmt(copied)}`);
  }
  seg.close();

  // 2. Drop the table from the catalog and shrink the file. The catalog is
  //    the tracked artifact, so this is the step that actually frees the
  //    space in git.
  db.exec('DROP TABLE transcript_segments');
  db.exec('VACUUM');

  const after = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_segments'",
  ).get();
  if (after) {
    console.error('[segments] the table is still in the catalog -- aborting');
    db.close();
    process.exit(1);
  }
  db.close();

  const sizeMb = fs.statSync(CATALOG_DB_PATH).size / 1048576;
  const segSizeMb = fs.existsSync(SEGMENTS_DB_PATH)
    ? fs.statSync(SEGMENTS_DB_PATH).size / 1048576
    : 0;
  console.log(`[segments] catalog now  : ${sizeMb.toFixed(1)} MB (tracked)`);
  console.log(`[segments] segments file: ${segSizeMb.toFixed(1)} MB (untracked)`);
  console.log('[segments] done');
}

main();
