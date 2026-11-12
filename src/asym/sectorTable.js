'use strict';

// Read the SECTOR TABLE out of an AsymTrading video frame.
//
// WHAT THIS IS
//
// The AsymTrading Market Pulse video is a TradeStation SCREENCAST, not a
// talking head. Its left-hand panel is a live table of the eleven GICS
// sectors with their numbers, and it is the one piece of QUANTITATIVE
// market data in the whole source that the written report does not carry
// -- the article gives the author's picks ("Primary focus: Energy,
// Healthcare"), and this gives the measurements behind them.
//
//   Company | 1 Mo ROC | (Avg 10 mo) D | (Avg 20) D | target(M) D | % Change
//   Financial Services |  7.28 |  v |  v |  v |  +0.91%
//   Energy             |  3.05 |  v |  v |  v |  -1.04%
//
// WHY THE PARSING IS NOT "OCR IT AND READ THE TEXT"
//
// 1. THE ROWS ARE NOT LINES. Tesseract's sparse mode returns the three
//    cells of a row as three separate lines, so the row is rebuilt from
//    the WORD POSITIONS -- the TSV's x and y -- exactly as the QMG
//    chart-stream parser rebuilds its panel boundaries.
//
// 2. THE SMALL NUMERALS LOSE THEIR DECIMAL POINT. "1.47" comes back as
//    "147" and "0.39" as "039", because a one-pixel period on a
//    twelve-pixel glyph is below the noise. The fix is a CONSTRAINT
//    rather than a guess: the column holds rate-of-change figures in the
//    range -15..+15, so a three-digit token cannot be 147 -- it has to
//    be 1.47.
//
// 3. THE SIGN IS LOST, AND IT DOES NOT HAVE TO BE READ AT ALL. The
//    table renders a positive % Change in GREEN and a negative one in
//    RED. So the sign is read from the PIXELS, not from the OCR: a
//    glyph whose pixels are green is a positive number. That recovers
//    three rows in the sample frame whose OCR had lost the sign
//    entirely ("124%" was really -1.24%).
//
// THE GEOMETRY IS MEASURED, NOT GUESSED
//
// The panel sits in the same place in every frame: the crop is the
// top-left of the 1920x1080 frame, and the strongest horizontal edges in
// the crop (the header rules) fall at the SAME pixel offsets in frames
// from different posts -- measured at offsets 8, 9, 36 and 37 in both a
// February and a July frame.
//
// THE TABLE SCROLLS
//
// The sector list is scrolled, so one frame shows only part of the
// eleven rows and which part depends on the video. So several frames are
// read per post and merged on the sector name.

const fs = require('node:fs');

const sharp = require('sharp');

/**
 * The panel's crop rectangle, in the 1920x1080 frame's pixels.
 *
 * Measured from three frames of two different posts.
 */
const SECTOR_PANEL = {
  left: 0,
  top: 108,
  width: 345,
  height: 300,
};

/**
 * How much the panel is enlarged before OCR.
 *
 * Four is enough to make the glyphs legible to Tesseract; eight is not
 * better (measured: the same values, slightly lower confidence).
 */
const PANEL_SCALE = 4;

/**
 * The column boundaries, in the PANEL's pixels.
 *
 * Measured from the word positions: the sector names run from 28 to
 * about 125, the rate-of-change values sit at 151-157, and the % Change
 * values at 292-296. The band in between (205-280) is the three
 * checkmark columns, which OCR reads as noise, so it is ignored.
 */
const COLUMN_BOUNDS = {
  companyMaxX: 135,
  rocMinX: 135,
  rocMaxX: 205,
  changeMinX: 280,
};

/**
 * The eleven GICS sectors.
 *
 * A FIXED list, which is what makes the name matching possible: the
 * table never shows anything else, so a name that is nearly one of these
 * IS one of these. OCR reads "Basic Matenals" and "Communication Ser"
 * and "Consumer Defensiv", and all three are repaired against this list.
 */
const GICS_SECTORS = [
  'Communication Services',
  'Consumer Defensive',
  'Real Estate',
  'Financial Services',
  'Utilities',
  'Healthcare',
  'Energy',
  'Technology',
  'Consumer Cyclical',
  'Industrials',
  'Basic Materials',
];

/**
 * The article's names for the same sectors.
 *
 * The written report uses the short GICS names (Financials, Materials,
 * Consumer Discretionary, Consumer Staples) while the TradeStation table
 * uses the long ones (Financial Services, Basic Materials, Consumer
 * Cyclical, Consumer Defensive). The mapping is what lets the article's
 * "Primary focus: Energy, Healthcare" be checked against the table's
 * numbers.
 */
const ARTICLE_SECTOR_ALIASES = {
  'Financials': 'Financial Services',
  'Materials': 'Basic Materials',
  'Consumer Discretionary': 'Consumer Cyclical',
  'Consumer Staples': 'Consumer Defensive',
  'Defensives': 'Consumer Defensive',
  'Consumer Defensives': 'Consumer Defensive',
  'Communication Services': 'Communication Services',
  'Communications': 'Communication Services',
  'Real Estate': 'Real Estate',
  'Utilities': 'Utilities',
  'Healthcare': 'Healthcare',
  'Health Care': 'Healthcare',
  'Energy': 'Energy',
  'Technology': 'Technology',
  'Consumer Cyclical': 'Consumer Cyclical',
  'Industrials': 'Industrials',
  'Basic Materials': 'Basic Materials',
  'Financial Services': 'Financial Services',
  'Consumer Defensive': 'Consumer Defensive',
};

/**
 * The GICS sector an article name refers to, or '' when it is not one.
 *
 * @param {string} spoken
 * @returns {string}
 */
function articleSector(spoken) {
  const raw = String(spoken || '').trim();
  if (!raw) return '';
  if (ARTICLE_SECTOR_ALIASES[raw]) return ARTICLE_SECTOR_ALIASES[raw];
  // A case-insensitive match.
  const lower = raw.toLowerCase();
  for (const [key, value] of Object.entries(ARTICLE_SECTOR_ALIASES)) {
    if (key.toLowerCase() === lower) return value;
  }
  return '';
}

/**
 * The parser version written onto every row.
 *
 * 1 (2026-11-12): the first version.
 */
const PARSER_VERSION = 'asym-sector-1';

/**
 * Reduce a sector's readings across the frames to ONE row.
 *
 * WHY THE MEDIAN AND NOT THE FIRST READING
 *
 * The table is on screen while the market moves, so the same row reads
 * slightly differently in different frames -- and the OCR of a
 * twelve-pixel number is fragile on its own. Measured on one post: the
 * same Healthcare row reads "11.27" in one frame and "\u00a2127)" in
 * another, which the decimal-point repair turns into 1.27. Taking the
 * FIRST reading would take whichever frame happened to be read best;
 * taking the MEDIAN across the frames that show the sector takes the
 * value the frames agree on.
 *
 * The % Change SIGN comes from the frame that supplied the median
 * magnitude, because the colour of that frame's glyph is the authority.
 *
 * @param {Array<object>} readings
 * @returns {object|null}
 */
function reduceReadings(readings) {
  const list = (readings || []).filter(Boolean);
  if (!list.length) return null;

  const rocReadings = list.filter((r) => r.roc_1mo !== null && r.roc_1mo !== undefined)
    .map((r) => ({ value: Number(r.roc_1mo), frame: r.frame, raw: r.roc_raw }));
  const changeReadings = list.filter((r) => r.pct_change !== null && r.pct_change !== undefined)
    .map((r) => ({ value: Number(r.pct_change), frame: r.frame, raw: r.change_raw, sign: r.sign_source, green: r.colour_green, red: r.colour_red }));

  const median = (rows) => {
    if (!rows.length) return null;
    const sorted = rows.slice().sort((a, b) => a.value - b.value);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2
      ? sorted[middle].value
      : (sorted[middle - 1].value + sorted[middle].value) / 2;
    return { value, rows: sorted };
  };

  const roc = median(rocReadings);
  const change = median(changeReadings);

  // The sign of the % Change comes from the frame whose magnitude is the
  // median -- that frame's glyph colour is the authority.
  let signSource = '';
  let changeValue = null;
  let changeFrame = null;
  let changeRaw = '';
  if (change) {
    const nearest = change.rows.reduce((best, row) => (
      Math.abs(row.value - change.value) < Math.abs(best.value - change.value) ? row : best
    ));
    changeValue = change.value;
    changeFrame = nearest.frame;
    changeRaw = nearest.raw || '';
    signSource = nearest.sign || '';
  }

  const spread = roc && rocReadings.length > 1
    ? Math.max(...rocReadings.map((r) => r.value)) - Math.min(...rocReadings.map((r) => r.value))
    : 0;

  return {
    sector: list[0].sector,
    roc_1mo: roc ? Number(roc.value.toFixed(4)) : null,
    roc_raw: roc ? rocReadings[0].raw : '',
    roc_frame: roc ? roc.rows[0].frame : null,
    pct_change: changeValue === null ? null : Number(changeValue.toFixed(4)),
    change_raw: changeRaw,
    change_frame: changeFrame,
    sign_source: signSource,
    spread,
    readings: list.length,
    confidence: list[0].confidence,
  };
}

module.exports = {
  COLUMN_BOUNDS,
  ARTICLE_SECTOR_ALIASES,
  GICS_SECTORS,
  PANEL_SCALE,
  PARSER_VERSION,
  SECTOR_PANEL,
};
/**
 * Normalise a name for comparison.
 *
 * @param {string} value
 * @returns {string}
 */
function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How many edits turn one string into another.
 *
 * A Levenshtein distance, because the OCR errors in a sector name are
 * one or two characters ("matenals" for "materials", "defensiv" for
 * "defensive") and the names are long enough that a prefix rule alone
 * is not enough.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[t.length];
}

/**
 * Match an OCR'd name against the fixed sector list.
 *
 * Two rules, in order: a PREFIX match (the table truncates long names,
 * so "Communication Ser" is Communication Services), and then an edit
 * distance of at most two.
 *
 * @param {string} spoken
 * @returns {{sector: string, matched: boolean, distance: number}}
 */
function matchSector(spoken) {
  const text = normaliseName(spoken);
  if (!text) return { sector: '', matched: false, distance: 99 };

  let best = { sector: '', matched: false, distance: 99 };
  for (const candidate of GICS_SECTORS) {
    const target = normaliseName(candidate);
    if (text === target) return { sector: candidate, matched: true, distance: 0 };
    if (text.length >= 4 && target.startsWith(text)) {
      const gap = target.length - text.length;
      if (gap < best.distance) {
        best = { sector: candidate, matched: true, distance: gap };
      }
    }
    if (target.length >= 4 && text.startsWith(target)) {
      const gap = text.length - target.length;
      if (gap < best.distance) {
        best = { sector: candidate, matched: true, distance: gap };
      }
    }
  }
  if (best.matched) return best;

  for (const candidate of GICS_SECTORS) {
    const distance = editDistance(text, normaliseName(candidate));
    if (distance <= 2 && distance < best.distance) {
      best = { sector: candidate, matched: true, distance };
    }
  }
  return best;
}
/**
 * Repair a number that the OCR read without its decimal point.
 *
 * The COLUMN is what makes the repair safe. A rate-of-change column
 * holds values in roughly -15..+15, so a token of "147" cannot mean 147:
 * it must mean 1.47. A token that already has a decimal point is
 * believed.
 *
 * @param {string} token - the OCR'd text
 * @returns {{value: number|null, repaired: boolean, raw: string}}
 */
function repairNumber(token) {
  const raw = String(token || '').trim();
  if (!raw) return { value: null, repaired: false, raw };

  // Already a number with a decimal point: believe it.
  const direct = /^([+-]?\d+\.\d+)/.exec(raw);
  if (direct) {
    const value = Number(direct[1]);
    return { value: Number.isFinite(value) ? value : null, repaired: false, raw };
  }

  // Otherwise take the digits and rebuild the decimal point.
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits.length) return { value: null, repaired: false, raw };

  // THE COLUMN SHOWS TWO DECIMALS, and that is what makes the repair
  // unambiguous: the point goes TWO DIGITS FROM THE RIGHT.
  //
  //   147  ->  1.47     039  ->  0.39     1127  ->  11.27
  //
  // The previous rule only handled three digits, so a value of 10.00 or
  // more whose decimal point was lost came back as NULL and the row was
  // DROPPED -- and the sample frame has a 11.27 in it.
  let text;
  if (digits.length >= 3) {
    text = digits.slice(0, -2) + '.' + digits.slice(-2);
  } else if (digits.length === 2) {
    text = '0.' + digits;
  } else {
    text = '0.' + digits + '0';
  }
  // The SIGN survives the repair. A token like "-369" is -3.69, not 3.69,
  // and the sign is the one thing the OCR cannot be relied on to keep.
  if (raw.includes('-') && !text.startsWith('-')) text = '-' + text;
  const value = Number(text);
  return { value: Number.isFinite(value) ? value : null, repaired: true, raw };
}

/**
 * The sign of a % Change cell, read from the glyph's colour.
 *
 * The table renders positives in green and negatives in red, so the
 * sign does not have to be read from the glyph at all -- which matters
 * because the OCR loses it ("124%" was really -1.24%).
 *
 * @param {object} image - a sharp raw buffer
 * @param {number} rowY - the row's vertical centre, in FRAME pixels
 * @param {object} [region] - the x band of the % Change column
 * @returns {{sign: number, green: number, red: number, confident: boolean}}
 */
function signFromColour(image, rowY, region = {}) {
  const left = region.left === undefined ? 282 : region.left;
  const right = region.right === undefined ? 336 : region.right;
  const halfHeight = region.halfHeight === undefined ? 5 : region.halfHeight;
  const data = image.data;
  const info = image.info;
  let green = 0;
  let red = 0;
  for (let y = Math.round(rowY - halfHeight); y <= Math.round(rowY + halfHeight); y += 1) {
    if (y < 0 || y >= info.height) continue;
    for (let x = left; x <= right; x += 1) {
      if (x < 0 || x >= info.width) continue;
      const offset = (y * info.width + x) * info.channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      if (r + g + b < 150) continue;
      if (g > r + 20 && g > b + 10) green += 1;
      else if (r > g + 20 && r > b + 10) red += 1;
    }
  }
  const sign = green > red ? 1 : (red > green ? -1 : 0);
  const confident = sign !== 0 && (green > 8 || red > 8);
  return { sign, green, red, confident };
}
/**
 * The Tesseract worker, created on first use.
 *
 * It is module-level so that a run over many frames pays the start-up
 * cost once. The caller must call closeSectorOcr() at the end, or the
 * process will not exit.
 */
let workerPromise = null;

/**
 * The OCR worker.
 *
 * @returns {Promise<object>}
 */
function getSectorWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng');
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        // Sparse text. The table is a grid of short cells, and the block
        // mode merges the columns into unreadable lines; the sparse mode
        // keeps every cell as its own word, with a position.
        tessedit_pageseg_mode: '11',
      });
      return worker;
    })();
  }
  return workerPromise;
}

/**
 * Close the OCR worker.
 *
 * @returns {Promise<void>}
 */
async function closeSectorOcr() {
  if (!workerPromise) return;
  const promise = workerPromise;
  workerPromise = null;
  try {
    const worker = await promise;
    await worker.terminate();
  } catch { /* already gone */ }
}

/**
 * Read the sector table out of one frame.
 *
 * @param {string} framePath - the PNG of a whole 1920x1080 frame
 * @param {object} [options]
 * @param {object} [options.panel] - the crop rectangle
 * @returns {Promise<{rows: Array<object>, confidence: number, warnings: Array<string>}>}
 */
async function parseSectorPanel(framePath, options = {}) {
  const panel = options.panel || SECTOR_PANEL;
  const warnings = [];
  if (!fs.existsSync(framePath)) {
    return { rows: [], confidence: 0, warnings: ['frame_missing'] };
  }

  // The whole frame, raw, for the COLOUR of the % Change glyphs.
  const raw = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // The panel, enlarged, for the OCR.
  const cropped = await sharp(framePath)
    .extract({ left: panel.left, top: panel.top, width: panel.width, height: panel.height })
    .resize({ width: panel.width * PANEL_SCALE, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const worker = await getSectorWorker();
  const { data } = await worker.recognize(cropped, {}, { tsv: true });

  // The words, with their positions in the ENLARGED crop.
  const words = String(data.tsv || '')
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .filter((cells) => cells[0] === '5')
    .map((cells) => ({
      text: cells[11],
      left: Number(cells[6]),
      top: Number(cells[7]),
      width: Number(cells[8]),
      height: Number(cells[9]),
      conf: Number(cells[10]),
    }))
    .filter((word) => word.text && word.text.trim());

  // Group the words into ROWS by their vertical centre.
  const rows = [];
  for (const word of words.slice().sort((a, b) => (a.top + a.height / 2) - (b.top + b.height / 2))) {
    const middle = word.top + word.height / 2;
    let row = rows.find((candidate) => Math.abs(candidate.middle - middle) < 12);
    if (!row) {
      row = { middle, words: [] };
      rows.push(row);
    }
    row.middle = (row.middle * row.words.length + middle) / (row.words.length + 1);
    row.words.push(word);
  }

  const out = [];
  for (const row of rows) {
    // The row's y in the PANEL, and then in the FRAME.
    const panelY = row.middle / PANEL_SCALE;
    const frameY = panel.top + panelY;

    const company = [];
    const roc = [];
    const change = [];
    for (const word of row.words) {
      const x = word.left / PANEL_SCALE;
      if (x < COLUMN_BOUNDS.companyMaxX) company.push(word);
      else if (x >= COLUMN_BOUNDS.rocMinX && x < COLUMN_BOUNDS.rocMaxX) roc.push(word);
      else if (x >= COLUMN_BOUNDS.changeMinX) change.push(word);
    }
    if (!company.length) continue;

    const spoken = company.map((word) => word.text).join(' ').trim();
    const matched = matchSector(spoken);
    if (!matched.matched) continue;

    const rocText = roc.map((word) => word.text).join(' ').trim();
    const changeText = change.map((word) => word.text).join(' ').trim();

    const rocNumber = repairNumber(rocText);
    const changeNumber = repairNumber(changeText);

    // The SIGN from the pixels, which is more reliable than the OCR.
    const colour = signFromColour(raw, frameY, {
      left: panel.left + 282,
      right: panel.left + 336,
    });
    let sign = 0;
    let signSource = '';
    if (colour.confident) {
      sign = colour.sign;
      signSource = 'colour';
    } else if (changeNumber.value !== null) {
      sign = changeText.trim().startsWith('-') ? -1 : 1;
      signSource = 'ocr';
    }
    const pctChange = changeNumber.value === null || sign === 0
      ? null
      : Number((sign * Math.abs(changeNumber.value)).toFixed(4));

    out.push({
      sector: matched.sector,
      spoken_name: spoken,
      name_distance: matched.distance,
      roc_1mo: rocNumber.value,
      roc_raw: rocText,
      roc_repaired: rocNumber.repaired,
      pct_change: pctChange,
      change_raw: changeText,
      change_repaired: changeNumber.repaired,
      sign_source: signSource,
      colour_green: colour.green,
      colour_red: colour.red,
      frame_y: Math.round(frameY),
      confidence: Number(data.confidence || 0),
    });
  }

  return { rows: out, confidence: Number(data.confidence || 0), warnings };
}
module.exports = {
  COLUMN_BOUNDS,
  GICS_SECTORS,
  PANEL_SCALE,
  PARSER_VERSION,
  SECTOR_PANEL,
  articleSector,
  closeSectorOcr,
  editDistance,
  getSectorWorker,
  matchSector,
  normaliseName,
  parseSectorPanel,
  reduceReadings,
  repairNumber,
  signFromColour,
};