'use strict';

/**
 * The Discord trader tables, and why they are new tables rather than columns
 * on `discord_messages`.
 *
 * `discord_messages` is the INGESTED layer: what a message said, verbatim,
 * with its raw JSON. These tables are the PARSED layer: what the message
 * means for a portfolio. They are derived, so they are rebuilt by
 * `tools/buildDiscordPositions.js` and can be dropped and re-made at any
 * time. The messages themselves are never rewritten.
 *
 * THREE TABLES
 *
 *   discord_positions      a SNAPSHOT's holdings: one row per
 *                          (source, as_of_date, account, side, ticker)
 *   discord_trade_actions  a MESSAGE's action: one row per (message, ticker)
 *   discord_episodes       a POSITION's lifecycle: one row per episode
 *
 * `parser_version` is on every row, so a re-run that changes the parser can
 * be told apart from the previous one -- the same contract
 * `trade_signals.parser_version` has.
 */

const { attachDerived } = require('../db/derivedStore');

const PARSER_VERSION = 'discord-traders-1';

const DDL = `
CREATE TABLE IF NOT EXISTS discord_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    as_of_date TEXT NOT NULL,
    as_of_source TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL,
    sub_account TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL,
    ticker TEXT NOT NULL,
    weight_pct REAL,
    stated_price REAL,
    annotation TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    is_new INTEGER NOT NULL DEFAULT 0,
    snapshot_notes TEXT NOT NULL DEFAULT '',
    header TEXT NOT NULL DEFAULT '',
    long_exposure_pct REAL,
    short_exposure_pct REAL,
    cash_pct REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_positions_date
    ON discord_positions(as_of_date, account, side, ticker);
CREATE INDEX IF NOT EXISTS idx_discord_positions_message
    ON discord_positions(message_id);

CREATE TABLE IF NOT EXISTS discord_trade_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    posted_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL DEFAULT '',
    ticker_inferred INTEGER NOT NULL DEFAULT 0,
    price REAL,
    stop_price REAL,
    stop_text TEXT NOT NULL DEFAULT '',
    size_pct REAL,
    size_note TEXT NOT NULL DEFAULT '',
    fraction REAL,
    fraction_basis TEXT NOT NULL DEFAULT '',
    stated_result_pct REAL,
    atr_multiple REAL,
    verb TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_actions_ticker
    ON discord_trade_actions(source_name, ticker, posted_at);
CREATE INDEX IF NOT EXISTS idx_discord_actions_message
    ON discord_trade_actions(message_id);

CREATE TABLE IF NOT EXISTS discord_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    basis TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    sub_account TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    direction INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    entry_weight REAL,
    entry_price REAL,
    entry_price_at REAL,
    exit_date TEXT NOT NULL DEFAULT '',
    exit_weight REAL,
    exit_price REAL,
    exit_price_at REAL,
    exit_action TEXT NOT NULL DEFAULT '',
    return_pct REAL,
    priced INTEGER NOT NULL DEFAULT 0,
    still_open INTEGER NOT NULL DEFAULT 0,
    left_censored INTEGER NOT NULL DEFAULT 0,
    implied_open INTEGER NOT NULL DEFAULT 0,
    ambiguous_inverse INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_episodes_ticker
    ON discord_episodes(source_name, ticker, entry_date);
`;

/**
 * The columns an existing database may be missing.
 *
 * SQLite has no "ADD COLUMN IF NOT EXISTS", so the error is caught and
 * ignored -- the same thing the project's other schema helpers do.
 *
 *   account   the BOOK a trade action belongs to. It was added for
 *             plechac, who keeps a main book and a "risky" one; the
 *             sources with one book leave it empty.
 */
const LATE_COLUMNS = [
  { table: 'discord_trade_actions', column: 'account', type: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Make sure the tables exist.
 *
 * @param {object} db
 * @returns {number} how many statements were executed
 */
function ensureDiscordSchema(db) {
  // The parsed tables live in derived.sqlite. Executing DDL on this
  // connection would create them in the catalog, which is the file the
  // split exists to keep small.
  db.exec('PRAGMA busy_timeout = 60000');
  attachDerived(db);
  let statements = 3;
  for (const entry of LATE_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.type}`);
      statements += 1;
    } catch {
      // The column is already there. SQLite has no IF NOT EXISTS for
      // ADD COLUMN, so "duplicate column name" is the success case.
    }
  }
  return statements;
}

module.exports = { DDL, LATE_COLUMNS, PARSER_VERSION, ensureDiscordSchema };
