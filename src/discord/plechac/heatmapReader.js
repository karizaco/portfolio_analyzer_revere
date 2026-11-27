'use strict';

/**
 * plechac's portfolio TREEMAP, read out of a broker screenshot.
 *
 * WHAT THE SCREEN IS
 *
 * The portfolio channel carries a screenshot of his broker's own
 * portfolio visualisation: a TREEMAP of the whole book, divided into
 * SECTOR groups, and every leaf is one holding:
 *
 *   Technologie +1.04%        <- the sector, and ITS aggregate change
 *   IDUS.LSE                  <- the leaf: the ticker
 *   +0.67%                    <- the leaf's DAILY CHANGE
 *   iShares Core S&P 500 UCIT  <- the leaf's company name
 *
 * The header says "96 pozic · 13 sektorů" -- 96 positions and 13
 * sectors -- and the tab strip says "Denní změna · velikost = hodnota v
 * portfoliu": the view is the DAILY CHANGE, and the AREA of each leaf is
 * its value in the portfolio.
 *
 * THE PERCENTAGE IS THE DAILY CHANGE AND NOT THE WEIGHT, and that was
 * MEASURED rather than assumed
 *
 * The open question this reader was built to answer was "is the
 * percentage next to each ticker the `velikost` (size) column the header
 * names?". **It is not.** The header's own sentence separates the two:
 * the daily change is what is PRINTED, and the size is what is DRAWN.
 *
 * And the arithmetic settles it independently: the percentages of the
 * leaves of a group are the sector's own aggregate, and the percentages
 * of ALL the leaves sum to roughly ZERO -- a book of daily changes --
 * where weights would sum to 100.
 *
 * So the weight is NOT PRINTED anywhere in this image, and this reader
 * does not publish one. Publishing the daily change as the weight would
 * be a wrong number in a portfolio record, and a weight is what a
 * portfolio record is for.
 *
 * WHAT THE READER IS GOOD FOR
 *
 * The TRADE channel says what he traded. This says WHAT HE HELD, on a
 * date, with the sector each holding sits in -- and that is the cross-
 * check the trade channel cannot give itself.
 *
 * THE LEAVES ARE FOUND BY THEIR GEOMETRY
 *
 * A leaf is a ticker, the percentage DIRECTLY BELOW it, and the company
 * name below that. The ticker's x and the percentage's x are within a
 * few pixels of each other, because the leaf's text is centred on the
 * leaf and the percentage is a line of it.
 *
 * The sector labels are found by a different rule, and they are not
 * leaves: a sector label is a run of words that CONTAIN A LOWERCASE
 * LETTER (so it is not a ticker), and the percentage that follows it is
 * on the SAME LINE -- a leaf's percentage is on the line BELOW its
 * ticker, and a sector's aggregate is beside its name.
 */

const { marketTickerOf } = require('./symbols');

/** A percentage, with the broker's lost minus sign read as a tilde. */
const PERCENT = /^[+~~-]?\s*\d+(?:[.,]\d+)?\s*%$/;

/**
 * A word that could be a ticker: capitals, and short.
 *
 * It may START WITH A DIGIT: "3CP.F" is Xiaomi on the Paris line and
 * the broker's own spelling, and a rule that began with a letter
 * dropped it. The word must carry at least one letter, so a bare
 * number is not a ticker.
 */
const TICKERISH = /^(?=[A-Z0-9.]*[A-Z])[A-Z0-9][A-Z0-9]{0,5}(?:\.[A-Z]{1,4})?$/;

/** A word that is a name rather than a ticker: it has a lowercase letter. */
const NAMELIKE = /[a-z]/;

/** How far below a ticker its percentage may sit, in OCR pixels. */
const PERCENT_MAX_DROP = 190;

/** How far to the side the percentage may sit, in OCR pixels. */
const PERCENT_MAX_SHIFT = 90;

/** How far above a leaf a sector label may sit, in OCR pixels. */
const SECTOR_MAX_DROP = 2400;

/** How close two sector labels have to be to share a band, in OCR pixels. */
const SECTOR_BAND_TOLERANCE = 60;

/**
 * Is this word a percentage, and what is it worth?
 *
 * @param {string} text
 * @returns {number|null}
 */
function percentValue(text) {
  const raw = String(text || '').trim();
  if (!PERCENT.test(raw)) return null;
  const negative = raw.startsWith('-') || raw.startsWith('~');
  // The SIGN is stripped before the number is read, and applied after.
  // Leaving it in and negating afterwards would flip a negative twice.
  const body = raw.replace(/^[+~-]/, '').replace(/[%\s]/g, '').replace(',', '.');
  const number = Number(body);
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

/**
 * The percentage words of an OCR result, with their geometry.
 *
 * @param {object[]} words
 * @returns {object[]}
 */
function percentagesOf(words) {
  return (words || [])
    .map((word) => ({ ...word, value: percentValue(word.text) }))
    .filter((word) => word.value !== null)
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

/**
 * The SECTOR labels: a name and the aggregate change beside it.
 *
 * The name is a RUN of name-like words on the same line, ending at the
 * percentage. The run is read backwards from the percentage and stops at
 * the first word that is not name-like or that is too far to the left.
 *
 * @param {object[]} words
 * @returns {object[]}
 */
function sectorsOf(words) {
  const list = (words || []).slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const sectors = [];
  for (const percent of percentagesOf(list)) {
    // The words on the SAME line, to the LEFT of the percentage.
    const sameLine = list.filter((word) => word.line === percent.line
      && word.left < percent.left
      && percent.left - (word.left + word.width) < 90);
    if (!sameLine.length) continue;
    sameLine.sort((a, b) => b.left - a.left);
    const run = [];
    for (const word of sameLine) {
      if (!NAMELIKE.test(word.text)) break;
      if (run.length && run[run.length - 1].left - (word.left + word.width) > 60) break;
      run.unshift(word);
    }
    if (!run.length) continue;
    const name = run.map((word) => word.text).join(' ')
      // The OCR splits a label that runs past its box ("Spotrebni zbozi
      // (cyklick"), so a fragment is trimmed rather than published.
      .replace(/\s*\([^)]*$/, '')
      .trim();
    if (!name || name.length < 3) continue;
    sectors.push({
      name,
      change_pct: percent.value,
      left: run[0].left,
      top: run[0].top,
    });
  }
  // The same label can be picked twice when two of its words each sit
  // beside a percentage; the highest (first) one wins.
  const seen = new Set();
  return sectors.filter((sector) => {
    const key = `${sector.name}|${sector.left}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The bands of sector labels: the groups that share a top edge.
 *
 * A treemap's groups are laid out in rows, and the labels of one row sit
 * at the same height. So the labels form BANDS, and a leaf's group is
 * found band by band.
 *
 * @param {object[]} sectors
 * @returns {object[][]} the bands, nearest above first
 */
function sectorBands(sectors) {
  const sorted = (sectors || []).slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const bands = [];
  for (const sector of sorted) {
    const band = bands.find((entry) => Math.abs(entry.top - sector.top) <= SECTOR_BAND_TOLERANCE);
    if (band) {
      band.labels.push(sector);
      band.top = Math.min(band.top, sector.top);
      continue;
    }
    bands.push({ top: sector.top, labels: [sector] });
  }
  for (const band of bands) band.labels.sort((a, b) => a.left - b.left);
  return bands;
}

/**
 * The sector a leaf belongs to.
 *
 * The rule walks the bands from the nearest one above the leaf downwards,
 * and in each band takes the RIGHTMOST label that is not to the right of
 * the leaf. A leaf that is to the LEFT of every label in its band belongs
 * to the group to the left of it, which starts higher up -- so the walk
 * continues downwards.
 *
 * The rule that this replaces -- "the nearest label above, with its left
 * edge not to the right of the leaf" -- put EVERY leaf in Technologie,
 * because the four top-row labels sit within ten pixels of each other and
 * the leftmost of them has the lowest top.
 *
 * AND WHAT IT CANNOT KNOW
 *
 * A leaf's group is a RECTANGLE, and the rectangle is not drawn -- only
 * the group is. So the group is inferred from the label above it, and a
 * group whose LABEL THE OCR MISSED has no label to be inferred from:
 * its leaves are assigned to the nearest group above them, and their
 * sector is then wrong. Measured on the 2026-04-15 screenshot: seven of
 * the thirteen sector labels were read, so the reader publishes the
 * coverage and the caveat with it.
 *
 * @param {object[]} sectors
 * @param {object} word  the leaf's ticker word
 * @returns {object|null}
 */
function sectorOf(sectors, word) {
  const bands = sectorBands(sectors);
  // The bands are walked from the NEAREST one above the leaf, and not
  // from the first one: the treemap's top row of groups is at the very
  // top of the screen, so walking from the first band put every leaf
  // below it in the top row's leftmost group.
  const above = bands
    .filter((band) => band.top <= word.top)
    .sort((a, b) => b.top - a.top);
  for (const band of above) {
    if (word.top - band.top > SECTOR_MAX_DROP) break;
    const candidates = band.labels.filter((entry) => entry.left <= word.left);
    if (candidates.length) return candidates[candidates.length - 1];
  }
  return null;
}

/**
 * The LEAVES: a ticker, the percentage below it, and the sector above it.
 *
 * @param {object[]} words
 * @param {object[]} sectors
 * @returns {object[]}
 */
function leavesOf(words, sectors) {
  const list = (words || []).slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const percents = percentagesOf(list);
  const leaves = [];

  for (const word of list) {
    if (!TICKERISH.test(word.text)) continue;
    if (word.text.length < 2) continue;
    // A ticker that is a sector's own label is not a leaf; sector
    // labels are name-like, so this only catches the rare all-caps one.
    const ticker = word.text;

    // The percentage DIRECTLY BELOW it, and beside it.
    const below = percents
      .filter((percent) => percent.top >= word.top
        && percent.top - word.top <= PERCENT_MAX_DROP
        && Math.abs(percent.left - word.left) <= PERCENT_MAX_SHIFT)
      .sort((a, b) => a.top - b.top || Math.abs(a.left - word.left) - Math.abs(b.left - word.left));
    if (!below.length) continue;
    const percent = below[0];

    const sector = sectorOf(sectors, word);

    leaves.push({
      broker_ticker: ticker,
      ticker: marketTickerOf(ticker),
      change_pct: percent.value,
      change_text: percent.text,
      // The percentage's own box, which is where the LEAF's colour has
      // to be sampled from.
      change_box: {
        left: percent.left,
        top: percent.top,
        width: percent.width,
        height: percent.height,
      },
      sector: sector ? sector.name : '',
      left: word.left,
      top: word.top,
    });
  }

  // One leaf per ticker: the OCR sometimes reads the same leaf twice, at
  // two scales, and the first reading wins.
  const seen = new Set();
  return leaves.filter((leaf) => {
    const key = `${leaf.broker_ticker}|${Math.round(leaf.top / 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Read the treemap out of an OCR result.
 *
 * @param {object} ocr  the result of the OCR of the screenshot
 * @returns {object} the sectors, the holdings, and what was read
 */
function readHeatmap(ocr) {
  const words = (ocr && ocr.words) || [];
  const sectors = sectorsOf(words);
  const holdings = leavesOf(words, sectors);

  // THE ARITHMETIC THAT SETTLES WHAT THE PERCENTAGE IS.
  //
  // If the percentages were the weights, they would sum to 100 -- a book
  // of sizes. If they are the daily changes, they sum to roughly zero --
  // a book of changes. Measured, and reported either way, because the
  // reader's own claim is the thing being tested.
  const sum = holdings.reduce((total, leaf) => total + leaf.change_pct, 0);

  return {
    sectors,
    holdings,
    coverage: {
      words: words.length,
      sectors_read: sectors.length,
      holdings_read: holdings.length,
      change_sum_pct: Number(sum.toFixed(3)),
      // The header of the screenshot says how many positions the
      // treemap holds; it is read from the OCR's own words when it is
      // there, and it is what the reader's coverage is measured against.
      stated_positions: statedPositions(words),
    },
  };
}

/**
 * The LEAF's background colour, and the SIGN it carries.
 *
 * WHY THE SIGN IS NOT READ FROM THE TEXT
 *
 * The broker draws a negative with a thin dash, and the OCR loses it:
 * **measured on the 2026-04-15 screenshot, the whole-image OCR read 12
 * of the 64 leaves' signs wrongly**, and the other OCR pass lost the
 * SAME minus on the same leaves -- so the two passes agreeing is not
 * evidence. (JPM's tile reads "-1.71 %" and the OCR read "+1.71 %";
 * MU's reads "-2.70 %" and the OCR read "+2.70 %".)
 *
 * The treemap's COLOUR carries the sign: the scale in the header is
 * "-4 % ... +4 %", red for a loss and green for a gain, and the
 * percentage is WHITE TEXT on that background. So the sign is read from
 * the pixels around the glyph.
 *
 * Measured on the screenshot:
 *
 *   a green tile   rgb(26, 65, 45)  -- g well above r
 *   a red tile     rgb(75, 31, 32)  -- r well above g
 *   a flat tile    rgb(45, 51, 59)  -- barely saturated at all
 *
 * So a SATURATED tile settles the sign, and a FLAT one does not: the
 * leaves whose change is under about a tenth of a point are drawn flat,
 * and for those the glyph is the only witness. The reader says which
 * it used, in `sign_source`.
 *
 * @param {object} leaf  a leaf with its `change_box`
 * @param {object} pixels  the image's raw pixels
 * @param {object} info  the image's dimensions and channel count
 * @param {number} scale  the OCR's upscale factor
 * @param {object} region  the OCR's crop, in fractions of the image
 * @returns {{sign: number, source: string, rgb: number[]|null}}
 */
function signFromColour(leaf, pixels, info, scale, region) {
  const box = leaf.change_box;
  if (!box) return { sign: 0, source: 'none', rgb: null };
  const originX = Math.round((region && region.x ? region.x : 0) * info.width);
  const originY = Math.round((region && region.y ? region.y : 0) * info.height);
  const x0 = Math.max(0, originX + Math.round(box.left / scale));
  const y0 = Math.max(0, originY + Math.round(box.top / scale));
  const x1 = Math.min(info.width, originX + Math.round((box.left + box.width) / scale));
  const y1 = Math.min(info.height, originY + Math.round((box.top + box.height) / scale));
  if (x1 <= x0 || y1 <= y0) return { sign: 0, source: 'none', rgb: null };

  const reds = [];
  const greens = [];
  const blues = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // The glyph is white, and it is not the tile.
      if (r > 200 && g > 200 && b > 200) continue;
      reds.push(r);
      greens.push(g);
      blues.push(b);
    }
  }
  if (reds.length < 20) return { sign: 0, source: 'none', rgb: null };
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const rgb = [median(reds), median(greens), median(blues)];
  const spread = Math.max(...rgb) - Math.min(...rgb);
  // A FLAT tile is not a witness: the leaves whose change is a fraction
  // of a point are drawn flat, and their sign has to come from the
  // glyph.
  if (spread < 25) return { sign: 0, source: 'flat', rgb };
  if (rgb[1] > rgb[0]) return { sign: 1, source: 'colour', rgb };
  return { sign: -1, source: 'colour', rgb };
}

/**
 * Read the treemap AND the signs its colours carry.
 *
 * The colours are read from the image, so this one is async and it
 * needs the image itself -- the screenshot on disk, which is the
 * evidence, and the OCR's own geometry to find the pixels.
 *
 * @param {object} ocr  the OCR result, with `scale` and `region`
 * @param {object} options
 * @param {string} options.imagePath  the screenshot
 * @returns {Promise<object>} the sectors, the holdings, and what was read
 */
async function readHeatmapWithColour(ocr, options = {}) {
  const read = readHeatmap(ocr);
  const imagePath = options.imagePath;
  if (!imagePath) return read;
  let sharp;
  try {
    // eslint-disable-next-line global-require
    sharp = require('sharp');
  } catch {
    return read;
  }
  let raw;
  let info;
  try {
    const out = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    raw = out.data;
    info = out.info;
  } catch {
    return read;
  }
  const scale = Number(ocr.scale) || 1;
  const region = ocr.region || { x: 0, y: 0, w: 1, h: 1 };
  let corrected = 0;
  let fromColour = 0;
  let flat = 0;
  for (const leaf of read.holdings) {
    const verdict = signFromColour(leaf, raw, info, scale, region);
    leaf.tile_rgb = verdict.rgb;
    if (verdict.source === 'colour') {
      fromColour += 1;
      // The count is taken BEFORE the value is changed: a leaf whose
      // glyph lost the minus is a correction, and it is the number that
      // says how often the OCR's sign was wrong.
      const glyphWasNegative = leaf.change_pct < 0;
      if (verdict.sign < 0 && !glyphWasNegative) corrected += 1;
      else if (verdict.sign > 0 && glyphWasNegative) corrected += 1;
      if (verdict.sign < 0 && leaf.change_pct > 0) leaf.change_pct = -leaf.change_pct;
      else if (verdict.sign > 0 && leaf.change_pct < 0) leaf.change_pct = Math.abs(leaf.change_pct);
      leaf.sign_source = 'colour';
    } else if (verdict.source === 'flat') {
      flat += 1;
      leaf.sign_source = 'glyph';
    } else {
      leaf.sign_source = 'glyph';
    }
  }
  read.coverage.sign_from_colour = fromColour;
  read.coverage.sign_flat_tile = flat;
  read.coverage.signs_corrected = corrected;
  return read;
}

/**
 * The screenshot's own count of its positions: "96 pozic".
 *
 * @param {object[]} words
 * @returns {number|null}
 */
function statedPositions(words) {
  for (const word of words || []) {
    const hit = /(\d+)\s+pozic/i.exec(word.text);
    if (hit) return Number(hit[1]);
  }
  return null;
}

module.exports = {
  PERCENT,
  TICKERISH,
  leavesOf,
  percentValue,
  percentagesOf,
  readHeatmap,
  readHeatmapWithColour,
  sectorBands,
  sectorOf,
  sectorsOf,
  signFromColour,
  statedPositions,
};
