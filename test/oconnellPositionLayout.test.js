'use strict';

// The O'Connell position log: what its columns mean.
//
// Three rules carry the weight here, and each of them was found by
// reading a real capture against the sheet:
//
//   1. THE COLUMNS ARE MATCHED BY NAME, NOT BY INDEX. The sheet's
//      "Trade Length" column is a 2025 addition, so the 2024 and the
//      2026 logs do not have the same number of columns.
//
//   2. THE MATCH IS GLOBAL. The sheet's two SMA columns read as
//      "20D SMA" and "30D SMA" -- the second is a "50D SMA" whose 5 was
//      read as a 3 -- and a per-cell match gives BOTH of them the same
//      column.
//
//   3. THE SIGN COMES FROM THE COLOUR. Tesseract loses the leading
//      minus of "-4.41%" -- and loses it unevenly, reading "-32.09%"
//      correctly and "-4.41%" as "4.41%" with the confidence
//      collapsing to 35. A number that is sometimes negative and
//      sometimes positive, read from an image, must not be guessed.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EQUITY_COLUMNS,
  OPTION_COLUMNS,
  assignColumns,
  columnDistance,
  dateFromCell,
  levenshtein,
  lotKey,
  matchColumn,
  normaliseHeader,
  numberFromCell,
  parseCount,
  signFromInk,
} = require('../src/oconnell/positionLayout');

function cell(text, ink = { b: 0, g: 0, r: 0 }) {
  return { inkColour: ink, text };
}

test('a header is matched to its column', () => {
  assert.equal(matchColumn('Ticker', EQUITY_COLUMNS).field, 'ticker');
  assert.equal(matchColumn('Cost Basis', EQUITY_COLUMNS).field, 'cost_basis');
  assert.equal(matchColumn('Gain/Loss %', EQUITY_COLUMNS).field, 'gain_loss_pct');
  assert.equal(matchColumn('Trade Length', EQUITY_COLUMNS).field, 'trade_length_days');
  assert.equal(matchColumn('Underlying Change', OPTION_COLUMNS).field, 'underlying_change_pct');
  assert.equal(matchColumn('Beta', OPTION_COLUMNS).field, 'beta');
});

test('a header is matched even when the OCR garbled it', () => {
  // "Gain/Loss %" came back as "GainfLoss %" -- an l read as an f.
  assert.equal(matchColumn('GainfLoss %', EQUITY_COLUMNS).field, 'gain_loss_pct');
  // "Trade Length" came back as "Trade Length" and "Entry Date" as
  // "E ntry Date", which normalises to the same thing.
  assert.equal(matchColumn('E ntry Date', EQUITY_COLUMNS).field, 'entry_date');
});

test('a header that is one edit from two columns is ambiguous on its own', () => {
  // "30D SMA" is one edit from BOTH "20D SMA" and "50D SMA", so a
  // single-cell match cannot choose -- and pretending it can would be
  // how one column ends up read twice. The global assignment is what
  // resolves it, and that is the code path the reader uses.
  assert.equal(columnDistance('30D SMA', { names: ['20D SMA'] }), 1);
  assert.equal(columnDistance('30D SMA', { names: ['50D SMA'] }), 1);
});

test('the two SMA columns do not share a column', () => {
  const header = [
    { text: '20D SMA' }, { text: '30D SMA' },
  ];
  const assignment = assignColumns(header, EQUITY_COLUMNS);
  const fields = [...assignment.values()].map((column) => column.field).sort();
  assert.deepEqual(fields, ['sma20', 'sma50']);
});

test('a column is only ever used once', () => {
  const header = [
    { text: 'Ticker' }, { text: 'Ticker' }, { text: 'Price' },
  ];
  const assignment = assignColumns(header, EQUITY_COLUMNS);
  const fields = [...assignment.values()].map((column) => column.field);
  assert.equal(new Set(fields).size, fields.length);
});

test('a header is normalised before it is compared', () => {
  assert.equal(normaliseHeader('Gain/Loss %'), 'gainloss%');
  assert.equal(normaliseHeader('20D SMA'), '20dsma');
  assert.equal(normaliseHeader('  Trade Length '), 'tradelength');
});

test('the levenshtein distance is the plain one', () => {
  assert.equal(levenshtein('ticker', 'ticker'), 0);
  assert.equal(levenshtein('30dsma', '50dsma'), 1);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('the sign comes from the colour of the ink', () => {
  assert.equal(signFromInk({ b: 0, g: 0, r: 240 }), -1);
  assert.equal(signFromInk({ b: 0, g: 176, r: 0 }), 1);
  assert.equal(signFromInk({ b: 0, g: 0, r: 0 }), 0);
  assert.equal(signFromInk(null), 0);
});

test('a number is read from a cell', () => {
  assert.equal(numberFromCell(cell('$5.00')), 5);
  assert.equal(numberFromCell(cell('-4.41%')), -4.41);
  assert.equal(numberFromCell(cell('12/1/25')), null);
  assert.equal(numberFromCell(cell('')), null);
});

test('a number whose minus was lost takes its sign from the colour', () => {
  // The measured case: Tesseract reads "-4.41%" as "4.41%", and the
  // cell's ink is red.
  assert.equal(numberFromCell(cell('4.41%', { b: 0, g: 0, r: 240 })), -4.41);
  assert.equal(numberFromCell(cell('8.19%', { b: 0, g: 176, r: 0 })), 8.19);
  assert.equal(numberFromCell(cell('8.19%')), 8.19);
});

test('a date is read as YYYYMMDD', () => {
  assert.equal(dateFromCell(cell('12/1/25'), 2026), '20251201');
  assert.equal(dateFromCell(cell('1/15/26'), 2026), '20260115');
  assert.equal(dateFromCell(cell('11/12/26'), 2026), '20261112');
  assert.equal(dateFromCell(cell(''), 2026), '');
});

test('a date with a four-digit year is read as it stands', () => {
  assert.equal(dateFromCell(cell('12/1/2025'), 2026), '20251201');
});

test('a count of zero is a value', () => {
  // "0 Days" is a real trade length: the position was opened today.
  assert.equal(parseCount('0 Days'), 0);
  assert.equal(parseCount('346 Days'), 346);
  assert.equal(parseCount(''), null);
});

test('a lot key carries the lot and not the ticker', () => {
  const key = lotKey({
    contract: '',
    cost_basis: 5,
    entry_date: '20251201',
    instrument: 'equity',
    ticker: 'MSOS',
  });
  assert.equal(key, 'equity|MSOS||20251201|5');
  // The same ticker, bought twice, is two lots.
  const second = lotKey({
    contract: '',
    cost_basis: 9,
    entry_date: '20260301',
    instrument: 'equity',
    ticker: 'MSOS',
  });
  assert.notEqual(key, second);
});

test('an option contract is part of the lot key', () => {
  const key = lotKey({
    contract: '01/15/27 5 Call (BTO)',
    cost_basis: 0.99,
    entry_date: '20251223',
    instrument: 'option',
    ticker: 'MSOS',
  });
  assert.ok(key.includes('01/15/27 5 Call (BTO)'));
});
