'use strict';

// The position episodes: what a portfolio snapshot says, and what a chain of
// trade messages says. Every rule here was a wrong number before it was a
// rule.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  directionOf, episodesFromActions, episodesFromSnapshots, priceEpisode,
} = require('../src/discord/episodes');

function snapshot(date, rows) {
  return {
    as_of_date: date,
    notes: [],
    positions: rows.map((row) => ({
      account: row.account || 'trading',
      annotation: '',
      is_new: Boolean(row.is_new),
      note: '',
      side: row.side || 'long',
      stated_price: null,
      sub_account: row.sub_account || '',
      ticker: row.ticker,
      weight_pct: row.weight === undefined ? null : row.weight,
    })),
  };
}

test('a position runs from the snapshot that lists it to the one that does not', () => {
  const episodes = episodesFromSnapshots([
    snapshot('2026-03-01', [{ ticker: 'NBIS', weight: 5 }]),
    snapshot('2026-03-02', [{ ticker: 'NBIS', weight: 5 }]),
    snapshot('2026-03-03', [{ ticker: 'NBIS', weight: 5 }]),
    snapshot('2026-03-04', []),
  ]);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].entry_date, '2026-03-01');
  assert.equal(episodes[0].exit_date, '2026-03-04');
});

test('a position in an account without weights closes by DISAPPEARING, not by a missing weight', () => {
  // The Vibe list carries no weights. Reading the missing weight as "closed"
  // would make every Vibe position a one-day trade.
  const episodes = episodesFromSnapshots([
    snapshot('2026-03-01', [{ account: 'vibe', ticker: 'NBIS' }]),
    snapshot('2026-03-02', [{ account: 'vibe', ticker: 'NBIS' }]),
    snapshot('2026-03-03', []),
  ], { includeVibe: true });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].entry_date, '2026-03-01');
  assert.equal(episodes[0].exit_date, '2026-03-03');
});

test('a position that comes back is a second trade', () => {
  const episodes = episodesFromSnapshots([
    snapshot('2026-03-01', [{ ticker: 'NBIS', weight: 5 }]),
    snapshot('2026-03-02', []),
    snapshot('2026-03-03', [{ ticker: 'NBIS', weight: 5 }]),
  ]);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].entry_date, '2026-03-03');
});

test('a position marked in bold again is a new position in the same name', () => {
  const episodes = episodesFromSnapshots([
    snapshot('2026-03-01', [{ ticker: 'NBIS', weight: 5 }]),
    snapshot('2026-03-02', [{ ticker: 'NBIS', weight: 5, is_new: true }]),
  ]);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].exit_date, '2026-03-02');
  assert.equal(episodes[1].entry_date, '2026-03-02');
});

test('an inverse product in the trading account is a LONG position', () => {
  // Drendel BUYS the inverse: "Bought AVS (AVGO inverse)", "Short AVGO (Long AVS)".
  assert.equal(directionOf('short', 'AVS'), 1);
  assert.equal(directionOf('short', 'SARK'), 1);
  // A short of a real stock is a short.
  assert.equal(directionOf('short', 'CVNA'), -1);
  assert.equal(directionOf('long', 'NBIS'), 1);
});

test('the trading account and the Vibe account are separate books', () => {
  const episodes = episodesFromSnapshots([
    snapshot('2026-03-01', [
      { account: 'trading', ticker: 'NBIS', weight: 5 },
      { account: 'vibe', ticker: 'HUT' },
    ]),
    snapshot('2026-03-02', [
      { account: 'trading', ticker: 'NBIS', weight: 5 },
      { account: 'vibe', ticker: 'HUT' },
    ]),
  ], { includeVibe: true });
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((row) => row.account).sort(), ['trading', 'vibe']);
});

test('a chain of messages is one position lifecycle', () => {
  const episodes = episodesFromActions([
    { action: 'open', fraction: null, price: 240, posted_at: '2026-01-02T15:00:00.000Z', size_pct: 5, ticker: 'TSLA' },
    { action: 'add', fraction: null, price: 250, posted_at: '2026-01-05T15:00:00.000Z', size_pct: 5, ticker: 'TSLA' },
    { action: 'trim', fraction: 0.5, posted_at: '2026-01-08T15:00:00.000Z', price: 270, ticker: 'TSLA' },
    { action: 'exit', fraction: null, posted_at: '2026-01-12T15:00:00.000Z', price: 260, ticker: 'TSLA' },
  ], { side: 'long' });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].entry_date, '2026-01-02');
  assert.equal(episodes[0].exit_date, '2026-01-12');
  assert.equal(episodes[0].exit_action, 'exit');
});

test('an episode with no price is not scored', () => {
  const episode = { entry_date: '2026-01-02', exit_date: '2026-01-12', side: 'long', ticker: 'TSLA' };
  const priced = priceEpisode(episode, () => null, '2026-01-12');
  assert.equal(priced.priced, false);
  assert.equal(priced.return_pct, null);
});

test('a return is signed by the direction', () => {
  const prices = {
    CVNA: { '2026-01-02': 100, '2026-01-12': 80 },
    TSLA: { '2026-01-02': 100, '2026-01-12': 80 },
  };
  const at = (ticker, date) => prices[ticker][date];
  const long = priceEpisode({ entry_date: '2026-01-02', exit_date: '2026-01-12', side: 'long', ticker: 'TSLA' }, at, '2026-01-12');
  const short = priceEpisode({ entry_date: '2026-01-02', exit_date: '2026-01-12', side: 'short', ticker: 'CVNA' }, at, '2026-01-12');
  assert.equal(long.return_pct, -20);
  assert.equal(short.return_pct, 20);
});

test('a still-open position is marked to the last date, and says so', () => {
  const prices = { TSLA: { '2026-01-02': 100, '2026-01-12': 120 } };
  const priced = priceEpisode(
    { entry_date: '2026-01-02', exit_date: '', side: 'long', ticker: 'TSLA' },
    (ticker, date) => prices[ticker][date], '2026-01-12',
  );
  assert.equal(priced.still_open, true);
  assert.equal(priced.return_pct, 20);
});
