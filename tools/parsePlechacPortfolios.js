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
const { readHeatmapWithColour } = require('../src/discord/plechac/heatmapReader');
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

/**
 * The width a picture has to reach before the WHOLE-image OCR is worth
 * it.
 *
 * The whole-image OCR costs about six minutes a picture, and the corpus
 * holds fourteen pictures of three different formats. The treemap is the
 * only one that is WIDER than 2000 px -- the XTB table is 1387, the
 * "My Holdings" pictures are 1846-1861, and the ticker strips are
 * 201-992 -- so the width is the gate, and it is the one measurement
 * that separates the treemap from the rest.
 *
 * The "My Holdings" pictures are a THIRD format and have no reader yet;
 * the gate keeps them out of this one rather than pretending they are
 * treemaps.
 */
const TREEMAP_MIN_WIDTH = 2000;

/**
 * The OCR of the WHOLE image, cached beside the partial one.
 *
 * The pipeline's OCR region is the chart-stream overlay -- the LEFT 70 %
 * of the image -- because that is where a TradingView panel lives. The
 * 2026-04-15 screenshot is not a chart panel: it is a full-width
 * TREEMAP of the whole book, and 30 % of it was never read.
 *
 * So the treemap is OCR'd whole, and the result is cached under its own
 * name -- the partial OCR is kept, because the table reader is measured
 * against it and there is no reason to pay for it twice.
 *
 * @param {string} file
 * @param {string} cachePath
 * @returns {Promise<object>}
 */
async function ocrOfWholeImage(file, cachePath) {
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // a broken cache is a cache miss
    }
  }
  const buffer = await preprocessChartStreamRawToBuffer(file, {
    overlayRegion: { x: 0, y: 0, w: 1, h: 1 },
    overlayScale: 2,
  });
  const tmp = path.join(path.dirname(cachePath), '.ocr-full-input.png');
  fs.writeFileSync(tmp, buffer);
  const result = await runEasyOcr(tmp, {});
  try {
    fs.unlinkSync(tmp);
  } catch {
    // the temp file is not worth a failure
  }
  const payload = {
    text: result.text,
    words: result.words || [],
    scale: 2,
    region: { x: 0, y: 0, w: 1, h: 1 },
  };
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

  const summary = {
    images: 0,
    read: 0,
    unread: 0,
    positions: 0,
    complete: 0,
    unverified: 0,
    heatmaps: 0,
    heatmap_holdings: 0,
  };
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
      // NOT THE TABLE? Then it may be the TREEMAP, which is a
      // full-width picture and needs the whole image OCR'd. The
      // treemap's own percentage is the DAILY CHANGE and not the
      // weight -- the weight is not printed in that picture at all --
      // so the rows it produces carry NO weight.
      let heatmap = null;
      const wholeCachePath = path.join(
        path.dirname(file),
        `${path.basename(file, path.extname(file))}.ocr.full.json`,
      );
      if (Number(attachment.width) >= TREEMAP_MIN_WIDTH) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const whole = await ocrOfWholeImage(file, wholeCachePath);
          // The SIGN of each change comes from the leaf's COLOUR, not
          // from the glyph: the broker's minus dash is lost by the OCR
          // on 12 of the 64 leaves, and both OCR passes lose the SAME
          // one, so their agreement is not evidence.
          // eslint-disable-next-line no-await-in-loop
          const candidate = await readHeatmapWithColour(whole, { imagePath: file });
          if (candidate.holdings.length) heatmap = candidate;
        } catch (error) {
          detail.push({ file: attachment.local_path, status: `whole-image ocr failed: ${error.message}` });
        }
      }
      if (heatmap) {
        summary.heatmaps += 1;
        summary.heatmap_holdings += heatmap.holdings.length;
        const asOfDate = String(attachment.posted_at).slice(0, 10);
        const account = accountOf(attachment.content);
        detail.push({
          file: attachment.local_path,
          date: asOfDate,
          account,
          format: 'treemap',
          coverage: heatmap.coverage,
          sectors: heatmap.sectors,
          positions: heatmap.holdings.map((holding) => ({
            broker: holding.broker_ticker,
            ticker: holding.ticker,
            weight_pct: null,
            change_pct: holding.change_pct,
            sector: holding.sector,
          })),
        });
        if (!dryRun) {
          db.exec('BEGIN');
          try {
            for (const holding of heatmap.holdings) {
              insert.run(
                PARSER_VERSION,
                SOURCE,
                attachment.message_id,
                asOfDate,
                'discord_portfolio_treemap',
                account,
                holding.ticker,
                // NO WEIGHT: the treemap prints the DAILY CHANGE and
                // draws the size, and the size is the value in the
                // portfolio and not a percentage of it.
                null,
                '',
                `treemap leaf; broker symbol ${holding.broker_ticker}`
                  + `; daily change ${holding.change_pct}%`
                  + `; sector ${holding.sector || 'not read'}`,
                `daily change ${holding.change_pct}%`,
                JSON.stringify(heatmap.coverage),
                `XTB portfolio treemap, ${asOfDate}, ${account} book`,
              );
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
        continue;
      }
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
