'use strict';

/**
 * Read the Komar PANEL out of a frame.
 *
 * WHAT IT READS
 *
 * The on-screen table at the right edge of a session: the holdings (or
 * the watchlist), their last price, their change, and the groups they
 * sit in -- `CLOSED` for the exited names, the theme names in the
 * later eras.
 *
 * WHY IT IS NOT THE QMG READER
 *
 * `src/video/positionTableScan.js` reads a table it has to FIND: it
 * looks for the ticker column by ink runs over the whole frame and
 * then reconciles a title probe against a header. The Komar panel is
 * not found -- it is at a MEASURED place (see `panelLayout.js`), so
 * this reader crops that region and reads the columns from the header
 * it finds there.
 *
 * WHAT THE SHARED MACHINERY IS USED FOR
 *
 * `src/table/tableReader.js`'s `readCell` does the OCR: it crops a
 * rectangle out of the SOURCE pixels, upscales it and hands it to
 * Tesseract, and it returns the words with their boxes. The panel's
 * text is 9-13 px tall in the source, so the upscale is the whole
 * difference between a readable panel and a row of confetti.
 *
 * HOW THE PANEL IS READ, AND WHY
 *
 * 1. **THE WHOLE REGION IS READ ONCE**, to find the HEADER (the
 *    column labels) and the ROWS (where each row's band is). The
 *    symbols and the percentages come out of it, but its numbers lose
 *    their decimal points: "252.76" comes back "25276" and "76.64"
 *    comes back "7664".
 * 2. **EACH CELL IS READ ON ITS OWN**, which is what Tesseract is
 *    best at -- and what `src/video/positionTableScan.js` does for the
 *    QMG table. A column strip is four thousand pixels high and the
 *    layout analysis gives up; a cell is a strip of pixels.
 * 3. **THE ROWS ARE CLUSTERS, NOT A FIXED PITCH.** The words of one
 *    row do not share a top, and a fixed pitch puts them in different
 *    rows whenever they straddle a pitch boundary -- which is what
 *    happens to half the rows.
 * 4. **THE SYMBOL COLUMN CARRIES THE ROW ICONS.** The panel draws a
 *    small coloured icon before every symbol, and Tesseract reads some
 *    of them as letters: the POWL row reads "VPOWLE".
 *
 * ITERATION 3, AND THE THREE DEFECTS IT FIXED
 *
 * The reader is MEASURED against the panels' own pixels -- the
 * expectation is pinned in `test/fixtures/komar_panel/expectations.json`
 * and the score is in `test/komarPanelReader.test.js`. Before this
 * iteration it read **7 of 52 symbols in the right order (13.5 %)**,
 * and the three defects were:
 *
 *   (a) THE ICON WAS READ AS THE SYMBOL. The icon is COLOURED and the
 *       text is not, so iteration 2 took the saturated pixels out of
 *       the picture -- but a partly-saturated edge still reads as a
 *       letter, and the US flag in front of "US02" reads as "C", the
 *       "S" logo in front of DIA reads as "S", the "i" in front of IWN
 *       reads as "I". **The fix is to REMOVE the icon, not to cut the
 *       cell**: the icon is painted white in the OCR's own box for
 *       it, so the symbol is left whole. (A cut is a risk: the cut
 *       lands on the icon's antialiased edge, and one pixel of pale
 *       blue is enough for Tesseract to read a letter out of it -- the
 *       MU row reads "CMU" when the cell starts at the last saturated
 *       pixel and "MU" when it starts one pixel later.)
 *   (b) THE DETAIL CARD WAS READ AS ROWS. The card under the table
 *       carries the selected row's symbol again, the company name and
 *       a statistics widget. The gap test did not catch it, and the
 *       reason is the CHART'S PRICE AXIS: the axis labels sit at the
 *       crop's left edge, they are spaced about a pitch apart, and
 *       they bridge the gap between the table and the card. **The fix
 *       is to read only the panel's own columns**: a word to the left
 *       of the panel's content edge is the chart, not the panel.
 *   (c) THE THEME GROUP HEADERS WERE NOT RECOGNISED. The group
 *       headers are the author's OWN names -- MEDICAL, DRONES,
 *       SEMICONDUCTORS, OIL / GAS / COAL -- and they are not an
 *       enumerable set, so a list of them cannot work. **The fix is
 *       the rule the panel itself states**: a group header is a row
 *       with NO NUMBERS. A row whose numbers could not be read is
 *       still a position when the lexicon knows its symbol, so the
 *       lexicon is what tells a header from an unreadable position.
 *
 * AND ONE THING THE MEASUREMENT FOUND, which is not the reader's
 * fault and is worth knowing: **Tesseract's reading of the SAME
 * pixels depends on what the shared worker read before it.** Measured
 * on the 2026-04-25 frame, the same region read twice in one process
 * gave "nue" and "MU" for the same ticker. The project's own Revere
 * notes say the same about that path. So a panel reading is a
 * MEASUREMENT of the pixels and not a function of them alone, and the
 * score is reported with the reader's own frame set.
 */

const sharp = require('sharp');

const { readCell, SATURATION_MIN } = require('../table/tableReader');
const {
  isGroupHeader,
  isOccluded,
  panelEraForDate,
  panelRegionForFrame,
  panelRowPitch,
} = require('./panelLayout');

/** The upscale the panel is read at. The panel's text is 9-13 px tall
 *  in the source; Tesseract needs it about four times that. */
const PANEL_SCALE = 4;

/** How far LEFT of the header's first label the panel's own content may
 *  start. The row icons sit a couple of pixels left of the "Symbol"
 *  label, and the chart's price axis is further left still. */
const CONTENT_MARGIN = 16;

/** How far the icon's word may sit from the panel's icon column and
 *  still be the icon. */
const ICON_TOLERANCE = 8;

/** The header labels, and the column each one names. */
const HEADER_COLUMNS = [
  { field: 'symbol', label: 'symbol' },
  { field: 'last', label: 'last' },
  { field: 'chg', label: 'chg' },
  { field: 'chg_pct', label: 'chg%' },
];

/**
 * Is a word a NUMBER?
 *
 * The panel's prices are numbers and the panel's other text is not, and
 * the whole-region read is loose about both: "418.08" comes back as
 * "a18.08" and "1.86%" as "1.86%". So the test is a count, not a
 * pattern -- two or more digits and at most a couple of letters.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksNumeric(text) {
  const value = String(text || '');
  const digits = (value.match(/\d/g) || []).length;
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  return digits >= 2 && letters <= 2 && value.length <= 14;
}

/**
 * A copy of the pixels with a BOX painted white.
 *
 * THE ROW ICON. The panel draws a small coloured icon before every
 * symbol, and Tesseract reads some of them as letters -- the POWL row
 * reads "VPOWLE", the US flag in front of "US02" reads as "C", and the
 * "S" logo in front of DIA reads as "S".
 *
 * The icon is REMOVED rather than CUT AWAY. A cut is a risk: if the
 * cut lands inside the symbol, the holding is lost, and the cut's
 * position depends on the icon's antialiased edge, which is one pixel
 * of pale blue that is enough for Tesseract to read a letter out of
 * (the MU row reads "CMU" when the cell starts at the last saturated
 * pixel and "MU" when it starts one pixel later). Painting the icon
 * white leaves the symbol whole.
 *
 * The box is the OCR's OWN box for the icon's word, so it is the
 * icon's measured extent and not a guess.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @returns {Buffer}
 */
function whitenBox(raw, info, rect) {
  const out = Buffer.from(raw);
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      out[offset] = 255;
      out[offset + 1] = 255;
      out[offset + 2] = 255;
    }
  }
  return out;
}

/**
 * The sign a cell's FILL states, by COUNTING the coloured pixels.
 *
 * Sampling one pixel in the middle of the cell is unreliable: the
 * middle can be over the text, or over the white between two digits,
 * and "-7.41 %" comes back "+7.41 %". The fill covers the cell, so the
 * majority of its COLOURED pixels is the answer.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @returns {number} -1, 0 or 1
 */
function signFromCellFill(raw, info, rect) {
  let green = 0;
  let red = 0;
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = raw[offset];
      const g = raw[offset + 1];
      const b = raw[offset + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat <= SATURATION_MIN) continue;
      if (g > r + 25 && g > b + 25) green += 1;
      else if (r > g + 25 && r > b + 25) red += 1;
    }
  }
  if (green === 0 && red === 0) return 0;
  return green > red ? 1 : -1;
}

/**
 * The pixel colour of a cell, sampled in its middle.
 *
 * The W/L column's SIGN is in the fill (green for a gain, red for a
 * loss) and Tesseract loses a leading minus now and then -- the same
 * rule the O'Connell position log uses, and the same reason.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @returns {{r: number, g: number, b: number}}
 */
function cellColour(raw, info, rect) {
  const x = Math.max(0, Math.min(info.width - 1, Math.round((rect.left + rect.right) / 2)));
  const y = Math.max(0, Math.min(info.height - 1, Math.round((rect.top + rect.bottom) / 2)));
  const offset = (y * info.width + x) * info.channels;
  return { b: raw[offset + 2], g: raw[offset + 1], r: raw[offset] };
}

/**
 * The sign a cell's FILL states.
 *
 * @param {{r: number, g: number, b: number}} colour
 * @returns {number} -1, 0 or 1
 */
function signFromFill(colour) {
  if (!colour) return 0;
  const { b, g, r } = colour;
  if (g > r + 25 && g > b + 25) return 1;
  if (r > g + 25 && r > b + 25) return -1;
  return 0;
}

/**
 * A number, from a cell's text.
 *
 * The panel prints "216.09" and "1.86%" and "-3.77%" -- a dot decimal
 * and an explicit sign.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseNumber(text) {
  const value = String(text || '').replace(/[^0-9.\-]/g, '');
  if (!value || !/[0-9]/.test(value)) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The column a header word names.
 *
 * @param {object[]} words
 * @returns {Array<{field: string, left: number, right: number}>}
 */
function columnsFromHeader(words) {
  const found = [];
  for (const column of HEADER_COLUMNS) {
    const word = words.find((candidate) => (
      String(candidate.text || '').toLowerCase().replace(/[^a-z%]/g, '') === column.label
    ));
    if (!word) continue;
    found.push({
      field: column.field,
      left: word.left,
      right: word.left + (word.width || 0),
    });
  }
  return found;
}

/**
 * Cluster words into rows by their vertical gap.
 *
 * @param {object[]} words
 * @param {number} pitch
 * @returns {Array<{top: number, bottom: number, words: object[]}>}
 */
function clusterRows(words, pitch) {
  const sorted = words.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const clusters = [];
  let current = null;
  for (const word of sorted) {
    const bottom = word.top + (word.height || 0);
    if (!current || bottom - current.bottom > pitch * 0.5) {
      current = { bottom, top: word.top, words: [word] };
      clusters.push(current);
      continue;
    }
    current.words.push(word);
    current.bottom = Math.max(current.bottom, bottom);
  }
  return clusters;
}

/**
 * The words of a cluster that fall in a column's x band.
 *
 * @param {object[]} words
 * @param {{left: number, right: number}} band
 * @returns {object[]}
 */
function wordsInBand(words, band) {
  return words.filter((word) => (
    word.left + (word.width || 0) / 2 >= band.left && word.left + (word.width || 0) / 2 <= band.right
  ));
}

/**
 * The symbol a row's words name.
 *
 * The WHOLE-REGION read is better at the symbol than the per-cell read
 * is, and the reason is the icon: in the whole region the icon is a
 * WORD of its own ("© TER", "MU »"), so the ticker is a separate
 * token, while the per-cell read puts the icon's letter and the
 * ticker in one string ("CMU").
 *
 * THREE THINGS IT HAS TO GET RIGHT.
 *
 * 1. THE ICON'S WORD IS NOT THE SYMBOL. The icon is the row's
 *    leftmost word, and it is excluded here -- otherwise the lexicon
 *    can pick the icon's letter ("Q" is a ticker, and it is the icon
 *    in front of WULF).
 * 2. THE PANEL'S TRAILING DOT IS NOT PART OF THE TICKER. The panel
 *    draws a small dot after every symbol, and Tesseract reads it as a
 *    final "e" -- "DIAe", "HYGe", "UVXYe" -- so the dot is stripped.
 *    A ticker that really ends in "e" is kept when the lexicon knows
 *    it ("LITE"), because the lexicon has the last word.
 * 3. THE LEXICON ARBITRATES. When it knows the ticker, that ticker
 *    wins over the longest token.
 *
 * @param {object[]} words - the row's symbol-column words
 * @param {Set<string>|null} lexicon
 * @param {object|null} [iconWord] - the icon's own word, to exclude
 * @returns {string}
 */
function symbolFromWords(words, lexicon, iconWord = null) {
  const candidates = words
    .filter((word) => word !== iconWord)
    .map((word) => String(word.text || '').replace(/[^A-Za-z0-9.\-]/g, ''))
    .filter(Boolean)
    .map((token) => {
      if (lexicon && lexicon.has(token)) return token;
      const stripped = token.replace(/e$/, '');
      if (stripped.length >= 2 && /^[A-Z][A-Z0-9.\-]{0,5}$/.test(stripped)) return stripped;
      return token;
    })
    .filter((token) => /^[A-Z][A-Z0-9.\-]{0,6}$/.test(token));
  if (!candidates.length) return '';
  if (lexicon) {
    const known = candidates.filter((token) => lexicon.has(token));
    if (known.length) return known.sort((a, b) => b.length - a.length)[0];
  }
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * The row pitch, MEASURED on the frame.
 *
 * A row's prices share a top, so the price words' distinct tops are the
 * rows' tops, and the gaps between them are the pitch. The median is
 * the robust estimator: one wide gap (the jump to the detail card)
 * cannot move it.
 *
 * @param {object[]} words - the price words
 * @param {number} fallback - the layout's pitch, when there is nothing to measure
 * @returns {number}
 */
function measurePitch(words, fallback) {
  const tops = [];
  for (const word of words.slice().sort((a, b) => a.top - b.top)) {
    if (!tops.length || word.top - tops[tops.length - 1] > 3) {
      tops.push(word.top);
      continue;
    }
    tops[tops.length - 1] = word.top;
  }
  const gaps = [];
  for (let index = 1; index < tops.length; index += 1) {
    const gap = tops[index] - tops[index - 1];
    if (gap > 4) gaps.push(gap);
  }
  if (!gaps.length) return fallback;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median = gaps.length % 2
    ? gaps[middle]
    : (gaps[middle - 1] + gaps[middle]) / 2;
  return median >= 8 ? median : fallback;
}

/**
 * The most common value of a set.
 *
 * @param {Map<number, number>} counts
 * @returns {number|null}
 */
function modeOf(counts) {
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
 * Read the panel out of a frame.
 *
 * @param {string} framePath - the SOURCE frame (never a downscaled one)
 * @param {object} [options]
 * @param {string} [options.dateKey] - YYYYMMDD, for the era
 * @param {string} [options.mode] - 'portfolio' | 'watchlist'
 * @param {Set<string>} [options.lexicon] - the tickers that may be read
 * @returns {Promise<object>} { rows, groups, bands, mode, era, notes }
 */
async function readKomarPanel(framePath, options = {}) {
  const notes = [];
  const source = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: raw, info } = source;
  const era = panelEraForDate(options.dateKey);
  const region = panelRegionForFrame(options.dateKey, info);
  const lexicon = options.lexicon instanceof Set ? options.lexicon : null;
  const pitch = panelRowPitch(info);

  const toWords = (read) => (read.words || []).map((word) => ({
    height: (word.height || 0) / PANEL_SCALE,
    left: word.left / PANEL_SCALE,
    text: String(word.text || '').trim(),
    top: word.top / PANEL_SCALE,
    width: (word.width || 0) / PANEL_SCALE,
  })).filter((word) => word.text);

  // 1. THE WHOLE REGION, once: the header and the row bands.
  const whole = await readCell(raw, info, {
    bottom: region.top + region.height,
    left: region.left,
    right: region.left + region.width,
    top: region.top,
  }, { scale: PANEL_SCALE });
  const allWords = toWords(whole);
  if (!allWords.length) {
    return {
      bands: [], era: era.era, groups: [], mode: options.mode || '',
      notes: ['no words in the panel region'], rows: [],
    };
  }

  // The header is the cluster that carries the column labels. It is
  // found over ALL the words, because the chart's axis labels are to
  // the left of the panel and are not part of it.
  let headerIndex = -1;
  let columns = [];
  const headerClusters = clusterRows(allWords, pitch);
  for (let index = 0; index < headerClusters.length; index += 1) {
    const candidate = columnsFromHeader(headerClusters[index].words);
    if (candidate.length >= 2) {
      headerIndex = index;
      columns = candidate;
      break;
    }
  }
  if (headerIndex === -1) {
    return {
      bands: [], era: era.era, groups: [], mode: options.mode || '',
      notes: ['no header row in the panel'], rows: [],
    };
  }

  // The column boundaries are the midpoints between the labels. There
  // are TWO coordinate spaces here and they are not to be mixed: the
  // WORDS are region-relative (x from 0 at the region's left edge) and
  // the cell rectangles are in FRAME coordinates, because that is what
  // `readCell` crops.
  const columnBands = [];
  const frames = [];
  for (let index = 0; index < columns.length; index += 1) {
    const left = index === 0
      ? columns[index].left - CONTENT_MARGIN
      : Math.round((columns[index - 1].right + columns[index].left) / 2);
    const right = index === columns.length - 1
      ? region.width
      : Math.round((columns[index].right + columns[index + 1].left) / 2);
    columnBands.push({ field: columns[index].field, left, right });
    frames.push({
      field: columns[index].field,
      left: region.left + left,
      right: region.left + right,
    });
  }
  const symbolBand = columnBands.find((column) => column.field === 'symbol');
  const priceBands = columnBands.filter((column) => column.field !== 'symbol');

  // THE PANEL'S OWN CONTENT, and nothing else. The chart's price axis
  // is to the LEFT of the panel, and its labels are spaced about a
  // pitch apart -- so they bridge the gap between the table and the
  // detail card, and the gap test never sees it. The panel's content
  // starts at the header's first label, less the margin the row icons
  // need.
  const contentLeft = symbolBand ? symbolBand.left : 0;
  const panelWords = allWords.filter((word) => (
    word.left + (word.width || 0) / 2 >= contentLeft
  ));

  // THE ROWS ARE THE PRICE WORDS. The panel's numbers are one font and
  // one height, so they are the only words that cluster reliably: the
  // ICONS are taller than the text (a 16 px logo against a 10 px
  // ticker), and a tall word chains the row above it to the row below
  // it, so a cluster of everything merges two rows into one. The
  // prices do not move -- they are the same height in every row.
  //
  // The header's own labels are excluded: "Last" and "Chg%" sit in the
  // price columns, and a header read as a row is a row with no symbol.
  const headerBottom = headerClusters[headerIndex].bottom;
  const priceWords = panelWords.filter((word) => (
    word.top > headerBottom
    && priceBands.some((band) => (
      word.left + (word.width || 0) / 2 >= band.left
      && word.left + (word.width || 0) / 2 <= band.right
    ))
  ));

  // THE PITCH IS MEASURED, NOT ASSUMED. The layout's fraction (0.0231
  // of the height) is right for the 2026 frame and wrong for the 2022
  // one, whose rows are 28 px apart at 1080 and not 25 -- and a pitch
  // that is too small merges two rows and a pitch that is too large
  // splits one. So the pitch is the MEDIAN of the gaps between the
  // rows' own tops, measured on this frame.
  const measuredPitch = measurePitch(priceWords, pitch);
  // THE ROWS ARE THE PANEL'S WORDS, CLUSTERED. A band is a row.
  //
  // The bands are the whole panel's words clustered by their vertical
  // gap, and each band carries its own symbol words, its own numbers
  // and its own position -- which is what the reader needs, and what
  // the price words alone do not give (the symbols and the prices are
  // read at slightly different tops, so a price cluster and a symbol
  // word do not always land in the same band).
  //
  // The gap threshold is TIGHTER than the row's own words need,
  // because the ICONS are taller than the text: a 16 px logo against
  // a 10 px ticker leaves a gap of 9 px to the next row, and the
  // default threshold (half a pitch) swallows it and chains two rows
  // into one.
  const clusters = clusterRows(panelWords, measuredPitch * 0.7)
    .filter((cluster) => cluster.top > headerBottom);

  // THE TABLE'S ROWS ARE CONTIGUOUS, and the detail card under it is
  // not: the card's own numbers sit in the price columns, a long way
  // below the table's last row.
  const rowBands = [];
  let previousBottom = null;
  for (const cluster of clusters) {
    if (previousBottom !== null && (cluster.top - previousBottom) > measuredPitch * 1.6) break;
    previousBottom = cluster.bottom;
    rowBands.push(cluster);
  }

  // WHERE THE ICON COLUMN IS. The icon sits in the same place in every
  // row, so it is the MODE of the rows' leftmost symbol word -- and
  // the rows whose leftmost word is the symbol itself (a row with no
  // icon) are outliers.
  const bandSymbols = rowBands.map((band) => (
    symbolBand ? wordsInBand(band.words, symbolBand) : []
  ));
  const iconLefts = [];
  for (const words of bandSymbols) {
    if (!words.length) continue;
    const leftmost = words.reduce((best, word) => (word.left < best.left ? word : best), words[0]);
    iconLefts.push(leftmost.left);
  }
  const iconCounts = new Map();
  for (const left of iconLefts) iconCounts.set(Math.round(left), (iconCounts.get(Math.round(left)) || 0) + 1);
  const iconLeft = modeOf(iconCounts);

  const rows = [];
  const bands = [];
  const groups = [];
  let group = '';
  for (let index = 0; index < rowBands.length; index += 1) {
    const cluster = rowBands[index];
    const words = bandSymbols[index];
    // The row's NUMBERS: the price columns are what make a row a row.
    const numbers = priceBands
      .flatMap((band) => wordsInBand(cluster.words, band))
      .filter((word) => looksNumeric(word.text));
    const symbolText = words.map((word) => word.text).join(' ').trim();

    // A GROUP HEADER is a row with NO NUMBERS -- and the author's own
    // theme names (MEDICAL, DRONES, OIL / GAS / COAL) are not an
    // enumerable set, so a list of them cannot be the rule. A row
    // whose numbers could not be read is still a POSITION when the
    // lexicon knows its symbol.
    const knownSymbol = lexicon
      ? symbolText.split(/\s+/).filter(Boolean).some((token) => lexicon.has(token))
      : false;
    if (!numbers.length && !knownSymbol) {
      if (symbolText) {
        group = symbolText;
        groups.push({ group, row_index: rows.length });
      }
      bands.push({ kind: 'group', numbers: [], symbol_text: symbolText, top: cluster.top });
      continue;
    }

    // 2. EACH CELL, on its own -- and the SYMBOL COLUMN WITH THE ICON
    //    PAINTED OUT, so the icon is never in the picture.
    const icon = words.reduce(
      (best, word) => (best === null || word.left < best.left ? word : best),
      null,
    );
    const isIcon = icon !== null
      && iconLeft !== null
      && Math.abs(icon.left - iconLeft) <= ICON_TOLERANCE
      && words.length > 1;
    const masked = isIcon
      ? whitenBox(raw, info, {
        bottom: region.top + icon.top + (icon.height || 0) + 2,
        left: region.left + icon.left - 1,
        right: region.left + icon.left + (icon.width || 0) + 1,
        top: region.top + icon.top - 2,
      })
      : raw;

    const cells = {};
    for (const column of frames) {
      const read = await readCell(masked, info, {
        bottom: Math.round(region.top + cluster.bottom),
        left: Math.round(column.left),
        right: Math.round(column.right),
        top: Math.round(region.top + cluster.top),
      }, { scale: PANEL_SCALE });
      cells[column.field] = (read.words || [])
        .map((word) => String(word.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    }

    const symbolCell = cells.symbol || '';
    // The symbol comes from the WHOLE-REGION words (the icon is a word
    // of its own there), and the cell read is the fallback.
    const symbol = symbolFromWords(words, lexicon, isIcon ? icon : null)
      || symbolFromWords([{ text: symbolCell }], lexicon);
    bands.push({
      kind: 'row',
      numbers: numbers.map((word) => word.text),
      symbol_text: symbolCell,
      top: cluster.top,
    });
    if (!symbol) continue;

    const y = region.top + cluster.top;
    let chgPct = parseNumber(cells.chg_pct);
    if (chgPct !== null && !/[-−]/.test(cells.chg_pct)) {
      const last = frames[frames.length - 1];
      const sign = signFromCellFill(raw, info, {
        bottom: Math.round(region.top + cluster.bottom),
        left: Math.round(last.left),
        right: Math.round(last.right),
        top: Math.round(region.top + cluster.top),
      });
      if (sign < 0 && chgPct > 0) chgPct = -chgPct;
      if (sign > 0 && chgPct < 0) chgPct = -chgPct;
    }

    rows.push({
      chg: parseNumber(cells.chg),
      chg_pct: chgPct,
      group,
      last: parseNumber(cells.last),
      occluded: isOccluded(y, info),
      symbol,
    });
  }

  if (!rows.length) notes.push('the panel read no rows');
  return {
    bands,
    era: era.era,
    groups: groups.map((entry) => ({ group: entry.group, row_index: 0 })),
    mode: options.mode || '',
    notes,
    rows,
  };
}

module.exports = {
  HEADER_COLUMNS,
  PANEL_SCALE,
  cellColour,
  clusterRows,
  columnsFromHeader,
  looksNumeric,
  parseNumber,
  readKomarPanel,
  signFromFill,
  symbolFromWords,
  whitenBox,
};
