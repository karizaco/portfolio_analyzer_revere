'use strict';

/**
 * Additive Discord derived layers (improvements 1–5).
 * Does NOT alter discord_positions / trade_actions / episodes / clement_posts.
 */

const EXPOSURE_DDL = `
CREATE TABLE IF NOT EXISTS trader_exposures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    trader TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT '',
    size REAL,
    role_or_action TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    ref_table TEXT NOT NULL DEFAULT '',
    ref_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trader_exposures_date_ticker
    ON trader_exposures(as_of_date, ticker);
CREATE INDEX IF NOT EXISTS idx_trader_exposures_trader_date
    ON trader_exposures(trader, as_of_date);

CREATE TABLE IF NOT EXISTS clement_focus_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'long',
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL DEFAULT '',
    still_open INTEGER NOT NULL DEFAULT 0,
    days INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'dashboard_left_ocr',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clement_focus_episodes_ticker
    ON clement_focus_episodes(ticker, entry_date);

CREATE TABLE IF NOT EXISTS discord_attachment_hints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    discord_message_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    attachment_id TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    hint TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_attachment_hints_msg_att
    ON discord_attachment_hints(message_id, attachment_id);

CREATE TABLE IF NOT EXISTS regime_book_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    daily_buy_signal INTEGER,
    weekly_buy_signal INTEGER,
    technical_theme TEXT NOT NULL DEFAULT '',
    drendel_holdings INTEGER NOT NULL DEFAULT 0,
    ariel_open_episodes INTEGER NOT NULL DEFAULT 0,
    clement_focus_tickers INTEGER NOT NULL DEFAULT 0,
    clement_idea_mentions INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regime_book_days_date
    ON regime_book_days(as_of_date);
`;

module.exports = { EXPOSURE_DDL };
