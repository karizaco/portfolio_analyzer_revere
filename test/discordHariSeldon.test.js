'use strict';

// HariSeldon's trade journal, read out of one of his posts.
//
// Every rule here was measured on his corpus -- 3,000 messages in the
// `verified-traders` channel of the /r/RealDayTrading server, 2024-12
// .. 2026-11 -- and every rule here exists because its absence produced
// a WRONG price or a WRONG holding somewhere in it.

const assert = require('node:assert/strict');
const test = require('node:test');

const { parsePost } = require('../src/discord/hariseldon/parser');
const { marketTickerOf } = require('../src/discord/plechac/symbols');

function read(content) {
  return parsePost(content, { known: new Set(['ETSY', 'TSLA', 'NKE', 'WMT', 'MRNA']) });
}

test('an entry is an entry, with its price and its size', () => {
  const rows = read('Long $TSLA `438.60` - 1,000 Shares');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'open');
  assert.equal(rows[0].ticker, 'TSLA');
  assert.equal(rows[0].price, 438.6);
  assert.equal(rows[0].size_note, '1000 shares');
});

test('the PRICE is the first number after the ticker, and the size is not a price', () => {
  // The second number is the SIZE, and the third the strike.
  assert.equal(read('Long $TSLA `438.60` - 1,000 Shares')[0].price, 438.6);
  // The spread's PRICE is after the strikes, not one of them.
  assert.equal(read('Long $MSTR CDS $385/$400 - $5.25 - 10 Contracts')[0].price, 5.25);
  // And a number that is a size is never a price.
  assert.equal(read('Exit $TSLA with $10.96 profit per share (5K Shares)')[0].price, null);
  assert.equal(read('Exit $MRNA with $1.32 profit per contract (15)')[0].price, null);
});

test('a leading decimal point is a number', () => {
  // ".98 profit per share" is 0.98 and not 98 -- and 98 would be taken
  // for the PRICE of the exit.
  const row = read('Exit $NKE `36.52` with .98 profit per share')[0];
  assert.equal(row.price, 36.52);
  assert.equal(row.stated_result, 0.98);
});

test('a ticker is read with or without its dollar sign', () => {
  assert.equal(read('Exit $WMT at breakeven -')[0].ticker, 'WMT');
  // A bare ticker is only a ticker when the lexicon knows it.
  assert.equal(read('Exit ETSY partial at $55.05 for a $7.20 loss')[0].ticker, 'ETSY');
  assert.equal(read('Exit the position at $55.05')[0], undefined);
});

test('the futures carry Yahoo\'s symbol, not the broker\'s', () => {
  // "ES" on its own is Eversource Energy; the S&P future is ES=F.
  const row = read('Short /ES 6052.25 - 10 Contracts')[0];
  assert.equal(row.ticker, 'ES=F');
  assert.equal(row.kind, 'future');
  assert.equal(row.price, 6052.25);
});

test('an option is not an equity', () => {
  // A spread's price is the SPREAD's price and not the underlying's, so
  // an option action is not chained into a position episode.
  const spread = read('Short $SPY PDS $730/$720 for $3.08 - 10 Contract - expires Friday')[0];
  assert.equal(spread.kind, 'option');
  assert.equal(spread.ticker, 'SPY');
  // The SPREAD's price is the one after "for" -- the numbers before it
  // are the two strikes of the spread.
  assert.equal(spread.price, 3.08);
  const leg = read('I sold the $AMD $500 Calls (again) this time for $8.55 - expiring tomorrow')[0];
  assert.equal(leg.kind, 'option');
  assert.equal(leg.ticker, 'AMD');
});

test('a message may carry two actions', () => {
  const rows = read('Exit $META with $6.10 profit from the sold Puts Exit $APP with $2 profit per share');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.ticker), ['META', 'APP']);
});

test('an announcement is not a trade', () => {
  assert.deepEqual(read('Starting in 10 Minutes: https://x.com/RealDayTrading/status/1981032975405056056'), []);
  assert.deepEqual(read('Live today at 11am (pst) / 2pm (est) :'), []);
});

test('a ticker is inherited when the message names none', () => {
  const rows = parsePost('Bought back the sold Calls for $4 profit per contract (5 Contract)', {
    inheritedTicker: 'AMD',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'AMD');
});

test('the broker\'s own spelling is translated', () => {
  assert.equal(marketTickerOf('RHM XETRA'), 'RHM.DE');
  assert.equal(marketTickerOf('RHM.XETRA'), 'RHM.DE');
});
