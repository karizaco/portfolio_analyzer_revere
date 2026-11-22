'use strict';

/**
 * Clement derived tables.
 *
 *   clement_posts   one row per message we interpret
 *   clement_ideas   one row per ticker/theme idea pulled from a caption
 *
 * Both live in derived.sqlite (via attachDerived). Rebuild with
 * tools/buildClementIdeas.js — messages are never rewritten.
 */

const { attachDerived } = require('../../db/derivedStore');
const { PARSER_VERSION } = require('./sources');

const DDL = `
CREATE TABLE IF NOT EXISTS clement_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT 'clement',
    message_id INTEGER NOT NULL,
    discord_message_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    as_of_source TEXT NOT NULL DEFAULT '',
    post_kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    image_count INTEGER NOT NULL DEFAULT 0,
    primary_attachment_id TEXT NOT NULL DEFAULT '',
    idea_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clement_posts_date
    ON clement_posts(as_of_date, post_kind);
CREATE INDEX IF NOT EXISTS idx_clement_posts_message
    ON clement_posts(message_id);

CREATE TABLE IF NOT EXISTS clement_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT 'clement',
    message_id INTEGER NOT NULL,
    discord_message_id TEXT NOT NULL DEFAULT '',
    as_of_date TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'mention',
    theme TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT 'medium',
    source TEXT NOT NULL DEFAULT 'caption',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clement_ideas_date_ticker
    ON clement_ideas(as_of_date, ticker);
CREATE INDEX IF NOT EXISTS idx_clement_ideas_message
    ON clement_ideas(message_id);
CREATE INDEX IF NOT EXISTS idx_clement_ideas_ticker
    ON clement_ideas(ticker, as_of_date);
`;

/**
 * Ensure Clement tables exist in the derived file.
 *
 * @param {object} db catalog connection (will ATTACH derived)
 */
function ensureClementSchema(db) {
  db.exec('PRAGMA busy_timeout = 60000');
  attachDerived(db);
  // Create on the derived connection if the unqualified name is missing.
  // attachDerived + schema_derived.sql bootstrap usually already created them;
  // this is a safety path for fresh clones.
  try {
    db.exec(DDL);
  } catch (err) {
    // If tables already exist in derived and main has no shadow, CREATE IF NOT EXISTS is fine.
    // Some attach modes put DDL on main — ensureDerivedSchema is the canonical path.
    if (!String(err && err.message).includes('already exists')) {
      // fall through: build tool also calls ensureDerivedSchema
    }
  }
  return 2;
}

module.exports = {
  DDL,
  PARSER_VERSION,
  ensureClementSchema,
};
