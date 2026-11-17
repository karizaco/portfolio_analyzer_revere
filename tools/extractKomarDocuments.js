'use strict';

/**
 * The Phase-2 Komar document extraction runner.
 *
 * WHAT THIS STAGE DOES
 *
 * The catalog (Phase 1) says what files exist. This stage reads what the
 * documents SAY and writes three derived tables:
 *
 *   komar_market_cards   one row per card image
 *   komar_theme_leaders  one row per (theme, ticker)
 *   komar_deck_notes     one row per relevant deck page
 *
 * The write contract is the same as every other source stage here:
 *
 *   - REPLACE this document's rows, in one transaction
 *   - include parser_version on every row
 *   - keep a committed JSON sidecar under data/komar_records/
 *
 * Usage:
 *   node tools/extractKomarDocuments.js
 *   node tools/extractKomarDocuments.js --doc-id komar_doc_report_20260509
 *   node tools/extractKomarDocuments.js --limit 5 --json
 *   node tools/extractKomarDocuments.js --refresh
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');

const { komarSourceDir } = require('../src/komar/channel');
const { ensureKomarSchema } = require('../src/komar/schema');
const {
  PARSER_VERSION,
  closeKomarDocumentWorkers,
  parseKomarDocuments,
} = require('../src/komar/documentExtract');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const RECORDS_DIR = path.join(ROOT, 'data', 'komar_records');
const WORK_DIR = path.join(ROOT, 'data', 'komar_work');

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  docId: readFlag(argv, '--doc-id') || '',
  json: argv.includes('--json'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  refresh: argv.includes('--refresh'),
  sourceDir: komarSourceDir({ sourceDir: readFlag(argv, '--source-dir') }),
};

/**
 * Open the catalog with the derived file attached.
 *
 * @returns {object}
 */
function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureKomarSchema(db);
  return db;
}

/**
 * The documents this stage should process.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listDocuments(db) {
  let sql = `
    SELECT doc_id, kind, pdf_path, session_date, title, pdf_checksum
    FROM komar_documents
    WHERE kind IN ('report', 'post', 'deck')
  `;
  const params = [];
  if (options.docId) {
    sql += ' AND doc_id = ?';
    params.push(options.docId);
  }
  sql += ' ORDER BY session_date, doc_id';
  if (options.limit > 0) {
    sql += ` LIMIT ${Math.max(1, options.limit)}`;
  }
  return db.prepare(sql).all(...params);
}

/**
 * Write one document's Phase-2 rows, replacing whatever was there before.
 *
 * @param {object} db
 * @param {object} doc
 * @param {{cards:object[],leaders:object[],notes:object[]}} parsed
 */
function writeDocumentRows(db, doc, parsed) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM komar_market_cards WHERE doc_id = ?').run(doc.doc_id);
    db.prepare('DELETE FROM komar_theme_leaders WHERE doc_id = ?').run(doc.doc_id);
    db.prepare('DELETE FROM komar_deck_notes WHERE doc_id = ?').run(doc.doc_id);

    const cardStmt = db.prepare(`
      INSERT INTO komar_market_cards (
        doc_id, page, image_xref, image_width, image_height,
        market_text, market_trend_nasdaq, market_trend_sp500,
        market_trend_russell2000, trend_nasdaq_dir, trend_sp500_dir,
        trend_russell2000_dir, trend_by_horizon_json, exposure_pct,
        confidence, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of parsed.cards) {
      cardStmt.run(
        row.doc_id,
        row.page,
        row.image_xref,
        row.image_width,
        row.image_height,
        row.market_text,
        row.market_trend_nasdaq,
        row.market_trend_sp500,
        row.market_trend_russell2000,
        row.trend_nasdaq_dir,
        row.trend_sp500_dir,
        row.trend_russell2000_dir,
        JSON.stringify(row.trend_by_horizon || {}),
        row.exposure_pct,
        row.confidence,
        row.parser_version
      );
    }

    const leaderStmt = db.prepare(`
      INSERT INTO komar_theme_leaders (
        doc_id, page, image_xref, theme, ticker,
        leader_index, confidence, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of parsed.leaders) {
      leaderStmt.run(
        row.doc_id,
        row.page,
        row.image_xref,
        row.theme,
        row.ticker,
        row.leader_index,
        row.confidence,
        row.parser_version
      );
    }

    const noteStmt = db.prepare(`
      INSERT INTO komar_deck_notes (
        doc_id, page, heading, body_text, trade_state,
        stars, trade_grade, quick_checklist_json, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of parsed.notes) {
      noteStmt.run(
        row.doc_id,
        row.page,
        row.heading,
        row.body_text,
        row.trade_state,
        row.stars,
        row.trade_grade,
        JSON.stringify(row.quick_checklist || []),
        row.parser_version
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The JSON sidecar for one document.
 *
 * @param {object} doc
 * @param {{cards:object[],leaders:object[],notes:object[]}} parsed
 */
function writeRecord(doc, parsed) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const out = {
    doc_id: doc.doc_id,
    generated_at: new Date().toISOString(),
    kind: doc.kind,
    parser_version: PARSER_VERSION,
    pdf_checksum: doc.pdf_checksum,
    pdf_path: doc.pdf_path,
    session_date: doc.session_date || '',
    title: doc.title || '',
    cards: parsed.cards,
    leaders: parsed.leaders,
    notes: parsed.notes,
  };
  fs.writeFileSync(
    path.join(RECORDS_DIR, `${doc.doc_id}.json`),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  const db = openDatabase();
  const docs = listDocuments(db);
  if (!docs.length) {
    console.log('no Komar documents to process');
    db.close();
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });

  const summary = {
    cards: 0,
    docs: docs.length,
    leaders: 0,
    notes: 0,
    parser_version: PARSER_VERSION,
  };

  try {
    for (const doc of docs) {
      const parsed = await parseKomarDocuments([doc], {
        sourceDir: options.sourceDir,
        workDir: path.join(WORK_DIR, doc.doc_id),
      });
      writeDocumentRows(db, doc, parsed);
      writeRecord(doc, parsed);
      summary.cards += parsed.cards.length;
      summary.leaders += parsed.leaders.length;
      summary.notes += parsed.notes.length;
      console.log(`[komar-docs] ${doc.doc_id}: cards=${parsed.cards.length}, leaders=${parsed.leaders.length}, notes=${parsed.notes.length}`);
    }
  } finally {
    await closeKomarDocumentWorkers();
    db.close();
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`processed ${summary.docs} document(s): cards=${summary.cards}, leaders=${summary.leaders}, notes=${summary.notes}`);
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    try {
      await closeKomarDocumentWorkers();
    } catch {
      // best effort
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  listDocuments,
  writeDocumentRows,
  writeRecord,
};
