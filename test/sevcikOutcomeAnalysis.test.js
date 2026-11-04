'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  directionHit,
  scoreSignalOutcome,
  summarizeOutcomes,
  toIsoDate,
  yahooSymbolFor,
} = require('../src/sevcik/outcomeAnalysis');

test('upload dates become ISO dates', () => {
  assert.equal(toIsoDate('20261104'), '2026-11-04');
  assert.equal(toIsoDate('2026-11-04'), '2026-11-04');
});

test('Czech tickers map to Yahoo symbols', () => {
  assert.equal(yahooSymbolFor('ČEZ'), 'CEZ.PR');
  assert.equal(yahooSymbolFor('MONETA'), 'MONET.PR');
  assert.equal(yahooSymbolFor('BTC'), 'BTC-USD');
  assert.equal(yahooSymbolFor('AAPL'), 'AAPL');
});

test('bullish is a hit when the price rose', () => {
  assert.equal(directionHit('bullish', 0.05), true);
  assert.equal(directionHit('bullish', -0.02), false);
  assert.equal(directionHit('bearish', -0.02), true);
  assert.equal(directionHit('bearish', 0.02), false);
  assert.equal(directionHit('mixed', 0.02), null);
});

test('a signal is scored with week and month returns', () => {
  const row = scoreSignalOutcome(
    { video_id: 'v', upload_date: '20260902', ticker: 'AAPL', bias: 'bullish', evidence_text: 'x' },
    { entry: 100, week: 105, month: 90, meta: { status: 'ok' } },
  );
  assert.equal(row.return_1w, 0.05);
  assert.equal(row.return_1m, -0.1);
  assert.equal(row.hit_1w, true);
  assert.equal(row.hit_1m, false);
  assert.equal(row.yahoo_symbol, 'AAPL');
  assert.equal(row.claim_kind, 'forward');
});


test('the summary counts hit rates', () => {
  const summary = summarizeOutcomes([
    { ticker: 'AAPL', hit_1w: true, hit_1m: false, return_1w: 0.1, return_1m: -0.05, entry_price: 1 },
    { ticker: 'AAPL', hit_1w: false, hit_1m: false, return_1w: -0.1, return_1m: -0.2, entry_price: 1 },
    { ticker: 'TSLA', hit_1w: true, hit_1m: true, return_1w: 0.2, return_1m: 0.3, entry_price: 1 },
  ]);
  assert.equal(summary.scored_1w, 3);
  assert.equal(summary.hit_rate_1w, 0.667);
  assert.equal(summary.tickers[0].ticker, 'AAPL');
});
