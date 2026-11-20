'use strict';

/**
 * The Phase-3 Komar TRADE LOG extraction.
 *
 * WHAT THIS STAGE READS
 *
 * The trade-log sheet: `Trades-August-2025.pdf` page 2 carries a
 * 2048x1715 screenshot of a spreadsheet with 18 columns and 32 rows --
 * one row per trade, with the entry date, the exit date, the entry and
 * exit types, the ticker, the average opening and close prices, the
 * stop, the risk, the MMTS verdicts, the W/L % and R, the author's two
 * star ratings, his trade grade and his comment.
 *
 * It is the closest thing in the corpus to a GROUND-TRUTH trade log:
 * what he actually did, with the prices and the outcome.
 *
 * HOW THE SHEET IS FOUND
 *
 * The sheet is an EMBEDDED IMAGE, not a page, so it is extracted at its
 * native resolution and read as a picture. It is recognised by its
 * SHAPE -- the sheet is 2048x1715, which is a portrait-ish ratio
 * (0.837) that none of the deck's other images has (the per-trade
 * chart screenshots are 2048x1215, ratio 0.593, and the narrow chart
 * strips are 680x1490, ratio 2.19) -- and by its TITLE, which reads
 * "Trade Log".
 *
 * Usage:
 *   node tools/extractKomarTradeLog.js
 *   node tools/extractKomarTradeLog.js --doc-id komar_doc_deck_trades-august-2025
 *   node tools/extractKomarTradeLog.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');

const { komarSourceDir } = require('../src/komar/channel');
const { ensureKomarSchema } = require('../src/komar/schema');
const { PARSER_VERSION, readTradeLogImage } = require('../src/komar/tradeLogLayout');
const { closeWorker } = require('../src/table/tableReader');
const { extractEmbeddedImage, readMeta } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const RECORDS_DIR = path.join(ROOT, 'data', 'komar_records');
const WORK_DIR = path.join(ROOT, 'data', 'komar_work');

/**
 * The sheet's shape: the ratio of its height to its width, and the
 * width it must have.
 *
 * Measured on the corpus (2026-11-17): the trade-log sheet is
 * 2048x1715 (0.837); the per-trade chart screenshots in the same deck
 * are 2048x1215 (0.593) and 680x1490 (2.19); the market cards in the
 * weekly reports are 1080x764 (0.707) at a width of 1080. So the
 * sheet is the only image in the corpus that is WIDE and TALL.
 */
const SHEET_MIN_WIDTH = 2000;
const SHEET_MIN_RATIO = 0.80;
const SHEET_MAX_RATIO = 0.87;

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
 * The documents that could carry a trade log.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listDocuments(db) {
  let sql = `
    SELECT doc_id, kind, pdf_path, session_date, title, pdf_checksum
    FROM komar_documents
    WHERE kind = 'deck'
  `;
  const params = [];
  if (options.docId) {
    sql += ' AND doc_id = ?';
    params.push(options.docId);
  }
  sql += ' ORDER BY session_date, doc_id';
  if (options.limit > 0) sql += ` LIMIT ${Math.max(1, options.limit)}`;
  return db.prepare(sql).all(...params);
}

/**
 * The sheet's image inside a document, if it has one.
 *
 * @param {object} doc
 * @returns {object[]}
 */
function findSheetImages(doc) {
  const pdfPath = path.isAbsolute(doc.pdf_path)
    ? doc.pdf_path
    : path.join(options.sourceDir, doc.pdf_path);
  if (!fs.existsSync(pdfPath)) return [];
  let meta;
  try {
    meta = readMeta(pdfPath);
  } catch {
    return [];
  }
  const found = [];
  for (const page of meta.pages || []) {
    for (const image of page.images || []) {
      const ratio = image.height / image.width;
      if (image.width < SHEET_MIN_WIDTH) continue;
      if (ratio < SHEET_MIN_RATIO || ratio > SHEET_MAX_RATIO) continue;
      found.push({ page: page.page, xref: image.xref, width: image.width, height: image.height });
    }
  }
  return found;
}

/**
 * Write one document's trade-log rows, replacing whatever was there.
 *
 * @param {object} db
 * @param {object} doc
 * @param {object[]} rows
 */
function writeTradeLogRows(db, doc, rows) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM komar_trade_log WHERE doc_id = ?').run(doc.doc_id);
    const statement = db.prepare(`
      INSERT INTO komar_trade_log (
        doc_id, page, row_index, date_opened, date_closed, entry_type, ticker,
        avg_open_price, avg_close_price, stop_loss_price, stop_loss_pct,
        risk_capital_pct, exit_type, mmts_opening, mmts_close, wl_pct, wl_r,
        initial_rating, after_close_rating, review, comment,
        reading_check, derived_fields, confidence, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      statement.run(
        doc.doc_id,
        row.page || 2,
        row.row_index,
        row.date_opened,
        row.date_closed,
        row.entry_type,
        row.ticker,
        row.avg_open_price,
        row.avg_close_price,
        row.stop_loss_price,
        row.stop_loss_pct,
        row.risk_capital_pct,
        row.exit_type,
        row.mmts_opening,
        row.mmts_close,
        row.wl_pct,
        row.wl_r,
        row.initial_rating,
        row.after_close_rating,
        row.review,
        row.comment,
        row.reading_check || '',
        row.derived_fields || '',
        row.confidence,
        row.parser_version || PARSER_VERSION
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The JSON sidecar for one document's trade log.
 *
 * @param {object} doc
 * @param {object[]} rows
 * @param {string[]} notes
 */
function writeRecord(doc, rows, notes) {
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
    notes,
    rows,
  };
  fs.writeFileSync(
    path.join(RECORDS_DIR, `${doc.doc_id}_tradelog.json`),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  const db = openDatabase();
  const docs = listDocuments(db);
  if (!docs.length) {
    console.log('no Komar decks to process');
    db.close();
    await closeWorker();
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const summary = {
    docs: docs.length,
    parser_version: PARSER_VERSION,
    rows: 0,
    sheets: 0,
  };

  try {
    for (const doc of docs) {
      const images = findSheetImages(doc);
      if (!images.length) {
        console.log(`${doc.doc_id}: no trade-log sheet`);
        continue;
      }
      for (const image of images) {
        const workDir = path.join(WORK_DIR, doc.doc_id);
        fs.mkdirSync(workDir, { recursive: true });
        const imagePath = path.join(workDir, `p${image.page}_x${image.xref}.png`);
        extractEmbeddedImage(
          path.isAbsolute(doc.pdf_path) ? doc.pdf_path : path.join(options.sourceDir, doc.pdf_path),
          image.page,
          image.xref,
          imagePath
        );
        const parsed = await readTradeLogImage(imagePath);
        if (!/trade\s*log/i.test(parsed.title)) {
          console.log(`${doc.doc_id}: page ${image.page} is not a trade log (title: ${JSON.stringify(parsed.title)})`);
          continue;
        }
        for (const row of parsed.rows) row.page = image.page;
        writeTradeLogRows(db, doc, parsed.rows);
        writeRecord(doc, parsed.rows, parsed.notes);
        summary.sheets += 1;
        summary.rows += parsed.rows.length;
        console.log(
          `${doc.doc_id}: ${parsed.rows.length} trades read from page ${image.page}`
          + (parsed.notes.length ? ` (${parsed.notes.length} note(s))` : '')
        );
      }
    }
  } finally {
    db.close();
    await closeWorker();
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `${summary.rows} trades from ${summary.sheets} sheet(s) in ${summary.docs} document(s)`
    );
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    try {
      await closeWorker();
    } catch {
      // best effort
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  findSheetImages,
  listDocuments,
  writeRecord,
  writeTradeLogRows,
};
