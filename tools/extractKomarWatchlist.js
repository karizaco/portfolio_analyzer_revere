'use strict';

/**
 * The Komar WATCHLIST SCREENSHOT extraction.
 *
 * WHAT THIS STAGE READS
 *
 * The daily and mid-week updates carry a TradingView screenshot of the
 * author's own watchlist: one chart per pane, each with the ticker,
 * the date, the change and the change percentage. It is a DATED market
 * read of the names he was watching -- `komar_setups` is what he
 * SAID, `komar_trade_log` is what he HELD, and this is what he was
 * WATCHING.
 *
 * HOW THE SCREENSHOT IS FOUND
 *
 * It is an EMBEDDED IMAGE, not a page, and it is recognised by its
 * SHAPE rather than by its position: `src/komar/watchlistReader.js`
 * derives four 270-pixel panes from the image's width and refuses an
 * image whose panes would not be 270 wide. That is measured on the
 * corpus's three watchlist screenshots, and it is what keeps the
 * full-screen workspace captures (4353x2682) out of this stage -- they
 * are a different artifact with a different reader.
 *
 * Usage:
 *   node tools/extractKomarWatchlist.js
 *   node tools/extractKomarWatchlist.js --dry-run
 *   node tools/extractKomarWatchlist.js --doc-id komar_doc_post_20260429
 *   node tools/extractKomarWatchlist.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { komarSourceDir } = require('../src/komar/channel');
const { ensureKomarSchema } = require('../src/komar/schema');
const {
  PANE_WIDTH_MEASURED,
  PANE_WIDTH_TOLERANCE,
  PARSER_VERSION,
  PANES_ACROSS,
  readWatchlist,
} = require('../src/komar/watchlistReader');
const { closeWorker } = require('../src/table/tableReader');
const { extractEmbeddedImage, readMeta } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const RECORDS_DIR = path.join(ROOT, 'data', 'komar_records');
const WORK_DIR = path.join(ROOT, 'data', 'komar_work', 'charts');

/** The smallest an embedded image can be and still be the widget.
 *  The corpus's are 1080 wide; this only exists so that a one-pixel
 *  rule (the workspace captures' 1-pixel separator images) is not
 *  handed to the metadata reader. */
const MIN_IMAGE_WIDTH = 400;

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
  dryRun: argv.includes('--dry-run'),
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
 * The documents that could carry a watchlist screenshot.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listDocuments(db) {
  let sql = `
    SELECT doc_id, kind, pdf_path, session_date, session_date_precision, title, pdf_checksum
    FROM komar_documents
    WHERE kind = 'post'
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
 * The images in a document that COULD be the widget, by their shape.
 *
 * @param {object} doc
 * @returns {object[]}
 */
function findCandidateImages(doc) {
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
      if ((image.width || 0) < MIN_IMAGE_WIDTH) continue;
      const paneWidth = image.width / PANES_ACROSS;
      if (Math.abs(paneWidth - PANE_WIDTH_MEASURED) > PANE_WIDTH_TOLERANCE) continue;
      found.push({ page: page.page, xref: image.xref, width: image.width, height: image.height });
    }
  }
  return found;
}

/**
 * Write one document's rows, replacing whatever was there.
 *
 * The key is (doc_id, row, column), so the delete is WHOLE for the
 * document and the read is written in ONE call: a daily update carries
 * ONE watchlist screenshot (measured: all three of the corpus's do),
 * and two screenshots writing the same grid position would collide.
 *
 * The delete happens even when the read came back EMPTY. That is the
 * project's own rule for an extractor that always replaces (see
 * `src/transcript/extractRunner.js`): a source whose reading went to
 * zero keeps its old rows otherwise, and a row written by a run that
 * failed later is exactly what would survive. The tool only reaches
 * here when it could actually look at the document -- a missing PDF
 * returns no candidate images and touches nothing.
 *
 * @param {object} db
 * @param {object} doc
 * @param {object[]} rows
 * @param {number} page
 * @param {number} xref
 */
function writeRows(db, doc, rows, page, xref) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM komar_watchlist WHERE doc_id = ?').run(doc.doc_id);
    const statement = db.prepare(`
      INSERT INTO komar_watchlist (
        doc_id, page, image_xref, session_date, row, column, ticker,
        chg, chg_pct, raw, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      statement.run(
        doc.doc_id,
        page,
        xref,
        doc.session_date || '',
        row.row,
        row.column,
        row.ticker,
        row.chg,
        row.chg_pct,
        row.raw || '',
        PARSER_VERSION
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The JSON sidecar for one document's reading.
 *
 * @param {object} doc
 * @param {number} page
 * @param {number} xref
 * @param {object[]} rows
 * @param {string[]} notes
 */
function writeRecord(doc, page, xref, rows, notes) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const out = {
    doc_id: doc.doc_id,
    generated_at: new Date().toISOString(),
    image: { page, xref },
    image_xref: xref,
    kind: doc.kind,
    notes,
    parser_version: PARSER_VERSION,
    pdf_checksum: doc.pdf_checksum,
    pdf_path: doc.pdf_path,
    rows,
    session_date: doc.session_date || '',
    session_date_precision: doc.session_date_precision || '',
    title: doc.title || '',
  };
  fs.writeFileSync(
    path.join(RECORDS_DIR, `${doc.doc_id}_watchlist.json`),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  const db = openDatabase();
  const docs = listDocuments(db);
  if (!docs.length) {
    console.log('no Komar daily updates to process');
    db.close();
    await closeWorker();
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const summary = {
    docs: docs.length,
    images: 0,
    panes: 0,
    parser_version: PARSER_VERSION,
    screenshots: 0,
  };

  try {
    for (const doc of docs) {
      const images = findCandidateImages(doc);
      if (!images.length) {
        console.log(`${doc.doc_id}: no watchlist screenshot`);
        continue;
      }
      // The document could be examined, so its rows are reconciled to
      // what the examination finds -- including finding nothing. A
      // missing PDF returns no candidate images above and never gets
      // here, so an unreadable document keeps what it had.
      let examined = false;
      let watchlist = null;
      for (const image of images) {
        const imagePath = path.join(WORK_DIR, `${doc.doc_id}_p${image.page}_x${image.xref}.png`);
        const pdfPath = path.isAbsolute(doc.pdf_path)
          ? doc.pdf_path
          : path.join(options.sourceDir, doc.pdf_path);
        if (!fs.existsSync(imagePath)) {
          try {
            extractEmbeddedImage(pdfPath, image.page, image.xref, imagePath);
          } catch (error) {
            console.log(`${doc.doc_id}: page ${image.page} image ${image.xref} could not be extracted (${error.message})`);
            continue;
          }
        }
        let parsed;
        try {
          parsed = await readWatchlist(imagePath);
        } catch (error) {
          console.log(`${doc.doc_id}: page ${image.page} could not be read (${error.message})`);
          continue;
        }
        examined = true;
        summary.images += 1;
        if (!parsed.rows.length) {
          console.log(`${doc.doc_id}: page ${image.page} is not a watchlist (${parsed.notes.join('; ')})`);
          continue;
        }
        if (watchlist) {
          console.log(`${doc.doc_id}: page ${image.page} also read as a watchlist, but `
            + `page ${watchlist.image.page} already did; the first one is kept`);
          continue;
        }
        watchlist = { image, parsed };
      }
      if (!examined) {
        console.log(`${doc.doc_id}: its images could not be read; its rows are left as they are`);
        continue;
      }
      if (!options.dryRun) {
        if (watchlist) {
          writeRows(db, doc, watchlist.parsed.rows, watchlist.image.page, watchlist.image.xref);
          writeRecord(doc, watchlist.image.page, watchlist.image.xref, watchlist.parsed.rows, watchlist.parsed.notes);
        } else {
          writeRows(db, doc, [], 0, 0);
          // The sidecar is replaced with the rows, so it has to go when
          // they do -- a record of a screenshot the document does not
          // carry is the same stale claim as the rows would have been.
          const stale = path.join(RECORDS_DIR, `${doc.doc_id}_watchlist.json`);
          if (fs.existsSync(stale)) fs.rmSync(stale);
        }
      }
      if (!watchlist) {
        console.log(`${doc.doc_id}: no watchlist${options.dryRun ? '' : ' (any earlier rows are cleared)'}`);
        continue;
      }
      summary.screenshots += 1;
      summary.panes += watchlist.parsed.rows.length;
      const gains = watchlist.parsed.rows.filter((row) => row.chg_pct >= 0).length;
      console.log(
        `${doc.doc_id}: ${watchlist.parsed.rows.length} panes read from page ${watchlist.image.page} `
        + `(${gains} up, ${watchlist.parsed.rows.length - gains} down)`
        + (watchlist.parsed.notes.length ? `; ${watchlist.parsed.notes.length} note(s)` : '')
        + (options.dryRun ? ' [dry run: nothing written]' : '')
      );
    }
  } finally {
    db.close();
    await closeWorker();
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `${summary.panes} panes from ${summary.screenshots} screenshot(s) in ${summary.docs} document(s) `
      + `with ${summary.images} candidate image(s) read`
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
  findCandidateImages,
  listDocuments,
  writeRecord,
  writeRows,
};
