'use strict';

/**
 * Extract the POSITIONS from the O'Connell corpus.
 *
 * WHAT THIS STAGE READS
 *
 * The position log: the sheet that says what he actually held. Two
 * tables in one image -- equities and options -- with the entry date,
 * the position size, the stop, the risk, the R-multiple target and, for
 * options, the contract with its beta and delta.
 *
 * WHERE THE IMAGE COMES FROM
 *
 * Two places, in this order:
 *
 *   1. The standalone screenshot beside the PDF. It is a higher
 *      resolution copy of the same table: measured on 20261112, 2085x729
 *      standalone against 1272x445 embedded in the PDF.
 *   2. The copy embedded in the PDF, for the 170 issues that have no
 *      screenshot. It is smaller but it reads: the same column-aware
 *      reader gets "MSOS GTBIF TRLV GLAS" out of it.
 *
 * Usage:
 *   node tools/extractOconnellPositions.js
 *   node tools/extractOconnellPositions.js --doc-id oconnell_20261112
 *   node tools/extractOconnellPositions.js --limit 5 --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

const { oconnellSourceDir } = require('../src/oconnell/channel');
const { ensureOconnellSchema } = require('../src/oconnell/schema');
const {
  EQUITY_COLUMNS,
  EQUITY_TITLE,
  OPTION_COLUMNS,
  OPTION_TITLE,
  readFooterSnapshot,
  readSidebarSnapshot,
  readTableRows,
} = require('../src/oconnell/positionLayout');
const { closeWorker, readBandStrip, readGridFromRaw, readRegionText } = require('../src/table/tableReader');
const { extractEmbeddedImage, readMeta } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const RECORDS_DIR = path.join(ROOT, 'data', 'oconnell_records');
const WORK_DIR = path.join(ROOT, 'data', 'oconnell_work');

/**
 * The parser version written onto every row.
 *
 * 1 (2026-11-14): the first version. It reads the grid with
 * per-cell OCR at five times, takes the sign of a percentage from the
 * colour of the ink, and counts the position-sizing stars as connected
 * components.
 */
const PARSER_VERSION = 'oconnell-positions-2';

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
 * The image the position log is read from.
 *
 * The standalone screenshot first, because it is the higher-resolution
 * copy; the copy embedded in the PDF second, for the issues that have
 * no screenshot beside them.
 *
 * @param {object} issue
 * @returns {Promise<{path: string, source: string}|null>}
 */
async function resolvePositionImage(issue) {
  if (issue.positions_path) {
    const screenshot = path.join(options.sourceDir, issue.positions_path);
    if (fs.existsSync(screenshot)) {
      return { path: screenshot, source: 'screenshot' };
    }
  }

  const pdfPath = path.join(options.sourceDir, issue.pdf_path);
  if (!fs.existsSync(pdfPath)) return null;

  const meta = readMeta(pdfPath);
  if (meta.error) return null;

  for (const page of meta.pages || []) {
    const heading = (page.text_blocks || []).find((block) => /position\s*log/i.test(block.text || ''));
    if (!heading) continue;
    const below = (page.images || [])
      .filter((image) => image.bbox[1] >= heading.bbox[1] - 12)
      .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])
        - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
    if (!below.length) continue;
    const target = below[0];
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const out = path.join(WORK_DIR, `${issue.doc_id}_embedded.png`);
    extractEmbeddedImage(pdfPath, page.page, target.xref, out);
    return { path: out, source: 'pdf_embedded' };
  }
  return null;
}

/**
 * Does a band's text match a pattern?
 *
 * The cells are tried first, joined left to right: it is free, and on
 * the 2026 logs the title is intact in its cells. If that fails the
 * band is read as a STRIP, because the sheet's rules can cut a title
 * into pieces (the 2025 options title reads cell by cell as "oP | TONS
 * - | WING TI").
 *
 * The strip is read at scale 4, NOT the table reader's default of 8. A
 * full-width band at 8x is ~16,700 pixels wide, which Tesseract returns
 * nothing for -- that made the 2026 log find no tables at all.
 *
 * @param {object} band
 * @param {RegExp} pattern
 * @param {Buffer} raw
 * @param {object} info
 * @returns {Promise<boolean>}
 */
async function bandMatches(band, pattern, raw, info) {
  const joined = band.cells.map((cell) => cell.text).filter(Boolean).join(' ');
  if (pattern.test(joined) || pattern.test(band.text || '')) return true;
  const strip = await readBandStrip(raw, info, {
    bottom: band.bottom,
    left: 0,
    right: info.width - 1,
    top: band.top,
  }, 4);
  return pattern.test(strip);
}

/**
 * The bands whose header row starts with "Ticker".
 *
 * A position log has two tables, and both start with a Ticker column. The
 * band ABOVE a header band is that table's title band, and the title is
 * what says whether it is the equities table or the options one.
 *
 * @param {object} grid
 * @returns {number[]} the band indices, top to bottom
 */
function findHeaderBands(grid) {
  const bands = grid.bands || [];
  const headers = [];
  for (let index = 0; index < bands.length; index += 1) {
    const cells = bands[index].cells.filter((cell) => cell.text);
    if (cells.length < 4) continue;
    const first = String(cells[0].text).trim().toLowerCase();
    if (first === 'ticker' || first === 'tacker' || first === 'ticker.') {
      headers.push(index);
    }
  }
  return headers;
}

/**
 * The table of one kind, with its rows.
 *
 * The TITLE is read as a STRIP, not cell by cell: the sheet's own
 * vertical rules cut a title into pieces, and the 20250910 options title
 * reads cell by cell as "oP | TONS - | WING TI | JADES - | JSIC Aci |
 * ount - | Money | ..." -- which no pattern can match. Read as a strip it
 * is "OPTIONS - SWING TRADES - USIC Account - Money Manager ($1MM+)
 * Division".
 *
 * @param {object} options
 * @param {object} options.grid
 * @param {Buffer} options.raw
 * @param {object} options.info
 * @param {RegExp} options.pattern - the title pattern
 * @returns {Promise<{header: object, rows: object[], title: object}|null>}
 */
async function findTable(options) {
  // (see bandMatches below for how a title is recognised)
  const { grid, info, pattern, raw } = options;
  const bands = grid.bands || [];
  const headers = findHeaderBands(grid);

  for (const headerIndex of headers) {
    // The title band is the nearest band ABOVE the header that carries
    // any text. It is not always the band directly above: a one-pixel
    // rule between the title and the header reads as a band of its own,
    // and in the 20261112 log the options title is TWO bands above its
    // header.
    let titleIndex = -1;
    for (let index = headerIndex - 1; index >= 0; index -= 1) {
      if (!bands[index].text.trim()) continue;
      titleIndex = index;
      break;
    }
    if (titleIndex < 0) continue;

    const titleBand = bands[titleIndex];
    if (!(await bandMatches(titleBand, pattern, raw, info))) continue;

    const rows = [];
    for (let index = headerIndex + 1; index < bands.length; index += 1) {
      const band = bands[index];
      if (!band.text.trim()) continue;
      // The next table's title ends this one's rows -- whichever table it
      // is, so the equities table stops at the options title and not at
      // another equities title. A DATA ROW always has a percentage cell,
      // so only a band without one can be a title, and only those are
      // worth the cost of a strip read.
      if (index > headerIndex + 1 && !band.cells.some((cell) => /%/.test(cell.text))) {
        if (await bandMatches(band, /SWING\s*TRADES/i, raw, info)) break;
      }
      rows.push(band);
    }

    return { header: bands[headerIndex], rows, title: titleBand };
  }
  return null;
}

/**
 * Read the position log out of an image.
 *
 * @param {string} imagePath
 * @param {number} [sourceYear]
 * @returns {Promise<{positions: object[], snapshot: object, notes: string[]}>}
 */
async function readPositionLog(imagePath, sourceYear) {
  const source = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grid = await readGridFromRaw(source.data, source.info);

  const notes = [];
  const positions = [];

  const equity = await findTable({
    grid,
    info: source.info,
    pattern: EQUITY_TITLE,
    raw: source.data,
  });
  if (equity) {
    positions.push(...await readTableRows({
      columns: EQUITY_COLUMNS,
      headerCells: equity.header.cells,
      info: source.info,
      instrument: 'equity',
      raw: source.data,
      rowBands: equity.rows,
      sourceYear,
    }));
  } else {
    notes.push('no equities table found');
  }

  const optionsTable = await findTable({
    grid,
    info: source.info,
    pattern: OPTION_TITLE,
    raw: source.data,
  });
  if (optionsTable) {
    positions.push(...await readTableRows({
      columns: OPTION_COLUMNS,
      headerCells: optionsTable.header.cells,
      info: source.info,
      instrument: 'option',
      raw: source.data,
      rowBands: optionsTable.rows,
      sourceYear,
    }));
  } else {
    notes.push('no options table found');
  }

  const snapshot = {
    ...readSidebarSnapshot(grid),
    ...(await readFooterSnapshot(source.data, source.info, grid)),
  };

  return { notes, positions, snapshot };
}

/**
 * The cached reading of an image, if there is one.
 *
 * The cache key is the file's checksum and the parser version, so a
 * parser change invalidates every row by itself.
 *
 * @param {object} db
 * @param {string} checksum
 * @returns {object|null}
 */
function cachedReading(db, checksum) {
  const row = db.prepare(
    'SELECT payload FROM oconnell_ocr_cache WHERE source_key = ? AND parser_version = ?'
  ).get(checksum, PARSER_VERSION);
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * Store a reading in the cache.
 *
 * @param {object} db
 * @param {string} checksum
 * @param {object} payload
 */
function cacheReading(db, checksum, payload) {
  db.prepare(`
    INSERT INTO oconnell_ocr_cache (source_key, source_size, source_mtime, parser_version, payload)
    VALUES (?, 0, 0, ?, ?)
    ON CONFLICT(source_key, source_size, source_mtime, parser_version)
    DO UPDATE SET payload = excluded.payload
  `).run(checksum, PARSER_VERSION, JSON.stringify(payload));
}

/**
 * Write the positions and the snapshot of one issue.
 *
 * @param {object} db
 * @param {object} issue
 * @param {object} reading
 */
function writeReading(db, issue, reading) {
  db.prepare('DELETE FROM oconnell_positions WHERE doc_id = ?').run(issue.doc_id);
  db.prepare('DELETE FROM oconnell_snapshots WHERE doc_id = ?').run(issue.doc_id);

  const insert = db.prepare(`
    INSERT INTO oconnell_positions (
      doc_id, instrument, ticker, contract, setup_label, change_pct,
      underlying_change_pct, option_change_pct, cost_basis, price,
      gain_loss_pct, size_stars, stop_price, risk_pct, r2_price, sma20,
      sma50, beta, delta, entry_date, trade_length_days, exits, exit_price,
      lot_key, source_image, source_row, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  reading.positions.forEach((position, index) => {
    insert.run(
      issue.doc_id,
      position.instrument,
      position.ticker,
      position.contract,
      position.setup_label,
      position.change_pct,
      position.underlying_change_pct,
      position.option_change_pct,
      position.cost_basis,
      position.price,
      position.gain_loss_pct,
      position.size_stars,
      position.stop_price,
      position.risk_pct,
      position.r2_price,
      position.sma20,
      position.sma50,
      position.beta,
      position.delta,
      position.entry_date,
      position.trade_length_days,
      position.exits,
      position.exit_price,
      position.lot_key,
      reading.source_image || '',
      index,
      PARSER_VERSION
    );
  });

  const snapshot = reading.snapshot || {};
  db.prepare(`
    INSERT INTO oconnell_snapshots (
      doc_id, equity_count, option_count, cash_pct, invested_pct, trend_model,
      max_loss_stock_pct, max_loss_options_pct, win_rate_stock_pct,
      win_rate_options_pct, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      equity_count = excluded.equity_count,
      option_count = excluded.option_count,
      cash_pct = excluded.cash_pct,
      invested_pct = excluded.invested_pct,
      trend_model = excluded.trend_model,
      max_loss_stock_pct = excluded.max_loss_stock_pct,
      max_loss_options_pct = excluded.max_loss_options_pct,
      win_rate_stock_pct = excluded.win_rate_stock_pct,
      win_rate_options_pct = excluded.win_rate_options_pct,
      parser_version = excluded.parser_version
  `).run(
    issue.doc_id,
    reading.positions.filter((position) => position.instrument === 'equity').length,
    reading.positions.filter((position) => position.instrument === 'option').length,
    snapshot.cash_pct === undefined ? null : snapshot.cash_pct,
    snapshot.invested_pct === undefined ? null : snapshot.invested_pct,
    snapshot.trend_model === undefined ? null : snapshot.trend_model,
    snapshot.max_loss_stock_pct === undefined ? null : snapshot.max_loss_stock_pct,
    snapshot.max_loss_options_pct === undefined ? null : snapshot.max_loss_options_pct,
    snapshot.win_rate_stock_pct === undefined ? null : snapshot.win_rate_stock_pct,
    snapshot.win_rate_options_pct === undefined ? null : snapshot.win_rate_options_pct,
    PARSER_VERSION
  );
}

/**
 * The committed record of one issue.
 *
 * The corpus is paid and lives outside the repository, so this file is
 * the only recoverable copy of what was read.
 */
function writeRecord(issue, reading) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const file = path.join(RECORDS_DIR, `${issue.doc_id}.json`);
  const payload = {
    doc_id: issue.doc_id,
    generated_at: new Date().toISOString(),
    notes: reading.notes || [],
    parser_version: PARSER_VERSION,
    positions: reading.positions,
    source_date: issue.source_date,
    source_image: reading.source_image || '',
    source_kind: reading.source_kind || '',
    snapshot: reading.snapshot || {},
    title: issue.title,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

async function main() {
  const db = openDatabase();
  const rows = db.prepare(`
    SELECT doc_id, source_date, pdf_path, positions_path, positions_checksum, title
    FROM oconnell_issues
    ORDER BY source_date ASC
  `).all();

  let candidates = rows;
  if (options.docId) candidates = rows.filter((row) => row.doc_id === options.docId);
  if (options.limit) candidates = candidates.slice(0, options.limit);

  const results = [];
  let read = 0;
  let cached = 0;
  let failed = 0;
  let noPositionLog = 0;

  for (const issue of candidates) {
    const checksum = issue.positions_checksum || `pdf:${issue.pdf_path}`;
    let reading = options.refresh ? null : cachedReading(db, checksum);

    if (!reading) {
      const image = await resolvePositionImage(issue);
      if (!image) {
        // NOT a failure. A document that carries no position log says so,
        // and counting it as a failure would put a number in the coverage
        // funnel that reads as "we tried and could not" when the truth is
        // "there was nothing there".
        noPositionLog += 1;
        results.push({ doc_id: issue.doc_id, status: 'no_position_log' });
        continue;
      }
      const sourceYear = Number(String(issue.source_date).slice(0, 4));
      reading = await readPositionLog(image.path, sourceYear);
      reading.source_image = path.basename(image.path);
      reading.source_kind = image.source;
      cacheReading(db, checksum, reading);
      read += 1;
    } else {
      cached += 1;
    }

    writeReading(db, issue, reading);
    writeRecord(issue, reading);
    if (reading.setups) delete reading.setups;
    results.push({
      doc_id: issue.doc_id,
      positions: reading.positions.length,
      snapshot: Object.keys(reading.snapshot || {}).length,
      status: 'ok',
    });
  }

  const summary = {
    cached,
    documents: candidates.length,
    failed,
    no_position_log: noPositionLog,
    read,
    with_positions: results.filter((result) => result.status === 'ok').length,
  };

  if (options.json) {
    console.log(JSON.stringify({ results, summary }, null, 2));
  } else {
    console.log(`issues: ${summary.documents} | read ${read} | cached ${cached} | no position log ${failed}`);
    console.log(`with positions: ${summary.with_positions}`);
  }

  db.close();
  await closeWorker();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error && error.stack ? error.stack : String(error));
    await closeWorker();
    process.exit(1);
  });
}

module.exports = { PARSER_VERSION, findTable, readPositionLog, resolvePositionImage };
