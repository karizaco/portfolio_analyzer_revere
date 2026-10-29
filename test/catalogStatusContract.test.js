'use strict';

// The catalog's `status` column is a contract, and this file pins it.
//
// `videos.status` is one column with six writers, and the two that matter
// most disagree about what `done` means:
//
//   tools/runAllOcr.js         'done' = "the OCR pass finished"
//   tools/whiteboard_worker.py 'done' = "the scan wrote an artifact"
//
// Both downloaders select their work with a status filter that EXCLUDES
// `done`, because a `done` row is supposed to be finished. But `done` says
// nothing about whether the media is still on disk, so a row that was OCR'd
// and whose file was later deleted is invisible to every downloader: neither
// re-fetched, nor reported as missing. That was true of 21 rows on 2026-10-29.
//
// These tests check the contract against the code and against the shipped
// catalog, so that:
//   * the schema and the tools agree on which statuses exist;
//   * the downloaders' work lists come from ONE place, not from six comments;
//   * a row cannot be `scanning` or `done` without having been downloaded.
//
// The filesystem-dependent check lives in test/reconcileCatalogStatus.test.js,
// because it needs the media, which is not in git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  DOWNLOAD_CANDIDATE_STATUSES,
  HIRES_CANDIDATE_STATUSES,
  REQUIRES_MEDIA_STATUSES,
  STATUS,
  STATUS_MEANING,
  STATUS_VALUES,
  requiresMedia,
  sqlStatusList,
  statusMeaning,
} = require('../src/video/videoStatus');
const { CANDIDATE_SQL, buildDownloadCandidateSql } = require('../src/video/downloadCandidates');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

// ---------------------------------------------------------------------------
// The schema and the module agree
// ---------------------------------------------------------------------------

test('the schema allows exactly the statuses the module knows', () => {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const match = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(sql);
  assert.ok(match, 'schema.sql has no CHECK constraint on videos.status');
  const allowed = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
  assert.deepEqual(allowed, [...STATUS_VALUES].sort(),
    'the schema and src/video/videoStatus.js list the same statuses');
});

test('every status has a documented meaning and every documented writer exists', () => {
  for (const status of STATUS_VALUES) {
    const meaning = statusMeaning(status);
    assert.ok(meaning, `${status} has no documented meaning`);
    assert.ok(meaning.meaning.length > 10, `${status} has no usable description`);
    assert.ok(meaning.writtenBy.length > 0, `${status} names no writer`);
    for (const writer of meaning.writtenBy) {
      // The writer is written as a sentence, so check the tool name in it.
      const tool = writer.split(' ')[0];
      assert.ok(fs.existsSync(path.join(ROOT, tool)),
        `${status} names a writer that does not exist: ${tool}`);
    }
  }
});

test('a status with no meaning is reported as unknown rather than guessed', () => {
  assert.equal(statusMeaning('not_a_status'), null);
  assert.equal(requiresMedia('not_a_status'), false);
});

// ---------------------------------------------------------------------------
// The work lists come from one place
// ---------------------------------------------------------------------------

test('the 1080p downloader queries the statuses the module names', () => {
  assert.ok(CANDIDATE_SQL.includes(`status IN (${sqlStatusList(HIRES_CANDIDATE_STATUSES)})`),
    'src/video/downloadCandidates.js must build its status filter from '
    + 'src/video/videoStatus.js, so the two cannot drift apart');
  assert.ok(!CANDIDATE_SQL.includes('done'),
    "the 1080p downloader must not select 'done' rows -- that exclusion is "
    + 'what makes a deleted file invisible, and tools/reconcileCatalogStatus.js '
    + 'is the repair');
});

test('the 1080p query is valid SQL and returns rows', {
  skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout',
}, () => {
  // The status list is interpolated into the query, so a broken template
  // would only show up when the tool ran -- against YouTube. Run it here.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(CANDIDATE_SQL).all();
  db.close();
  assert.ok(rows.length > 0, 'the query returns the videos it is meant to fetch');
  for (const row of rows) {
    assert.ok(HIRES_CANDIDATE_STATUSES.includes(row.status),
      `the query returned a row it should have filtered out: ${row.video_id}`);
  }
});

test('the 720p downloader queries the statuses the module names', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'downloadHiresBatch.js'), 'utf8');
  assert.ok(source.includes('buildDownloadCandidateSql('),
    'tools/downloadHiresBatch.js must take its query from '
    + 'src/video/downloadCandidates.js, so the two downloaders cannot drift apart');
  assert.ok(!/status IN \('pending','scanning','error'\)/.test(source),
    "the hardcoded status list is gone -- keep the filter in one place");

  const sql = buildDownloadCandidateSql();
  assert.ok(sql.includes(`status IN (${sqlStatusList(DOWNLOAD_CANDIDATE_STATUSES)})`));
  assert.ok(!sql.includes('done'), "the 720p downloader must not select 'done' rows");
});

test('the 720p query is valid SQL and returns rows', {
  skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout',
}, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(buildDownloadCandidateSql()).all();
  db.close();
  assert.ok(rows.length > 0, 'the query returns the videos it is meant to fetch');
  for (const row of rows) {
    assert.ok(DOWNLOAD_CANDIDATE_STATUSES.includes(row.status),
      `the query returned a row it should have filtered out: ${row.video_id}`);
  }
});

test('the downloaders agree that a done row is not their work', () => {
  assert.ok(!DOWNLOAD_CANDIDATE_STATUSES.includes(STATUS.DONE));
  assert.ok(!HIRES_CANDIDATE_STATUSES.includes(STATUS.DONE));
});

test('the two downloaders have different work lists, on purpose', () => {
  // The 720p batch retries failures; the 1080p batch wants the videos it has
  // never fetched at 1080p, not a re-run of the other batch's errors.
  assert.ok(DOWNLOAD_CANDIDATE_STATUSES.includes(STATUS.ERROR));
  assert.ok(!HIRES_CANDIDATE_STATUSES.includes(STATUS.ERROR));
});

// ---------------------------------------------------------------------------
// The shipped catalog obeys the contract
// ---------------------------------------------------------------------------

test('the shipped catalog uses no status the schema does not allow', {
  skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout',
}, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const used = db.prepare('SELECT DISTINCT status FROM videos').all().map((r) => r.status);
  db.close();
  for (const status of used) {
    assert.ok(STATUS_VALUES.includes(status), `the catalog holds an unknown status: ${status}`);
  }
});

test('a row that was downloaded has a pointer to where it was downloaded', {
  skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout',
}, () => {
  // `scanning` and `done` are only ever reached after a download, so a row in
  // one of them with an empty download_path is a catalog defect: nothing in
  // the pipeline can move a row into those states without having fetched it.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare('SELECT video_id, status, download_path FROM videos').all();
  db.close();

  const offending = rows.filter(
    (r) => REQUIRES_MEDIA_STATUSES.includes(r.status) && !(r.download_path || '').trim(),
  );
  assert.deepEqual(offending.map((r) => r.video_id), [],
    'every downloaded row points at where it was downloaded');
});

test('the artifact columns are empty, and that is a known state', {
  skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout',
}, () => {
  // `output_path`, `review_reason`, `selected_timestamp` and `selected_score`
  // are written ONLY by tools/whiteboard_worker.py command_scan, which has
  // never run against this catalog -- the Revere OCR goes through
  // tools/runAllOcr.js, which writes a probe log instead. So `status='done'`
  // points at no artifact through the database.
  //
  // This test pins the FACT, so that a future change to it is deliberate. If
  // the whiteboard scan path starts running, the non-empty count rises and
  // this test fails with a message saying what changed.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM videos WHERE COALESCE(output_path,\'\') <> \'\'').get();
  db.close();
  assert.equal(row.n, 0,
    'the whiteboard scan path has never run against this catalog -- if it has, '
    + 'update this test and the "done points at no artifact" note in CLAUDE.md');
});
