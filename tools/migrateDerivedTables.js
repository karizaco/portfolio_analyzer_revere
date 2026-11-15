'use strict';

/**
 * Move the interpretation tables out of the tracked catalog and into
 * data/video_pipeline/derived.sqlite, which is also tracked.
 *
 * WHY
 *
 * GitHub refuses a file over 100 MB and warns at 50. state.sqlite was
 * 59 MB, against a 60 MB budget. The interpretations (signals, setups,
 * readings, Asym, O'Connell lots, the Discord position parse) are real
 * data and stay in git -- they just do not share a file with the catalog.
 *
 * WHAT IT DOES
 *
 *   1. Copies the catalog, so an interrupted run leaves the original.
 *   2. Creates the derived file from schema_derived.sql.
 *   3. Copies each table by the columns the two schemas share, keeping ids.
 *   4. Checks the row counts.
 *   5. Drops the tables from the catalog copy and VACUUMs it.
 *   6. Replaces the catalog only after the copy verifies.
 *
 *   node tools/migrateDerivedTables.js            # dry-run
 *   node tools/migrateDerivedTables.js --execute
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  CATALOG_DB_PATH,
  DERIVED_DB_PATH,
  DERIVED_SCHEMA_PATH,
  DERIVED_TABLES,
} = require('../src/db/derivedStore');

const execute = process.argv.includes('--execute');

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function countOf(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

function main() {
  if (!fs.existsSync(CATALOG_DB_PATH)) {
    console.error(`No catalog at ${CATALOG_DB_PATH}`);
    process.exit(1);
  }
  // Fold the WAL into the main file first. A copy of the main file alone
  // misses whatever a writer has not checkpointed, and replacing the file
  // then deleting the WAL would lose it.
  const checkpoint = new DatabaseSync(CATALOG_DB_PATH);
  checkpoint.exec('PRAGMA busy_timeout = 60000');
  checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  checkpoint.close();
  const live = new DatabaseSync(CATALOG_DB_PATH, { readOnly: true });
  const present = DERIVED_TABLES.filter((table) => live.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table));
  console.log(`[derived] catalog : ${CATALOG_DB_PATH}`);
  console.log(`[derived] tables still in the catalog: ${present.length}`);
  for (const table of present) console.log(`  ${table} ${countOf(live, table)}`);
  live.close();
  if (!present.length) {
    console.log('[derived] already migrated');
    return;
  }
  if (!execute) {
    console.log('[derived] DRY RUN -- nothing was changed');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const work = path.join(path.dirname(CATALOG_DB_PATH), `state.migrate-${stamp}.sqlite`);
  const derivedWork = path.join(path.dirname(DERIVED_DB_PATH), `derived.migrate-${stamp}.sqlite`);
  fs.copyFileSync(CATALOG_DB_PATH, work);

  const catalog = new DatabaseSync(work);
  catalog.exec('PRAGMA busy_timeout = 60000');
  const derived = new DatabaseSync(derivedWork);
  derived.exec('PRAGMA busy_timeout = 60000');
  derived.exec(fs.readFileSync(DERIVED_SCHEMA_PATH, 'utf8'));
  derived.prepare('ATTACH DATABASE ? AS catalog').run(work);

  try {
    derived.exec('BEGIN');
    for (const table of present) {
      const liveCols = new Set(columnsOf(catalog, table));
      const destCols = columnsOf(derived, table).filter((name) => liveCols.has(name));
      if (!destCols.length) throw new Error(`${table}: no shared columns`);
      const list = destCols.join(', ');
      derived.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM catalog.${table}`);
      const copied = countOf(derived, table);
      const source = countOf(catalog, table);
      if (copied !== source) {
        throw new Error(`${table}: copied ${copied} of ${source}`);
      }
      console.log(`[derived] copied ${table} ${copied}`);
    }
    derived.exec('COMMIT');
  } catch (error) {
    derived.exec('ROLLBACK');
    derived.close();
    catalog.close();
    fs.rmSync(work, { force: true });
    fs.rmSync(derivedWork, { force: true });
    throw error;
  }
  derived.exec('DETACH DATABASE catalog');
  derived.exec('VACUUM');
  derived.close();

  for (const table of present) catalog.exec(`DROP TABLE ${table}`);
  catalog.exec('VACUUM');
  const left = present.filter((table) => catalog.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table));
  catalog.close();
  if (left.length) {
    fs.rmSync(work, { force: true });
    fs.rmSync(derivedWork, { force: true });
    throw new Error(`still in the catalog copy: ${left.join(', ')}`);
  }

  const backup = `${CATALOG_DB_PATH}.premigrate`;
  fs.copyFileSync(CATALOG_DB_PATH, backup);
  fs.copyFileSync(work, CATALOG_DB_PATH);
  fs.copyFileSync(derivedWork, DERIVED_DB_PATH);
  fs.rmSync(work, { force: true });
  fs.rmSync(derivedWork, { force: true });
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${CATALOG_DB_PATH}${suffix}`, { force: true });
  }
  const catalogMb = fs.statSync(CATALOG_DB_PATH).size / 1048576;
  const derivedMb = fs.statSync(DERIVED_DB_PATH).size / 1048576;
  console.log(`[derived] catalog now  : ${catalogMb.toFixed(1)} MB`);
  console.log(`[derived] derived file : ${derivedMb.toFixed(1)} MB`);
  console.log(`[derived] backup       : ${backup}`);
  console.log('[derived] done');
}

main();
