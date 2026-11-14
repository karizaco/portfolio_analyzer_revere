'use strict';

/**
 * The O'Connell position log: what its columns MEAN.
 *
 * WHY THIS IS SEPARATE FROM THE TABLE READER
 *
 * `src/table/tableReader.js` knows how to find a grid in an image and
 * read its cells. It has no idea what a "STOP" is. This module holds
 * the source-specific knowledge: which tables the position log has, what
 * its columns are called, what a value in them means, and how a row
 * becomes a position.
 *
 * THE TWO TABLES
 *
 * The position log is two spreadsheets stacked in one image:
 *
 *   EQUITIES - SWING TRADES - USIC Account - Money Manager ($1MM+) Division
 *     Ticker | Change | Cost Basis | Price | 20D SMA | 50D SMA |
 *     Gain/Loss % | Size | STOP | RISK | R2 | Exits | Exit Price |
 *     Entry Date | Trade Length
 *
 *   OPTIONS - SWING TRADES - USIC Account - Money Manager ($1MM+) Division
 *     Ticker | Underlying Change | Options Change | Position | Cost Basis |
 *     Price | Gain/Loss % | Size | Beta | Delta | Setup | Exits |
 *     Exit Price | Entry Date | Trade Length
 *
 * "Trade Length" is a 2025 addition; the 2024 and early-2025 logs do
 * not have it. So the columns are matched BY NAME, not by index.
 *
 * A ROW IS A LOT, NOT A TICKER
 *
 * The same ticker appears on several rows with different cost basis and
 * entry date, and those are different lots. Measured on 20250910: MSOS is
 * on four rows of the equities table. The equity and the option on the
 * same ticker are also different positions, and the equity table and the
 * options table both carry MSOS on the same day.
 *
 * THE SIGN COMES FROM THE COLOUR
 *
 * Tesseract loses the leading minus of "-4.41%" -- and loses it
 * unevenly, reading "-32.09%" correctly and "-4.41%" as "4.41%" with the
 * confidence collapsing to 35. A number that is sometimes negative and
 * sometimes positive, read from an image, must not be guessed. The
 * cell's ink colour settles it: red is a loss, green is a gain, black
 * is neither.
 */

const { countStars, readCell, readRegionText } = require('../table/tableReader');

/**
 * The equities table's columns, in the order the sheet prints them.
 *
 * The `whitelist` is what the cell may contain, and it is not decoration.
 * A digit read as a CURRENCY SIGN is the measured failure: the 20250910
 * RISK cell reads "-£2.41%" when the truth is "-42.41%", because a "4"
 * and a "£" are the same shape with a stroke through them. A whitelist
 * of "0123456789.%+-" makes the "£" impossible.
 */
const EQUITY_COLUMNS = [
  { field: 'ticker', names: ['ticker'], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.-' },
  { field: 'change_pct', names: ['change'], whitelist: '0123456789.%+-' },
  { field: 'cost_basis', names: ['cost basis'], whitelist: '0123456789.$' },
  { field: 'price', names: ['price'], whitelist: '0123456789.$' },
  { field: 'sma20', names: ['20d sma'], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { field: 'sma50', names: ['50d sma'], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { field: 'gain_loss_pct', names: ['gain loss %', 'gainloss%'], whitelist: '0123456789.%+-' },
  { field: 'size_stars', names: ['size'] },
  { field: 'stop_price', names: ['stop'], whitelist: '0123456789.$' },
  { field: 'risk_pct', names: ['risk'], whitelist: '0123456789.%+-' },
  { field: 'r2_price', names: ['r2'], whitelist: '0123456789.$' },
  { field: 'exits', names: ['exits'], whitelist: '0123456789.$' },
  { field: 'exit_price', names: ['exit price'], whitelist: '0123456789.$' },
  { field: 'entry_date', names: ['entry date'], whitelist: '0123456789/' },
  { field: 'trade_length_days', names: ['trade length'], whitelist: '0123456789 Days' },
];

/** The options table's columns, in the order the sheet prints them. */
const OPTION_COLUMNS = [
  { field: 'ticker', names: ['ticker'], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.-' },
  { field: 'underlying_change_pct', names: ['underlying change'], whitelist: '0123456789.%+-' },
  { field: 'option_change_pct', names: ['options change'], whitelist: '0123456789.%+-' },
  { field: 'contract', names: ['position'], whitelist: '0123456789 ()CallPutABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { field: 'cost_basis', names: ['cost basis'], whitelist: '0123456789.$' },
  { field: 'price', names: ['price'], whitelist: '0123456789.$' },
  { field: 'gain_loss_pct', names: ['gain loss %', 'gainloss%'], whitelist: '0123456789.%+-' },
  { field: 'size_stars', names: ['size'] },
  { field: 'beta', names: ['beta'], whitelist: '0123456789.-' },
  { field: 'delta', names: ['delta'], whitelist: '0123456789.-' },
  { field: 'setup_label', names: ['setup'] },
  { field: 'exits', names: ['exits'], whitelist: '0123456789.$' },
  { field: 'exit_price', names: ['exit price'], whitelist: '0123456789.$' },
  { field: 'entry_date', names: ['entry date'], whitelist: '0123456789/' },
  { field: 'trade_length_days', names: ['trade length'], whitelist: '0123456789 Days' },
];

/**
 * The title bands of the two tables, as they are printed.
 *
 * The dash is optional because the OCR does not always keep it: the
 * 20261112 title band reads "EQUITIES SWING TRADES USIC Account Money
 * Manager", with the dash lost.
 */
const EQUITY_TITLE = /EQUITIES\b.*SWING\s*TRADES/i;
const OPTION_TITLE = /OPTIONS\b.*SWING\s*TRADES/i;

/**
 * A header name, reduced to something comparable.
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseHeader(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9%]/g, '');
}

/**
 * The Levenshtein distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current.push(Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost
      ));
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Which column a header cell is.
 *
 * The match is fuzzy because the header is OCR'd: the sheet's own
 * "50D SMA" comes back as "30D SMA" (a 5 read as a 3) and "Gain/Loss %"
 * as "GainfLoss %" (an l read as an f). A distance of two is accepted,
 * which is enough for both and not enough to confuse "STOP" with "Size".
 *
 * @param {string} headerText
 * @param {Array<object>} columns
 * @returns {object|null} the column, or null when nothing matches
 */
function matchColumn(headerText, columns) {
  const normalised = normaliseHeader(headerText);
  if (!normalised) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    for (const name of column.names) {
      const distance = levenshtein(normalised, normaliseHeader(name));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = column;
      }
    }
  }
  if (!best) return null;
  const limit = Math.max(2, Math.round(normaliseHeader(best.names[0]).length * 0.34));
  return bestDistance <= limit ? best : null;
}

/**
 * The distance from a header cell to a column.
 *
 * @param {string} headerText
 * @param {object} column
 * @returns {number}
 */
function columnDistance(headerText, column) {
  const normalised = normaliseHeader(headerText);
  let best = Infinity;
  for (const name of column.names) {
    const distance = levenshtein(normalised, normaliseHeader(name));
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Match every header cell to a DIFFERENT column.
 *
 * The match is global, not per cell, and that matters. The sheet's two
 * SMA columns read as "20D SMA" and "30D SMA" -- the second is a "50D
 * SMA" whose 5 was read as a 3 -- and a per-cell match gives BOTH of
 * them the same column, because both are one edit from "50D SMA" and
 * neither is an exact match for "20D SMA" once the first has taken it.
 *
 * So the cells are matched greedily from the closest pair outwards, and
 * a column is only ever used once.
 *
 * The result is keyed by the header cell's INDEX and not by its
 * coordinates, because the header band and the data bands do not have
 * the same number of cells: the header carries the sidebar's labels and
 * the rows carry the sidebar's rules, and only the main table's cells
 * line up. The main table's cells are the FIRST ones in both bands --
 * the two bands share every rule up to the sidebar's edge -- so the
 * index is the alignment.
 *
 * @param {Array<object>} headerCells
 * @param {Array<object>} columns
 * @returns {Map<number, object>} the header cell's index to its column
 */
function assignColumns(headerCells, columns) {
  const candidates = [];
  headerCells.forEach((cell, index) => {
    if (!cell.text) return;
    for (const column of columns) {
      candidates.push({ column, distance: columnDistance(cell.text, column), index });
    }
  });
  candidates.sort((a, b) => a.distance - b.distance);

  const assignment = new Map();
  const takenColumns = new Set();
  for (const candidate of candidates) {
    if (assignment.has(candidate.index)) continue;
    if (takenColumns.has(candidate.column)) continue;
    const limit = Math.max(
      2,
      Math.round(normaliseHeader(candidate.column.names[0]).length * 0.34)
    );
    if (candidate.distance > limit) continue;
    assignment.set(candidate.index, candidate.column);
    takenColumns.add(candidate.column);
  }
  return assignment;
}

/**
 * The sign of a cell, from the colour of its ink.
 *
 * @param {{r: number, g: number, b: number}} ink
 * @returns {number} -1, 0 or 1
 */
function signFromInk(ink) {
  if (!ink) return 0;
  const { b, g, r } = ink;
  if (r > g + 30 && r > b + 30) return -1;
  if (g > r + 30 && g > b + 30) return 1;
  return 0;
}

/**
 * A number, from a cell.
 *
 * A DATE IS NOT A NUMBER. The sheet's "Entry Date" column prints
 * "12/1/25", and stripping the non-numeric characters out of that
 * leaves "12125" -- which is a number, and a wrong one. So a cell whose
 * text carries a slash is refused.
 *
 * @param {object} cell
 * @returns {number|null}
 */
function numberFromCell(cell) {
  if (!cell || !cell.text) return null;
  const text = String(cell.text);
  if (text.includes('/')) return null;
  const cleaned = text.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  const sign = signFromInk(cell.inkColour);
  if (sign < 0 && value > 0) return -value;
  return value;
}

/**
 * A date, from a cell.
 *
 * The sheet prints US dates -- "12/1/25" is 1 December 2025 -- and the
 * two-digit year means the century it belongs to. The corpus runs from
 * 2024, so a year below 30 is this century and one above is the last.
 *
 * @param {object} cell
 * @param {number} [sourceYear]
 * @returns {string} YYYYMMDD, or ''
 */
function dateFromCell(cell, sourceYear) {
  if (!cell || !cell.text) return '';
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(cell.text);
  if (!match) return '';
  const first = Number(match[1]);
  const second = Number(match[2]);
  const rawYear = Number(match[3]);
  let year;
  if (rawYear >= 100) {
    year = rawYear;
  } else {
    const pivot = Number(String(sourceYear || 2026).slice(0, 2)) * 100;
    year = pivot + rawYear;
    if (year > Number(sourceYear || 2026) + 5) year -= 100;
  }
  const month = first > 12 ? second : first;
  const day = first > 12 ? first : second;
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * The size stars of a cell.
 *
 * The stars are not OCR'd -- a five-pointed star is not a character in
 * any training set, and "★★" reads as "w WK" -- so they are counted as
 * connected components.
 *
 * @param {Buffer} raw
 * @param {object} info
 * @param {object} cell
 * @returns {number}
 */
function sizeFromCell(raw, info, cell) {
  if (!raw || !info || !cell) return 0;
  return countStars(raw, info, {
    bottom: cell.bottom - 2,
    left: cell.left + 2,
    right: cell.right - 2,
    top: cell.top + 2,
  });
}

/**
 * A count out of a cell, where zero is a value.
 *
 * "0 Days" is a real trade length -- the position was opened today --
 * and a naive `parseInt(...) || null` turns it into a missing value.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseCount(text) {
  const digits = String(text || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * The identity of a lot.
 *
 * The key carries the lot and not the ticker, because the same ticker is
 * on several rows. It is a string rather than the columns themselves
 * because a NULL cost basis never equals another NULL cost basis in a
 * UNIQUE constraint.
 *
 * @param {object} position
 * @returns {string}
 */
function lotKey(position) {
  return [
    position.instrument,
    position.ticker,
    position.contract,
    position.entry_date,
    position.cost_basis === null || position.cost_basis === undefined ? '' : position.cost_basis,
  ].join('|');
}

/**
 * Read the rows of one table out of the grid.
 *
 * @param {object} options
 * @param {Array<object>} options.headerCells - the header band's cells
 * @param {Array<object>} options.rowBands - the data bands
 * @param {Array<object>} options.columns - the column definitions
 * @param {string} options.instrument - 'equity' | 'option'
 * @param {Buffer} options.raw
 * @param {object} options.info
 * @param {number} [options.sourceYear]
 * @returns {Promise<object[]>} the positions
 */
async function readTableRows(options) {
  const { columns, headerCells, info, instrument, raw, rowBands, sourceYear } = options;

  const mapping = assignColumns(headerCells, columns);
  const whitelistByField = new Map();
  for (const column of columns) {
    if (column.whitelist) whitelistByField.set(column.field, column.whitelist);
  }

  const positions = [];
  for (const band of rowBands) {
    // The header band and the data bands do not have the same CELLS: the
    // header carries one extra one-pixel rule, so "Entry Date" ends at
    // 1655 there and at 1656 in the rows. The columns LINE UP, though --
    // every column starts at the same x in both -- so the alignment is by
    // LEFT EDGE.
    const byLeftEdge = new Map();
    for (const cell of band.cells) byLeftEdge.set(cell.left, cell);

    const values = {};
    for (const [index, column] of mapping) {
      const headerCell = headerCells[index];
      if (!headerCell) continue;
      const cell = byLeftEdge.get(headerCell.left);
      if (!cell) continue;
      values[column.field] = cell;
    }

    // THE REPAIR PASS
    //
    // A cell whose text carries a character its column cannot hold was
    // misread: the 20250910 RISK cell reads "-£2.41%" where the truth is
    // "-42.41%", because a "4" and a "£" are the same shape with a
    // stroke through them. Such a cell is read AGAIN, this time with a
    // whitelist that makes the mistake impossible.
    //
    // It is a repair and not a replacement: the second reading is used
    // only when the first one carries a character the column cannot
    // hold, so a cell that read cleanly is never touched.
    for (const [field, whitelist] of whitelistByField) {
      const cell = values[field];
      if (!cell || !cell.text) continue;
      const allowed = new Set(whitelist.split(''));
      const stray = cell.text.replace(/\s/g, '').split('')
        .filter((character) => !allowed.has(character));
      if (!stray.length) continue;
      const repaired = await readCell(raw, info, {
        bottom: cell.bottom,
        left: cell.left,
        right: cell.right,
        top: cell.top,
      }, { whitelist });
      if (repaired.text) {
        cell.text = repaired.text;
        cell.confidence = repaired.confidence;
      }
    }

    const tickerCell = values.ticker;
    const ticker = tickerCell ? String(tickerCell.text).replace(/[^A-Za-z0-9.\-]/g, '').toUpperCase() : '';
    if (!ticker) continue;

    const position = {
      beta: values.beta ? numberFromCell(values.beta) : null,
      change_pct: values.change_pct ? numberFromCell(values.change_pct) : null,
      contract: values.contract ? String(values.contract.text).replace(/\s+/g, ' ').trim() : '',
      cost_basis: values.cost_basis ? numberFromCell(values.cost_basis) : null,
      delta: values.delta ? numberFromCell(values.delta) : null,
      entry_date: dateFromCell(values.entry_date, sourceYear),
      exit_price: values.exit_price ? numberFromCell(values.exit_price) : null,
      exits: values.exits ? String(values.exits.text).trim() : '',
      gain_loss_pct: values.gain_loss_pct ? numberFromCell(values.gain_loss_pct) : null,
      instrument,
      option_change_pct: values.option_change_pct ? numberFromCell(values.option_change_pct) : null,
      price: values.price ? numberFromCell(values.price) : null,
      r2_price: values.r2_price ? numberFromCell(values.r2_price) : null,
      risk_pct: values.risk_pct ? numberFromCell(values.risk_pct) : null,
      setup_label: values.setup_label ? String(values.setup_label.text).trim() : '',
      size_stars: values.size_stars ? sizeFromCell(raw, info, values.size_stars) : 0,
      sma20: values.sma20 ? String(values.sma20.text).trim().toUpperCase() : '',
      sma50: values.sma50 ? String(values.sma50.text).trim().toUpperCase() : '',
      stop_price: values.stop_price ? numberFromCell(values.stop_price) : null,
      ticker,
      trade_length_days: values.trade_length_days
        ? parseCount(values.trade_length_days.text)
        : null,
      underlying_change_pct: values.underlying_change_pct
        ? numberFromCell(values.underlying_change_pct)
        : null,
    };
    position.lot_key = lotKey(position);

    // A row is a position only if it carries NUMBERS. The band below the
    // last row holds the position-colour legend -- "Bullish", "Neutral",
    // "Bearish" -- and "Bearish" reads as a ticker.
    const hasNumber = position.cost_basis !== null || position.price !== null
      || position.gain_loss_pct !== null || position.entry_date !== '';
    if (!hasNumber) continue;

    positions.push(position);
  }

  return positions;
}

/**
 * The snapshot: the numbers the position log reports about ITSELF.
 *
 * These live beside the tables, in the sidebar and the footer, and they
 * are worth having -- the cash split, the loss limits, the trend model
 * and the running win rates are a daily read on how the portfolio is
 * being run.
 *
 * The four in the sidebar ("CASH", "INVESTED", "MAX LOSS STOCK",
 * "MAX LOSS OPTIONS") are read out of the grid, because the sidebar's
 * cells are grid cells like any other.
 *
 * The two in the footer ("% Winning Stock Trades", "% Winning Options
 * Trades") and the trend model are NOT, because the footer's grid is
 * not the arrangement of its widgets -- the win-rate table is two rows
 * of two columns, and the trend model is a label above a value, and
 * neither is a cell of the footer's grid. They are read as blocks.
 */
const SIDEBAR_LABELS = {
  'CASH': 'cash_pct',
  'INVESTED': 'invested_pct',
  'MAX LOSS STOCK': 'max_loss_stock_pct',
  'MAX LOSS OPTIONS': 'max_loss_options_pct',
};

/**
 * The sidebar numbers, out of the grid.
 *
 * @param {object} grid
 * @returns {object} the snapshot fields that were found
 */
function readSidebarSnapshot(grid) {
  const snapshot = {};
  for (const band of grid.bands || []) {
    const cells = band.cells.filter((cell) => cell.text);
    for (let index = 0; index < cells.length; index += 1) {
      const label = String(cells[index].text).trim().toUpperCase();
      const field = SIDEBAR_LABELS[label];
      if (!field) continue;
      for (let next = index + 1; next < cells.length; next += 1) {
        const value = numberFromCell(cells[next]);
        if (value === null) continue;
        snapshot[field] = value;
        break;
      }
    }
  }
  return snapshot;
}

/**
 * The trend model and the win rates, read as blocks.
 *
 * The two regions are found by their own rules rather than by fixed
 * coordinates, because the image is a screenshot of a spreadsheet whose
 * width changes with the window it was captured in.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {object} grid
 * @returns {Promise<object>} the snapshot fields that were found
 */
async function readFooterSnapshot(raw, info, grid) {
  const snapshot = {};
  const { findHorizontalRules } = require('../table/tableGrid');

  // The win-rate table is at the bottom LEFT. Its last rule is the
  // table's bottom edge, and the band above it holds the values.
  const bottomLeftRules = findHorizontalRules(raw, info, {
    xEnd: Math.floor(info.width * 0.4),
    xStart: 0,
  });
  if (bottomLeftRules.length >= 2) {
    const last = bottomLeftRules[bottomLeftRules.length - 1];
    let above = bottomLeftRules[bottomLeftRules.length - 2];
    while (above >= last - 2 && bottomLeftRules.length > 2) {
      bottomLeftRules.pop();
      above = bottomLeftRules[bottomLeftRules.length - 2];
    }
    const values = await readRegionText(raw, info, {
      height: Math.max(1, last - above - 1),
      left: 0,
      top: above + 1,
      width: Math.floor(info.width * 0.4),
    });
    const percentages = (values.match(/(\d+(?:\.\d+)?)\s*%/g) || [])
      .map((text) => Number.parseFloat(text));
    if (percentages.length >= 1) snapshot.win_rate_stock_pct = percentages[0];
    if (percentages.length >= 2) snapshot.win_rate_options_pct = percentages[1];
  }

  // The trend model is at the bottom RIGHT, above its value.
  const sidebarRules = findHorizontalRules(raw, info, {
    xEnd: info.width - 1,
    xStart: Math.floor(info.width * 0.78),
  });
  if (sidebarRules.length >= 2) {
    const last = sidebarRules[sidebarRules.length - 1];
    const start = Math.max(0, sidebarRules[Math.max(0, sidebarRules.length - 3)] || 0);
    const text = await readRegionText(raw, info, {
      height: Math.max(1, info.height - start),
      left: Math.floor(info.width * 0.78),
      top: start,
      width: Math.ceil(info.width * 0.22),
    });
    const trend = /trend\s*\S{0,5}\s*[Mm]odel\D{0,15}(-?\d+)/i.exec(text);
    if (trend) snapshot.trend_model = Number.parseInt(trend[1], 10);
  }

  return snapshot;
}

module.exports = {
  EQUITY_COLUMNS,
  EQUITY_TITLE,
  OPTION_COLUMNS,
  OPTION_TITLE,
  SIDEBAR_LABELS,
  assignColumns,
  columnDistance,
  dateFromCell,
  levenshtein,
  lotKey,
  matchColumn,
  normaliseHeader,
  numberFromCell,
  parseCount,
  readFooterSnapshot,
  readSidebarSnapshot,
  readTableRows,
  signFromInk,
  sizeFromCell,
};
