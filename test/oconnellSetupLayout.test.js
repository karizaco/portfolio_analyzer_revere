'use strict';

// The O'Connell setup headings: what they say and what they mean.
//
// A setup is the author's stated intent -- a ticker, the kind of setup he
// is watching, a direction where he states one, and the thesis in his
// own words.
//
// The rules this test pins are the ones that keep the noise out. The
// corpus's text layer carries 743 headings that begin with a ticker,
// and a scan of them found 151 that begin "VAHm", 40 that begin "10D"
// and 10 that begin "9/21" -- all of them screener column names rather
// than setups. Two rules reject them:
//
//   1. the TICKER IS UPPERCASE, because every real ticker in the corpus
//      is capitals and the screener labels are camel case;
//   2. the SIZE is 16.1 points, the third-level heading of the
//      newsletter.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SECTION_HEADING_SIZE,
  SETUP_HEADING_SIZE,
  isTickerShape,
  parseSetupHeading,
  sectionFor,
  setupKindFor,
} = require('../src/oconnell/setupLayout');

test('a dash heading gives its ticker and its label', () => {
  assert.deepEqual(parseSetupHeading('NU - Nu Holdings Ltd'), {
    direction: '',
    label: 'Nu Holdings Ltd',
    ticker: 'NU',
  });
});

test('an arrow heading gives its ticker and its label', () => {
  assert.deepEqual(parseSetupHeading('AVGO → 200D SMA Reclaim'), {
    direction: '',
    label: '200D SMA Reclaim',
    ticker: 'AVGO',
  });
});

test('a stated direction is read, and the label keeps the rest', () => {
  assert.deepEqual(parseSetupHeading('QFIN - Qifu Technology - Long'), {
    direction: 'long',
    label: 'Qifu Technology',
    ticker: 'QFIN',
  });
  assert.deepEqual(parseSetupHeading('DELL → VAHm Breakout → Long'), {
    direction: 'long',
    label: 'VAHm Breakout',
    ticker: 'DELL',
  });
  assert.deepEqual(parseSetupHeading('XOM - Exxon - Short'), {
    direction: 'short',
    label: 'Exxon',
    ticker: 'XOM',
  });
});

test('a heading without a ticker is not a setup', () => {
  assert.equal(parseSetupHeading('Position Log'), null);
  assert.equal(parseSetupHeading('Technical Trading - Watchlist LINKED HERE'), null);
  assert.equal(parseSetupHeading(''), null);
});

test('a camel-case screener label is not a ticker', () => {
  // These are the measured noise: the screener's own column names.
  assert.equal(parseSetupHeading('VAHm - Breakouts'), null);
  assert.equal(parseSetupHeading('POCm - Point of Control'), null);
  assert.equal(parseSetupHeading('VALm - Value Area Low'), null);
});

test('a lowercase word is not a ticker', () => {
  assert.equal(parseSetupHeading('the market is trading sideways'), null);
});

test('a ticker may carry a dot or a dash', () => {
  assert.equal(isTickerShape('BRK.B'), true);
  assert.equal(isTickerShape('RKT'), true);
  assert.equal(isTickerShape('GTBIF'), true);
  assert.equal(isTickerShape('TOO-LONG'), false);
  assert.equal(isTickerShape('lower'), false);
});

test('the setup vocabulary is matched by the longest keyword', () => {
  assert.equal(setupKindFor('Power Earnings Gap (PEG) Continuation'), 'power_earnings_gap');
  assert.equal(setupKindFor('200D SMA Reclaim'), 'moving_average');
  assert.equal(setupKindFor('Relative Strength'), 'relative_strength');
  assert.equal(setupKindFor('Russell Inclusion'), 'index_inclusion');
  assert.equal(setupKindFor('MSOS Cannabis Reform Trade'), 'cannabis_rescheduling');
  assert.equal(setupKindFor('Carving Out a Base'), 'base');
  assert.equal(setupKindFor('52wk High'), 'fifty_two_week');
  assert.equal(setupKindFor('Something else entirely'), '');
});

test('the sections are recognised', () => {
  assert.equal(sectionFor('Technical Trading - Watchlist LINKED HERE'), 'technical_trading');
  assert.equal(sectionFor('EOD Trade Blotter & Position Log'), 'trade_blotter');
  assert.equal(sectionFor('Position Log'), 'position_log');
  assert.equal(sectionFor('Focus List'), 'focus_list');
  assert.equal(sectionFor('Something else'), '');
});

test('the heading sizes are the measured ones', () => {
  // The setup heading is 16.1 points and the section heading 19.6.
  assert.equal(SETUP_HEADING_SIZE, 16.1);
  assert.equal(SECTION_HEADING_SIZE, 19.6);
});
