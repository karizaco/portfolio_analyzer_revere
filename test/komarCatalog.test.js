'use strict';

// The catalog tool's own contracts.
//
// THE BUG THIS FILE EXISTS TO PREVENT
//
// The catalog writes its rows with an upsert:
//
//     ON CONFLICT(video_id) DO UPDATE SET ...
//
// and the SET list is written out by hand, one column at a time. A
// column added to the INSERT and forgotten in the SET list is written
// exactly once -- on the run that INSERTS the row -- and never again:
// every later run conflicts, updates the columns it does list, and
// leaves the new one at whatever the first run put there.
//
// That is how `session_date_precision` stayed empty for every one of
// the 116 videos while the catalog reported them as up to date. The
// catalog's own diff says "unchanged", so nothing announces it.
//
// So the rule is pinned here: every column in the INSERT has to appear
// in the UPDATE list. This test reads the tool's source and checks it,
// because a column list is exactly the thing that has to change
// together with the schema and nothing at runtime will complain.
//
// THE OTHER THING PINNED HERE
//
// A document that names its MONTH does not get to link a video by
// date. "Trades-August-2025.pdf" carries July 2025 in its content, and
// every video that mentions July 2025 would otherwise be linked to it
// -- including the two that have nothing to do with each other.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildManifest,
  buildVideoRows,
  diffAgainstCatalog,
  documentIdFor,
  findIdCollisions,
  probeVideo,
  removeStaleRows,
  resolveDocumentDate,
  videoIdFor,
  writeDocumentRows,
  writeVideoRows,
} = require('../tools/catalogKomar');
const { ensureKomarSchema } = require('../src/komar/schema');

const TOOL_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'tools', 'catalogKomar.js'), 'utf8');
const { DatabaseSync } = require('node:sqlite');

/**
 * A fresh derived file and a fresh catalog, for the write path.
 */
function isolatedDatabases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-catalog-'));
  const derivedPath = path.join(dir, 'derived.sqlite');
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  return {
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    db,
    derivedPath,
  };
}

/** The conflict key each table upserts on. */
const CONFLICT_KEY = {
  komar_documents: 'doc_id',
  komar_videos: 'video_id',
};

/**
 * The column list of an INSERT, and the columns its UPDATE sets.
 */
function upsertColumns(table) {
  const insert = new RegExp(`INSERT INTO ${table} \\(([^)]*)\\)`, 'i').exec(TOOL_SOURCE);
  assert.ok(insert, `${table} has an INSERT`);
  const columns = insert[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((name) => name !== 'created_at' && name !== 'updated_at' && name !== CONFLICT_KEY[table]);

  const marker = `ON CONFLICT(${CONFLICT_KEY[table]}) DO UPDATE SET`;
  const start = TOOL_SOURCE.indexOf(marker);
  assert.ok(start !== -1, `${table} has an upsert`);
  const end = TOOL_SOURCE.indexOf('`);', start);
  assert.ok(end !== -1, `${table}'s upsert is closed`);
  const block = TOOL_SOURCE.slice(start + marker.length, end);
  const set = new Set();
  for (const match of block.matchAll(/(\w+)\s*=\s*excluded\.\1/g)) {
    set.add(match[1]);
  }
  return { columns, set };
}

test('every inserted column is also updated on a conflict', () => {
  for (const table of ['komar_documents', 'komar_videos']) {
    const { columns, set } = upsertColumns(table);
    for (const column of columns) {
      assert.ok(set.has(column), `${table}.${column} is inserted but never updated on a conflict`);
    }
  }
});

test('the precision column is one of them', () => {
  // The column that was silently dropped. It is named here so that
  // removing it from the SET list fails THIS test and not a run.
  for (const table of ['komar_documents', 'komar_videos']) {
    const { columns, set } = upsertColumns(table);
    assert.ok(columns.includes('session_date_precision'));
    assert.ok(set.has('session_date_precision'));
  }
});

test("a document's own date beats its filename, and the disagreement is kept", () => {
  const resolved = resolveDocumentDate(
    { fileDate: '20260408', fileDatePrecision: 'day', slug: '' },
    { titleDate: '20250408', titleDatePrecision: 'day', urlDate: '20250408' }
  );
  assert.equal(resolved.date, '20250408');
  assert.equal(resolved.source, 'chrome_title');
  assert.equal(resolved.precision, 'day');
  assert.equal(resolved.conflict, true);
});

test('a document with no date of its own falls back to its filename', () => {
  const resolved = resolveDocumentDate(
    { fileDate: '20250125', fileDatePrecision: 'day', slug: '' },
    { titleDate: '', titleDatePrecision: '', urlDate: '', urlDatePrecision: '' }
  );
  assert.equal(resolved.date, '20250125');
  assert.equal(resolved.source, 'filename');
  assert.equal(resolved.conflict, false);
});

test('a MONTH-precision date does not link a video to a document', () => {
  const documents = [
    {
      doc_id: 'komar_doc_deck_trades-august-2025',
      report_number: '',
      session_date: '20250701',
      session_date_precision: 'month',
    },
  ];
  const videos = [
    {
      datePrecision: 'month',
      fileName: 'Trade Review July 2025 MARKET UPDATE Premium.mp4',
      folder: '',
      kind: 'lesson',
      part: '',
      partIndex: 0,
      reportNumber: '',
      sessionDate: '20250701',
      slug: 'trade-review-july-2025-market-update-premium',
      title: 'Trade Review July 2025',
    },
  ];
  const rows = buildVideoRows(videos, documents, 'D:/somewhere');
  assert.equal(rows[0].session_date, '20250701');
  assert.equal(rows[0].session_date_precision, 'month');
  // The link is NOT made: the document names a month, and so does the
  // video, and two things that both say "July 2025" are not thereby
  // the same thing.
  assert.equal(rows[0].session_doc_id, '');
  assert.equal(rows[0].session_date_source, 'filename');
});

test('a DAY-precision date does link a video to its document', () => {
  const documents = [
    {
      doc_id: 'komar_doc_report_20260509',
      report_number: '226',
      session_date: '20260509',
      session_date_precision: 'day',
    },
  ];
  const videos = [
    {
      datePrecision: '',
      fileName: 'Weekend-Report 226 - Stocks Analysis.mp4',
      folder: '',
      kind: 'weekend',
      part: 'stocks_analysis',
      partIndex: 3,
      reportNumber: '226',
      sessionDate: '',
      slug: 'weekend-report-226-stocks-analysis',
      title: 'Weekend-Report 226 - Stocks Analysis',
    },
  ];
  const rows = buildVideoRows(videos, documents, 'D:/somewhere');
  assert.equal(rows[0].session_date, '20260509');
  assert.equal(rows[0].session_date_source, 'pdf_chrome');
  assert.equal(rows[0].session_doc_id, 'komar_doc_report_20260509');
});

test('two files for one id are reported, not silently merged', () => {
  const collisions = findIdCollisions(
    [
      { doc_id: 'komar_doc_report_20260509', pdf_path: 'a.pdf' },
      { doc_id: 'komar_doc_report_20260509', pdf_path: 'b.pdf' },
    ],
    'doc_id'
  );
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].files, ['a.pdf', 'b.pdf']);
});

test('the ids the catalog builds are the channel module\'s ids', () => {
  assert.equal(
    documentIdFor({ slug: 'x' }, { kind: 'report' }, { date: '20260509' }),
    'komar_doc_report_20260509'
  );
  assert.equal(
    videoIdFor({ kind: 'weekend', reportNumber: '226', part: 'stocks_analysis' }),
    'komar_vid_weekend_226_stocks_analysis'
  );
});

test('the diff counts a changed checksum as an update', () => {
  const db = {
    prepare() {
      return {
        all() {
          return [
            { doc_id: 'komar_doc_report_20260509', pdf_checksum: 'old' },
            { video_id: 'komar_vid_weekend_226_stocks_analysis', content_key: 'old' },
          ];
        },
      };
    },
  };
  const counts = diffAgainstCatalog(
    db,
    [{ doc_id: 'komar_doc_report_20260509', pdf_checksum: 'new' }],
    [{ video_id: 'komar_vid_weekend_226_stocks_analysis', content_key: 'new' }]
  );
  assert.equal(counts.documentsUpdated, 1);
  assert.equal(counts.videosUpdated, 1);
});



// ---------------------------------------------------------------------------
// The catalog's own write path, on an isolated database.
//
// The write path is where the ON CONFLICT bug lived, so it is worth
// exercising end to end rather than only reading the source.
// ---------------------------------------------------------------------------

test('a row survives the round trip through the database', () => {
  const ctx = isolatedDatabases();
  try {
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    writeDocumentRows(ctx.db, [
      {
        chapters: ['12:35', '41:04'],
        date_conflict: 1,
        doc_id: 'komar_doc_post_20250408',
        filename_date: '20260408',
        folder: '',
        kind: 'post',
        page_count: 4,
        pdf_bytes: 811926,
        pdf_checksum: 'abc',
        pdf_path: 'komar_20260408.pdf',
        print_stamp: '2026-05-10, 12:38',
        provenance: 'primary',
        report_number: '',
        series: 'Mid-Week Update',
        session_date: '20250408',
        session_date_precision: 'day',
        session_date_source: 'chrome_title',
        source_url: 'https://members.julian-komar.com/c/questions/x',
        title: 'April 8, 2025 - Mid-Week Update',
      },
    ]);
    const row = ctx.db
      .prepare('SELECT * FROM komar_documents WHERE doc_id = ?')
      .get('komar_doc_post_20250408');
    assert.equal(row.session_date, '20250408');
    assert.equal(row.session_date_precision, 'day');
    assert.equal(row.date_conflict, 1);
    assert.deepEqual(JSON.parse(row.chapters_json), ['12:35', '41:04']);
    assert.equal(row.provenance, 'primary');
  } finally {
    ctx.cleanup();
  }
});

test('writing the same row twice UPDATES it rather than duplicating it', () => {
  const ctx = isolatedDatabases();
  try {
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    const row = {
      chapters: [],
      date_conflict: 0,
      doc_id: 'komar_doc_report_20260509',
      filename_date: '20260509',
      folder: '',
      kind: 'report',
      page_count: 8,
      pdf_bytes: 1,
      pdf_checksum: 'one',
      pdf_path: 'komar_20260509.pdf',
      print_stamp: '',
      provenance: 'primary',
      report_number: '226',
      series: 'Weekend-Report',
      session_date: '20260509',
      session_date_precision: 'day',
      session_date_source: 'chrome_title',
      source_url: '',
      title: 'Weekend-Report #226',
    };
    writeDocumentRows(ctx.db, [row]);
    writeDocumentRows(ctx.db, [{ ...row, pdf_checksum: 'two', title: 'A NEW TITLE' }]);
    const rows = ctx.db.prepare('SELECT pdf_checksum, title FROM komar_documents').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pdf_checksum, 'two');
    assert.equal(rows[0].title, 'A NEW TITLE');
  } finally {
    ctx.cleanup();
  }
});

test('a row that leaves the corpus is removed', () => {
  const ctx = isolatedDatabases();
  try {
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    writeDocumentRows(ctx.db, [
      {
        chapters: [], date_conflict: 0, doc_id: 'komar_doc_report_20260509', filename_date: '',
        kind: 'report', folder: '', page_count: 1, pdf_bytes: 1, pdf_checksum: 'x', pdf_path: 'a.pdf',
        print_stamp: '', provenance: 'primary', report_number: '', series: '',
        session_date: '', session_date_precision: '', session_date_source: '', source_url: '',
        title: '',
      },
    ]);
    writeVideoRows(ctx.db, [
      {
        audio_channels: 2, audio_codec: 'aac', content_key: 'k', duration_sec: 10, folder: '',
        has_video: 1, height: 1080, kind: 'lesson', media_path: 'a.mp4', part: '', series: '',
        part_index: 0, report_number: '', session_date: '', session_date_precision: '',
        session_date_source: '', session_doc_id: '', size_bytes: 1, title: 'a',
        video_id: 'komar_vid_lesson_a', width: 1920,
      },
    ]);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_documents').get().c, 1);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_videos').get().c, 1);

    // The corpus now holds neither of them.
    const removed = removeStaleRows(ctx.db, [], []);
    assert.equal(removed, 2);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_documents').get().c, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_videos').get().c, 0);
  } finally {
    ctx.cleanup();
  }
});

test('the manifest carries the summary the report needs', () => {
  const manifest = buildManifest(
    [
      { kind: 'report', date_conflict: 1, session_date: '20260509' },
      { kind: 'deck', date_conflict: 0, session_date: '20250701' },
    ],
    [
      {
        audio_channels: 2, audio_codec: 'aac', content_key: 'k', duration_sec: 3600,
        folder: '', has_video: 1, height: 1080, kind: 'weekend', media_path: 'a.mp4',
        part: 'main', part_index: 1, report_number: '226', session_date: '20260509',
        session_date_precision: 'day', session_date_source: 'pdf_chrome',
        session_doc_id: 'komar_doc_report_20260509', size_bytes: 1, title: 'a',
        video_id: 'komar_vid_weekend_226_main', width: 1920,
      },
      {
        audio_channels: 0, audio_codec: '', content_key: 'k2', duration_sec: 0, folder: '',
        has_video: 0, height: 0, kind: 'lesson', media_path: 'b.mp4', part: '', series: '',
        part_index: 0, report_number: '', session_date: '', session_date_precision: '',
        session_date_source: '', session_doc_id: '', size_bytes: 1, title: 'b',
        video_id: 'komar_vid_lesson_b', width: 0,
      },
    ],
    { skipped: [{ name: 'notes.txt' }] }
  );
  assert.equal(manifest.summary.documents, 2);
  assert.equal(manifest.summary.videos, 2);
  assert.equal(manifest.summary.date_conflicts, 1);
  assert.equal(manifest.summary.documents_by_kind.report, 1);
  assert.equal(manifest.summary.videos_by_kind.weekend, 1);
  assert.equal(manifest.summary.total_duration_hours, 1);
  assert.equal(manifest.summary.videos_with_a_session_date, 1);
  assert.equal(manifest.summary.videos_with_a_document, 1);
  assert.equal(manifest.summary.skipped_entries, 1);
  assert.equal(manifest.source, 'komar');
});

test('a video that does not exist is probed, not guessed at', () => {
  const probe = probeVideo(path.join(os.tmpdir(), 'komar-no-such-video-xyz.mp4'));
  assert.ok(probe.error, 'the probe reports the failure');
  assert.equal(probe.hasVideo, undefined);
});




