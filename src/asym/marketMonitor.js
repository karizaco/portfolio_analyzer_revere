'use strict';

// Parse the AsymTrading Market Monitor Google Sheet.
//
// WHAT IT IS
//
// Every free Market Pulse post links a Google Sheet whose first tab is a
// daily breadth / momentum tape: for each date, and for each of the
// indices and the eleven GICS sectors, the author records
//
//   10NH   10-day new highs
//   10NL   10-day new lows
//   5U/5D  names up / down on a 5-day (or 3ADR) rule
//
// That is the same tape the written report summarises as "Breadth:
// Positive" and "Momentum: Mixed" -- so the sheet is the MEASUREMENT
// behind the reading, the way the TradeStation sector table is the
// measurement behind the sector picks.
//
// WHY THIS IS A PARSER AND NOT A DOWNLOAD TOOL
//
// The sheet is PUBLIC. Google's CSV export endpoint returns it without a
// login, so there is no auth and no session. The download is one GET.
// What is hard is the LAYOUT: three header rows, groups of four columns
// that start at different offsets, and a date that is "M/D" without a
// year. The year is the year of the POST the sheet is linked from, with
// a December/January wrap when the month runs backwards through the year.
//
// Measured on the 2026-10-28 sheet: 593 rows, two gids, the second empty.
// The first data row is 10/29 with Large Cap 10NH=392, 10NL=125.

const SECTOR_GROUPS = [
  { key: 'small_plus', label: 'Small +', start: 5 },
  { key: 'large_cap', label: 'Large Cap', start: 9 },
  { key: 'mid_cap', label: 'Mid Cap', start: 13 },
  { key: 'small_cap', label: 'Small Cap', start: 17 },
  { key: 'tech', label: 'Tech', start: 21, sector: 'Technology' },
  { key: 'consumer', label: 'Consumer', start: 25, sector: 'Consumer Cyclical' },
  { key: 'healthcare', label: 'Healthcare', start: 29, sector: 'Healthcare' },
  { key: 'financials', label: 'Financials', start: 33, sector: 'Financial Services' },
  { key: 'energy', label: 'Energy', start: 37, sector: 'Energy' },
  { key: 'industrials', label: 'Industrials', start: 41, sector: 'Industrials' },
  { key: 'materials', label: 'Materials', start: 45, sector: 'Basic Materials' },
  { key: 'defensive', label: 'Defensive', start: 49, sector: 'Consumer Defensive' },
  { key: 'real_estate', label: 'Real Estate', start: 53, sector: 'Real Estate' },
  { key: 'comms', label: 'Comms Svcs', start: 57, sector: 'Communication Services' },
  { key: 'utilities', label: 'Utilities', start: 61, sector: 'Utilities' },
];

const INDEX_COLUMNS = [
  { key: 'qqq', label: 'QQQ', index: 1 },
  { key: 'spy', label: 'SPY', index: 2 },
  { key: 'mdy', label: 'MDY', index: 3 },
  { key: 'iwm', label: 'IWM', index: 4 },
];

/**
 * Split one CSV line into cells, honouring quotes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  const text = String(line || '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * A number, or null when the cell is empty / not numeric.
 *
 * @param {string} value
 * @returns {number|null}
 */
function cellNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The calendar date of a "M/D" cell, given the year of the post.
 *
 * The sheet lists dates newest-first and only carries month and day. When
 * the month runs BACKWARDS across a year boundary (1/3 after 12/30), the
 * year decrements. That is the only honest reading of a December-to-
 * January wrap inside one sheet.
 *
 * @param {string} token
 * @param {number} yearHint
 * @param {{lastMonth?: number, year?: number}} state
 * @returns {{iso: string, compact: string}|null}
 */
function parseSheetDate(token, yearHint, state) {
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(String(token || '').trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = match[3]
    ? (Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]))
    : (state.year || yearHint);
  if (!match[3] && state.lastMonth && month > state.lastMonth + 1 && state.lastMonth <= 2 && month >= 11) {
    // Went from Jan/Feb back into Nov/Dec: previous year.
    year -= 1;
  }
  state.lastMonth = month;
  state.year = year;
  const iso = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  const compact = iso.replace(/-/g, '');
  return { iso, compact };
}

/**
 * One group's four cells.
 *
 * @param {string[]} cells
 * @param {number} start
 * @returns {{nh: number|null, nl: number|null, up: number|null, down: number|null}}
 */
function readGroup(cells, start) {
  return {
    nh: cellNumber(cells[start]),
    nl: cellNumber(cells[start + 1]),
    up: cellNumber(cells[start + 2]),
    down: cellNumber(cells[start + 3]),
  };
}

/**
 * Parse the Market Monitor CSV text.
 *
 * @param {string} csvText
 * @param {object} [options]
 * @param {string} [options.yearHint] - YYYY or YYYYMMDD from the post
 * @returns {{rows: Array<object>, groups: Array<object>, warnings: string[]}}
 */
function parseMarketMonitorCsv(csvText, options = {}) {
  const lines = String(csvText || '').split(/\r?\n/);
  const warnings = [];
  if (lines.length < 5) {
    return { rows: [], groups: SECTOR_GROUPS, warnings: ['too_few_lines'] };
  }

  const yearHintRaw = String(options.yearHint || new Date().getUTCFullYear());
  const yearHint = Number(yearHintRaw.slice(0, 4)) || new Date().getUTCFullYear();
  const state = { year: yearHint, lastMonth: 0 };
  const rows = [];

  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (!cells.length) continue;
    const date = parseSheetDate(cells[0], yearHint, state);
    if (!date) continue;

    const indices = {};
    for (const col of INDEX_COLUMNS) {
      indices[col.key] = String(cells[col.index] || '').trim();
    }

    const groups = {};
    for (const group of SECTOR_GROUPS) {
      groups[group.key] = readGroup(cells, group.start);
    }

    // The Small+ group is the market-wide breadth the report summarises.
    const small = groups.small_plus || {};
    const breadthNet = (small.nh == null || small.nl == null) ? null : small.nh - small.nl;
    const momentumNet = (small.up == null || small.down == null) ? null : small.up - small.down;

    rows.push({
      date: date.compact,
      date_iso: date.iso,
      indices,
      groups,
      breadth_nh: small.nh,
      breadth_nl: small.nl,
      breadth_net: breadthNet,
      momentum_up: small.up,
      momentum_down: small.down,
      momentum_net: momentumNet,
      source_row: i + 1,
    });
  }

  if (!rows.length) warnings.push('no_data_rows');
  return { rows, groups: SECTOR_GROUPS, warnings };
}

/**
 * The spreadsheet id inside a Google Sheets URL.
 *
 * @param {string} url
 * @returns {string}
 */
function spreadsheetIdFromUrl(url) {
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(String(url || ''));
  return match ? match[1] : '';
}

/**
 * The public CSV export URL of a sheet.
 *
 * @param {string} spreadsheetId
 * @param {string|number} [gid]
 * @returns {string}
 */
function spreadsheetCsvUrl(spreadsheetId, gid) {
  const id = String(spreadsheetId || '').trim();
  if (!id) return '';
  const base = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=csv';
  return gid == null || gid === '' ? base : base + '&gid=' + encodeURIComponent(String(gid));
}

module.exports = {
  INDEX_COLUMNS,
  SECTOR_GROUPS,
  cellNumber,
  parseMarketMonitorCsv,
  parseSheetDate,
  readGroup,
  splitCsvLine,
  spreadsheetCsvUrl,
  spreadsheetIdFromUrl,
};
