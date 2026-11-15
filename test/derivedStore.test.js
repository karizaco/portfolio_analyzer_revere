'use strict';

// The derived-file attach, and the two ways it can be wrong.
//
// A scratch catalog must not attach the production derived.sqlite: a test
// that did would write into the committed interpretations. And an
// unqualified CREATE on a connection that already has the table in the
// attached file creates a second, empty table in main. Every later
// unqualified read then hits the empty one. That is how the catalog would
// grow back past GitHub's limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const {
  CATALOG_DB_PATH,
  DERIVED_DB_PATH,
  attachDerived,
  ensureDerivedTable,
  tableHome,
} = require('../src/db/derivedStore');

test('a scratch catalog attaches a sibling, not the production derived file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-store-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  try {
    db.exec('CREATE TABLE videos (video_id TEXT)');
    attachDerived(db);
    const attached = db.prepare('PRAGMA database_list').all()
      .find((row) => String(row.name) === 'derived');
    assert.ok(attached, 'derived was not attached');
    assert.equal(path.resolve(attached.file), path.resolve(path.join(dir, 'derived.sqlite')));
    assert.notEqual(path.resolve(attached.file), path.resolve(DERIVED_DB_PATH));
    assert.equal(tableHome(db, 'trade_signals'), 'derived');
    const inMain = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='trade_signals'",
    ).get();
    assert.equal(inMain, undefined);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('creating a derived table does not shadow it in the catalog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-shadow-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  try {
    db.exec('CREATE TABLE videos (video_id TEXT)');
    attachDerived(db);
    db.prepare(
      'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, '
      + 'ticker, evidence_text, parser_version) VALUES (?, 1, 0, 0, ?, ?, ?)',
    ).run('v1', 'NVDA', 'because', 'test');

    // The bug: unqualified CREATE IF NOT EXISTS lands in main even though
    // the table already exists in the attached file.
    ensureDerivedTable(db, 'trade_signals',
      'CREATE TABLE IF NOT EXISTS trade_signals (video_id TEXT)');
    assert.equal(tableHome(db, 'trade_signals'), 'derived');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trade_signals'").get(),
      undefined,
      'the catalog must not gain a shadow trade_signals',
    );
    assert.equal(db.prepare('SELECT ticker FROM trade_signals').get().ticker, 'NVDA');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('the production catalog is the one the helper recognises', () => {
  assert.ok(CATALOG_DB_PATH.endsWith(path.join('data', 'video_pipeline', 'state.sqlite')));
  assert.ok(DERIVED_DB_PATH.endsWith(path.join('data', 'video_pipeline', 'derived.sqlite')));
});
