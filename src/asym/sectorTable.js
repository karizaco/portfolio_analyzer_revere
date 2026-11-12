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
const {
  cellsFromSeparators,
  detectSeparators,
} = require('./sectorGeometry');

/**
 * The panel's crop rectangle, in the 1920x1080 frame's pixels.
 *
 * Measured from three frames of two different posts.
 *
 * The width is 370 because the table is cut off at 360: the "Rate of
 * Change (1yr)" column ends at 355 and the "Price % Change (3mo)"
 * column starts at 360. A panel that stopped at 345 cut the last
 * digit off every one year reading -- "10.30" came back as "10.".
 */
const SECTOR_PANEL = {
  left: 0,
  top: 108,
  width: 370,
  height: 300,
  /**
   * How much of the frame is scanned for the table.
   *
   * The table is a screen SHARE, and it is not the same width in every
   * post: measured over the twenty four posts of the corpus, the one
   * year column ends at x=357 in one post and at x=390 in another, and
   * the number of checkmark columns between the rate of change and the
   * percent change changes too. So the scan is WIDE enough for the
   * widest table in the corpus, and the columns are found inside it.
   */
  scanWidth: 480,
};

/**
 * How much the panel is enlarged before OCR.
 *
 * Four is enough to make the glyphs legible to Tesseract; eight is not
 * better (measured: the same values, slightly lower confidence).
 */
const PANEL_SCALE = 4;

/**
 * The column boundaries, in the FRAME's pixels.
 *
 * MEASURED from the pixels, not guessed. The table is a screen of a
 * charting platform, and its columns are:
 *
 *   x   4.. 21  the flag icons
 *   x  28..124  the sector NAME
 *   x 148..175  the "1 Mo ROC" column
 *   x 185..231  the two checkmark columns, which carry no numbers
 *   x 254..294  the "% Change" column -- red or green, ends with a %
 *   x 326..355  the "Rate of Change (1yr)" column -- white, two decimals
 *   x 370..395  the "Price % Change (3mo)" column
 *
 * WHY THE OLD BOUNDS WERE WRONG
 *
 * The old bounds put the % Change boundary at x=280, which is INSIDE
 * that column: the number sits at 254..294, so a boundary at 280 kept
 * only its trailing "%" and threw the number away. What survived was
 * the "Rate of Change (1yr)" column at 326..355, so the column that
 * was called "pct_change" was in fact the ONE YEAR rate of change --
 * and the 3-month column leaked in as well. The colour band had the
 * same problem: it ran from 282 to 336, so it sampled the tail of one
 * column and the white digits of the next.
 */
const COLUMN_BOUNDS = {
  companyMaxX: 135,
  roc: { min: 138, max: 180 },
  change: { min: 240, max: 300 },
  roc1yr: { min: 318, max: 356 },
};

/**
 * The columns that are read as their OWN STRIP, as well as from the
 * panel.
 *
 * A strip is a narrow crop of the frame, read on its own.
 *
 * WHY TWO OF THE THREE COLUMNS GET A SECOND READING
 *
 * The % Change column cannot be read from a strip: its values are
 * written in a larger font in some posts, so they are wider there
 * and a fixed strip cuts the last digit off. It is read from the
 * panel, which is wide enough for both.
 *
 * The other two columns are narrow, and their values are WHITE on a
 * dark background -- which means the minus sign is a one pixel dash
 * that the wide read of the panel loses. Read on its own, the strip
 * keeps it. So the two readings are merged: the panel's magnitude,
 * the strip's sign.
 */
const COLUMN_STRIPS = {
  roc: { min: 138, max: 180 },
  roc1yr: { min: 318, max: 356 },
};

/**
 * How far a strip row's centre may be from a panel row's centre and
 * still be the same row.
 *
 * The rows are 24 frame pixels apart, so this is less than half of
 * that.
 */
const ROW_TOLERANCE = 9;

/**
 * The x band the % Change SIGN is read from, in frame pixels.
 *
 * It is the whole % Change cell: the glyphs are red when the number is
 * negative and green when it is positive, which is a more reliable
 * sign than the OCR, and the OCR loses the minus sign often.
 */
const CHANGE_SIGN_BAND = { min: 250, max: 296 };

/**
 * Where the columns of the table are, in ONE frame.
 *
 * @typedef {object} SectorLayout
 * @property {string} source - 'detected' or 'fixed'
 * @property {number} nameMaxX - the right hand edge of the NAME column
 * @property {{min: number, max: number}} rocStrip - the 1 Mo ROC strip
 * @property {{min: number, max: number}} changePanel - the % Change cell
 * @property {{min: number, max: number}} changeBand - where the sign is read
 * @property {{min: number, max: number}} yearStrip - the 1yr ROC strip
 */

/**
 * The layout used when the table's rules cannot be found.
 *
 * The fixed bounds are the ones measured on a 2025 post. They are the
 * FALLBACK, not the rule: on the other twenty three posts of the corpus
 * the table sits somewhere else.
 *
 * @returns {SectorLayout}
 */
function fixedLayout() {
  return {
    source: 'fixed',
    nameMaxX: COLUMN_BOUNDS.companyMaxX,
    rocStrip: COLUMN_STRIPS.roc,
    changePanel: COLUMN_BOUNDS.change,
    changeBand: CHANGE_SIGN_BAND,
    yearStrip: COLUMN_STRIPS.roc1yr,
  };
}

/**
 * The layout that the detected cells describe.
 *
 * @param {Array<{left: number, right: number}>} cells
 * @param {object} columns - the cell indices
 * @returns {SectorLayout}
 */
function layoutFromCells(cells, columns) {
  const band = (index) => ({
    min: cells[index].left + 2,
    max: cells[index].right - 2,
  });
  return {
    source: 'detected',
    nameMaxX: cells[columns.nameCell].right,
    rocStrip: band(columns.rocCell),
    changePanel: band(columns.changeCell),
    changeBand: band(columns.changeCell),
    yearStrip: band(columns.yearCell),
  };
}

/**
 * The columns of the table, found by what is in its cells.
 *
 * The table is a GRID, so its vertical rules cut it into cells, and
 * the cells are found by counting how many of the table's rows each
 * column of pixels is crossed by (see sectorGeometry). Which cell is
 * which COLUMN is then decided by the content:
 *
 *   - the NAME cell is the first cell that holds sector names;
 *   - the 1 Mo ROC cell is the cell right after it;
 *   - the % Change cell is the first cell to the right that holds a
 *     percent sign -- the percent sign is the marker, because the
 *     number of checkmark columns between the two rates of change is
 *     not the same in every post;
 *   - the 1yr ROC cell is the cell right after THAT.
 *
 * The content decides, so a post with two checkmark columns and a post
 * with four are read the same way, and a post whose table is 35 pixels
 * further right is read the same way too.
 *
 * @param {{cells: Array<object>, rows: Array<object>}} input
 * @returns {object|null} the cell indices, or null when the table could
 *   not be read
 */
function identifyColumns({ cells, rows }) {
  if (!cells || cells.length < 5) return null;
  const wordsIn = (row, index) => row.words.filter((word) => {
    const x = word.left / PANEL_SCALE;
    return x >= cells[index].left && x < cells[index].right;
  });

  // The NAME cell: the first cell that holds sector names.
  const nameScores = new Array(cells.length).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cells.length; i += 1) {
      const words = wordsIn(row, i);
      if (!words.length) continue;
      const text = words.map((word) => word.text).join(' ').trim();
      if (matchSector(text).matched) nameScores[i] += 1;
    }
  }
  let nameCell = -1;
  let bestName = 0;
  for (let i = 0; i < nameScores.length; i += 1) {
    if (nameScores[i] > bestName) {
      bestName = nameScores[i];
      nameCell = i;
    }
  }
  if (nameCell < 0 || bestName < 3) return null;

  // The 1 Mo ROC cell is the cell right after the names.
  const rocCell = nameCell + 1;
  if (rocCell >= cells.length) return null;

  // The % Change cell: the first cell to the right that holds a percent
  // sign, in at least three rows.
  const percentScores = new Array(cells.length).fill(0);
  for (const row of rows) {
    for (let i = rocCell + 1; i < cells.length; i += 1) {
      const words = wordsIn(row, i);
      if (!words.length) continue;
      if (words.some((word) => word.text.includes('%'))) percentScores[i] += 1;
    }
  }
  let changeCell = -1;
  for (let i = rocCell + 1; i < cells.length; i += 1) {
    if (percentScores[i] >= 3) {
      changeCell = i;
      break;
    }
  }
  if (changeCell < 0) return null;

  // The 1yr ROC cell is the cell right after the percent change.
  const yearCell = changeCell + 1;
  if (yearCell >= cells.length) return null;

  return { nameCell, rocCell, changeCell, yearCell, nameScore: bestName };
}

/**
 * Is this token the LEFT HAND PART of a number whose right hand part is
 * covered?
 *
 * WHY
 *
 * In several posts another widget of the screen share overlaps the
 * right hand side of the table, and it covers the right hand side of
 * the one year column. What is left of "34.71" is "34" -- and "34" is
 * not a one year rate of change, it is a fragment of one.
 *
 * Read as a number, "34" would become 0.34 (the decimal point was
 * lost) and be stored as if it were the truth. So a bare integer of
 * one or two digits is refused in the one year column: the column
 * always shows two decimals, so a short bare integer there is a
 * fragment, not a reading.
 *
 * A LOST decimal point is a different thing: it leaves three or four
 * digits ("197" for -1.97), and those are still read.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isBareFragment(token) {
  const text = String(token || '').trim();
  if (!text) return false;
  if (/[.,]/.test(text)) return false;
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits.length) return false;
  return digits.length <= 2;
}



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
 * 2 (2026-11-12): a cell whose LAST DIGIT was lost is no longer read
 *    as a number with a lost decimal point. It used to be read as
 *    hundredths -- "15." became 0.15 instead of 15 -- which put a 10x
 *    and a 100x error into the corpus. Such a reading is now INCOMPLETE:
 *    the integer part is kept and the fraction is left unknown.
 * 3 (2026-11-12): the columns are read CORRECTLY. The % Change column
 *    was never read: the column boundary sat inside it, so the number
 *    was thrown away and the ONE YEAR rate of change was read in its
 *    place, under the name "pct_change". Each numeric column is now
 *    read as its own strip, so the columns cannot be confused, and the
 *    one year rate of change is stored under its own name, roc_1yr.
 * 4 (2026-11-12): the columns are FOUND in every frame, not assumed.
 *    The table is a screen share, and it is not the same width in
 *    every post: the Company column is a different width, the number
 *    of checkmark columns changes, and in eleven of the twenty four
 *    posts another widget covers the right hand side of the table. So
 *    the vertical rules of the grid are detected in every frame, they
 *    cut the panel into cells, and the cells are matched to the
 *    columns by what is in them. Before this, a post whose table sat
 *    35 pixels further right had its percent change column read as
 *    the one year column -- which is a wrong number, not a missing
 *    one. A one year reading that is a bare integer of one or two
 *    digits is now refused, because the column always shows two
 *    decimals and a short integer there is the left hand part of a
 *    number whose right hand part is covered.
 */
const PARSER_VERSION = 'asym-sector-4';

/**
 * Reduce a sector's readings across the frames to ONE row.
 *
 * WHY THE MEDIAN AND NOT THE FIRST READING
 *
 * The table is on screen while the market moves, so the same row reads
 * slightly differently in different frames -- and the OCR of a
 * twelve-pixel number is fragile on its own. Measured on one post: the
 * same Healthcare row reads "11.27" in one frame and "11." in another.
 * Taking the FIRST reading would take whichever frame happened to be
 * read best; taking the MEDIAN across the frames that show the sector
 * takes the value the frames agree on.
 *
 * WHY THE COMPLETE READINGS WIN
 *
 * A reading whose last digit was lost is INCOMPLETE: its integer part
 * is known but its fraction is not, so it can be ten or a hundred times
 * away from the truth. Comparing it with a complete reading is
 * meaningless, and averaging the two produces a number that never
 * appeared on screen. So the complete readings are the canonical ones,
 * and the incomplete ones are used only when there is nothing else --
 * and then the row is flagged approximate, because the value is then a
 * lower bound rather than a reading.
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

  // The readings of one metric: the value, the frame it came from, the
  // raw text, and whether the cell was read WHOLE.
  const collect = (valueKey, rawKey, completeKey) => list
    .filter((row) => row[valueKey] !== null && row[valueKey] !== undefined)
    .map((row) => ({
      value: Number(row[valueKey]),
      frame: row.frame,
      raw: row[rawKey],
      sign: row.sign_source,
      green: row.colour_green,
      red: row.colour_red,
      complete: row[completeKey] !== false,
    }));

  // THE CANONICAL READINGS: the complete ones, or -- when there are
  // none -- the incomplete ones, flagged.
  const pick = (rows) => {
    const complete = rows.filter((row) => row.complete);
    if (complete.length) return { rows: complete, approximate: false };
    return { rows, approximate: rows.length > 0 };
  };

  const median = (rows) => {
    if (!rows.length) return null;
    const sorted = rows.slice().sort((a, b) => a.value - b.value);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2
      ? sorted[middle].value
      : (sorted[middle - 1].value + sorted[middle].value) / 2;
    return { value, rows: sorted };
  };

  // The frame that SUPPLIED the value: the one nearest the median.
  // The frame is what the row is attributed to, so it has to be a
  // frame that actually read that value.
  const nearest = (rows, value) => rows.reduce((best, row) => (
    Math.abs(row.value - value) < Math.abs(best.value - value) ? row : best
  ));

  // One metric, reduced the same way whichever metric it is.
  const reduce = (valueKey, rawKey, completeKey) => {
    const rows = pick(collect(valueKey, rawKey, completeKey));
    const med = median(rows.rows);
    if (!med) {
      return { value: null, raw: '', frame: null, rows: rows.rows, spread: 0, approximate: false, sign: '' };
    }
    const best = nearest(med.rows, med.value);
    return {
      value: med.value,
      raw: best.raw || '',
      frame: best.frame,
      rows: rows.rows,
      sign: best.sign || '',
      approximate: rows.approximate,
      spread: rows.rows.length > 1
        ? Math.max(...rows.rows.map((row) => row.value)) - Math.min(...rows.rows.map((row) => row.value))
        : 0,
    };
  };

  // How many FRAMES read this row WHOLE.
  //
  // A reading is one (frame, cell) pair, and there are three cells per
  // frame, so summing the cells would count a frame three times and
  // `complete_readings` would not be comparable with `readings`, which
  // counts frames. A frame is complete when every cell it DID read was
  // read whole -- a cell that was not read at all is missing, not
  // incomplete, and does not spoil the frame.
  const completeFrames = list.filter((row) => {
    const cells = [
      [row.roc_1mo, row.roc_complete],
      [row.pct_change, row.change_complete],
      [row.roc_1yr, row.roc1yr_complete],
    ];
    const read = cells.filter(([value]) => value !== null && value !== undefined);
    if (!read.length) return false;
    return read.every(([, complete]) => complete !== false);
  }).length;
  const roc = reduce('roc_1mo', 'roc_raw', 'roc_complete');
  const change = reduce('pct_change', 'change_raw', 'change_complete');
  const roc1yr = reduce('roc_1yr', 'roc1yr_raw', 'roc1yr_complete');

  return {
    sector: list[0].sector,
    roc_1mo: roc.value === null ? null : Number(roc.value.toFixed(4)),
    roc_raw: roc.raw,
    roc_frame: roc.frame,
    pct_change: change.value === null ? null : Number(change.value.toFixed(4)),
    change_raw: change.raw,
    change_frame: change.frame,
    sign_source: change.sign,
    roc_1yr: roc1yr.value === null ? null : Number(roc1yr.value.toFixed(4)),
    roc1yr_raw: roc1yr.raw,
    roc1yr_frame: roc1yr.frame,
    spread: roc.spread,
    change_spread: change.spread,
    roc1yr_spread: roc1yr.spread,
    readings: list.length,
    roc_readings: roc.rows.length,
    change_readings: change.rows.length,
    roc1yr_readings: roc1yr.rows.length,
    complete_readings: completeFrames,
    approximate: roc.approximate || change.approximate || roc1yr.approximate,
    confidence: list[0].confidence,
  };
}

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
 * Read one number out of a cell.
 *
 * THE THREE SHAPES A CELL CAN BE IN
 *
 * 1. The number, whole:   "11.27"  -> 11.27, complete.
 * 2. The number with its LAST DIGIT lost: "15."  -> 15, INCOMPLETE.
 * 3. The number with its DECIMAL POINT lost: "147" -> 1.47, complete.
 *
 * Case 2 is the one that used to be wrong, and it was wrong badly.
 * The old rule assumed a trailing dot meant the point was missing, so
 * it read the two digits "15" as 0.15 -- a hundred times too small --
 * and then, because the reducer has to average the two middle values of
 * an even set, it averaged 0.15 with the true 15.6 into 7.875, a
 * number that never appeared on screen.
 *
 * The evidence is in the corpus: 12 rows carry BOTH a truncated and a
 * complete reading of the same cell, and in 11 of them the truncated
 * token is the integer part ("15." beside "15.6", "-8." beside
 * "-8.4", "20." beside "20.8"). The one exception is a cell where the
 * truncated token is a misread of a different number entirely.
 *
 * So a trailing dot means the DIGIT was lost, not the point. The
 * integer part is known and the fraction is NOT, which makes the
 * reading INCOMPLETE: it cannot be compared with a complete reading,
 * because it can be ten or a hundred times away from the truth.
 *
 * @param {string} token - the OCR'd text
 * @returns {{value: number|null, repaired: boolean, raw: string, complete: boolean, truncated?: boolean}}
 */
function repairNumber(token) {
  const raw = String(token || '').trim();
  if (!raw) return { value: null, repaired: false, raw, complete: false };

  // CASE 1: the number, whole. The match is not anchored, because a
  // cell carries marks around the number -- a sign, a percent sign, and
  // a curly quote where the minus sign should be ("0.02%").
  const direct = /[+-]?\d+\.\d+/.exec(raw);
  if (direct) {
    const value = Number(direct[0]);
    return { value: Number.isFinite(value) ? value : null, repaired: false, raw, complete: true };
  }

  // CASE 2: the last digit was lost. The integer part is known; the
  // fraction is not, so the reading is INCOMPLETE.
  const truncated = /[+-]?\d+\.\D*$/.exec(raw);
  if (truncated) {
    const digits = truncated[0].replace(/[^0-9]/g, '');
    if (!digits.length) return { value: null, repaired: false, raw, complete: false };
    const sign = raw.includes('-') ? -1 : 1;
    const magnitude = Number(digits);
    // Not `magnitude * sign`, which would give -0 for a cell that reads
    // "-0." -- and -0 is not 0 to `Object.is`.
    const value = magnitude === 0 ? 0 : magnitude * sign;
    return {
      value: Number.isFinite(value) ? value : null,
      repaired: false,
      raw,
      complete: false,
      truncated: true,
    };
  }

  // CASE 3: the decimal point was lost. The column shows TWO decimals,
  // and that is what makes the repair unambiguous: the point goes TWO
  // DIGITS FROM THE RIGHT.
  //
  //   147  ->  1.47     039  ->  0.39     1127  ->  11.27
  //
  // The previous rule only handled three digits, so a value of 10.00 or
  // more whose decimal point was lost came back as NULL and the row was
  // DROPPED -- and the sample frame has a 11.27 in it.
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits.length) return { value: null, repaired: false, raw, complete: false };

  // A LOST DECIMAL POINT LEAVES A CANONICAL INTEGER PART.
  //
  // The column shows two decimals, so the number "35.71" without its
  // point is "3571" and the integer part is "35". A digit string
  // whose integer part has a LEADING ZERO -- "03571" -- is not a
  // number that lost its point: it is a reading that went wrong in
  // some other way. It came from "-0.51%" read as "03571%", and
  // taking it at face value stored a day change of 35.71% for a cell
  // that said 0.51%.
  //
  // The zero is allowed when the integer part IS zero ("0.51" lost
  // its point and reads "051"), because that is the one leading zero
  // a real number has.
  const integerPart = digits.length >= 3 ? digits.slice(0, -2) : '';
  if (integerPart.length > 1 && integerPart[0] === '0') {
    return { value: null, repaired: false, raw, complete: false };
  }

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
  // A single digit is not enough to place the point: "7" could be 0.70
  // or 7.00, so that reading is incomplete too.
  return {
    value: Number.isFinite(value) ? value : null,
    repaired: true,
    raw,
    complete: digits.length >= 2,
  };
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
 * OCR one image and return its words, with their positions.
 *
 * @param {object} worker - the Tesseract worker
 * @param {Buffer} image - the PNG to read
 * @returns {Promise<Array<object>>}
 */
async function recogniseWords(worker, image) {
  const { data } = await worker.recognize(image, {}, { tsv: true });
  return String(data.tsv || '')
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
}

/**
 * The mean confidence of a set of words.
 *
 * @param {Array<object>} words
 * @returns {number}
 */
function meanConfidence(words) {
  if (!words || !words.length) return 0;
  const total = words.reduce((sum, word) => sum + (Number(word.conf) || 0), 0);
  return Number((total / words.length).toFixed(2));
}

/**
 * The rows of a set of words, by their vertical centre.
 *
 * @param {Array<object>} words - the words, with positions in the image
 * @returns {Array<object>} the rows, with the words of each
 */
function groupRows(words) {
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
  return rows;
}

/**
 * Read one column of the table, as its own strip of the frame.
 *
 * @param {object} worker - the Tesseract worker
 * @param {string} framePath - the PNG of a whole frame
 * @param {{min: number, max: number}} bounds - the column, in frame pixels
 * @param {number} top - the panel's top, in frame pixels
 * @param {number} height - the panel's height, in frame pixels
 * @returns {Promise<Array<object>>} the rows of the strip
 */
async function readColumnStrip(worker, framePath, bounds, top, height) {
  const width = bounds.max - bounds.min;
  if (!(width > 4)) return [];
  const image = await sharp(framePath)
    .extract({ left: bounds.min, top, width, height })
    .resize({ width: width * PANEL_SCALE, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const words = await recogniseWords(worker, image);
  return groupRows(words).map((row) => ({
    y: top + row.middle / PANEL_SCALE,
    text: row.words.map((word) => word.text).join(' ').trim(),
  }));
}

/**
 * The text of the strip row that belongs to a panel row.
 *
 * @param {Array<object>} strip - the strip's rows
 * @param {number} frameY - the panel row's centre, in frame pixels
 * @returns {string}
 */
function stripText(strip, frameY) {
  let best = null;
  let bestDistance = Infinity;
  for (const row of strip) {
    const distance = Math.abs(row.y - frameY);
    if (distance <= ROW_TOLERANCE && distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best ? best.text : '';
}

/**
 * The sign of a cell, read from its own text.
 *
 * @param {string} token
 * @returns {number} -1, 0 or 1
 */
function signOfToken(token) {
  const text = String(token || '').trim();
  if (!text) return 0;
  return text.includes('-') ? -1 : 1;
}

/**
 * Merge two readings of the same cell.
 *
 * The two readings are the panel's and a strip's, and they fail in
 * different ways: the panel loses the last digit of a narrow value
 * and the sign of a thin one, the strip misses a row now and then.
 * So the reading that is COMPLETE wins, and the one that is missing
 * is only used when there is nothing else.
 *
 * @param {string} preferredToken - the reading to use when both are usable
 * @param {string} fallbackToken - the reading to fall back on
 * @returns {{value: number|null, raw: string, complete: boolean, repaired: boolean}}
 */
function mergeReadings(preferredToken, fallbackToken) {
  const preferred = repairNumber(preferredToken);
  const fallback = repairNumber(fallbackToken);
  if (preferred.value !== null && preferred.complete) {
    return { ...preferred, raw: preferredToken.trim() };
  }
  if (fallback.value !== null && fallback.complete) {
    return { ...fallback, raw: fallbackToken.trim() };
  }
  if (preferred.value !== null) {
    return { ...preferred, raw: preferredToken.trim() };
  }
  if (fallback.value !== null) {
    return { ...fallback, raw: fallbackToken.trim() };
  }
  return { value: null, raw: '', complete: false, repaired: false };
}

/**
 * Read the sector table out of one frame.
 *
 * THE COLUMNS ARE SEPARATED BY WHERE THEY ARE, NOT BY WHAT THEY SAY
 *
 * The table has four columns of numbers, and the words of a row are
 * read across the whole panel. Which column a word belongs to is
 * therefore decided by its x position, and the boundaries are
 * measured rather than guessed -- see COLUMN_BOUNDS.
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

  // The whole frame, raw: for the COLOUR of the % Change glyphs, and
  // for the table's vertical rules.
  const raw = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const worker = await getSectorWorker();

  // THE GEOMETRY OF THIS FRAME.
  //
  // The table is a screen of a charting platform, and the screen is a
  // screen SHARE, so the table is not laid out the same way in every
  // video: the Company column is a different width, the number of
  // checkmark columns changes, and in several posts another widget
  // covers the right hand side of the table. So the columns are FOUND
  // in every frame -- the vertical rules cut the panel into cells, and
  // the cells are matched to the columns by what is in them -- rather
  // than assumed.
  const scanWidth = Math.min(raw.info.width, panel.scanWidth || SECTOR_PANEL.scanWidth);
  const separators = detectSeparators(raw.data, raw.info, {
    top: panel.top,
    height: panel.height,
    xMax: scanWidth,
  });
  const cells = cellsFromSeparators(separators, scanWidth);

  // The panel, enlarged, for the OCR: the names, the rows, and the
  // % Change column, whose width varies from post to post.
  const cropped = await sharp(framePath)
    .extract({ left: panel.left, top: panel.top, width: scanWidth, height: panel.height })
    .resize({ width: scanWidth * PANEL_SCALE, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const words = await recogniseWords(worker, cropped);
  const rows = groupRows(words);

  // The columns of THIS frame.
  const columns = identifyColumns({ cells, rows });
  const layout = columns ? layoutFromCells(cells, columns) : fixedLayout();
  if (!columns) warnings.push('geometry_fallback');

  // The two narrow columns, read on their own as well, because the
  // minus sign of a white number is a thin dash that the wide read
  // loses.
  const rocStrip = await readColumnStrip(worker, framePath, layout.rocStrip, panel.top, panel.height);
  const yearStrip = await readColumnStrip(worker, framePath, layout.yearStrip, panel.top, panel.height);

  const out = [];
  for (const row of rows) {
    // The row's y in the PANEL, and then in the FRAME.
    const frameY = panel.top + row.middle / PANEL_SCALE;

    // The name is read LEFT TO RIGHT. The words of a row arrive in
    // the order Tesseract found them, which is by vertical centre, so
    // a name whose second part sits a pixel higher ("Communication"
    // and its truncated "Se") comes out as "Se Communication" and
    // matches nothing -- which is how the Communication Services row
    // was being dropped from whole posts.
    const company = row.words
      .filter((word) => word.left / PANEL_SCALE < layout.nameMaxX)
      .sort((a, b) => a.left - b.left);
    if (!company.length) continue;

    const spoken = company.map((word) => word.text).join(' ').trim();
    const matched = matchSector(spoken);
    if (!matched.matched) continue;

    // The columns, by x.
    const inColumn = (bounds, word) => {
      const x = word.left / PANEL_SCALE;
      return x >= bounds.min && x < bounds.max;
    };
    const panelText = (bounds) => row.words
      .filter((word) => inColumn(bounds, word))
      .map((word) => word.text)
      .join(' ')
      .trim();

    const rocPanelText = panelText(layout.rocStrip);
    const changeText = panelText(layout.changePanel);
    const yearPanelText = panelText(layout.yearStrip);

    const rocStripText = stripText(rocStrip, frameY);
    const yearStripText = stripText(yearStrip, frameY);

    // The 1 Mo ROC column: the strip is the better read of it.
    const roc = mergeReadings(rocStripText, rocPanelText);

    // The % Change column: the panel is the only read of it, and its
    // SIGN comes from the colour of the glyphs.
    const changeNumber = repairNumber(changeText);
    const colour = signFromColour(raw, frameY, {
      left: panel.left + layout.changeBand.min,
      right: panel.left + layout.changeBand.max,
    });
    let sign = 0;
    let signSource = '';
    if (colour.confident) {
      sign = colour.sign;
      signSource = 'colour';
    } else if (changeNumber.value !== null) {
      sign = signOfToken(changeText);
      signSource = 'ocr';
    }
    const pctChange = changeNumber.value === null || sign === 0
      ? null
      : Number((sign * Math.abs(changeNumber.value)).toFixed(4));

    // The one year column: the panel's magnitude, the strip's sign.
    const year = mergeReadings(yearPanelText, yearStripText);
    const yearSign = yearStripText ? signOfToken(yearStripText) : signOfToken(yearPanelText);
    // A bare integer of one or two digits is the left hand part of a
    // number whose right hand part is COVERED, not a reading.
    const yearClipped = isBareFragment(year.raw);
    const roc1yr = year.value === null || yearSign === 0 || yearClipped
      ? null
      : Number((yearSign * Math.abs(year.value)).toFixed(4));

    out.push({
      sector: matched.sector,
      spoken_name: spoken,
      name_distance: matched.distance,
      roc_1mo: roc.value,
      roc_raw: roc.raw,
      roc_repaired: roc.repaired,
      // A cell whose last digit was lost is INCOMPLETE: the integer
      // part is known and the fraction is not.
      roc_complete: roc.complete,
      pct_change: pctChange,
      change_raw: changeText,
      change_repaired: changeNumber.repaired,
      change_complete: changeNumber.complete,
      roc_1yr: roc1yr,
      roc1yr_raw: year.raw,
      roc1yr_repaired: year.repaired,
      roc1yr_complete: year.complete,
      roc1yr_clipped: yearClipped ? 1 : 0,
      layout_source: layout.source,
      sign_source: signSource,
      colour_green: colour.green,
      colour_red: colour.red,
      frame_y: Math.round(frameY),
      confidence: meanConfidence(row.words),
    });
  }

  return { rows: out, confidence: meanConfidence(words), warnings };
}

module.exports = {
  ARTICLE_SECTOR_ALIASES,
  CHANGE_SIGN_BAND,
  COLUMN_BOUNDS,
  GICS_SECTORS,
  PANEL_SCALE,
  PARSER_VERSION,
  COLUMN_STRIPS,
  SECTOR_PANEL,
  articleSector,
  closeSectorOcr,
  editDistance,
  fixedLayout,
  getSectorWorker,
  identifyColumns,
  isBareFragment,
  layoutFromCells,
  matchSector,
  meanConfidence,
  mergeReadings,
  normaliseName,
  parseSectorPanel,
  readColumnStrip,
  recogniseWords,
  reduceReadings,
  repairNumber,
  signFromColour,
  signOfToken,
  stripText,
};