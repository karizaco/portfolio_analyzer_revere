'use strict';

// A trade ACTION, read out of one message. Every rule here exists because
// its absence produced a wrong holding somewhere in the corpus.

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseTradeMessage, readActionStream } = require('../src/discord/tradeActions');
const { loadLexicon } = require('../src/discord/symbols');

const KNOWN = loadLexicon();

function read(content, book = 'trading') {
  return parseTradeMessage(content, { book, known: KNOWN });
}

test('an entry is an entry, with its size, fill and stop', () => {
  const parsed = read('Bought 5% of FIGR through Pre-market high 40.60, stop today\'s low 38.30');
  assert.equal(parsed.kind, 'action');
  assert.equal(parsed.action, 'open');
  assert.deepEqual(parsed.tickers, ['FIGR']);
  assert.equal(parsed.size_pct, 5);
  assert.equal(parsed.price, 40.60);
  assert.equal(parsed.stop_price, 38.30);
});

test('the earliest verb is the action', () => {
  // A purchase that mentions a stop-out in a parenthesis is a purchase.
  const parsed = read('Bought 5% SQQQ back at 50.63, stop at 49.80 (was stopped this morning so total size is 5% again)');
  assert.equal(parsed.action, 'open');
  assert.deepEqual(parsed.tickers, ['SQQQ']);
});

test('an intent is not a trade', () => {
  assert.equal(read('Watching OKLO on the short side against yesterdays highs', 'short').kind, 'intent');
  assert.equal(read('looking to add later if market keeps its bid').kind, 'intent');
  assert.equal(read('will look for adds later').kind, 'intent');
});

test('a commentary sentence that mentions a past trade is not a trade', () => {
  // "the dip was bought so aggressively" is a description, not an action.
  const parsed = read('NAAIM coming in HOT (96% vs 76% last week). To me that raises a warning flag as the dip was bought so aggressively this week');
  assert.notEqual(parsed.kind, 'action');
});

test('a ticker in the first slot is the subject of the message', () => {
  const parsed = read('CRWD - Bought today on the undercut and reclaim of the support gap');
  assert.equal(parsed.action, 'open');
  assert.deepEqual(parsed.tickers, ['CRWD']);
});

test('a name that is not in the lexicon is still a ticker', () => {
  // The corpus's own stocks are not US registrants.
  const parsed = read('Bought TSLL at 21.90 stop LOD');
  assert.deepEqual(parsed.tickers, ['TSLL']);
});

test('a trim keeps the fraction of the position it took', () => {
  assert.equal(read('Trimmed 1/3 of RDDT at previous highs').fraction, 1 / 3);
  assert.equal(read('trimming off a third of my NEM 93.86').fraction, 1 / 3);
  assert.equal(read('Cut half of SARK at 32.05').fraction, 0.5);
  assert.equal(read('20% trim on CIEN 512.09').fraction, 0.2);
  assert.equal(read('Trimmed 1/3 of RDDT at previous highs').action, 'trim');
});

test('closing the rest of a position is an exit, not a trim', () => {
  const parsed = read('Closed the rest of DUST at 68.56');
  assert.equal(parsed.action, 'exit');
  assert.equal(parsed.fraction, null);
});

test('a stop-out is a stop-out', () => {
  const parsed = read('Stopped on AMD 570.36');
  assert.equal(parsed.action, 'stop_out');
  assert.deepEqual(parsed.tickers, ['AMD']);
});

test('a number is a price only where a price can stand', () => {
  // "50sma", "7x ATR" and "6/20 setup" are not prices.
  const parsed = read('10% trim of DELL 239.13 9x ATR from the 50sma');
  assert.equal(parsed.price, 239.13);
  assert.equal(parsed.atr_multiple, 9);
});

test('an ATR multiple is read when he cites one', () => {
  assert.equal(read('trimming a piece of RKLB into the 7x ATR extension from the 50sma 68.38').atr_multiple, 7);
});

test('the short book opens a trade with "short" and the long book with "long"', () => {
  assert.equal(read('$NVDA short 114.30', 'short').action, 'open');
  assert.equal(read('$NVDA short 114.30', 'short').tickers[0], 'NVDA');
  assert.equal(read('Long PLTR 181.61', 'long').action, 'open');
  // "short" is a noun in the long book, and a verb in the short book.
  assert.equal(read('I have some MSTR short back on', 'long').action !== 'open', true);
});

test('two names written side by side are one action on both', () => {
  const parsed = read('MU SNDK 10% trim on both right at the open', 'long');
  assert.deepEqual(parsed.tickers, ['MU', 'SNDK']);
  assert.equal(parsed.action, 'trim');
});

test('a ticker in a later remark is not the subject', () => {
  // AAOI is in the parenthesis; the trade is AAOZ.
  const parsed = read('Bought 4% AAOZ at 9.76 with stop above today\'s low (8.86) (AAOI failed at resistance gap)');
  assert.deepEqual(parsed.tickers, ['AAOZ']);
});

test('a message that names no ticker inherits the one before it', () => {
  const stream = readActionStream([
    { content: 'Bought TSLA 240.00', id: 1, posted_at: '2026-01-02T15:00:00.000Z' },
    { content: 'stop LOD', id: 2, posted_at: '2026-01-02T16:00:00.000Z' },
  ], { book: 'trading', known: KNOWN });
  const stop = stream.find((row) => row.message_id === 2);
  assert.equal(stop.ticker, 'TSLA');
  assert.equal(stop.ticker_inferred, true);
  assert.equal(stop.kind, 'stop_update');
});

test('an inherited ticker is not inherited across a long silence', () => {
  const stream = readActionStream([
    { content: 'Bought TSLA 240.00', id: 1, posted_at: '2026-01-02T15:00:00.000Z' },
    { content: 'stop LOD', id: 2, posted_at: '2026-01-04T15:00:00.000Z' },
  ], { book: 'trading', carryHours: 6, known: KNOWN });
  const stop = stream.find((row) => row.message_id === 2);
  assert.equal(stop.ticker, '');
});

test('the jargon of a trading channel is never a ticker', () => {
  const parsed = read('stop LOD, watching for a VWAP reclaim');
  assert.equal(parsed.tickers.length, 0);
});
