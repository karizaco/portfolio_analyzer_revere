'use strict';

/**
 * Read the Komar WATCHLIST SCREENSHOT out of a daily update.
 *
 * WHAT IT IS
 *
 * The daily and mid-week updates carry a TradingView screenshot of the
 * author's own watchlist: one chart per ticker, each with the ticker's
 * change, its change percentage and its price. It is a DATED market
 * read of the names he was watching -- and the ticker labels are
 * THIRTY pixels tall, against the eight to thirteen of the panel video
 * frames, which is why this is a better source than the panel reader
 * is.
 *
 * THE PANE GRID, MEASURED
 *
 * The screen is a grid of TradingView panes. Measured on all three of
 * the corpus's watchlist screenshots: a pane is **270 pixels wide** and
 * **150 pixels tall**, the screen is 1080 pixels wide (four panes
 * across), and a row that does not fill its width is CENTRED -- one
 * pane at 405, three at 135, 405 and 675.
 *
 * **SO THE PANE ORIGINS ARE ON A HALF-PANE GRID** -- 0, 135, 270, 405,
 * 540, 675, 810 -- and the rows are 150 pixels apart. The reader
 * sweeps that grid and reads each cell, and a cell that is not a pane
 * reads as nothing.
 *
 * WHY THE GRID AND NOT THE OCR'S OWN READING
 *
 * The whole screen was read first, and the reading is not good
 * enough: at 2x the 2025-04-08 frame's first change comes back as the
 * word "he" -- the header merged with the chart under it -- and at 1x
 * the tickers come back mangled ("AER" for AEHR). So the whole-screen
 * reading is not used at all. Each cell is read on its own, which is
 * what works: a pane's header, alone, is legible.
 *
 * HOW A CELL IS READ
 *
 * 1. **THE TICKER, from the pane's own left edge.** The ticker's
 *    glyphs are thirteen pixels tall and start five to nine pixels
 *    inside the pane, so the crop is the pane's first 56 pixels.
 *    Measured on the corpus's frames: at 36 px the tickers come back
 *    truncated ("AAC" for AAOI), at 44 they come back misread ("USAF"
 *    for USAR), and at 52 all of them read whole.
 * 2. **THE MARKET ARBITRATES.** The SEC's own registrant list says
 *    which reading is a ticker, and a misread that is one edit away
 *    from exactly one listed ticker is repaired to it.
 * 3. **THE CHANGE IS READ THREE TIMES AND THE MAJORITY WINS.** The
 *    change's own crop reads "+1.21 (12.17%)" at one scale and
 *    "+1.21 (12.27%)" at another -- the same pixels, read twice, with
 *    one digit different. So the crop is read at three scales and the
 *    value two of them agree on is the value. This is the project's
 *    own rule (see `tools/resolveUndatedDates.js`): two independent
 *    readings have to agree before anything is written.
 * 4. **THE SIGN COMES FROM THE INK.** The header prints the sign on
 *    the CHANGE ("-0.39 (3.31%)") and none on the percentage, and the
 *    printed minus is one pixel wide -- which Tesseract drops. The
 *    change is printed in green for a gain and in red for a loss, so
 *    the sign is read from the COLOUR of the text, the way the panel
 *    reader takes the W/L sign from the fill.
 *
 * WHAT IT IS NOT
 *
 * The PRICE is not read: it is not in the header but in a box on the
 * chart itself, and the price is a reading of the chart rather than
 * of the header. The change and the change percentage are what a
 * market read needs, and they are in the header.
 */

const sharp = require('sharp');

const { readCell } = require('../table/tableReader');
const { loadMarketTickers } = require('../normalize/marketTickers');

/** How many panes the screen is across. Measured on the corpus: the
 *  watchlist screenshots are 1080 pixels wide, four panes across. */
const PANES_ACROSS = 4;

/** Which reading produced these rows. Bump it whenever a row's value
 *  can move: the crop, the grid, the quorum and the sign rule are all
 *  claims about the pixels, and a row has to say which claims made it. */
const PARSER_VERSION = 'komar-watchlist-1';

/** The width a pane has to have, in pixels, and how far it may
 *  differ. Every crop this reader takes is measured against the
 *  corpus's 270-pixel panes -- the ticker's crop is 52 px, the
 *  change's runs from 130 to 240 -- so a screen whose panes are a
 *  different size would be silently misread rather than merely read
 *  worse. An image outside this band is refused, and the note says
 *  why. */
const PANE_WIDTH_MEASURED = 270;
const PANE_WIDTH_TOLERANCE = 12;

/** The height a pane has to have, in pixels, and how far it may
 *  differ. A screenshot shows WHOLE panes, so its height is a whole
 *  number of them: the corpus's are 306 (2 panes), 451 (3) and 604
 *  (4), against 692 for the market CARD -- which is 1080 wide too,
 *  and carries a "(46.04 -0.19%)" of its own that a percentage test
 *  alone would take for a header. */
const PANE_HEIGHT_MEASURED = 150;
const PANE_HEIGHT_TOLERANCE = 12;

/** How tall a pane is, as a fraction of its width. Measured: a pane
 *  is 270 by 150. */
const PANE_ASPECT = 150 / 270;

/** A header crop's scale. One pane's header, alone, is legible at 4x. */
const CROP_SCALE = 4;

/** The scales the CHANGE crop is read at, and the value two of them
 *  agreeing on is the value. */
const CHANGE_SCALES = [3, 4, 6];

/** How wide the TICKER's own crop is, in pixels. */
const TICKER_CROP = 52;

/** How wide the TICKER's SECOND crop is. The 52-pixel crop is the one
 *  that reads a four-letter ticker whole, but it can pick up the start
 *  of the date beside it -- "TER" came back as "TERE". So a reading
 *  the market does not know is tried again at this width, and the
 *  market picks between the two. */
const TICKER_CROP_NARROW = 40;

/** How far into the pane the ticker's crop starts. The ticker's own
 *  left edge is five to nine pixels inside the pane. */
const TICKER_CROP_LEAD = 4;

/** How far the CHANGE's crop starts after the pane's left edge. The
 *  change sits 145 to 164 pixels in, and its percentage 172 to 207. */
const CHANGE_CROP_LEAD = 130;

/** How far the CHANGE's crop reaches past the pane's left edge. */
const CHANGE_CROP_TRAIL = 240;

/** The header's vertical band, relative to the pane row's top. The
 *  TICKER's glyphs are thirteen pixels tall and the change's are
 *  eight, so the band has to reach the bottom of the taller of them:
 *  measured on the corpus's frames, a band of [top - 8, top + 14]
 *  reads 12 of the 15 tickers of the 2026 frames and a band of
 *  [top - 3, top + 27] reads all of them. */
const BAND_ABOVE = 3;
const BAND_BELOW = 27;

/** The band around the header's top that the sign is measured in. It
 *  is tighter than the reading band, because it must not reach the
 *  chart's ink below the header -- a candle's top in this band would
 *  move the change's own left edge. */
const SIGN_BAND_ABOVE = 3;
const SIGN_BAND_BELOW = 19;

/** The shortest a word may be and still be the ticker. */
const TICKER_MIN_LENGTH = 2;

/** The longest a ticker may be. */
const TICKER_MAX_LENGTH = 6;

/** How close a word has to be to "finviz.com" to be the watermark. */
const WATERMARK_DISTANCE = 4;

/**
 * The edit distance between two strings, with a cap.
 *
 * @param {string} left
 * @param {string} right
 * @param {number} [cap]
 * @returns {number}
 */
function editDistance(left, right, cap = 4) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Is this word the source's watermark?
 *
 * The watermark is read as "finviz.com", "finvizcom", "Ofinvizcom",
 * "©fimizcom", "finiz.com" and "Ofinvizeom" -- one to three edits
 * from the truth in every case. It is the only text EVERY header
 * carries, and it sits at the RIGHT of the header, after the change
 * percentage.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isWatermark(text) {
  const value = String(text || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (value.length < 5 || value.length > 14) return false;
  return editDistance(value, 'finvizcom') <= WATERMARK_DISTANCE;
}

/**
 * Does this word have the shape of a ticker?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isTickerShaped(text) {
  const value = String(text || '').trim().toUpperCase();
  if (value.length < TICKER_MIN_LENGTH || value.length > TICKER_MAX_LENGTH) return false;
  return /^[A-Z][A-Z0-9.\-]*$/.test(value);
}

/**
 * A copy of the pixels INVERTED.
 *
 * The screens are dark -- white text on a black chart -- and
 * Tesseract reads dark-on-light.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @returns {Buffer}
 */
function inverted(raw, info) {
  const out = Buffer.from(raw);
  for (let offset = 0; offset < out.length; offset += info.channels) {
    out[offset] = 255 - out[offset];
    out[offset + 1] = 255 - out[offset + 1];
    out[offset + 2] = 255 - out[offset + 2];
  }
  return out;
}

/**
 * The greenness and the redness of a rectangle's ink.
 *
 * The header's change is printed in green for a gain and in red for a
 * loss, and the text is ANTIALIASED -- a single letter's pixels are
 * a spread of blends, each of them one or two pixels wide. So the
 * colour is measured as a SUM of how far each pixel leans green or
 * red, not as a count of pixels: a count is a tie between a green and
 * a red change, because both are made of the same handful of pixels.
 *
 * The background contributes nothing: the screen's own background is
 * (35, 38, 47), and neither green nor red is the largest of those
 * three channels.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @returns {{green: number, red: number}}
 */
function inkColours(raw, info, rect) {
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  let green = 0;
  let red = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = raw[offset];
      const g = raw[offset + 1];
      const b = raw[offset + 2];
      const greenness = g - Math.max(r, b);
      const redness = r - Math.max(g, b);
      if (greenness > 0) green += greenness;
      if (redness > 0) red += redness;
    }
  }
  return { green, red };
}

/**
 * The change and the change percentage out of a pane's header.
 *
 * The header reads "AAOI Apr 29 +7.42 (5.41%) © finviz.com" -- so
 * the change is the number before the parenthesis and the change
 * percentage is the one inside it.
 *
 * **THE PERCENTAGE TAKES THE CHANGE'S SIGN.** The header prints the
 * sign on the CHANGE ("-0.39 (3.31%)") and none on the percentage,
 * so a percentage read without a sign takes the sign of the ink.
 *
 * @param {string} text
 * @param {number} sign - 1, 0 or -1, from the ink
 * @returns {{chg: number|null, chg_pct: number|null}}
 */
function parseChange(text, sign) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const pair = /([-+]?\d+(?:\.\d+)?)\s*\(\s*([-+]?\d+(?:\.\d+)?)\s*%/.exec(value);
  let change = null;
  let percent = null;
  if (pair) {
    change = Number(pair[1]);
    percent = Number(pair[2]);
  } else {
    const percentMatch = /([-+]?\d+(?:\.\d+)?)\s*%/.exec(value);
    if (percentMatch) {
      percent = Number(percentMatch[1]);
      const before = value.slice(0, percentMatch.index);
      const numbers = (before.match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
      change = numbers.length ? numbers[numbers.length - 1] : null;
    }
  }
  if (change !== null && !Number.isFinite(change)) change = null;
  if (percent !== null && !Number.isFinite(percent)) percent = null;
  if (change !== null && sign < 0 && change > 0) change = -change;
  if (percent !== null && sign < 0 && percent > 0) percent = -percent;
  if (change !== null && sign > 0 && change < 0) change = Math.abs(change);
  if (percent !== null && sign > 0 && percent < 0) percent = Math.abs(percent);
  return { chg: change, chg_pct: percent };
}

/**
 * The value the most readings agree on.
 *
 * @param {Array<number|null>} values
 * @returns {number|null}
 */
function majority(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Repair a misread ticker, if exactly one known ticker is one edit
 * away.
 *
 * A misread ticker is a MISSING holding, so the market's own ticker
 * list arbitrates -- but only when the candidate is UNIQUE: a misread
 * that is equally near two known tickers is left alone, because a
 * wrong holding is worse than a missing one.
 *
 * @param {string} ticker
 * @param {Set<string>} vocabulary
 * @returns {string} the repaired ticker, or the one that was read
 */
function repairTicker(ticker, vocabulary) {
  const value = String(ticker || '').trim().toUpperCase();
  if (!value || vocabulary.has(value)) return value;
  const near = [];
  for (const candidate of vocabulary) {
    if (Math.abs(candidate.length - value.length) > 1) continue;
    if (editDistance(candidate, value, 2) === 1) near.push(candidate);
  }
  if (near.length === 1) return near[0];
  return value;
}

/**
 * The pane grid of a screen.
 *
 * The panes sit on a HALF-pane grid, because a row that does not fill
 * the screen's width is centred: one pane at 405, three at 135, 405
 * and 675.
 *
 * @param {number} width
 * @returns {number[]}
 */
function paneOrigins(width) {
  const pane = width / PANES_ACROSS;
  const half = pane / 2;
  const origins = [];
  for (let x = 0; x + pane <= width + 1; x += half) origins.push(Math.round(x));
  return origins;
}

/**
 * Read the watchlist screenshot.
 *
 * @param {string} imagePath
 * @param {object} [options]
 * @param {Set<string>} [options.vocabulary] - the tickers the market knows
 * @returns {Promise<{rows: object[], notes: string[]}>}
 */
async function readWatchlist(imagePath, options = {}) {
  const notes = [];
  const source = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: raw, info } = source;
  const paneWidth = info.width / PANES_ACROSS;
  if (Math.abs(paneWidth - PANE_WIDTH_MEASURED) > PANE_WIDTH_TOLERANCE) {
    return {
      notes: [`this is not a watchlist screenshot: its panes would be ${Math.round(paneWidth)} `
        + `pixels wide, and the reader's crops are measured on ${PANE_WIDTH_MEASURED}`],
      rows: [],
    };
  }
  const whole = info.height / PANE_HEIGHT_MEASURED;
  if (Math.abs(whole - Math.round(whole)) * PANE_HEIGHT_MEASURED > PANE_HEIGHT_TOLERANCE) {
    return {
      notes: [`this is not a watchlist screenshot: its height of ${info.height} is not a whole `
        + `number of ${PANE_HEIGHT_MEASURED}-pixel panes`],
      rows: [],
    };
  }
  const light = inverted(raw, info);

  const vocabulary = options.vocabulary || loadMarketTickers();
  const readCrop = async (left, right, top, bottom, scale) => {
    const read = await readCell(light, info, {
      bottom: Math.min(info.height - 1, bottom),
      left: Math.max(0, left),
      right: Math.min(info.width - 1, right),
      top: Math.max(0, top),
    }, { scale });
    return (read.words || [])
      .map((word) => String(word.text || '').trim())
      .filter(Boolean)
      .join(' ');
  };

  const origins = paneOrigins(info.width);
  const rowPitch = Math.round(paneWidth * PANE_ASPECT);
  const out = [];
  // Only WHOLE rows are swept: a screenshot that cuts its last pane
  // in half has no header to read in the part that is missing.
  for (let rowTop = 0; rowTop + rowPitch <= info.height; rowTop += rowPitch) {
    const top = rowTop - BAND_ABOVE;
    const bottom = rowTop + BAND_BELOW;
    for (const origin of origins) {
      // THE TICKER, from the pane's own left edge. The wide crop reads
      // a four-letter ticker whole; when its reading is a name the
      // market does not know, the narrow crop is read too and the two
      // are settled by the market's own list.
      let tickerText = '';
      try {
        tickerText = await readCrop(
          origin + TICKER_CROP_LEAD,
          origin + TICKER_CROP_LEAD + TICKER_CROP,
          top,
          bottom,
          CROP_SCALE,
        );
      } catch (error) {
        notes.push(`the cell at x ${origin}, y ${rowTop} could not be read: ${error.message}`);
        continue;
      }
      let token = (tickerText.split(' ').find((part) => isTickerShaped(part)) || '')
        .trim()
        .toUpperCase();
      if (token && !vocabulary.has(token)) {
        try {
          const narrow = await readCrop(
            origin + TICKER_CROP_LEAD,
            origin + TICKER_CROP_LEAD + TICKER_CROP_NARROW,
            top,
            bottom,
            CROP_SCALE,
          );
          const alt = (narrow.split(' ').find((part) => isTickerShaped(part)) || '')
            .trim()
            .toUpperCase();
          if (alt && vocabulary.has(alt)) token = alt;
        } catch (error) {
          notes.push(`the cell at x ${origin}, y ${rowTop} could not be read: ${error.message}`);
        }
      }
      if (!token || isWatermark(tickerText)) continue;

      // THE CHANGE'S SIGN, from the ink: the header prints the sign
      // on the CHANGE and none on the percentage, and the printed
      // minus is one pixel wide -- which Tesseract drops.
      const region = {
        bottom: rowTop + SIGN_BAND_BELOW,
        left: origin + CHANGE_CROP_LEAD,
        right: origin + CHANGE_CROP_TRAIL,
        top: rowTop + SIGN_BAND_ABOVE,
      };
      const colours = inkColours(raw, info, region);
      if (colours.green === 0 && colours.red === 0) continue;
      const sign = colours.green === colours.red ? 0 : (colours.green > colours.red ? 1 : -1);

      // THE CHANGE, read three times, and the value two of them agree
      // on.
      const magnitudes = { chg: [], chg_pct: [] };
      const readings = [];
      for (const scale of CHANGE_SCALES) {
        let text;
        try {
          text = await readCrop(region.left, region.right, top, bottom, scale);
        } catch (error) {
          notes.push(`the cell at x ${origin}, y ${rowTop} could not be read: ${error.message}`);
          break;
        }
        readings.push(text);
        const parsed = parseChange(text, 0);
        magnitudes.chg.push(parsed.chg === null ? null : Math.abs(parsed.chg));
        magnitudes.chg_pct.push(parsed.chg_pct === null ? null : Math.abs(parsed.chg_pct));
      }
      // A cell whose change crop carries no bracketed percentage is
      // not a pane: the change is what every header carries, and a
      // chart's own axis label is not a header. So it is dropped
      // without a word.
      if (!readings.some((text) => /\(\s*[-+]?\d[^\s]*%/.test(text))) continue;

      const change = parseChange(`${majority(magnitudes.chg)} (${majority(magnitudes.chg_pct)}%)`, sign);
      if (change.chg_pct === null) {
        notes.push(`the cell at x ${origin}, y ${rowTop} read "${readings.join(' | ')}" and no change came out of it`);
        continue;
      }
      out.push({
        chg: change.chg,
        chg_pct: change.chg_pct,
        column: origin,
        raw: readings.join(' | '),
        row: rowTop,
        ticker: repairTicker(token, vocabulary),
      });
    }
  }
  if (!out.length) notes.push('no pane produced a ticker and a change');
  return { notes, rows: out };
}

module.exports = {
  BAND_ABOVE,
  BAND_BELOW,
  CHANGE_CROP_LEAD,
  CHANGE_CROP_TRAIL,
  CHANGE_SCALES,
  CROP_SCALE,
  PANE_ASPECT,
  PANE_WIDTH_MEASURED,
  PANE_WIDTH_TOLERANCE,
  PANES_ACROSS,
  PARSER_VERSION,
  TICKER_CROP,
  TICKER_CROP_LEAD,
  TICKER_CROP_NARROW,
  editDistance,
  inkColours,
  isTickerShaped,
  isWatermark,
  majority,
  paneOrigins,
  parseChange,
  readWatchlist,
  repairTicker,
};
