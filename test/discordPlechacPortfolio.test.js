'use strict';

// plechac's portfolio screenshots: the XTB positions table, read.
//
// The fixture is the EasyOCR read of his 2026-05-22 screenshot, frozen:
// the reader is measured against the pixels it will really see, and the
// test costs no OCR.
//
// The reader's own check is the table's arithmetic -- `value = units x
// price` and `P&L = units x (price - average cost)` -- because two of
// the table's three printed P&L columns are misread on this very
// screenshot.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  parseCellNumber,
  parseNumber,
  parsePercent,
  readPositionsTable,
} = require('../src/discord/plechac/portfolioReader');
const { marketTickerOf } = require('../src/discord/plechac/symbols');
const { normalizeTickerSymbol } = require('../src/analysis/priceProvider');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plechac_portfolio', 'xtb_positions_20260522.json');

function readFixture() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return readPositionsTable({ words: fixture.words });
}

test('the table is read whole, and the weights add up to its own total', () => {
  const read = readFixture();
  assert.deepEqual(read.unread, []);
  assert.equal(read.positions.length, 15);
  // The table's own "Celkem" row says 100 %, and the weights add up.
  assert.equal(read.coverage.table_total_pct, 100);
  assert.equal(read.coverage.weight_sum_pct, 100);
  assert.equal(read.coverage.complete, true);
});

test('the tickers are read, and the broker\'s spelling is translated', () => {
  const read = readFixture();
  const tickers = read.positions.map((position) => position.ticker);
  assert.deepEqual(tickers.slice(0, 5), ['NBIS', 'UBER', 'RHM XETRA', 'COIN', 'CRCL']);
  assert.ok(tickers.includes('GTLB'));
  // "RHM XETRA" is one instrument, and the record says so once.
  assert.equal(marketTickerOf('RHM XETRA'), 'RHM.DE');
  assert.equal(marketTickerOf('RHM.XETRA'), 'RHM.DE');
  assert.equal(marketTickerOf('IDUS.LSE'), 'IDUS.L');
  assert.equal(marketTickerOf('MC.PA'), 'MC.PA');
});

test('the P&L is DERIVED, and its sign comes from the prices', () => {
  const read = readFixture();
  const uber = read.positions.find((position) => position.ticker === 'UBER');
  // The broker's minus sign is not read: "-24,53 $" comes back as
  // "~24,53 $". The sign is taken from the prices instead.
  assert.ok(uber.pnl_pct < 0, 'the UBER P&L is negative');
  assert.ok(Math.abs(uber.pnl_pct + 3.97) < 0.05, `expected about -3.97 %, got ${uber.pnl_pct}`);
  const nbis = read.positions.find((position) => position.ticker === 'NBIS');
  assert.ok(Math.abs(nbis.pnl_pct - 238.19) < 0.05, `expected about +238.19 %, got ${nbis.pnl_pct}`);
});

test('a row that does not add up is FLAGGED, not published as sound', () => {
  const read = readFixture();
  const rhm = read.positions.find((position) => position.ticker === 'RHM XETRA');
  // The average-cost cell holds two numbers ("1 527,23 $ 21314.18"), so
  // the cost is not read at all and the row says so.
  assert.equal(rhm.avg_cost, null);
  assert.equal(rhm.reading_check, 'unverified');
  // And the rows that DO add up say so.
  const nbis = read.positions.find((position) => position.ticker === 'NBIS');
  assert.equal(nbis.reading_check, 'ok');
  assert.equal(nbis.avg_cost, 63.84);
  assert.equal(nbis.price, 215.9);
  assert.equal(nbis.weight_pct, 12.5);
});

test('the numbers are European', () => {
  assert.equal(parseNumber('63,84 $'), 63.84);
  assert.equal(parseNumber('1 527,23'), 1527.23);
  assert.equal(parseNumber('5 187,26'), 5187.26);
  assert.equal(parseNumber('0.4'), 0.4);
  assert.equal(parseNumber('2.4'), 2.4);
  assert.equal(parsePercent('+238,18%'), 238.18);
});

test('a cell with TWO numbers is ambiguous, and is not read', () => {
  assert.equal(parseCellNumber('420,76 $'), 420.76);
  assert.equal(parseCellNumber('1 527,23 $ 21314.18'), null);
});

test('the vendor\'s exchange suffix is translated where the symbol is FETCHED', () => {
  // The broker writes the exchange it trades on; Yahoo writes its own
  // name for it, and every one of these vendor forms 404s on Yahoo.
  assert.equal(normalizeTickerSymbol('RHM.XETRA'), 'RHM.DE');
  assert.equal(normalizeTickerSymbol('IDUS.LSE'), 'IDUS.L');
  assert.equal(normalizeTickerSymbol('IGLN.UK'), 'IGLN.L');
  // And the market's own spellings are left alone.
  assert.equal(normalizeTickerSymbol('MC.PA'), 'MC.PA');
  assert.equal(normalizeTickerSymbol('EVO.ST'), 'EVO.ST');
  assert.equal(normalizeTickerSymbol('ASML.AS'), 'ASML.AS');
  assert.equal(normalizeTickerSymbol('3CP.F'), '3CP.F');
  assert.equal(normalizeTickerSymbol('BRK-B'), 'BRK-B');
  assert.equal(normalizeTickerSymbol('005930.KS'), '005930.KS');
});
