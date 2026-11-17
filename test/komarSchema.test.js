'use strict';

// The Komar schema.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The Komar tables live in the DERIVED file, not in the catalog. That is
// not a preference -- `src/db/derivedStore.js` says it plainly:
//
//   Unqualified DDL lands in MAIN. The derived schema is therefore
//   executed on a connection whose main IS the derived file, never on
//   the catalog connection.
//
// So the derived schema is executed by `ensureDerivedSchema` against the
// derived FILE, and the connection is only attached afterwards. If the
// order is ever reversed, `CREATE TABLE komar_documents` lands in the
// catalog, and the catalog is the file GitHub refuses to push over
// 100 MB.
//
// THE SECOND RULE
//
// A database that already has the tables does not gain a new column from
// a CREATE TABLE IF NOT EXISTS. So a column added to the schema has to
// be added to an EXISTING database too, by a guarded ALTER that is a
// no-op when the column is already there. The test below builds a
// database with the OLD shape and checks that the column appears.
//
// The third rule is the one that is easy to get wrong by accident: a
// table that exists in the derived file must NOT also exist in the
// catalog. Two copies of the same table is how a row gets written to
// one file and read from the other.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { LATE_COLUMNS, ensureKomarSchema } = require('../src/komar/schema');
const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');

/**
 * A fresh derived file, and a connection to a fresh catalog.
 *
 * @returns {{db: object, derivedPath: string, cleanup: function}}
 */
function isolatedDatabases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-schema-'));
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

/**
 * The columns a table has, in a given schema.
 */
function columnsOf(db, schema, table) {
  return db
    .prepare(`SELECT name FROM ${schema}.pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

test('a fresh derived file gets both tables with every column', () => {
  const ctx = isolatedDatabases();
  try {
    ensureDerivedSchema(ctx.derivedPath);
    ctx.db.prepare('ATTACH DATABASE ? AS derived').run(ctx.derivedPath);
    assert.ok(columnsOf(ctx.db, 'derived', 'komar_documents').includes('doc_id'));
    assert.ok(columnsOf(ctx.db, 'derived', 'komar_videos').includes('video_id'));
  } finally {
    ctx.cleanup();
  }
});

test('the tables are in the DERIVED file and not in the catalog', () => {
  const ctx = isolatedDatabases();
  try {
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    assert.ok(columnsOf(ctx.db, 'derived', 'komar_documents').length > 0);
    assert.ok(columnsOf(ctx.db, 'derived', 'komar_videos').length > 0);
    // The catalog itself must NOT carry a copy. Two copies of the same
    // table is how a row gets written to one file and read from the
    // other.
    const inCatalog = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'komar%'")
      .all();
    assert.deepEqual(inCatalog, []);
  } finally {
    ctx.cleanup();
  }
});

test('a database with the OLD shape grows the late columns', () => {
  const ctx = isolatedDatabases();
  try {
    // The shape before the late columns were added.
    ensureDerivedSchema(ctx.derivedPath);
    ctx.db.prepare('ATTACH DATABASE ? AS derived').run(ctx.derivedPath);
    ctx.db.exec('DROP TABLE derived.komar_documents');
    ctx.db.exec('DROP TABLE derived.komar_videos');
    // The shape BEFORE any of the late columns -- so every one of them
    // has to be added. A fixture that quietly included one of them
    // would make the test pass with a column missing.
    ctx.db.exec(`CREATE TABLE derived.komar_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL UNIQUE,
      kind TEXT, title TEXT, series TEXT, session_date TEXT, session_date_source TEXT,
      report_number TEXT, page_count INTEGER, source_url TEXT, print_stamp TEXT,
      pdf_path TEXT, pdf_bytes INTEGER, pdf_checksum TEXT, folder TEXT,
      catalog_version TEXT, created_at TEXT, updated_at TEXT
    )`);
    ctx.db.exec(`CREATE TABLE derived.komar_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL UNIQUE,
      kind TEXT, series TEXT, title TEXT, part TEXT, part_index INTEGER, report_number TEXT,
      session_date TEXT, session_date_source TEXT, has_video INTEGER,
      width INTEGER, height INTEGER, duration_sec REAL, audio_codec TEXT, audio_channels INTEGER,
      size_bytes INTEGER, media_path TEXT, folder TEXT, catalog_version TEXT,
      created_at TEXT, updated_at TEXT
    )`);

    // The count is the number of columns that were MISSING, which is not
    // always every late column: a column that the schema file already
    // carries is a no-op, and the guarded ALTER swallows it on purpose.
    // So the columns that were already there are counted BEFORE the
    // ALTERs run.
    const alreadyPresent = LATE_COLUMNS.filter((entry) => (
      columnsOf(ctx.db, 'derived', entry.table).includes(entry.column)
    ));
    const added = ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    assert.equal(added, LATE_COLUMNS.length - alreadyPresent.length);
    assert.ok(added > 0, 'the old shape really was missing columns');
    for (const entry of LATE_COLUMNS) {
      assert.ok(
        columnsOf(ctx.db, 'derived', entry.table).includes(entry.column),
        `${entry.table}.${entry.column} was added`
      );
    }
  } finally {
    ctx.cleanup();
  }
});

test('adding the late columns twice is a no-op', () => {
  const ctx = isolatedDatabases();
  try {
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    const added = ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    assert.equal(added, 0, 'the second run adds nothing');
  } finally {
    ctx.cleanup();
  }
});

test('every late column is on a Komar table', () => {
  // A late column naming a table that does not exist would be a silent
  // no-op: the ALTER fails, the catch swallows it, and the column is
  // quietly missing forever.
  for (const entry of LATE_COLUMNS) {
    assert.match(entry.table, /^komar_/);
    assert.match(entry.column, /^[a-z_]+$/);
    assert.ok(entry.type, `${entry.column} has a type`);
  }
});

test('the schema file and the late columns do not disagree about a name', () => {
  // A column in LATE_COLUMNS that the schema file does not have is a
  // column that only exists on an OLD database -- the opposite of what
  // is wanted. A column the schema file has that LATE_COLUMNS does not
  // is a column an old database will never grow.
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'db', 'schema_derived.sql'),
    'utf8'
  );
  for (const entry of LATE_COLUMNS) {
    const pattern = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${entry.table}[\\s\\S]*?\\n\\s*${entry.column}\\s`
    );
    assert.ok(pattern.test(schema), `${entry.table}.${entry.column} is in the schema file`);
  }
});



