'use strict';

// The Komar lexicon: which tickers the corpus names, and which
// capitalised tokens are the LESSON rather than a holding.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The shared seed lexicon was grown from the QMG and Revere position
// lists, and it does not know this corpus: measured on 2026-11-17, the
// Komar corpus names 105 tickers and only 32 of them are in the seed.
// The other 73 live in config/ticker_lexicon_komar.csv, and the
// capitalised tokens that are the lesson rather than a holding (the
// MMTS score, the EMA indicator misheard as EMI, "the US market") are
// stopped -- but ONLY after each was checked against the SEC's own
// registrant list, because a token that IS a listed registrant might be
// a holding.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  KOMAR_LEXICON_PATH,
  KOMAR_SYMBOL_STOPLIST,
  findKomarCompanyNames,
  loadKomarLexicon,
} = require('../src/komar/lexicon');

test('the corpus\'s own tickers are in the lexicon', () => {
  const lexicon = loadKomarLexicon();
  // From the trade log (text).
  for (const ticker of ['QS', 'BMNR', 'CRML', 'QSI', 'PDYN', 'VNET']) {
    assert.ok(lexicon.has(ticker), `${ticker} is in the lexicon`);
  }
  // From the card theme leaders (OCR).
  for (const ticker of ['WULF', 'UMAC', 'HYMC', 'NEXA', 'LWLG']) {
    assert.ok(lexicon.has(ticker), `${ticker} is in the lexicon`);
  }
  // From the Summary holdings (text).
  for (const ticker of ['VFF', 'SBET', 'HIPO', 'XPEV', 'VSAT']) {
    assert.ok(lexicon.has(ticker), `${ticker} is in the lexicon`);
  }
});

test('the Komar lexicon file is the corpus\'s own gap in the seed', () => {
  const lines = fs.readFileSync(KOMAR_LEXICON_PATH, 'utf8').split(/\r?\n/);
  assert.equal(lines[0], 'ticker,note');
  const tickers = lines.slice(1).filter(Boolean).map((line) => line.split(',')[0].trim());
  assert.equal(tickers.length, 73, 'the corpus names 105 tickers and 32 are in the seed');
  assert.equal(new Set(tickers).size, tickers.length, 'and no ticker is twice');
  // And every row says which of the corpus's artifacts names it.
  for (const line of lines.slice(1).filter(Boolean)) {
    assert.match(line, /Komar (trade log|corpus)/, `the note says where it came from: ${line}`);
  }
});

test('the words that are not tickers are stopped', () => {
  for (const token of ['MMTS', 'EMI', 'US', 'EPS', 'VCP', 'IBD', 'IPO', 'ETF', 'ADR', 'OTC', 'FOMO']) {
    assert.ok(KOMAR_SYMBOL_STOPLIST.has(token), `${token} is stopped`);
  }
  // And the shared English stoplist's chart words are in it too.
  for (const token of ['EMA', 'ATR', 'RSI', 'SMA', 'AI', 'IT']) {
    assert.ok(KOMAR_SYMBOL_STOPLIST.has(token), `${token} is stopped`);
  }
});

test('the corpus\'s own holdings are NOT stopped', () => {
  // Measured from the contexts (2026-11-17): "CCG is another sister
  // stock", "I'm thinking about ALAP, CRDO", "NB Bancorp", "the same
  // is true for KC, VNET". These LOOK like chart words and are not.
  for (const ticker of ['CCG', 'ALAP', 'NB', 'KC']) {
    assert.ok(!KOMAR_SYMBOL_STOPLIST.has(ticker), `${ticker} is a holding, not a word`);
  }
  // "CRISPR" is the other way round: the corpus says it for the
  // COMPANY (CRISPR Therapeutics, CRSP), but CRISPR is not a ticker,
  // and the confirmed-names table has no row for it -- so it is stopped
  // rather than published as one. That is a gap in the table, and the
  // plan says it needs a Komar pass.
  assert.ok(KOMAR_SYMBOL_STOPLIST.has('CRISPR'));
});

test('"the ARK Innovation Fund" is ARKK, and only in full', () => {
  const lexicon = loadKomarLexicon();
  const full = findKomarCompanyNames('And the ARK Innovation Fund loaded up on this thing.', { lexicon });
  assert.ok(full.some((name) => name.ticker === 'ARKK'), 'the full name is ARKK');

  // A looser alias fired on sentences ABOUT Cathie Wood and turned
  // them into 57 setups.
  const loose = findKomarCompanyNames(
    "Kathy Woods from the ARC, you know, she would do 1,000,000 times better if she would look at charts.",
    { lexicon }
  );
  assert.ok(
    !loose.some((name) => name.ticker === 'ARKK'),
    'a remark about the fund manager is not a call on ARKK'
  );
});
