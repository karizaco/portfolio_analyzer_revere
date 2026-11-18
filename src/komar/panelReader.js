'use strict';

/**
 * Read the Komar PANEL out of a frame.
 *
 * WHAT IT READS
 *
 * The on-screen table at the right edge of a session: the holdings (or
 * the watchlist), their last price, their change, and the groups they
 * sit in -- `CLOSED` for the exited names, the theme names in era C.
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
 *    of them as letters: the POWL row reads "VPOWLE". So the symbol
 *    is the token that LOOKS like a ticker -- the longest run of
 *    capitals, and, where the lexicon knows it, the one it knows.
 */

const sharp = require('sharp');

const { readCell } = require('../table/tableReader');
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

/** The header labels, and the column each one names. */
const HEADER_COLUMNS = [
  { field: 'symbol', label: 'symbol' },
  { field: 'last', label: 'last' },
  { field: 'chg', label: 'chg' },
  { field: 'chg_pct', label: 'chg%' },
];

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
 * Read the panel out of a frame.
 *
 * @param {string} framePath - the SOURCE frame (never a downscaled one)
 * @param {object} [options]
 * @param {string} [options.dateKey] - YYYYMMDD, for the era
 * @param {string} [options.mode] - 'portfolio' | 'watchlist'
 * @param {Set<string>} [options.lexicon] - the tickers that may be read
 * @returns {Promise<object>} { rows, groups, mode, era, notes }
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
  const clusters = clusterRows(toWords(whole), pitch);
  if (!clusters.length) {
    return { era, groups: [], mode: options.mode || '', notes: ['no words in the panel region'], rows: [] };
  }

  // The header is the cluster that carries the column labels.
  let headerIndex = -1;
  let columns = [];
  for (let index = 0; index < clusters.length; index += 1) {
    const candidate = columnsFromHeader(clusters[index].words);
    if (candidate.length >= 2) {
      headerIndex = index;
      columns = candidate;
      break;
    }
  }
  if (headerIndex === -1) {
    return { era, groups: [], mode: options.mode || '', notes: ['no header row in the panel'], rows: [] };
  }

  // The column boundaries are the midpoints between the labels.
  const boundaries = [];
  for (let index = 0; index < columns.length; index += 1) {
    const left = index === 0
      ? columns[index].left - 14
      : Math.round((columns[index - 1].right + columns[index].left) / 2);
    const right = index === columns.length - 1
      ? region.width
      : Math.round((columns[index].right + columns[index + 1].left) / 2);
    boundaries.push({
      field: columns[index].field,
      left: region.left + left,
      right: region.left + right,
    });
  }

  // The data rows are the clusters below the header, up to the first
  // GAP: the table's rows are contiguous and the detail card under it
  // is not.
  const rowBands = [];
  let previousBottom = null;
  for (let index = headerIndex + 1; index < clusters.length; index += 1) {
    const cluster = clusters[index];
    if (previousBottom !== null && (cluster.top - previousBottom) > pitch * 1.6) break;
    previousBottom = cluster.bottom;
    rowBands.push(cluster);
  }

  // 2. EACH CELL, on its own.
  const rows = [];
  const groups = [];
  let group = '';
  for (const band of rowBands) {
    const cells = {};
    for (const column of boundaries) {
      const read = await readCell(raw, info, {
        bottom: Math.round(region.top + band.bottom),
        left: Math.round(column.left),
        right: Math.round(column.right),
        top: Math.round(region.top + band.top),
      }, { scale: PANEL_SCALE });
      cells[column.field] = (read.words || [])
        .map((word) => String(word.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    }

    const symbolCell = cells.symbol || '';
    const line = Object.values(cells).filter(Boolean).join(' ').trim();

    if (isGroupHeader(line, era) || isGroupHeader(symbolCell, era)) {
      group = symbolCell || line;
      groups.push({ group, row_index: rows.length });
      continue;
    }

    const tokens = symbolCell.split(/\s+/).filter(Boolean);
    let symbol = '';
    const known = tokens.filter((token) => /^[A-Z][A-Z0-9.\-]{0,6}$/.test(token));
    if (lexicon) {
      const inLexicon = known.filter((token) => lexicon.has(token));
      if (inLexicon.length) symbol = inLexicon[0];
    }
    if (!symbol) symbol = known.sort((a, b) => b.length - a.length)[0] || '';
    if (!symbol || !/^[A-Z][A-Z0-9.\-]{0,6}$/.test(symbol)) continue;

    const y = region.top + band.top;
    let chgPct = parseNumber(cells.chg_pct);
    if (chgPct !== null && !/[-−]/.test(cells.chg_pct)) {
      const last = boundaries[boundaries.length - 1];
      const rect = {
        bottom: Math.round(region.top + band.bottom),
        left: Math.round(last.left),
        right: Math.round(last.right),
        top: Math.round(region.top + band.top),
      };
      const sign = signFromFill(cellColour(raw, info, rect));
      if (sign < 0 && chgPct > 0) chgPct = -chgPct;
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
  return { era, groups, mode: options.mode || '', notes, rows };
}

module.exports = {
  HEADER_COLUMNS,
  PANEL_SCALE,
  cellColour,
  clusterRows,
  columnsFromHeader,
  parseNumber,
  readKomarPanel,
  signFromFill,
};
