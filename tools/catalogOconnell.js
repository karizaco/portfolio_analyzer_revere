'use strict';

/**
 * Catalog the O'Connell corpus: inventory the folder of PDFs, read each
 * document's masthead, and record what every document IS.
 *
 * WHAT THIS STAGE IS FOR
 *
 * Every source here has the same first stage: know what you have. A
 * catalog that does not know its own corpus cannot report coverage
 * honestly, and this project has been bitten by that more than once --
 * the 2026-10-28 audit's "7 Revere rows are no longer returned by the
 * channel" did not reproduce, because the LISTING it was measured against
 * was itself stale.
 *
 * So this stage records, per document: the session date it covers, when
 * it was published, its title, its series, its kind, and its checksum.
 * The checksum is what makes a re-run meaningful: a document whose
 * checksum has not changed has not changed, and a document whose
 * checksum HAS changed must be re-extracted.
 *
 * THE FILENAME IS THE KEY, AND THE PUBLISH DATE IS NOT
 *
 * The filename is the SESSION the issue covers; the newsletter goes out
 * the morning after. The 20261112 issue was published 2026-11-13 10:20.
 * The id is the session date, because that is what a reader asking "what
 * did he hold on 12 November" means, and the publish timestamp is a
 * separate column.
 *
 * Usage:
 *   node tools/catalogOconnell.js
 *   node tools/catalogOconnell.js --source-dir D:\trading_books\... --json
 *   node tools/catalogOconnell.js --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  OCONNELL_SOURCE,
  oconnellDocId,
  oconnellSourceDir,
} = require('../src/oconnell/channel');
const { ensureOconnellSchema } = require('../src/oconnell/schema');
const {
  classifyIssue,
  kindExpectsPositionLog,
  readMasthead,
} = require('../src/oconnell/issueKinds');
const {
  checksumFile,
  listCorpus,
  positionCopies,
  positionsForDate,
} = require('../src/newsletter/documentCatalog');
const { readMetaMany } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const MANIFEST_PATH = path.join(ROOT, 'data', 'oconnell_manifest.json');

/**
 * The catalog stage's own version.
 *
 * It goes on the manifest, not on the rows: the rows carry the version of
 * whatever READ them, and this stage writes no extracted data.
 */
const CATALOG_VERSION = 'oconnell-catalog-1';

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  sourceDir: oconnellSourceDir({ sourceDir: readFlag(argv, '--source-dir') }),
};

function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  ensureOconnellSchema(db);
  return db;
}

/**
 * Read every document's structure, in one interpreter.
 *
 * @param {object[]} documents
 * @param {string} sourceDir
 * @returns {object[]} the helper's results, in the order of `documents`
 */
function readStructures(documents, sourceDir) {
  const paths = documents.map((document) => path.join(sourceDir, document.fileName));
  return readMetaMany(paths);
}

/**
 * Build the catalog rows.
 *
 * @param {object[]} documents - the folder's documents
 * @param {object[]} positions - the folder's position screenshots
 * @param {object[]} structures - the helper's per-document results
 * @param {string} sourceDir
 * @returns {object[]} one row per document
 */
function buildRows(documents, positions, structures, sourceDir) {
  const rows = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const structure = structures[index] || {};
    const error = structure.error ? String(structure.error) : '';

    const masthead = error ? null : readMasthead((structure.pages && structure.pages[0] ? structure.pages[0].text_blocks : []) || []);
    const kind = masthead ? classifyIssue(masthead) : 'special';

    const positionsEntry = positionsForDate(positions, document.sourceDate);
    const positionsPath = positionsEntry ? positionsEntry.fileName : '';
    const positionsAbsolute = positionsPath ? path.join(sourceDir, positionsPath) : '';

    const pdfAbsolute = path.join(sourceDir, document.fileName);

    rows.push({
      access: (masthead && masthead.access) || 'unknown',
      discriminator: document.discriminator || '',
      doc_id: oconnellDocId(document.source_date || document.sourceDate, document.discriminator),
      kind,
      page_count: Number(structure.page_count || 0),
      pdf_bytes: fs.existsSync(pdfAbsolute) ? fs.statSync(pdfAbsolute).size : 0,
      pdf_checksum: fs.existsSync(pdfAbsolute) ? checksumFile(pdfAbsolute) : '',
      pdf_path: document.fileName,
      positions_checksum: positionsAbsolute && fs.existsSync(positionsAbsolute)
        ? checksumFile(positionsAbsolute)
        : '',
      positions_path: positionsPath,
      publish_date: (masthead && masthead.publishDate) || '',
      publish_time: (masthead && masthead.publishTime) || '',
      position_copies: positionCopies(positions, document.sourceDate).map((entry) => entry.fileName),
      series: (masthead && masthead.series) || '',
      source_date: document.sourceDate,
      source_url: (masthead && masthead.sourceUrl) || '',
      title: (masthead && masthead.title) || '',
      unreadable: error,
    });
  }
  return rows;
}

/**
 * The documents that would share a catalog id.
 *
 * Two files for one date are common enough in this corpus -- there are
 * two pairs -- and a date-only id would silently overwrite one of them
 * with the other. So a collision is reported rather than resolved.
 *
 * @param {object[]} rows
 * @returns {object[]} the collisions
 */
function findIdCollisions(rows) {
  const byId = new Map();
  for (const row of rows) {
    const list = byId.get(row.doc_id) || [];
    list.push(row.pdf_path);
    byId.set(row.doc_id, list);
  }
  const collisions = [];
  for (const [docId, files] of byId) {
    if (files.length > 1) collisions.push({ doc_id: docId, files });
  }
  return collisions;
}

/**
 * Compare the fresh inventory with what is already recorded.
 *
 * @param {object} db
 * @param {object[]} rows
 * @returns {object} the counts
 */
function diffAgainstCatalog(db, rows) {
  const existing = new Map();
  for (const row of db.prepare('SELECT doc_id, pdf_checksum FROM oconnell_issues').all()) {
    existing.set(row.doc_id, row.pdf_checksum);
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const seen = new Set();

  for (const row of rows) {
    seen.add(row.doc_id);
    const prior = existing.get(row.doc_id);
    if (prior === undefined) {
      inserted += 1;
      continue;
    }
    if (prior !== row.pdf_checksum) {
      updated += 1;
      continue;
    }
    unchanged += 1;
  }

  let removed = 0;
  for (const docId of existing.keys()) {
    if (!seen.has(docId)) removed += 1;
  }

  return { inserted, removed, unchanged, updated };
}

/**
 * Write the rows.
 *
 * @param {object} db
 * @param {object[]} rows
 * @returns {number} the number of rows written
 */
function writeRows(db, rows) {
  const statement = db.prepare(`
    INSERT INTO oconnell_issues (
      doc_id, source_date, publish_date, publish_time, sequence, title, series,
      kind, access, page_count, source_url, pdf_path, pdf_bytes, pdf_checksum,
      positions_path, positions_checksum, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
    )
    ON CONFLICT(doc_id) DO UPDATE SET
      source_date = excluded.source_date,
      publish_date = excluded.publish_date,
      publish_time = excluded.publish_time,
      sequence = excluded.sequence,
      title = excluded.title,
      series = excluded.series,
      kind = excluded.kind,
      access = excluded.access,
      page_count = excluded.page_count,
      source_url = excluded.source_url,
      pdf_path = excluded.pdf_path,
      pdf_bytes = excluded.pdf_bytes,
      pdf_checksum = excluded.pdf_checksum,
      positions_path = excluded.positions_path,
      positions_checksum = excluded.positions_checksum,
      updated_at = datetime('now')
  `);

  for (const row of rows) {
    const sequence = row.discriminator || '';
    statement.run(
      row.doc_id,
      row.source_date,
      row.publish_date,
      row.publish_time,
      sequence,
      row.title,
      row.series,
      row.kind,
      row.access,
      row.page_count,
      row.source_url,
      row.pdf_path,
      row.pdf_bytes,
      row.pdf_checksum,
      row.positions_path,
      row.positions_checksum
    );
  }
  return rows.length;
}

/**
 * Remove the issues that are no longer in the corpus.
 *
 * A document that has been taken out of the folder has to stop being
 * part of the catalog, or the coverage funnel counts it forever. The
 * child rows go with it: `oconnell_issues` is the parent of the
 * setups, the positions and the snapshot, and the foreign keys cascade.
 *
 * @param {object} db
 * @param {object[]} rows
 * @returns {number} how many issues were removed
 */
function removeStaleIssues(db, rows) {
  const present = new Set(rows.map((row) => row.doc_id));
  const stale = db.prepare('SELECT doc_id FROM oconnell_issues').all()
    .map((row) => row.doc_id)
    .filter((docId) => !present.has(docId));
  for (const docId of stale) {
    db.prepare('DELETE FROM oconnell_issues WHERE doc_id = ?').run(docId);
  }
  return stale.length;
}

/**
 * The manifest: what the corpus IS, in a form a reader can diff.
 *
 * It is committed, because the corpus itself is not: the PDFs are paid
 * and live outside the repository, so the manifest is the record of what
 * was read.
 *
 * @param {object[]} rows
 * @param {object} corpus
 * @param {object} counts
 * @returns {object}
 */
function buildManifest(rows, corpus, counts) {
  const byKind = {};
  let withPositions = 0;
  let withPublishDate = 0;
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    if (row.positions_path) withPositions += 1;
    if (row.publish_date) withPublishDate += 1;
  }
  return {
    catalog_version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    source: OCONNELL_SOURCE,
    source_dir_name: path.basename(options.sourceDir),
    documents: rows.map((row) => ({
      access: row.access,
      doc_id: row.doc_id,
      kind: row.kind,
      page_count: row.page_count,
      pdf_bytes: row.pdf_bytes,
      pdf_checksum: row.pdf_checksum,
      pdf_path: row.pdf_path,
      positions_checksum: row.positions_checksum,
      positions_path: row.positions_path,
      publish_date: row.publish_date,
      publish_time: row.publish_time,
      series: row.series,
      source_date: row.source_date,
      source_url: row.source_url,
      title: row.title,
    })),
    summary: {
      by_kind: byKind,
      documents: rows.length,
      documents_with_position_screenshot: withPositions,
      documents_with_publish_date: withPublishDate,
      kinds_expecting_a_position_log: rows.filter((row) => kindExpectsPositionLog(row.kind)).length,
      position_screenshots: corpus.positions.length,
      skipped_entries: corpus.skipped,
      unreadable: rows.filter((row) => row.unreadable).length,
    },
  };
}

function main() {
  if (!fs.existsSync(options.sourceDir)) {
    console.error(`No corpus folder at ${options.sourceDir}`);
    console.error('Set OCONNELL_SOURCE_DIR or pass --source-dir.');
    process.exit(1);
  }

  const corpus = listCorpus(options.sourceDir);
  console.log(`corpus: ${corpus.documents.length} document(s), ${corpus.positions.length} position screenshot(s)`);

  const structures = readStructures(corpus.documents, options.sourceDir);
  const rows = buildRows(corpus.documents, corpus.positions, structures, options.sourceDir);

  const collisions = findIdCollisions(rows);
  if (collisions.length) {
    console.error('Two documents would share a catalog id:');
    for (const collision of collisions) {
      console.error(`  ${collision.doc_id}: ${collision.files.join(' , ')}`);
    }
    process.exit(1);
  }

  const db = openDatabase();
  const counts = diffAgainstCatalog(db, rows);

  if (!options.dryRun) {
    writeRows(db, rows);
    const removed = removeStaleIssues(db, rows);
    if (removed) console.log(`removed ${removed} issue(s) that are no longer in the corpus`);
    db.prepare(`
      INSERT INTO catalog_runs (
        source_url, channel, command_json, raw_output_path, row_count,
        inserted_count, updated_count, missing_upload_dates, malformed_rows,
        created_at, kind, not_listed_count, listing_complete, row_count_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), 'live', 0, 1, 'listing_rows')
    `).run(
      'file://' + options.sourceDir,
      OCONNELL_SOURCE,
      JSON.stringify(process.argv.slice(1)),
      path.relative(ROOT, MANIFEST_PATH),
      rows.length,
      counts.inserted,
      counts.updated,
      rows.filter((row) => row.unreadable).length
    );
  }

  const manifest = buildManifest(rows, corpus, counts);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify({ counts, manifest: manifest.summary }, null, 2));
  } else {
    console.log(`inserted ${counts.inserted}, updated ${counts.updated}, unchanged ${counts.unchanged}, removed ${counts.removed}`);
    console.log('by kind:', JSON.stringify(manifest.summary.by_kind));
    console.log(`with a position screenshot: ${manifest.summary.documents_with_position_screenshot} / ${manifest.summary.documents}`);
    if (!options.dryRun) console.log(`manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }

  db.close();
}

if (require.main === module) {
  main();
}

module.exports = { CATALOG_VERSION, buildManifest, buildRows, diffAgainstCatalog };
