'use strict';

/**
 * The Komar schema, and the columns an existing database may be missing.
 *
 * WHY THIS EXISTS
 *
 * `data/db/schema_derived.sql` holds the CREATE TABLE statements, so a
 * fresh clone is correct. A database that already has the tables does
 * not gain a new column from a CREATE TABLE IF NOT EXISTS -- it keeps
 * the shape it was created with.
 *
 * So a column added to the schema has to be added to an EXISTING
 * database too, and that is what this module is for: a guarded ALTER
 * that is a no-op when the column is already there.
 *
 * That is the project's established pattern. `src/oconnell/schema.js`
 * does it for `oconnell_positions.exits`, and
 * `tools/extractSevcikSetups.js` does it three times for `sevcik_setups`.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  attachDerived,
  derivedPathFor,
  ensureDerivedSchema,
  tableHome,
} = require('../db/derivedStore');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema_derived.sql');

/**
 * The columns an existing Komar database may be missing.
 *
 * Each is added with a guarded ALTER: SQLite has no "ADD COLUMN IF
 * NOT EXISTS", so the error is caught and ignored, which is exactly what
 * the project's other tools do.
 */
const LATE_COLUMNS = [
  { column: 'date_conflict', table: 'komar_documents', type: 'INTEGER NOT NULL DEFAULT 0' },
  { column: 'filename_date', table: 'komar_documents', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'chapters_json', table: 'komar_documents', type: "TEXT NOT NULL DEFAULT '[]'" },
  { column: 'provenance', table: 'komar_documents', type: "TEXT NOT NULL DEFAULT 'primary'" },
  { column: 'session_doc_id', table: 'komar_videos', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'content_key', table: 'komar_videos', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'session_date_precision', table: 'komar_documents', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'session_date_precision', table: 'komar_videos', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'trend_by_horizon_json', table: 'komar_market_cards', type: "TEXT NOT NULL DEFAULT '{}'" },
  // The trade log's columns were re-shaped to the sheet's own 18
  // headers (see schema_derived.sql). These are the columns the NEW
  // shape adds; on an old-shape table that could not be dropped (it
  // has rows), they are added so the writer still works.
  { column: 'avg_open_price', table: 'komar_trade_log', type: 'REAL' },
  { column: 'avg_close_price', table: 'komar_trade_log', type: 'REAL' },
  { column: 'risk_capital_pct', table: 'komar_trade_log', type: 'REAL' },
  { column: 'mmts_opening', table: 'komar_trade_log', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'mmts_close', table: 'komar_trade_log', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'wl_r', table: 'komar_trade_log', type: 'REAL' },
  { column: 'reading_check', table: 'komar_trade_log', type: "TEXT NOT NULL DEFAULT ''" },
  { column: 'derived_fields', table: 'komar_trade_log', type: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Reshape an old `komar_trade_log` to the sheet's own columns.
 *
 * The first shape was written from the plan's column list, which
 * guessed at the sheet's headers; the measured header (18 columns,
 * read off the pixels on 2026-11-17) has Avg. OPENING and Avg. CLOSE
 * price as two columns, one Risk Capital, MMTS Opening/close as words,
 * and W/L % beside W/L R. `avg_price` marks the old shape.
 *
 * A table with ROWS is never dropped -- there is no honest automatic
 * rewrite from one shape to the other -- so the old-shape-with-rows
 * case falls through to the additive LATE_COLUMNS above instead.
 *
 * @param {object} db - a connection with the derived file attached
 * @param {object} [options] - passed through to `derivedPathFor`
 * @returns {boolean} whether the reshape happened
 */
function reshapeTradeLogTable(db, options = {}) {
  const home = tableHome(db, 'komar_trade_log');
  if (!home) return false;
  const columns = db
    .prepare(`SELECT name FROM ${home}.pragma_table_info('komar_trade_log')`)
    .all()
    .map((row) => row.name);
  if (!columns.includes('avg_price')) return false; // already the new shape
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${home}.komar_trade_log`).get();
  if (n > 0) return false; // never drop a table that holds rows
  db.exec(`DROP TABLE ${home}.komar_trade_log`);
  // Re-run the schema file: every statement is IF NOT EXISTS, so only
  // the dropped table (and its two indexes) come back.
  ensureDerivedSchema(derivedPathFor(db, options.derivedPath));
  return true;
}

/**
 * Make sure the Komar tables exist and carry every column.
 *
 * @param {object} db
 * @param {object} [options] - passed to `attachDerived`; `derivedPath`
 *   points the attach at another file, which is how a test gets an
 *   isolated database instead of the shipped one.
 * @returns {number} how many columns were added
 */
function ensureKomarSchema(db, options = {}) {
  // `state.sqlite` is shared: other sessions' transcript and catalog tools
  // write to it too, and SQLite's default is to fail IMMEDIATELY with
  // "database is locked".
  db.exec('PRAGMA busy_timeout = 60000');
  // The tables live in the derived file. The ALTER has to see that
  // table, not create a second one in the catalog -- and that is exactly
  // why the attach happens BEFORE the ALTERs and not after them.
  attachDerived(db, options);
  reshapeTradeLogTable(db, options);
  let added = 0;
  for (const entry of LATE_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.type}`);
      added += 1;
    } catch {
      // The column is already there, or the table is not: either way
      // there is nothing to do.
    }
  }
  return added;
}

module.exports = { LATE_COLUMNS, SCHEMA_PATH, ensureKomarSchema, reshapeTradeLogTable };



