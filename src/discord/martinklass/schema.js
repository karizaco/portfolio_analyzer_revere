'use strict';

/**
 * The table Martin Klass's readings live in.
 *
 * The same shape as `monoszon_readings` and for the same reason: a
 * READING is not a trade. He publishes no position list and no size, so
 * there is nothing to price as a holding and nothing to chain into an
 * episode.
 *
 * THE CLAIM KIND IS THE SCORING GATE, and it lives in the DATA:
 *
 *   forward    an expectation about what has not happened -- SCORED
 *   reported   a result that has already happened -- recorded, NOT
 *              scored, because the price has already moved by the time
 *              the claim is written
 *
 * Every row carries the sentence it was read from, for the same reason
 * `trade_signals.evidence_text` is NOT NULL: a claim you cannot point
 * at is a claim you cannot check.
 */

const { attachDerived } = require('../../db/derivedStore');
const { PARSER_VERSION } = require('./sources');

const DDL = `
CREATE TABLE IF NOT EXISTS martinklass_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT 'martinklass',
    message_id INTEGER NOT NULL,
    discord_message_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    -- market | commodity | crypto | fx | stock
    scope TEXT NOT NULL DEFAULT 'market',
    -- The subject AS HE SAID IT: "zlato", "Ambarella", "EUR/USD".
    subject TEXT NOT NULL DEFAULT '',
    -- The tradeable instrument it is scored with.
    proxy_ticker TEXT NOT NULL DEFAULT '',
    -- bullish | bearish
    stance TEXT NOT NULL DEFAULT 'neutral',
    -- forward | reported
    claim_kind TEXT NOT NULL DEFAULT 'forward',
    -- intraday | swing | 1w | 1m | long
    horizon TEXT NOT NULL DEFAULT '',
    horizon_text TEXT NOT NULL DEFAULT '',
    -- high | medium
    confidence TEXT NOT NULL DEFAULT 'medium',
    -- The EXACT sentence this reading was read from. NOT NULL.
    evidence_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, subject, stance, claim_kind, parser_version)
);

CREATE INDEX IF NOT EXISTS idx_martinklass_readings_date
    ON martinklass_readings(as_of_date, claim_kind);
CREATE INDEX IF NOT EXISTS idx_martinklass_readings_proxy
    ON martinklass_readings(proxy_ticker, as_of_date);
CREATE INDEX IF NOT EXISTS idx_martinklass_readings_message
    ON martinklass_readings(message_id);
`;

/**
 * Make sure the table exists in the derived file.
 *
 * @param {object} db  a catalog connection (it will ATTACH derived)
 * @returns {number} how many statements were executed
 */
function ensureMartinKlassSchema(db) {
  db.exec('PRAGMA busy_timeout = 60000');
  attachDerived(db);
  try {
    db.exec(DDL);
  } catch (error) {
    if (!String(error && error.message).includes('already exists')) throw error;
  }
  return 1;
}

module.exports = {
  DDL,
  PARSER_VERSION,
  ensureMartinKlassSchema,
};
