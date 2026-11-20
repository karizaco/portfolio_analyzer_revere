'use strict';

/**
 * The Komar market card: the "Market Update" slide that a session's
 * print embeds.
 *
 * WHAT THE CARD IS
 *
 * Every session print carries a rendered slide -- the author's own
 * summary of the session. It is the densest structured document in the
 * corpus:
 *
 *   Market Trend            Exposure
 *   NASDAQ    Mid   Short   (  50%  )
 *   S&P 500   [up]  [down]   invested
 *   Russell 2000 [up] [up]
 *
 *   Money Maker Market! You want to take new opportunities and keep
 *   maximum exposure. Hold on to winners and stick to your rules.
 *
 *   High-Potential Themes
 *   Semis          Data center      Software
 *   Strong demand  AI data centers  AI software tools
 *   Leaders: SNDK, MU, INTC and more.
 *
 * The THEMES with their LEADERS are the highest-value field in the
 * whole corpus: a dated, curated list of the market leaders in each
 * theme, in the author's own selection.
 *
 * WHY THE ARROWS ARE NOT TEXT
 *
 * The trend arrows are IMAGES -- coloured discs with a white arrow
 * glyph -- and no OCR reads a picture of an arrow. So the DIRECTION is
 * read from the DISC'S COLOUR, which is what carries the meaning:
 *
 *   green   the arrow points up    -> up
 *   amber   the arrow points across -> flat
 *   red     the arrow points down  -> down
 *
 * Measured on the corpus's own cards, the discs are the only strongly
 * saturated round objects in the image, and they sit in a regular
 * lattice: three rows (NASDAQ, S&P 500, Russell 2000) by one to three
 * columns (the horizons: Long, Mid, Short -- the card does not always
 * print all three).
 *
 * WHY THE CARD IS READ IN PIECES
 *
 * The card is white text on a dark green photographic background --
 * a trading chart showing through. One OCR pass over the whole card
 * reads the prose and mangles the numbers: measured, the whole-card
 * read of `komar_20260509.pdf` page 2 came back at confidence 29 with
 * "Matket Trend" for "Market Trend" and "MoneyiMakegiaikettoliwant'to"
 * for the narrative.
 *
 * So the card is read in REGIONS: each region is cropped, inverted
 * (white-on-dark is unreadable to Tesseract), and read on its own.
 * The regions are found by WHERE THE INK IS, not by hard-coded pixels,
 * because the card is 1080x692 in one document and 1080x769 in another.
 */

/**
 * The horizons the card may print, longest first.
 *
 * The card prints a subset: the 2026-05-09 card prints "Mid" and
 * "Short", and the 2026-01-25 card prints "Long", "Mid" and "Short".
 * The order is by horizon LENGTH, because that is the order the discs
 * are in.
 */
const HORIZONS = Object.freeze(['Long', 'Mid', 'Short']);

/** The index rows the card prints, in the order they are printed. */
const INDEX_ROWS = Object.freeze([
  { field: 'nasdaq', label: 'NASDAQ' },
  { field: 'sp500', label: 'S&P 500' },
  { field: 'russell2000', label: 'Russell 2000' },
]);

/**
 * The colour of a disc, and what it means.
 *
 * The windows are measured from the corpus's own cards, not chosen:
 *
 *   up   green  rgb(81,162,52)   the arrow points up
 *   flat amber  rgb(239,153,57)   the arrow points across
 *   down red    rgb(209,56,49)    the arrow points down
 *
 * The card's BACKGROUND is also green (rgb(57,110,41)) and its
 * background PHOTOGRAPH is green too, so the windows are narrow on the
 * blue channel and the green is required to be BRIGHT -- the
 * background's green is 41-57 and the disc's is 162.
 */
/**
 * The windows are measured from the corpus's own cards, at the DISC's
 * own pixels and at the BACKGROUND's own pixels:
 *
 *   up    rgb(83,190,107)    the disc
 *   flat  rgb(232,179,64)    the disc
 *   down  rgb(209,56,49)     the disc
 *   --    rgb(38,87,25)      the card's background green
 *   --    rgb(69,100,33)     the chart photograph showing through
 *
 * So a green disc is separated from the background by its GREEN (190
 * against 87 and 100) and by its BLUE (107 against 25 and 33). The
 * amber and the red are separated from the green by their hue.
 */
/**
 * AND THE 2025 CARDS ARE A DIFFERENT LAYOUT
 *
 * The 2025-01-25 card is 1978x1466 -- not the 1080-wide card of 2026
 * -- and its arrows are a BRIGHT green, rgb(32,176,0), against an olive
 * background of rgb(80,96,24). The 2026 card's green is rgb(83,190,107)
 * against a darker green background of rgb(38,87,25).
 *
 * So the green window has to cover BOTH greens: r 15-120, g 150-215,
 * b 0-140. The backgrounds are excluded by their GREEN, which is 96 and
 * 87 against the discs' 176 and 190.
 */
const DISC_WINDOWS = Object.freeze({
  down: { b: [0, 90], g: [20, 95], r: [175, 245] },
  flat: { b: [0, 100], g: [135, 200], r: [215, 255] },
  up: { b: [0, 140], g: [150, 215], r: [15, 120] },
});

/**
 * The smallest disc the reader will accept, in pixels.
 *
 * The discs are 33-35 px across in the corpus's cards, and the smallest
 * thing that could be confused with one is the theme title text, which
 * is not a disc at all.
 */
const MIN_DISC_SIZE = 22;

/** The largest a disc may be, in pixels. */
const MAX_DISC_SIZE = 48;

/**
 * The theme words the card uses to introduce the leaders.
 *
 * "Leaders: SNDK, MU, INTC and more." -- the word is always there and
 * the tickers follow it.
 */
const LEADERS_PATTERN = /leaders\s*:?\s*(.+?)(?:\s+and\s+more\.?)?$/i;

/**
 * A ticker-shaped token.
 *
 * The corpus's tickers are 1-5 capitals, sometimes with a dot: "U",
 * "LARC", "NBIS", "CRML", "BRK.B".
 */
const TICKER_PATTERN = /^[A-Z][A-Z0-9]{0,4}(?:\.[A-Z])?$/;

/**
 * Is this token shaped like a ticker?
 *
 * @param {string} token
 * @returns {boolean}
 */
function isTickerShape(token) {
  const value = String(token || '').trim();
  if (!TICKER_PATTERN.test(value)) return false;
  // "AI" appears in this corpus's theme prose and is not a ticker.
  if (value === 'AI') return false;
  return true;
}

/**
 * The tickers in a "Leaders: ..." run.
 *
 * The run is read with a WHITELIST of shapes, not with a guess: the
 * theme's own description ("Strong demand from data centers.") sits in
 * the same column, and a line like "AI related software tools" would
 * otherwise contribute "AI" as a leader.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseLeaders(text) {
  const match = LEADERS_PATTERN.exec(String(text || '').trim());
  if (!match) return [];
  const run = match[1];
  const tickers = [];
  for (const token of run.split(/[,\s]+/)) {
    // The 2025 cards print the leaders with a DOLLAR SIGN: "Leaders:
    // $GEV, $SAR, $VST". The sign is decoration, not part of the ticker.
    const clean = token.replace(/^\$/, '').replace(/[.;:]$/, '').trim();
    if (!clean) continue;
    if (!isTickerShape(clean)) continue;
    tickers.push(clean);
  }
  return tickers;
}

/**
 * The themes in a card's theme section, with their leaders.
 *
 * @param {string} text - the card's theme section, as read
 * @returns {Array<{theme: string, leaders: string[]}>}
 */
function parseThemes(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const themes = [];
  for (const line of lines) {
    const match = LEADERS_PATTERN.exec(line);
    if (!match) continue;
    const before = line.slice(0, match.index).trim();
    // The theme's NAME is the last heading before its "Leaders:" line.
    // The card prints the name on its own line (or two, when it wraps),
    // so the name is whatever heading-like text precedes the leaders.
    const name = before.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop() || '';
    const leaders = parseLeaders(line);
    if (!name || !leaders.length) continue;
    themes.push({ leaders, theme: name });
  }
  return themes;
}

/**
 * The exposure percentage in a card.
 *
 * The donut carries the number as TEXT in its middle -- "50%
 * invested" -- and the number is a bare percentage.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseExposure(text) {
  const match = /(\d{1,3})\s*%/.exec(String(text || ''));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

/**
 * The colour of a disc, from its pixels.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string} 'up' | 'flat' | 'down' | ''
 */
function classifyDisc(r, g, b) {
  for (const name of Object.keys(DISC_WINDOWS)) {
    const window = DISC_WINDOWS[name];
    if (r >= window.r[0] && r <= window.r[1]
      && g >= window.g[0] && g <= window.g[1]
      && b >= window.b[0] && b <= window.b[1]) {
      return name;
    }
  }
  return '';
}

/**
 * The disc a colour belongs to, or 'unknown'.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
function discDirection(r, g, b) {
  return classifyDisc(r, g, b) || 'unknown';
}

/**
 * The trend rows of a card, from the discs that were found.
 *
 * THE LATTICE IS FOUND, NOT ASSUMED
 *
 * The card prints the index names down the left and the discs to their
 * right, one row per index and one column per horizon. The discs are
 * therefore sorted into rows by their Y, and the rows are matched to the
 * indices by their ORDER -- the card always prints NASDAQ, then
 * S&P 500, then Russell 2000.
 *
 * A row with no disc is 'unknown', never 'flat'. A missing reading and
 * a flat reading are different facts.
 *
 * @param {Array<object>} discs - { x, y, direction }
 * @returns {object} the rows
 */
function readTrendRows(discs) {
  const rows = { nasdaq: 'unknown', russell2000: 'unknown', sp500: 'unknown' };
  if (!discs || !discs.length) return rows;

  const sorted = [...discs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  for (const disc of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.y - disc.y) <= 12) {
      last.discs.push(disc);
      continue;
    }
    groups.push({ discs: [disc], y: disc.y });
  }

  INDEX_ROWS.forEach((row, index) => {
    const group = groups[index];
    if (!group) return;
    const byX = [...group.discs].sort((a, b) => a.x - b.x);
    rows[row.field] = byX[0].direction;
  });
  return rows;
}

/**
 * The horizons a card printed, from the columns the discs are in.
 *
 * @param {Array<object>} discs
 * @returns {string[]}
 */
function readHorizons(discs) {
  if (!discs || !discs.length) return [];
  const columns = [];
  for (const disc of [...discs].sort((a, b) => a.x - b.x)) {
    const last = columns[columns.length - 1];
    if (last && Math.abs(last.x - disc.x) <= 12) {
      last.n += 1;
      continue;
    }
    columns.push({ n: 1, x: disc.x });
  }
  // A column that carries discs for only one row is not a horizon; it is
  // a stray. Only columns with a disc on every row are horizons.
  const rows = new Set(discs.map((disc) => disc.y));
  return columns
    .filter((column) => column.n >= Math.max(2, rows.size - 1))
    .map((column, index) => HORIZONS[HORIZONS.length - columns.length + index] || `col${index}`);
}

/**
 * The leader GROUPS of a card, read by COLUMN.
 *
 * THE ORDER THE OCR READS IS NOT THE ORDER THE CARD IS IN.
 *
 * Tesseract reads a multi-column layout LINE BY LINE across the whole
 * width, so the three "Leaders:" runs of the 2026-05-09 card come out
 * interleaved:
 *
 *   Leaders: SNDK, MU,    Leaders: CIFR, HUT,    Leaders: FROG,
 *   INTC and more.        NBIS and more.        DDOG, TWLO and more.
 *
 * and the text parser -- which walks the text in the order it arrives
 * -- therefore mixes the columns: the 2026-05-09 card's "Semis" group
 * got the "Data centers" leaders and its "Software" group got the
 * tail of both of its neighbours. **The leaders were right; their
 * GROUPING was wrong.**
 *
 * So the groups are read by POSITION: the "Leaders:" word is the
 * ANCHOR of a column, and every ticker word belongs to the last
 * anchor at or before it. That is what the card says, and it does not
 * depend on the order the words arrive in.
 *
 * @param {object[]} words - the theme region's words, in CARD pixels
 * @returns {Array<{leaders: string[], x: number}>} the groups, in
 *   column order
 */
function parseLeaderGroups(words) {
  const list = Array.isArray(words) ? words : [];
  const anchors = [];
  for (const word of list) {
    const text = String(word.text || '').trim();
    if (!/^(leaders|eaders)\s*:?$/i.test(text)) continue;
    anchors.push({
      height: Number(word.height) || 0,
      top: Number(word.top) || 0,
      x: Number(word.left) || 0,
    });
  }
  if (!anchors.length) return [];
  anchors.sort((a, b) => a.x - b.x);

  const groups = anchors.map((anchor) => ({
    height: anchor.height,
    leaders: [],
    top: anchor.top,
    x: anchor.x,
  }));
  for (const word of list) {
    const text = String(word.text || '').trim();
    if (!text || /^(leaders|eaders)\s*:?$/i.test(text)) continue;
    // The card prints a dollar sign before some of the tickers, and a
    // comma after them: "Leaders: $GEV, $AR, $VST and more."
    //
    // And a trailing LOWERCASE letter is the OCR's own noise: the
    // 2026-03-14 card's "AAOI" reads as "AAOIl", and a ticker is
    // uppercase, so the lowercase letter at the end is dropped before
    // the shape test -- which would otherwise reject the word before
    // the lexicon ever sees it.
    const clean = text
      .replace(/^\$/, '')
      .replace(/[.,;:]$/, '')
      .replace(/[a-z]$/, '')
      .trim();
    if (!clean || !isTickerShape(clean)) continue;
    const x = Number(word.left) || 0;
    const top = Number(word.top) || 0;
    // The column of the word: the NEAREST anchor when it is close
    // enough, and otherwise the last anchor before it.
    //
    // The NEAREST rule matters because a wrapped tail can sit a pixel
    // LEFT of its own anchor -- the 2026-03-14 card's "AMPX," is at
    // x 326 and its "Leaders:" label is at x 327 -- and the
    // "last anchor before it" rule would hand the tail to the
    // PREVIOUS column. The columns are 250 px apart, so twelve pixels
    // of slack cannot reach the neighbour.
    let group = null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const candidate of groups) {
      const distance = Math.abs(candidate.x - x);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
      if (candidate.x <= x + 2) group = candidate;
    }
    if (nearest && nearestDistance <= 12) group = nearest;
    if (!group) continue;
    // AND THE WORD IS NOT MORE THAN ONE LINE ABOVE ITS OWN
    // "Leaders:" LABEL. The theme's DESCRIPTION is above it, and a
    // description can hold a ticker-shaped word ("powered by AI theme"
    // reads as "Al"), which would otherwise be published as a leader
    // of that theme. The tolerance is the LABEL'S OWN HEIGHT, so it
    // scales with the card: the 2025 card's leaders sit a few pixels
    // ABOVE their label's top (the label is a tall capital) and the
    // 2026 card's sit just below it.
    if (top < group.top - group.height - 2) continue;
    group.leaders.push(clean);
  }
  return groups.filter((group) => group.leaders.length);
}

/**
 * The theme title that belongs to a leader group.
 *
 * The title is CENTRED in its box and the "Leaders:" line is at the
 * box's left edge, so the two are not at the same x -- the title is
 * the NEAREST one.
 *
 * @param {Array<{left: number, right: number, text: string}>} titles
 * @param {Array<{x: number}>} groups
 * @returns {Array<string>} the theme name for each group, or '' when
 *   there is no title near it
 */
function matchThemesToGroups(titles, groups) {
  const list = Array.isArray(titles) ? titles : [];
  const columns = Array.isArray(groups) ? groups : [];
  if (!list.length || !columns.length) return [];
  return columns.map((group) => {
    let best = '';
    let bestDistance = Infinity;
    for (const title of list) {
      const centre = (Number(title.left) + Number(title.right)) / 2;
      const distance = Math.abs(centre - group.x);
      if (distance >= bestDistance) continue;
      best = title.text;
      bestDistance = distance;
    }
    return best;
  });
}

/**
 * The theme name of a leader group, from the OCR's own WORDS.
 *
 * THE FALLBACK FOR THE 2025 CARD.
 *
 * The 2025 card draws its theme boxes with a DOTTED border in the same
 * colour as the titles, so the accent ink cannot separate them: the
 * border and the title merge into one box, and the accent search
 * returns five boxes for four titles ("welwg,", "{i Datacenter || Chips",
 * "ELA"). So the name is read from the TEXT instead.
 *
 * The title is the topmost WORD-LOOKING token in the column, above the
 * "Leaders:" label: on the 2025 card that is "Energy" (y 803), "Software"
 * (798), "Datacenter" (803) and "Chips" (796) -- the descriptions are
 * below them, and the dotted borders read as "|" and "~~", which are
 * not words.
 *
 * The title is CENTRED in its box and the "Leaders:" line is at the
 * box's left edge, so a title belongs to the NEAREST column -- which
 * is a different rule from the leaders' (they are left-aligned, so
 * they belong to the last anchor at or before them).
 *
 * @param {object[]} words - the theme region's words
 * @param {Array<{x: number}>} groups
 * @returns {string[]} the theme name for each group
 */
function parseThemeHeadings(words, groups) {
  const list = Array.isArray(words) ? words : [];
  const columns = Array.isArray(groups) ? groups : [];
  if (!list.length || !columns.length) return [];
  // The candidate heading of each column: the topmost WORD-LOOKING
  // token above the column's "Leaders:" label.
  const candidates = columns.map((group) => {
    let best = '';
    let bestTop = Infinity;
    for (const word of list) {
      const text = String(word.text || '').trim();
      if (!/^[A-Z][A-Za-z]{0,20}$/.test(text)) continue;
      const x = Number(word.left) || 0;
      const top = Number(word.top) || 0;
      if (top >= group.top) continue;
      // The NEAREST column: the title is centred in its box.
      let nearest = null;
      let nearestDistance = Infinity;
      for (const column of columns) {
        const distance = Math.abs(column.x - x);
        if (distance >= nearestDistance) continue;
        nearest = column;
        nearestDistance = distance;
      }
      if (!nearest || nearest !== group) continue;
      if (top >= bestTop) continue;
      best = text;
      bestTop = top;
    }
    return { text: best, top: bestTop };
  });

  // THE TITLES SHARE A ROW. The card prints them side by side, so a
  // candidate that is well below the others is not a title but the
  // DESCRIPTION's first word ("Benefit from higher oil price." reads
  // as "Benefit"), and a wrong name is worse than no name.
  const tops = candidates.filter((entry) => entry.text).map((entry) => entry.top).sort((a, b) => a - b);
  const median = tops.length ? tops[Math.floor(tops.length / 2)] : 0;
  return candidates.map((entry) => (
    entry.text && Math.abs(entry.top - median) <= 12 ? entry.text : ''
  ));
}

module.exports = {
  DISC_WINDOWS,
  HORIZONS,
  INDEX_ROWS,
  LEADERS_PATTERN,
  MAX_DISC_SIZE,
  MIN_DISC_SIZE,
  classifyDisc,
  discDirection,
  isTickerShape,
  matchThemesToGroups,
  parseExposure,
  parseLeaderGroups,
  parseLeaders,
  parseThemeHeadings,
  parseThemes,
  readHorizons,
  readTrendRows,
};





