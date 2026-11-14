'use strict';

/**
 * The O'Connell schema, and the one column it had to grow.
 *
 * WHY THIS EXISTS
 *
 * `data/db/schema.sql` holds the CREATE TABLE statements, so a fresh
 * clone is correct. A database that already has the tables does not
 * gain a new column from a CREATE TABLE IF NOT EXISTS -- it keeps the
 * shape it was created with.
 *
 * So a column added to the schema has to be added to an EXISTING
 * database too, and that is what this module is for: a guarded ALTER
 * that is a no-op when the column is already there.
 *
 * That is the project's established pattern. `src/transcript/extractRunner.js`
 * does it for `trade_signals.claim_kind`, and
 * `tools/extractSevcikSetups.js` does it three times for `sevcik_setups`.
 *
 * THE COLUMN
 *
 * `oconnell_positions.exits` holds the sheet's own "Exits" column -- the
 * exits he has already taken on a lot. It was in the reader from the
 * first version and missing from the schema, so the first run wrote it
 * nowhere.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/**
 * The columns an existing O'Connell database may be missing.
 *
 * Each is added with a guarded ALTER: SQLite has no "ADD COLUMN IF
 * NOT EXISTS", so the error is caught and ignored, which is exactly what
 * the project's other tools do.
 */
const LATE_COLUMNS = [
  { column: 'exits', table: 'oconnell_positions', type: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Make sure the O'Connell tables exist and carry every column.
 *
 * @param {object} db
 * @returns {number} how many columns were added
 */
function ensureOconnellSchema(db) {
  // `state.sqlite` is shared: other sessions' transcript and catalog tools
  // write to it too, and SQLite's default is to fail IMMEDIATELY with
  // "database is locked". A position run is hours long, so a lock that
  // would clear in seconds must not kill it. Wait up to a minute instead.
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
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

module.exports = { LATE_COLUMNS, SCHEMA_PATH, ensureOconnellSchema };
