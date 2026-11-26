'use strict';

/**
 * The table David's calls live in.
 *
 * WHY A TABLE OF ITS OWN
 *
 * A reading is not a trade: he does not publish a position, a size or an
 * entry, and a call he made on an index is not a holding. The tables the
 * Discord traders use are about POSITIONS and their lifecycles, and a
 * reading fits neither.
 *
 * It is also not the shared `market_readings` table, because that table
 * is keyed on a VIDEO and a transcript: `video_id`, `transcript_id`. This
 * source is a chat channel, and the project already has a precedent for
 * a chat source with its own tables -- `clement_posts` and
 * `clement_ideas` -- so this follows that.
 *
 * EVERY ROW CARRIES ITS EVIDENCE
 *
 * `evidence_text` is NOT NULL, for the same reason `trade_signals
 * .evidence_text` is: a call you cannot point at is a call you cannot
 * check. Every reading in this table can be read against the sentence it
 * was read from.
 *
 * THE CLAIM KIND IS THE SCORING GATE
 *
 *   forward        a call about the future -- SCORED
 *   retrospective  a call about what already happened -- not scored
 *   present        a position he holds right now -- not scored
 *
 * The gate lives in the DATA and not in the reader: a query that wants
 * only the scorable calls says `WHERE claim_kind = 'forward'`.
 */

const { attachDerived } = require('../../db/derivedStore');
const { PARSER_VERSION } = require('./sources');

const DDL = `
CREATE TABLE IF NOT EXISTS monoszon_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT 'monoszon',
    message_id INTEGER NOT NULL,
    discord_message_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    -- What the reading is about.
    --   market      an index or the tape as a whole
    --   sector      a sector ETF
    --   commodity   gold, silver, oil
    --   crypto      bitcoin
    --   bond        the long bond
    --   stock       one of the few individual names he names
    scope TEXT NOT NULL DEFAULT 'market',
    -- The subject AS HE SAID IT: "NQ", "zlato", "SPX".
    subject TEXT NOT NULL DEFAULT '',
    -- The tradeable instrument it is scored with: QQQ for the Nasdaq
    -- 100 future, SPY for the S&P 500 future, GLD for gold.
    proxy_ticker TEXT NOT NULL DEFAULT '',
    -- bullish | bearish | mixed
    stance TEXT NOT NULL DEFAULT 'neutral',
    -- forward | retrospective | present
    claim_kind TEXT NOT NULL DEFAULT 'forward',
    -- The horizon he stated: intraday | swing | 1w | 1m | 1y
    horizon TEXT NOT NULL DEFAULT '',
    horizon_text TEXT NOT NULL DEFAULT '',
    -- The price level he named, when he named one. It is NOT the entry:
    -- the project's price model enters at the close on the message date.
    level TEXT NOT NULL DEFAULT '',
    -- high | medium
    confidence TEXT NOT NULL DEFAULT 'medium',
    -- The EXACT sentence this reading was read from. NOT NULL.
    evidence_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One row per (message, subject, stance, kind): a message that says
    -- the same thing twice says it once.
    UNIQUE(message_id, subject, stance, claim_kind, parser_version)
);

CREATE INDEX IF NOT EXISTS idx_monoszon_readings_date
    ON monoszon_readings(as_of_date, claim_kind);
CREATE INDEX IF NOT EXISTS idx_monoszon_readings_proxy
    ON monoszon_readings(proxy_ticker, as_of_date);
CREATE INDEX IF NOT EXISTS idx_monoszon_readings_message
    ON monoszon_readings(message_id);
`;

/**
 * Make sure the table exists in the derived file.
 *
 * @param {object} db  a catalog connection (it will ATTACH derived)
 * @returns {number} how many statements were executed
 */
function ensureMonoszonSchema(db) {
  db.exec('PRAGMA busy_timeout = 60000');
  attachDerived(db);
  try {
    db.exec(DDL);
  } catch (error) {
    // The table is already there in the derived file, which is the
    // success case; SQLite has no CREATE TABLE IF NOT EXISTS across an
    // ATTACH boundary in every build.
    if (!String(error && error.message).includes('already exists')) throw error;
  }
  return 1;
}

module.exports = {
  DDL,
  PARSER_VERSION,
  ensureMonoszonSchema,
};
