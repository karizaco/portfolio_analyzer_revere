'use strict';

// Drendel's "Portfolio" post: the one place where the corpus states WHAT IS
// HELD and HOW LARGE. The parsing rules are claims, and each test is one
// claim.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  headerDateOf, isPortfolioPost, parsePortfolioPost, resolveSnapshotDates, sessionDateOf, stripMarkdown,
} = require('../src/discord/drendelPortfolio');

test('a portfolio post is recognised by its header', () => {
  assert.equal(isPortfolioPost('**Portfolio June 4th 2026:**\nLongs: 5%'), true);
  assert.equal(isPortfolioPost('**Updated Portfolio:**\nLong Exposure: 49.2%'), true);
  assert.equal(isPortfolioPost('Bought 5% of FIGR through the open'), false);
});

test('the trading account is everything that is not the Vibe account', () => {
  const post = parsePortfolioPost(
    '**Portfolio June 4th 2026:**\n\n**Longs: 36%**\nINTC - 10%\nDOCN - 5%\n\n'
    + '**Shorts: 10%**\nSOXS - 10%\n\nVibe Account Longs: NBIS, HUT, WULF',
    '2026-06-04T20:00:00.000Z',
  );
  const trading = post.positions.filter((row) => row.account === 'trading');
  const vibe = post.positions.filter((row) => row.account === 'vibe');
  assert.deepEqual(trading.map((row) => row.ticker), ['INTC', 'DOCN', 'SOXS']);
  assert.deepEqual(vibe.map((row) => row.ticker), ['NBIS', 'HUT', 'WULF']);
  assert.equal(trading.find((row) => row.ticker === 'SOXS').side, 'short');
  assert.equal(trading.find((row) => row.ticker === 'INTC').weight_pct, 10);
  // The Vibe list carries no weights, and none are invented.
  assert.equal(vibe.every((row) => row.weight_pct === null), true);
});

test('the small account is kept apart from the main book', () => {
  const post = parsePortfolioPost(
    '**Portfolio March 20th 2026:**\nLongs: 5%\nNBIS - 5%\n\nShorts in small account: APP, CVNA, DASH',
    '2026-03-20T21:00:00.000Z',
  );
  const small = post.positions.filter((row) => row.sub_account === 'small_account');
  assert.deepEqual(small.map((row) => row.ticker), ['APP', 'CVNA', 'DASH']);
  assert.equal(small.every((row) => row.side === 'short'), true);
  // The user's rule: not listed under Vibe means the trading account.
  assert.equal(small.every((row) => row.account === 'trading'), true);
});

test('a position the post marks in bold is a new position', () => {
  const post = parsePortfolioPost(
    '**Portfolio June 4th 2026:**\nLongs: 36%\n**INTC - 10%**\nDOCN - 5%',
    '2026-06-04T20:00:00.000Z',
  );
  const byTicker = new Map(post.positions.map((row) => [row.ticker, row]));
  assert.equal(byTicker.get('INTC').is_new, true);
  assert.equal(byTicker.get('DOCN').is_new, false);
});

test('the date in the header is the session the post describes', () => {
  const post = parsePortfolioPost('**Portfolio June 4th 2026:**\nLongs: 0%', '2026-06-04T20:00:00.000Z');
  assert.equal(post.as_of_date, '2026-06-04');
  assert.equal(post.as_of_source, 'header');
});

test('a post made before the open describes the previous session', () => {
  // 2026-06-04 09:15 New York is 2026-06-04 13:15 UTC.
  assert.equal(sessionDateOf('2026-06-04T13:15:00.000Z'), '2026-06-03');
  assert.equal(sessionDateOf('2026-06-04T14:00:00.000Z'), '2026-06-04');
});

test('a header date within a day of the timestamp is the one he wrote', () => {
  // He posts at night about the session of the day, and at weekends about
  // the session of the Friday before, so a day's difference is normal.
  const post = parsePortfolioPost('**Portfolio March 17th 2026:**\nLongs: 0%', '2026-03-18T22:06:00.000Z');
  assert.equal(post.as_of_date, '2026-03-17');
  assert.equal(post.as_of_source, 'header');
});

test('a header date far from the timestamp does not win', () => {
  // A typo, not a weekend: the post was made on the 18th.
  const post = parsePortfolioPost('**Portfolio March 3rd 2026:**\nLongs: 0%', '2026-03-18T22:06:00.000Z');
  assert.equal(post.as_of_date, '2026-03-18');
  assert.equal(post.as_of_source, 'posted_at');
  assert.equal(post.notes.length > 0, true);
});

test('two posts cannot describe one session, so the later one is dated by its timestamp', () => {
  const first = { ...parsePortfolioPost('**Portfolio March 17th 2026:**\nLongs: 0%', '2026-03-17T20:06:00.000Z'), posted_at: '2026-03-17T20:06:00.000Z' };
  const second = { ...parsePortfolioPost('**Portfolio March 17th 2026:**\nLongs: 5%', '2026-03-19T04:25:00.000Z'), posted_at: '2026-03-19T04:25:00.000Z' };
  const resolved = resolveSnapshotDates([first, second]);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((row) => row.as_of_date), ['2026-03-17', '2026-03-18']);
});

test('the weights are checked against the total the post states', () => {
  const post = parsePortfolioPost(
    '**Portfolio June 4th 2026:**\nLongs: 36%\nINTC - 10%\nDOCN - 5%\n\nShorts: 10%\nSOXS - 10%',
    '2026-06-04T20:00:00.000Z',
  );
  // 15% of weights against a stated 36% is a mismatch, and it is reported.
  assert.equal(post.notes.some((note) => /long weights sum to 15%/.test(note)), true);
});

test('the old format is read as well as the new one', () => {
  const post = parsePortfolioPost(
    '**Updated Portfolio:**\n\n**Long Exposure: 49.2%**\nTSLL - 14.8%\nLABU - 13.2%\n\n'
    + '**Short Exposure: 13.5%**\nMSTZ - 8.2%\n\n**Cash - 37.3%**',
    '2025-09-26T20:00:00.000Z',
  );
  assert.equal(post.long_exposure_pct, 49.2);
  assert.equal(post.short_exposure_pct, 13.5);
  assert.equal(post.cash_pct, 37.3);
  assert.deepEqual(post.positions.map((row) => row.ticker), ['TSLL', 'LABU', 'MSTZ']);
});

test('an inverse product keeps the annotation he wrote beside it', () => {
  const post = parsePortfolioPost(
    '**Portfolio March 6th 2026:**\nShorts: 14.8%\nSARK (ARKK Inverse): 8.3%\nDUST (GDX Inverse): 6.5%',
    '2026-03-06T21:00:00.000Z',
  );
  const sark = post.positions.find((row) => row.ticker === 'SARK');
  assert.equal(sark.annotation, 'ARKK Inverse');
  assert.equal(sark.weight_pct, 8.3);
  assert.equal(sark.side, 'short');
});

test('the markdown is stripped without losing which words were bold', () => {
  const { bold, clean } = stripMarkdown('**Bold** and plain');
  assert.equal(clean, 'Bold and plain');
  assert.equal(bold.slice(0, 4).every(Boolean), true);
  assert.equal(bold.slice(5).some(Boolean), false);
});

test('a header without a date yields no date', () => {
  assert.equal(headerDateOf('Portfolio Update:'), '');
});
