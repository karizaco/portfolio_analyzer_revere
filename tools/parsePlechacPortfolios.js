'use strict';

/**
 * Read plechac's portfolio screenshots into position rows.
 *
 * WHAT THIS IS
 *
 * The portfolio channel carries screenshots of his broker's positions
 * screen, and the readable format is the XTB "POZICE" table: one row per
 * holding with its units, its average cost, its market value, its P&L and
 * -- the column the trade channel cannot give -- its WEIGHT.
 *
 * The trade channel says WHAT he traded. This says HOW MUCH of the book
 * each holding is, and that is what turns a list of trades into a
 * portfolio.
 *
 * THE IMAGE IS THE RECORD
 *
 * The downloaded image is kept under
 * `data/discord_pipeline/media/<source>/<message_id>/` and the OCR of it
 * is cached beside it, so a change to the reader can be measured without
 * paying for the OCR again. The interpretation is the reader's; the image
 * is the evidence.
 *
 *   node tools/parsePlechacPortfolios.js            # every attachment
 *   node tools/parsePlechacPortfolios.js --dry-run  # read, write nothing
 *   node tools/parsePlechacPortfolios.js --no-cache # re-OCR every image
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { ensureDiscordSchema } = require('../src/discord/schema');
const { preprocessChartStreamRawToBuffer } = require('../src/ocr/ocrImage');
const { runEasyOcr } = require('../src/ocr/easyocrAdapter');
const { readPositionsTable } = require('../src/discord/plechac/portfolioReader');
const { marketTickerOf } = require('../src/discord/plechac/symbols');
const { ACCOUNT_MAIN, ACCOUNT_RISKY } = require('../src/discord/plechac/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SOURCE = 'plechac-portfolia';
const PARSER_VERSION = 'plechac-portfolio-1';

const dryRun = process.argv.includes('--dry-run');
const noCache = process.argv.includes('--no-cache');

/**
 * The book a screenshot belongs to.
 *
 * The message says which one: "Tohle je moje malé RISKY portfolio na
 * XTB". Everything else is the main book.
 *
 * @param {string} text
 * @returns {string}
 */
function accountOf(text) {
  return /risk/i.test(String(text || '')) ? ACCOUNT_RISKY : ACCOUNT_MAIN;
}

async function ocrOf(file, cachePath) {
  if (!noCache && fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // a broken cache is a cache miss
    }
  }
  const buffer = await preprocessChartStreamRawToBuffer(file, {
    overlayRegion: { x: 0, y: 0.03, w: 0.70, h: 0.94 },
    overlayScale: 3,
  });
  const tmp = path.join(path.dirname(cachePath), '.ocr-input.png');
  fs.writeFileSync(tmp, buffer);
  const result = await runEasyOcr(tmp, {});
  try {
    fs.unlinkSync(tmp);
  } catch {
    // the temp file is not worth a failure
  }
  const payload = { text: result.text, words: result.words || [] };
  fs.writeFileSync(cachePath, JSON.stringify(payload));
  return payload;
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureDiscordSchema(db);

  const attachments = db.prepare(`
    SELECT a.id, a.message_id, a.local_path, a.width, a.height, a.file_name,
           m.posted_at, m.content
      FROM discord_attachments a
      JOIN discord_messages m ON m.id = a.message_id
     WHERE a.source_name = ?
     ORDER BY m.posted_at, a.id
  `).all(SOURCE);

  const insert = db.prepare(`
    INSERT INTO discord_positions
      (parser_version, source_name, message_id, as_of_date, as_of_source, account,
       sub_account, side, ticker, weight_pct, stated_price, annotation, note,
       is_new, snapshot_notes, header, long_exposure_pct, short_exposure_pct, cash_pct)
    VALUES (?, ?, ?, ?, ?, ?, '', 'long', ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL)
  `);

  // The rows of THIS source and THIS parser version are replaced, so a
  // re-run cannot double them. The other sources' rows are untouched.
  if (!dryRun) {
    db.prepare(
      `DELETE FROM discord_positions
        WHERE source_name = ? AND parser_version = ?`,
    ).run(SOURCE, PARSER_VERSION);
  }

  const summary = { images: 0, read: 0, unread: 0, positions: 0, complete: 0, unverified: 0 };
  const detail = [];

  for (const attachment of attachments) {
    summary.images += 1;
    const file = path.join(ROOT, attachment.local_path);
    if (!fs.existsSync(file)) {
      detail.push({ file: attachment.local_path, status: 'image missing' });
      continue;
    }
    // The cache is PER ATTACHMENT: a message can carry two images (the
    // positions table and a strip cut out of it), and one cache per
    // message would read the first image's words for the second.
    const cachePath = path.join(
      path.dirname(file),
      `${path.basename(file, path.extname(file))}.ocr.json`,
    );
    let ocr;
    try {
      // eslint-disable-next-line no-await-in-loop
      ocr = await ocrOf(file, cachePath);
    } catch (error) {
      detail.push({ file: attachment.local_path, status: `ocr failed: ${error.message}` });
      summary.unread += 1;
      continue;
    }
    const read = readPositionsTable(ocr);
    if (!read.positions.length) {
      detail.push({
        file: attachment.local_path,
        status: `no positions (${read.unread.join('; ') || 'no table'})`,
        width: attachment.width,
        height: attachment.height,
      });
      summary.unread += 1;
      continue;
    }
    summary.read += 1;
    summary.positions += read.positions.length;
    if (read.coverage && read.coverage.complete) summary.complete += 1;
    summary.unverified += read.positions.filter((position) => position.reading_check !== 'ok').length;

    const asOfDate = String(attachment.posted_at).slice(0, 10);
    const account = accountOf(attachment.content);
    detail.push({
      file: attachment.local_path,
      date: asOfDate,
      account,
      coverage: read.coverage,
      positions: read.positions.map((position) => ({
        broker: position.ticker,
        ticker: marketTickerOf(position.ticker),
        weight_pct: position.weight_pct,
        avg_cost: position.avg_cost,
        price: position.price,
        pnl_pct: position.pnl_pct,
        reading_check: position.reading_check,
      })),
    });

    if (dryRun) continue;
    db.exec('BEGIN');
    try {
      for (const position of read.positions) {
        const ticker = marketTickerOf(position.ticker);
        insert.run(
          PARSER_VERSION,
          SOURCE,
          attachment.message_id,
          asOfDate,
          'discord_portfolio_screenshot',
          account,
          ticker,
          position.weight_pct,
          position.avg_cost,
          `broker symbol ${position.ticker}; units ${position.units === null ? '' : position.units}`
            + `; price ${position.price === null ? '' : position.price}`
            + `; check ${position.reading_check}`,
          position.pnl_pct === null ? '' : `pnl ${position.pnl_pct}%`,
          JSON.stringify(read.coverage),
          `XTB positions screenshot, ${asOfDate}, ${account} book`,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.close();
  console.log(JSON.stringify({ summary, detail }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
