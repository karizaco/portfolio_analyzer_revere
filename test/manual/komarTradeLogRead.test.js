'use strict';

// The Komar trade log: the FULL read of the sheet.
//
// This suite is MANUAL -- it is not part of `npm test`. It runs a
// Tesseract pass over every cell of the 2048x1715 sheet (measured: 20
// seconds), which is too slow for the default suite.
//
//   node --test test/manual/komarTradeLogRead.test.js
//
// WHAT IT PINS
//
// The sheet's own content: 32 trades, the tickers in the sheet's own
// order, and the arithmetic that ties the rows together (W/L % is the
// return on the average price, so a row can be checked against
// itself). The VALUES are reported rather than asserted one by one --
// they are the corpus's ground truth, and a change to them is a change
// to what the sheet says, which is worth reading rather than pinning.
//
// The fixture is the pinned image under test/fixtures/komar_tradelog/,
// so this suite needs no corpus.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { closeWorker } = require('../../src/table/tableReader');
const { readTradeLogImage } = require('../../src/komar/tradeLogLayout');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'komar_tradelog', 'trade_log_sheet.png');

/** The tickers, in the sheet's own order (read off the pixels). */
const TICKERS = [
  'QS', 'UMAC', 'ONDS', 'GOGO', 'CDTX', 'PCT', 'CRCL', 'RDW',
  'AVAV', 'JMIA', 'GDS', 'RGTI', 'VNET', 'PL', 'IREN', 'IREN',
  'ARQQ', 'CIFR', 'CRCL', 'PL', 'LEU', 'SOUN', 'SOUN', 'AIRO',
  'GRYP', 'AAOI', 'GRYP', 'UMAC', 'CRML', 'BMNR', 'QSI', 'PDYN',
];

test('the whole sheet reads as 32 trades', async (t) => {
  const result = await readTradeLogImage(FIXTURE);
  t.after(async () => {
    await closeWorker();
  });

  assert.match(result.title, /trade\s*log/i, 'the title band reads "Trade Log"');
  assert.equal(result.rows.length, TICKERS.length, 'one row per trade');
  assert.deepEqual(result.rows.map((row) => row.ticker), TICKERS);
  assert.deepEqual(result.notes, [], 'nothing was skipped or unmatched');

  for (const row of result.rows) {
    assert.ok(row.date_opened, `${row.ticker} has an entry date`);
    assert.match(row.date_opened, /^202507\d\d$/, `${row.ticker}'s entry date is in July 2025`);
    assert.ok(row.date_closed, `${row.ticker} has a close date`);
    assert.ok(
      ['Breakout short-term', 'Gap Up'].includes(row.entry_type),
      `${row.ticker}'s entry type is one of the sheet's two: ${row.entry_type}`
    );
    assert.ok(['Manual', 'Stop loss', 'Break-even'].includes(row.exit_type),
      `${row.ticker}'s exit type is one of the sheet's three: ${row.exit_type}`);
    assert.equal(row.mmts_opening, 'Green', `${row.ticker}'s MMTS opening verdict`);
    assert.equal(row.mmts_close, 'Green', `${row.ticker}'s MMTS close verdict`);
    assert.ok(row.review, `${row.ticker} has a trade grade`);
  }

  // The sheet's own arithmetic: W/L % is the return on the average
  // price, so the rows check against themselves. One row's own numbers
  // disagree (its avg close lost a digit) and one row's W/L could not
  // be read and was derived from the prices.
  const flagged = result.rows.filter((row) => row.reading_check);
  const derived = result.rows.filter((row) => row.derived_fields);
  assert.equal(flagged.length, 1, 'exactly one row disagrees with itself');
  assert.equal(flagged[0].ticker, 'GOGO');
  assert.equal(derived.length, 1, 'exactly one row had its W/L derived');
  assert.equal(derived[0].ticker, 'PDYN');
  assert.equal(derived[0].wl_pct, -11.33, 'and the derived W/L is the sheet\'s own -11,33 %');

  // REPORTED, not asserted: the readings, so a change in what the sheet
  // says is visible in the test output.
  console.log('date_opened | ticker | entry | avg_open | avg_close | wl% | wl R | rating | grade');
  for (const row of result.rows) {
    console.log([
      row.date_opened,
      row.ticker,
      row.entry_type,
      row.avg_open_price,
      row.avg_close_price,
      row.wl_pct,
      row.wl_r,
      row.initial_rating === null ? '' : row.initial_rating,
      row.review,
    ].join(' | '));
  }
  console.log(
    `trades=${result.rows.length} tickers=${new Set(result.rows.map((r) => r.ticker)).size}`
    + ` flagged=${flagged.length} derived=${derived.length}`
  );
});
