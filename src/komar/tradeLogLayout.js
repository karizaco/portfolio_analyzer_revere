'use strict';

/**
 * The Komar trade log: the sheet's GEOMETRY, its COLUMNS, and what a
 * value in them means.
 *
 * WHY THIS IS SEPARATE FROM THE TABLE READER
 *
 * `src/table/tableReader.js` finds a grid by NEAR-BLACK rules (luma <=
 * 40) on a white spreadsheet. The Komar sheet is a Google Sheets
 * screenshot whose gridlines are NEUTRAL GREY -- measured on
 * `Trades-August-2025.pdf` page 2 (a 2048x1715 embedded image): the
 * row separators run luma 169..248 and the column separators 165..195,
 * so `findHorizontalRules` finds **zero** rules on the raw pixels and
 * the whole image reads as ONE cell. That is the measured fact this
 * module exists for.
 *
 * The fix is a KOMAR-SPECIFIC PREPROCESS, never a change to the shared
 * module (the project's standing rule): the grey lines are located
 * here, painted near-black in a COPY of the pixels, and the shared
 * reader is then pointed at that copy. Everything downstream -- bands,
 * cells, per-cell OCR, rule erasure, cell colours -- is the shared
 * path unchanged.
 *
 * THE THREE THINGS THE GREY GRID DOES THAT THE BLACK ONE DOES NOT
 *
 * 1. THE HEADER IS A FILL BLOCK, NOT A RULE. The grey header band runs
 *    y=33..123 (91px) and its interior rows are >=85% grey just like a
 *    rule would be. So a thick grey island contributes its two EDGE
 *    rows (33 and 123) and no interior row, and the header text --
 *    which breaks the island into 33..47 / 56..123 -- is bridged by a
 *    gap merge of <=12 rows.
 *
 * 2. THE FILLED CELLS HIDE THEIR OWN COLUMN RULES. The W/L columns are
 *    conditionally filled (green rgb(85,221,49), red rgb(232,39,6)),
 *    and a fill starts exactly ON the boundary at x=960 and ends on the
 *    boundary at x=1030 -- so grey coverage over the data rows never
 *    reaches 85% there and both boundaries vanish. They are recovered
 *    from the FILLS' OWN EDGES: every saturated run's left and right
 *    edge is a column boundary candidate, merged with the grey lines.
 *
 * 3. THE DATE COLUMN IS FILLED TOO. `Date opened` carries a grey fill
 *    (rgb 220) down the whole table, and the date glyphs inside it
 *    break its column into fragments (gaps of 10/30/8px). Vertical
 *    islands are therefore merged across gaps of <=40px -- real column
 *    rules are never closer than 50px (measured: the narrowest real
 *    gap is 538..588).
 *
 * WHAT THE SHEET IS (measured 2026-11-17, pixels of the pinned fixture)
 *
 *   title band   y 0..33     "Trade Log"
 *   header band  y 33..123   18 labels, grey fill rgb(190,192,191)
 *   32 data rows y 124..1695 row pitch ~50px, two short rows (31px)
 *   19 column boundaries x = 10,121,225,350,418,482,538,588,638,721,
 *                            802,886,960,1030,1100,1195,1290,1384,2030
 *
 * THE VALUES ARE EUROPEAN. The decimal separator is a COMMA ("7,18",
 * "0,56 %"), the dates are day-first ("29.07.25" and "29.07.2025" both
 * occur), and a number that WRAPS inside its cell comes back with the
 * fragments space-joined ("17,10 15" is 17,1015) -- so whitespace is
 * stripped before a numeric cell is parsed.
 */

const sharp = require('sharp');

const { CELL_INSET, readCell } = require('../table/tableReader');
const { assignColumns, normaliseHeader } = require('../oconnell/positionLayout');

/** The parser version written onto every row this module produces. */
const PARSER_VERSION = 'komar-tradelog-1';

/** Neutral grey: low saturation, luma between ink and white. */
const GREY_LUMA_MIN = 100;
const GREY_LUMA_MAX = 252;
const GREY_SAT_MAX = 25;

/** How much of a line must be grey for it to be a line. */
const GREY_COVERAGE = 0.85;

/** An island this thin (rows/cols) is a RULE; thicker is a FILL BLOCK. */
const THIN_MAX = 6;

/** Gaps bridged when merging grey islands (header text: 8 rows; date
 *  glyphs inside the date-column fill: 10/30/8 cols). Real rules are
 *  further apart than both (rows >=31, columns >=50 -- measured). */
const H_MERGE_GAP = 12;
const V_MERGE_GAP = 40;

/** How close a fill edge must be to a grey line to count as the same
 *  boundary (measured: green fill edge 1103 vs rule 1100). */
const EDGE_MERGE_GAP = 8;

/** A saturated horizontal run at least this long is a FILLED CELL, and
 *  its edges are column-boundary candidates. The W/L cells are the only
 *  saturated fills on the sheet (the date fill and the header fill are
 *  neutral grey). */
const MIN_FILL_RUN = 20;
const SATURATION_MIN = 60;

/** The vertical tolerance that groups words into one line (measured:
 *  the words of a line are within 3px of each other; two lines of a
 *  wrapped cell are 19-20px apart). */
const LINE_TOLERANCE = 6;

/**
 * The sheet's 18 columns, as the header prints them.
 *
 * `names` are matched fuzzily and globally by `assignColumns` (from
 * `src/oconnell/positionLayout.js` -- exported helpers, reused rather
 * than copied; the matching is not O'Connell-specific). `whitelist` is
 * the repair-pass alphabet: a cell whose text carries a character its
 * column cannot hold was misread and is read again with the whitelist
 * that makes the mistake impossible (the O'Connell pattern -- there a
 * "4" read as "£", here an "O" read in a date).
 *
 * `bounds` are the measured value ranges; a parse outside them is
 * refused rather than published (a wrong number in a trade log is
 * worse than a missing one).
 *
 * The whitelists carry BOTH decimal marks: the sheet prints commas
 * ("7,18") and the OCR sometimes returns a dot for the same comma
 * ("-1.39"), and a whitelist without the dot would make that reading
 * a "stray character" -- so the repair pass would re-read the cell
 * with a whitelist that CANNOT hold the dot, and the value would come
 * back a hundred times too large (measured: QSI's W/L R "-1.39"
 * became -139 and fell outside its bounds).
 */
const TRADE_LOG_COLUMNS = [
  { field: 'date_opened', names: ['Date opened'], whitelist: '0123456789.' },
  { field: 'date_closed', names: ['Date closed'], whitelist: '0123456789.' },
  { field: 'entry_type', names: ['Entry type'] },
  { field: 'ticker', names: ['Ticker'], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { field: 'avg_open_price', names: ['Avg. opening price', 'Avg opening price'], whitelist: '0123456789,.', bounds: [0, 1000] },
  { field: 'avg_close_price', names: ['Avg. close price'], whitelist: '0123456789,.', bounds: [0, 1000] },
  { field: 'stop_loss_price', names: ['Stop loss'], whitelist: '0123456789,.', bounds: [0, 1000] },
  { field: 'stop_loss_pct', names: ['Stop loss %'], whitelist: '0123456789,.%', bounds: [0, 100] },
  { field: 'risk_capital_pct', names: ['Risk Capital'], whitelist: '0123456789,.%', bounds: [0, 10] },
  { field: 'exit_type', names: ['Exit type'] },
  { field: 'mmts_opening', names: ['MMTS Opening'] },
  { field: 'mmts_close', names: ['MMTS close'] },
  { field: 'wl_pct', names: ['W/L %'], whitelist: '0123456789,.%-', bounds: [-100, 100] },
  { field: 'wl_r', names: ['W/L R'], whitelist: '0123456789,.%-', bounds: [-20, 20] },
  { field: 'initial_rating', names: ['Initial rating'], whitelist: '0123456789.astars' },
  { field: 'after_close_rating', names: ['After close rating'], whitelist: '0123456789.astars' },
  { field: 'review', names: ['Review'] },
  { field: 'comment', names: ['Comment'] },
];

/**
 * Is this pixel the sheet's neutral grey (gridline, date fill, header
 * fill) rather than ink, white, or a saturated W/L fill?
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
function isNeutralGrey(r, g, b) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return luma >= GREY_LUMA_MIN && luma <= GREY_LUMA_MAX && sat <= GREY_SAT_MAX;
}

/**
 * Is this pixel part of a conditionally-filled cell (the W/L greens
 * and reds)?
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
function isSaturatedFill(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) > SATURATION_MIN;
}

/**
 * Read one pixel as an RGB triple.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
function rgbAt(raw, info, x, y) {
  const offset = (y * info.width + x) * info.channels;
  return [raw[offset], raw[offset + 1], raw[offset + 2]];
}

/**
 * The grey-coverage profile along one axis, and the mean luma of each
 * heavy row/column (the luma is what tells a drawn line from the
 * anti-aliased fringe of one: measured, the real rule at x=350 has
 * luma 179 where its fringe at x=345 has 245).
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {string} axis 'h' (profile per row) or 'v' (per column)
 * @param {number} from start of the along-axis range
 * @param {number} to end of the along-axis range (exclusive)
 * @param {number} acrossFrom start of the cross-axis range
 * @param {number} acrossTo end of the cross-axis range (exclusive)
 * @returns {{coverage: number[], luma: number[]}}
 */
function greyProfile(raw, info, axis, from, to, acrossFrom, acrossTo) {
  const coverage = [];
  const luma = [];
  const along = Math.max(1, to - from);
  const across = Math.max(1, acrossTo - acrossFrom);
  // The coverage is a FRACTION OF WHAT WAS SAMPLED, and the samples are
  // the inner loop: the columns for a row profile, the rows for a
  // column profile. Dividing one by the other is a unit error that
  // makes every column look lighter than it is (measured: it found no
  // vertical rule at all until this was fixed).
  const samples = axis === 'h' ? along : across;
  for (let a = from; a < to; a += 1) {
    let grey = 0;
    let lumaSum = 0;
    for (let b = acrossFrom; b < acrossTo; b += 1) {
      const [r, g, bb] = axis === 'h'
        ? rgbAt(raw, info, b, a)
        : rgbAt(raw, info, a, b);
      lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * bb;
      if (isNeutralGrey(r, g, bb)) grey += 1;
    }
    coverage.push(grey / samples);
    luma.push(lumaSum / across);
  }
  return { coverage, luma };
}

/**
 * Merge the heavy runs of a coverage profile into boundaries.
 *
 * Runs closer than `mergeGap` are ONE island (the header's text splits
 * the grey block; the date glyphs split the date-column fill). An
 * island of at most THIN_MAX is a RULE and contributes ONE boundary --
 * the row/column inside it with the lowest mean luma, which is the
 * drawn line rather than its fringe. A thicker island is a FILL BLOCK
 * and contributes its two EDGE rows (the header band's top y=33 and
 * bottom y=123), never its interior.
 *
 * @param {number[]} coverage
 * @param {number[]} luma
 * @param {number} mergeGap
 * @returns {number[]} ascending boundary positions, in profile index
 *   space (add the axis offset outside)
 */
function islandsToBoundaries(coverage, luma, mergeGap) {
  const heavy = coverage.map((value) => value >= GREY_COVERAGE);
  const islands = [];
  let index = 0;
  while (index < heavy.length) {
    if (!heavy[index]) { index += 1; continue; }
    const start = index;
    while (index < heavy.length && heavy[index]) index += 1;
    const previous = islands[islands.length - 1];
    if (previous && start - previous.end - 1 <= mergeGap) {
      previous.end = index - 1;
      continue;
    }
    islands.push({ start, end: index - 1 });
  }

  const out = [];
  for (const island of islands) {
    const thickness = island.end - island.start + 1;
    if (thickness > THIN_MAX) {
      out.push(island.start, island.end);
      continue;
    }
    let darkest = island.start;
    for (let i = island.start; i <= island.end; i += 1) {
      if (luma[i] < luma[darkest]) darkest = i;
    }
    out.push(darkest);
  }
  return out;
}

/**
 * The horizontal boundaries of the sheet: title/header edges and every
 * row separator, in image coordinates.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @returns {number[]}
 */
function findGreyHorizontalRules(raw, info) {
  const { coverage, luma } = greyProfile(raw, info, 'h', 0, info.height, 0, info.width);
  return islandsToBoundaries(coverage, luma, H_MERGE_GAP);
}

/**
 * The vertical boundaries from the GREY LINES over the data rows.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number} yStart
 * @param {number} yEnd
 * @returns {number[]}
 */
function findGreyVerticalRules(raw, info, yStart, yEnd) {
  const { coverage, luma } = greyProfile(raw, info, 'v', 0, info.width, yStart, yEnd);
  return islandsToBoundaries(coverage, luma, V_MERGE_GAP);
}

/**
 * The vertical boundaries hidden UNDER the W/L fills.
 *
 * A filled cell starts and ends exactly on its column's rules, so the
 * left and right edge of every saturated run is a boundary candidate.
 * Measured: the green run of the QS row spans 963..1103 (edges 960/
 * 1103 against the rules 960/1100) and the red run of the PDYN row
 * 960..1030 (edge 1030 -- the rule grey coverage cannot see at all).
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number} yStart
 * @param {number} yEnd
 * @returns {number[]}
 */
function findFillEdgeRules(raw, info, yStart, yEnd) {
  const edges = [];
  for (let y = yStart; y < yEnd; y += 1) {
    // The SPAN of the row's saturated pixels, not its runs: the text
    // inside a filled cell is black and breaks the run into pieces, but
    // the cell's own edges are the first and last saturated pixel.
    let first = -1;
    let last = -1;
    for (let x = 0; x < info.width; x += 1) {
      if (!isSaturatedFill(...rgbAt(raw, info, x, y))) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0 || last - first + 1 < MIN_FILL_RUN) continue;
    edges.push(first, last + 1);
  }
  return edges;
}

/**
 * Merge boundary candidates from several sources into one list.
 *
 * Candidates within EDGE_MERGE_GAP are one boundary. A grey LINE wins
 * over a fill edge in the same cluster (it is the drawn rule), and
 * among grey lines the darker one wins (the fringe of a line at x=345
 * must not shadow the line at x=350).
 *
 * @param {number[]} lines - grey-line boundaries
 * @param {number[]} edges - fill-edge candidates
 * @param {Buffer} [raw] - needed to compare luma when both sources hit
 * @param {{width: number, height: number, channels: number}} [info]
 * @param {number} [yStart]
 * @param {number} [yEnd]
 * @returns {number[]}
 */
function mergeBoundaries(lines, edges, raw, info, yStart, yEnd) {
  // Every candidate goes into ONE sorted list: the two sources are
  // found independently, so offering them in turn would build the
  // clusters in the wrong order (the fill edges of the W/L columns are
  // at x 960 and 1030, which is BEFORE the last grey line at 2030).
  const candidates = [
    ...lines.map((x) => ({ x, fromLine: true })),
    ...edges.map((x) => ({ x, fromLine: false })),
  ].sort((a, b) => a.x - b.x);

  const clusters = [];
  for (const candidate of candidates) {
    const previous = clusters[clusters.length - 1];
    if (previous && candidate.x - previous.end <= EDGE_MERGE_GAP) {
      previous.end = candidate.x;
      previous.values.push(candidate);
      continue;
    }
    clusters.push({ end: candidate.x, values: [candidate] });
  }

  const out = [];
  for (const cluster of clusters) {
    const pool = cluster.values.some((value) => value.fromLine)
      ? cluster.values.filter((value) => value.fromLine)
      : cluster.values;
    if (pool.length === 1 || !raw || !info) {
      out.push(pool[0].x);
      continue;
    }
    // The darkest position in the cluster is the drawn line, not its
    // anti-aliased fringe.
    let best = pool[0];
    let bestLuma = Infinity;
    for (const value of pool) {
      let sum = 0;
      let count = 0;
      for (let y = yStart; y < yEnd; y += 1) {
        const [r, g, b] = rgbAt(raw, info, value.x, y);
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        count += 1;
      }
      const mean = count ? sum / count : Infinity;
      if (mean < bestLuma) { bestLuma = mean; best = value; }
    }
    out.push(best.x);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Paint the located rules near-black so the shared reader sees the
 * grid it expects.
 *
 * Only the LOCATED lines are painted: the header fill stays grey (its
 * interior must not read as 90 rules), the date fill stays grey (it is
 * not a line), and the W/L fills stay saturated.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number[]} hRules
 * @param {number[]} vRules
 * @returns {Buffer} a copy
 */
function darkenRules(raw, info, hRules, vRules) {
  const out = Buffer.from(raw);
  const paint = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
  };
  for (const y of hRules) {
    if (y < 0 || y >= info.height) continue;
    for (let x = 0; x < info.width; x += 1) paint(x, y);
  }
  const top = hRules.length ? Math.min(...hRules) : 0;
  const bottom = hRules.length ? Math.max(...hRules) : info.height - 1;
  for (const x of vRules) {
    if (x < 0 || x >= info.width) continue;
    for (let y = top; y <= bottom; y += 1) paint(x, y);
  }
  return out;
}

/**
 * A number, from a cell of this sheet.
 *
 * The sheet writes decimals with a COMMA, so a comma with no dot is the
 * decimal separator ("7,18" -> 7.18). Whitespace is stripped first: a
 * number that wrapped inside its cell comes back as its fragments
 * space-joined ("17,10 15" is 17,1015, "255,0 1" is 255,01 -- measured
 * on the RDW and AVAV rows). When BOTH separators occur the rightmost
 * is the decimal one (the European thousands form, not measured on
 * this sheet but harmless to honour).
 *
 * @param {string} text
 * @param {[number, number]|null} [bounds]
 * @returns {number|null}
 */
function parseTradeNumber(text, bounds) {
  if (!text) return null;
  let cleaned = String(text).replace(/\s+/g, '').replace(/%/g, '');
  cleaned = cleaned.replace(/[^0-9,.\-]/g, '');
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // The rightmost separator is the decimal one; drop the other.
    if (lastComma > lastDot) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    else cleaned = cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    cleaned = cleaned.replace(/,/g, '.');
  }
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  if (bounds && (value < bounds[0] || value > bounds[1])) return null;
  return value;
}

/**
 * A date, from a cell of this sheet.
 *
 * Day-first, as the sheet prints it ("29.07.25", "01.08.2025" -- both
 * forms occur, and 29 can only be a day). A two-digit year belongs to
 * this century: the corpus is 2025.
 *
 * @param {string} text
 * @returns {string} YYYYMMDD, or '' when the cell holds no date
 */
function parseTradeDate(text) {
  if (!text) return '';
  const match = /(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(String(text));
  if (!match) return '';
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * A star rating, from a cell like "4.5 stars" or "0 stars".
 *
 * Zero is a VALUE -- the sheet prints "0 stars" for a trade he rates
 * worst -- so an absent rating is null, never 0.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseRating(text) {
  if (!text) return null;
  const match = /(\d+(?:\.\d+)?)/.exec(String(text));
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The sign a W/L cell's FILL states, for a number whose minus sign the
 * OCR lost.
 *
 * The fills are the sheet's own conditional formatting: green
 * rgb(85,221,49) is a gain, red rgb(232,39,6) a loss. The TEXT keeps
 * the sign when it is there; the fill only settles the ones the OCR
 * dropped (the O'Connell rule -- the colour is the authority for a
 * sign the glyphs do not carry).
 *
 * @param {{r: number, g: number, b: number}|null} background
 * @returns {number} -1, 0 or 1
 */
function signFromBackground(background) {
  if (!background) return 0;
  const { b, g, r } = background;
  if (g > r + 30 && g > b + 30) return 1;
  if (r > g + 30 && r > b + 30) return -1;
  return 0;
}

/**
 * The sheet's own arithmetic: W/L % IS the return on the average price.
 *
 * Measured on 30 of the 32 rows the sheet prints:
 *
 *   W/L % = (avg close price - avg opening price) / avg opening price * 100
 *
 * and the printed value is that number to TWO decimals -- e.g. QS
 * (9,91 - 7,18) / 7,18 = 38,0223 -> "38,02 %", and BMNR
 * (40,779 - 45,526) / 45,526 = -10,4295 -> "-10,43 %". The two
 * exceptions are the two rows where a number could not be read.
 *
 * So the column is DERIVED from two other columns, and the sheet's own
 * print of it is a CHECK on the reading rather than a fourth fact.
 * That is worth having: it catches a misread price (measured: GOGO's
 * avg close reads "15,57" where the sheet prints "15,576", and the
 * check sees 1,63 % against the sheet's "1,67 %"), and it RECOVERS the
 * W/L % of a row whose cell could not be read (measured: PDYN's
 * "-11,33 %" comes back as "-1 1 33 :" -- the comma and the per cent
 * sign lost -- and the prices give -11,33).
 *
 * The tolerance is 0.02: the sheet prints two decimals, so its own
 * rounding is +-0,005, and 0,02 is four times that.
 */
const WL_TOLERANCE = 0.02;

/**
 * The return the sheet's prices imply.
 *
 * @param {number} avgOpen
 * @param {number} avgClose
 * @returns {number|null}
 */
function impliedReturn(avgOpen, avgClose) {
  if (typeof avgOpen !== 'number' || typeof avgClose !== 'number') return null;
  if (!(avgOpen > 0)) return null;
  return ((avgClose - avgOpen) / avgOpen) * 100;
}

/**
 * A cell's text, in READING ORDER rather than left-edge order.
 *
 * The shared reader sorts a cell's words by their LEFT EDGE, which is
 * right for a single-line cell and wrong for a wrapped one: the sheet
 * wraps "Breakout short-" / "term", and the second line's first
 * character sits a pixel to the LEFT of the first line's, so the
 * reading came back "term Breakout short-" (measured). The same
 * scrambling hit the header ("Capital Risk" for "Risk Capital",
 * "Opening MMTS" for "MMTS Opening"), which cost four of the
 * eighteen columns their mapping, and it scrambled wrapped NUMBERS
 * ("2 10,31" for "10,312").
 *
 * So the text is rebuilt here from the words' own boxes: words are
 * grouped into LINES by their vertical position, the lines are read
 * top to bottom, and the words within a line left to right. Measured:
 * the words of one line are within 3px of each other and two lines of
 * a wrapped cell are 19-20px apart.
 *
 * @param {object} cell
 * @returns {string}
 */
function cellText(cell) {
  if (!cell) return '';
  const words = cell.words || [];
  if (!words.length) return String(cell.text || '');
  const sorted = [...words].sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const lines = [];
  for (const word of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(word.top - last.top) <= LINE_TOLERANCE) last.words.push(word);
    else lines.push({ top: word.top, words: [word] });
  }
  return lines
    .map((line) => line.words
      .sort((a, b) => a.left - b.left)
      .map((word) => word.text)
      .join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A cell's text, cleaned for a label-like column.
 *
 * A hyphenated word broken across two lines comes back with the break
 * as a space ("Breakout short- term"), and the join has to restore it
 * -- but only for the columns whose vocabulary is hyphenated (entry
 * type, exit type, review), never for the free-text comment, where a
 * real " - " must survive.
 *
 * @param {string} text
 * @param {boolean} [joinHyphens]
 * @returns {string}
 */
function cleanCellText(text, joinHyphens) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  if (joinHyphens) out = out.replace(/-\s+/g, '-');
  return out;
}

/**
 * Read the rows of the sheet out of a grid the shared reader produced.
 *
 * @param {object} options
 * @param {object} options.headerBand - the band carrying the 18 labels
 * @param {object[]} options.dataBands - the bands below it
 * @param {Buffer} options.raw - the pixels the cells were read from
 * @param {{width: number, height: number, channels: number}} options.info
 * @param {string[]} [options.notes]
 * @returns {Promise<object[]>}
 */
async function readTradeLogRows(options) {
  const { dataBands, headerBand, info, notes = [], raw } = options;
  // The header's own labels are wrapped too ("Risk" / "Capital"), so
  // the matching sees the READING ORDER -- four of the eighteen
  // columns were unmatched when the left-edge order was used.
  const headerCells = headerBand.cells.map((cell) => ({ ...cell, text: cellText(cell) }));
  const mapping = assignColumns(headerCells, TRADE_LOG_COLUMNS);
  const HYphen = new Set(['entry_type', 'exit_type', 'review']);

  const aligned = [];
  for (const [index, column] of mapping) {
    const headerCell = headerCells[index];
    if (headerCell) aligned.push({ column, headerCell });
  }
  const matched = new Set(aligned.map((entry) => entry.column.field));
  for (const column of TRADE_LOG_COLUMNS) {
    if (!matched.has(column.field)) notes.push(`header column not matched: ${column.field}`);
  }

  const rows = [];
  for (let bandIndex = 0; bandIndex < dataBands.length; bandIndex += 1) {
    const band = dataBands[bandIndex];
    const byLeft = new Map();
    for (const cell of band.cells) byLeft.set(cell.left, cell);

    const values = {};
    for (const { column, headerCell } of aligned) {
      const cell = byLeft.get(headerCell.left);
      if (cell) values[column.field] = cell;
    }

    // THE REPAIR PASS (the O'Connell pattern): a cell whose text holds
    // a character its column cannot hold was misread, and is read
    // again with the whitelist that makes the mistake impossible. A
    // clean cell is never touched.
    for (const column of TRADE_LOG_COLUMNS) {
      if (!column.whitelist) continue;
      const cell = values[column.field];
      if (!cell) continue;
      const text = cellText(cell);
      if (!text) continue;
      const allowed = new Set(column.whitelist.split(''));
      const stray = text.replace(/\s/g, '').split('')
        .filter((character) => !allowed.has(character));
      if (!stray.length) continue;
      // A FILLED cell is skipped. The shared reader rewrites a filled
      // cell as black-on-white before it reads it, and a repair would
      // have to do the same: reading the original white-on-red pixels
      // gives a worse reading than no repair at all (measured: the red
      // W/L cells came back as fragments).
      const background = cell.background || {};
      if (isSaturatedFill(background.r || 0, background.g || 0, background.b || 0)) continue;
      const repaired = await readCell(raw, info, {
        bottom: cell.bottom - CELL_INSET,
        left: cell.left + CELL_INSET,
        right: cell.right - CELL_INSET,
        top: cell.top,
      }, { whitelist: column.whitelist });
      if (repaired.text) {
        cell.text = repaired.text;
        // The repaired words carry the SCALED image's coordinates, so
        // they cannot be used to rebuild the reading order; the repaired
        // text is used as it comes.
        cell.words = [];
        cell.confidence = repaired.confidence;
      }
    }

    const number = (field) => {
      const column = TRADE_LOG_COLUMNS.find((entry) => entry.field === field);
      const cell = values[field];
      if (!cell) return null;
      return parseTradeNumber(cellText(cell), column ? column.bounds : undefined);
    };
    const signed = (field) => {
      const cell = values[field];
      const value = number(field);
      if (!cell || value === null) return null;
      const text = cellText(cell);
      if (!/[-−]/.test(text)) {
        const sign = signFromBackground(cell.background);
        if (sign < 0 && value > 0) return -value;
        if (sign > 0 && value < 0) return value * -1;
      }
      return value;
    };
    const textOf = (field) => (values[field] ? cellText(values[field]) : '');

    const row = {
      after_close_rating: values.after_close_rating
        ? parseRating(cellText(values.after_close_rating))
        : null,
      avg_close_price: number('avg_close_price'),
      avg_open_price: number('avg_open_price'),
      comment: cleanCellText(textOf('comment')),
      confidence: 0,
      date_closed: values.date_closed ? parseTradeDate(cellText(values.date_closed)) : '',
      date_opened: values.date_opened ? parseTradeDate(cellText(values.date_opened)) : '',
      derived_fields: '',
      entry_type: cleanCellText(textOf('entry_type'), true),
      exit_type: cleanCellText(textOf('exit_type'), true),
      initial_rating: values.initial_rating ? parseRating(cellText(values.initial_rating)) : null,
      mmts_close: cleanCellText(textOf('mmts_close')),
      mmts_opening: cleanCellText(textOf('mmts_opening')),
      parser_version: PARSER_VERSION,
      reading_check: '',
      review: cleanCellText(textOf('review'), true),
      risk_capital_pct: number('risk_capital_pct'),
      row_index: bandIndex,
      stop_loss_pct: number('stop_loss_pct'),
      stop_loss_price: number('stop_loss_price'),
      ticker: textOf('ticker')
        .replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase(),
      wl_pct: signed('wl_pct'),
      wl_r: signed('wl_r'),
    };

    const confidences = Object.values(values).map((cell) => cell.confidence || 0);
    row.confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0;

    // THE SHEET'S OWN ARITHMETIC
    //
    // W/L % is the return on the average price, so the row can be
    // checked against itself and a lost W/L can be recovered. A row
    // whose numbers disagree is flagged, not silently published.
    const derived = [];
    const implied = impliedReturn(row.avg_open_price, row.avg_close_price);
    if (row.wl_pct === null && implied !== null) {
      row.wl_pct = Math.round(implied * 100) / 100;
      derived.push('wl_pct');
    }
    if (row.wl_pct !== null && implied !== null) {
      const difference = Math.abs(implied - row.wl_pct);
      if (difference > WL_TOLERANCE) {
        row.reading_check = `W/L ${row.wl_pct}% disagrees with the prices (${implied.toFixed(2)}%)`;
      }
    }

    row.derived_fields = derived.join(',');

    // A row is a trade only if it carries its identity. Bands without
    // them (a stray line under the table) are skipped, with the reason.
    if (!row.ticker || !row.date_opened) {
      notes.push(`row ${bandIndex} skipped: ${row.ticker ? 'no date opened' : 'no ticker'}`);
      continue;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Read the trade log out of one sheet image.
 *
 * The pipeline: locate the grey rules (this module), paint them
 * near-black, hand the copy to the shared grid reader, find the header
 * band by its labels, map the 18 columns, parse the rows.
 *
 * @param {string} imagePath
 * @returns {Promise<{rows: object[], notes: string[], title: string,
 *   hRules: number[], vRules: number[], headerText: string}>}
 */
async function readTradeLogImage(imagePath) {
  const source = await sharp(imagePath).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return readTradeLogFromRaw(source.data, source.info);
}

/**
 * The reader, from raw pixels (so a test can drive it without a file).
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @returns {Promise<object>}
 */
async function readTradeLogFromRaw(raw, info) {
  const notes = [];
  const hRules = findGreyHorizontalRules(raw, info);

  // The header band is the grey FILL BLOCK: the thick island. Its two
  // edges bound it; everything between them is the header.
  const thick = [];
  for (let i = 1; i < hRules.length; i += 1) {
    if (hRules[i] - hRules[i - 1] <= THIN_MAX) continue;
    // A gap this large is either the header block (91px of grey) or the
    // jump from the last row rule to nothing; only a block whose span
    // is itself grey counts as the header.
    let grey = 0;
    let count = 0;
    for (let y = hRules[i - 1]; y <= hRules[i]; y += 1) {
      for (let x = 0; x < info.width; x += 4) {
        const [r, g, b] = rgbAt(raw, info, x, y);
        count += 1;
        if (isNeutralGrey(r, g, b)) grey += 1;
      }
    }
    if (count && grey / count >= GREY_COVERAGE) thick.push([hRules[i - 1], hRules[i]]);
  }
  const headerEdges = thick[0] || null;

  const dataFrom = headerEdges ? headerEdges[1] : (hRules[0] || 0);
  const dataTo = hRules[hRules.length - 1] || info.height;
  const vLines = findGreyVerticalRules(raw, info, dataFrom, dataTo);
  const vEdges = findFillEdgeRules(raw, info, dataFrom, dataTo);
  const vRules = mergeBoundaries(vLines, vEdges, raw, info, dataFrom, dataTo);

  const dark = darkenRules(raw, info, hRules, vRules);

  // eslint-disable-next-line global-require
  const { readGridFromRaw } = require('../table/tableReader');
  const grid = await readGridFromRaw(dark, info);
  const bands = grid.bands || [];

  const headerIndex = bands.findIndex((band) => (
    /date\s*opened/i.test(band.text) || /dateopened/i.test(normaliseHeader(band.text))
  ));
  if (headerIndex === -1) {
    return {
      hRules, vRules,
      headerText: '',
      notes: [...notes, 'no header band (no "Date opened" label found)'],
      rows: [],
      title: '',
    };
  }

  const headerBand = bands[headerIndex];
  let title = '';
  for (let i = 0; i < headerIndex; i += 1) {
    if (/trade\s*log/i.test(bands[i].text)) title = cleanCellText(bands[i].text);
  }
  if (!title) notes.push('title band does not read "Trade Log"');

  const dataBands = bands
    .slice(headerIndex + 1)
    .filter((band) => band.text && band.text.trim());

  const rows = await readTradeLogRows({
    dataBands,
    headerBand,
    info,
    notes,
    raw: dark,
  });

  return {
    hRules,
    headerText: cleanCellText(headerBand.text),
    notes,
    rows,
    title,
    vRules,
  };
}

module.exports = {
  GREY_COVERAGE,
  PARSER_VERSION,
  TRADE_LOG_COLUMNS,
  cellText,
  cleanCellText,
  darkenRules,
  findFillEdgeRules,
  findGreyHorizontalRules,
  findGreyVerticalRules,
  isNeutralGrey,
  isSaturatedFill,
  mergeBoundaries,
  parseRating,
  parseTradeDate,
  parseTradeNumber,
  readTradeLogFromRaw,
  readTradeLogImage,
  readTradeLogRows,
  signFromBackground,
};
