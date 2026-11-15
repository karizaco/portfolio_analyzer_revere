'use strict';

/**
 * The derived database, attached to the catalog.
 *
 * WHY TWO FILES
 *
 * `state.sqlite` is tracked, and GitHub refuses a push of a file over
 * 100 MB (it warns at 50). On 2026-11-06 the catalog hit 136 MB and the
 * push was refused; `transcript_segments` was split out then. The file
 * grew back to 59 MB, against a 60 MB budget in
 * `test/catalogSizeGuard.test.js`.
 *
 * The growth is the INTERPRETATIONS: signals, setups, readings, the
 * Asym tables, the O'Connell lots, the Discord position parse. They are
 * real data and they stay tracked -- they do not have to share a file
 * with the catalog. `derived.sqlite` holds them. Both files are committed.
 *
 * THE MECHANISM IS AN ATTACH, the same one `transcript_segments` uses.
 * An unqualified `trade_signals` resolves to the attached file once the
 * catalog no longer has that table, so the tools' SQL does not change.
 *
 * Unqualified DDL lands in MAIN. The derived schema is therefore executed
 * on a connection whose main IS the derived file, never on the catalog
 * connection. `tools/whiteboard_worker.py` executes `schema.sql` on every
 * open; a derived CREATE TABLE left in that file would recreate the table
 * in the catalog, which is the bug the segments split exists to prevent.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const CATALOG_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const DERIVED_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'derived.sqlite');
const DERIVED_SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema_derived.sql');

/** Tables that live in the derived file, not the catalog. */
const DERIVED_TABLES = [
  'trade_signals',
  'sevcik_setups',
  'sevcik_ta_features',
  'market_readings',
  'asym_articles',
  'asym_media',
  'asym_frames',
  'asym_frame_ocr',
  'asym_sectors',
  'asym_monitor_sheets',
  'asym_monitor_days',
  'oconnell_setups',
  'oconnell_positions',
  'oconnell_snapshots',
  'oconnell_readings',
  'oconnell_ocr_cache',
  'discord_positions',
  'discord_trade_actions',
  'discord_episodes',
];

/**
 * Create the derived tables in the derived FILE.
 *
 * @param {string} [derivedPath]
 */
function ensureDerivedSchema(derivedPath = DERIVED_DB_PATH) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
  const db = new DatabaseSync(derivedPath);
  try {
    db.exec('PRAGMA busy_timeout = 60000');
    db.exec(fs.readFileSync(DERIVED_SCHEMA_PATH, 'utf8'));
  } finally {
    db.close();
  }
}

function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Which derived file this connection should see.
 *
 * The production catalog attaches the production derived file. A scratch
 * catalog — a test, a one-off copy — attaches a sibling next to itself.
 * Attaching the production file from a temp catalog is how a test would
 * write into the committed interpretations.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [explicit]
 * @returns {string}
 */
function derivedPathFor(db, explicit) {
  if (explicit) return explicit;
  const main = db.prepare('PRAGMA database_list').all()
    .find((row) => String(row.name) === 'main');
  const file = main && main.file ? path.resolve(String(main.file)) : '';
  if (!file) {
    throw new Error('attachDerived needs a file-backed catalog, or an explicit derivedPath');
  }
  if (!samePath(file, CATALOG_DB_PATH)) {
    return path.join(path.dirname(file), 'derived.sqlite');
  }
  return DERIVED_DB_PATH;
}

/**
 * Where an existing table lives: 'main', 'derived', or '' if neither.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {'main'|'derived'|''}
 */
function tableHome(db, name) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
    return 'main';
  }
  const attached = db.prepare('PRAGMA database_list').all()
    .some((row) => String(row.name) === 'derived');
  if (!attached) return '';
  if (db.prepare("SELECT 1 FROM derived.sqlite_master WHERE type='table' AND name=?").get(name)) {
    return 'derived';
  }
  return '';
}

/**
 * Create a derived table without shadowing it in the catalog.
 *
 * Unqualified CREATE always lands in main, even when the same name already
 * exists in the attached file. That shadow is a second, empty table, and
 * every later unqualified read hits the empty one. So when `derived` is
 * attached the DDL is qualified; a scratch connection with no attach
 * (a memory test) still creates the table in main.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @param {string} ddl
 * @returns {'main'|'derived'}
 */
function ensureDerivedTable(db, name, ddl) {
  const home = tableHome(db, name);
  if (home) return home;
  const attached = db.prepare('PRAGMA database_list').all()
    .some((row) => String(row.name) === 'derived');
  if (!attached) {
    db.exec(ddl);
    return 'main';
  }
  const qualified = ddl
    .replace(/CREATE TABLE IF NOT EXISTS (?!derived\.)/gi, 'CREATE TABLE IF NOT EXISTS derived.')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS (?!derived\.)/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS derived.')
    .replace(/CREATE INDEX IF NOT EXISTS (?!derived\.)/gi, 'CREATE INDEX IF NOT EXISTS derived.');
  db.exec(qualified);
  return 'derived';
}

/**
 * Attach the derived database. Idempotent.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{derivedPath?: string, createSchema?: boolean}} [options]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function attachDerived(db, options = {}) {
  const attached = db.prepare('PRAGMA database_list').all()
    .some((row) => String(row.name) === 'derived');
  if (attached) return db;
  const derivedPath = derivedPathFor(db, options.derivedPath);
  if (options.createSchema !== false) {
    ensureDerivedSchema(derivedPath);
  } else if (!fs.existsSync(derivedPath)) {
    throw new Error(`derived database is missing: ${derivedPath}`);
  }
  db.prepare('ATTACH DATABASE ? AS derived').run(derivedPath);
  return db;
}

/**
 * Is this table one of the derived ones?
 *
 * @param {string} name
 * @returns {boolean}
 */
function isDerivedTable(name) {
  return DERIVED_TABLES.includes(name);
}

module.exports = {
  CATALOG_DB_PATH,
  DERIVED_DB_PATH,
  DERIVED_SCHEMA_PATH,
  DERIVED_TABLES,
  attachDerived,
  derivedPathFor,
  ensureDerivedSchema,
  ensureDerivedTable,
  isDerivedTable,
  tableHome,
};
