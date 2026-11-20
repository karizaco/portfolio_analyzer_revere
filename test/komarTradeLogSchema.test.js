'use strict';

// The Komar TRADE LOG's schema shape.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The first shape of komar_trade_log was written from the PLAN's column
// list, which guessed at the sheet's headers. The measured header (18
// columns, read off the pixels on 2026-11-17) has Avg. OPENING and Avg.
// CLOSE price as two columns, ONE Risk Capital, MMTS Opening/close as
// words, and W/L % beside W/L R -- there is no MARS column and no W%L
// flag. The table was EMPTY when the shape was corrected, so the old
// columns were dropped rather than left behind as dead names.
//
// A table that holds ROWS is never dropped: there is no honest
// automatic rewrite from one shape to the other, so that case grows the
// new columns additively and keeps the old ones.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ensureDerivedSchema } = require('../src/db/derivedStore');
const { ensureKomarSchema, reshapeTradeLogTable } = require('../src/komar/schema');

const OLD_SHAPE = `CREATE TABLE derived.komar_trade_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0, row_index INTEGER NOT NULL DEFAULT 0,
  date_opened TEXT NOT NULL DEFAULT '', date_closed TEXT NOT NULL DEFAULT '',
  entry_type TEXT NOT NULL DEFAULT '', ticker TEXT NOT NULL DEFAULT '',
  avg_price REAL, stop_loss_pct REAL, risk_size_pct REAL, stop_loss_price REAL,
  risk_vs_capital_pct REAL, exit_type TEXT NOT NULL DEFAULT '',
  mars_open_close REAL, mmts_open_close REAL, wl_flag TEXT NOT NULL DEFAULT '',
  wl_pct REAL, initial_rating REAL, after_close_rating REAL,
  review TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0, parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doc_id, page, row_index)
)`;

/**
 * A derived file with an old-shape trade log in it.
 */
function oldShapeDb(withRow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-tradelog-schema-'));
  const derivedPath = path.join(dir, 'derived.sqlite');
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  ensureDerivedSchema(derivedPath);
  db.prepare('ATTACH DATABASE ? AS derived').run(derivedPath);
  db.exec('DROP TABLE derived.komar_trade_log');
  db.exec(OLD_SHAPE);
  if (withRow) {
    db.prepare(`INSERT INTO derived.komar_trade_log (doc_id, ticker, avg_price, parser_version)
      VALUES ('komar_doc_deck_trades-august-2025', 'QS', 7.18, 'komar-tradelog-0')`).run();
  }
  return {
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    db,
    derivedPath,
  };
}

function columnsOf(ctx) {
  return ctx.db
    .prepare("SELECT name FROM derived.pragma_table_info('komar_trade_log')")
    .all()
    .map((row) => row.name);
}

test('an old-shape trade log is reshaped while it holds no rows', () => {
  const ctx = oldShapeDb(false);
  try {
    const reshaped = reshapeTradeLogTable(ctx.db, { derivedPath: ctx.derivedPath });
    assert.ok(reshaped, 'the old shape was reshaped');

    const columns = columnsOf(ctx);
    for (const wanted of [
      'avg_open_price', 'avg_close_price', 'risk_capital_pct', 'mmts_opening',
      'mmts_close', 'wl_r', 'reading_check', 'derived_fields',
    ]) {
      assert.ok(columns.includes(wanted), `${wanted} is on the new shape`);
    }
    for (const gone of ['avg_price', 'mars_open_close', 'wl_flag', 'risk_size_pct']) {
      assert.ok(!columns.includes(gone), `${gone} is gone`);
    }
  } finally {
    ctx.cleanup();
  }
});

test('a trade log with rows is NEVER dropped', () => {
  const ctx = oldShapeDb(true);
  try {
    const reshaped = reshapeTradeLogTable(ctx.db, { derivedPath: ctx.derivedPath });
    assert.equal(reshaped, false, 'a table with rows is not reshaped');
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS c FROM derived.komar_trade_log').get().c,
      1,
      'the row is still there'
    );

    // And the new columns arrive additively, so the writer still works.
    ensureKomarSchema(ctx.db, { derivedPath: ctx.derivedPath });
    const columns = columnsOf(ctx);
    assert.ok(columns.includes('avg_open_price'));
    assert.ok(columns.includes('wl_r'));
    assert.ok(columns.includes('avg_price'), 'and the old column is still there');
  } finally {
    ctx.cleanup();
  }
});

test('the shipped schema file carries the sheet\'s own eighteen columns', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'db', 'schema_derived.sql'),
    'utf8'
  );
  const block = /CREATE TABLE IF NOT EXISTS komar_trade_log \([\s\S]*?\n\);/.exec(schema);
  assert.ok(block, 'the schema file has the table');
  for (const column of [
    'date_opened', 'date_closed', 'entry_type', 'ticker', 'avg_open_price',
    'avg_close_price', 'stop_loss_price', 'stop_loss_pct', 'risk_capital_pct',
    'exit_type', 'mmts_opening', 'mmts_close', 'wl_pct', 'wl_r',
    'initial_rating', 'after_close_rating', 'review', 'comment',
  ]) {
    assert.match(block[0], new RegExp(`\\n\\s*${column}\\s`), `${column} is in the schema`);
  }
});
