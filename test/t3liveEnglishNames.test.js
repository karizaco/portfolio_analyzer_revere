'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findEnglishCompanyNames,
  isEnglishNameCandidate,
  ENGLISH_STOP_WORDS,
} = require('../src/t3live/englishNames');

// ─── isEnglishNameCandidate ────────────────────────────────────────────────

test('Title-cased token is a candidate', () => {
  assert.equal(isEnglishNameCandidate('Apple'), true);
  assert.equal(isEnglishNameCandidate('Nvidia'), true);
  assert.equal(isEnglishNameCandidate('Amazon'), true);
});

test('All-uppercase token is NOT a candidate (handled by symbol path)', () => {
  assert.equal(isEnglishNameCandidate('NVDA'), false);
  assert.equal(isEnglishNameCandidate('AAPL'), false);
});

test('Lowercase token is NOT a candidate', () => {
  assert.equal(isEnglishNameCandidate('apple'), false);
  assert.equal(isEnglishNameCandidate('nvidia'), false);
});

test('Stop words are NOT candidates', () => {
  assert.equal(isEnglishNameCandidate('Long'), false);
  assert.equal(isEnglishNameCandidate('Short'), false);
  assert.equal(isEnglishNameCandidate('Market'), false);
  assert.equal(isEnglishNameCandidate('Today'), false);
});

test('Too-short tokens are NOT candidates', () => {
  assert.equal(isEnglishNameCandidate('Ab'), false);
  assert.equal(isEnglishNameCandidate('A'), false);
  assert.equal(isEnglishNameCandidate(''), false);
});

test('Host names are NOT candidates', () => {
  assert.equal(isEnglishNameCandidate('Sami'), false);
  assert.equal(isEnglishNameCandidate('Scott'), false);
});

// ─── findEnglishCompanyNames ───────────────────────────────────────────────

test('sentence-start company name IS found (unlike Czech finder)', () => {
  // In English, "Apple is breaking out" — "Apple" at sentence start is a name.
  // The Czech finder would drop it; the English finder must not.
  const results = findEnglishCompanyNames('Apple is breaking out today.', { lexicon: new Set(['AAPL']) });
  const spoken = results.map((r) => r.spoken);
  assert.ok(spoken.includes('Apple'), `Expected "Apple" in results, got: ${JSON.stringify(spoken)}`);
});

test('mid-sentence company name is found', () => {
  const results = findEnglishCompanyNames('I like Nvidia here.', { lexicon: new Set(['NVDA']) });
  const spoken = results.map((r) => r.spoken);
  assert.ok(spoken.includes('Nvidia'), `Expected "Nvidia" in results, got: ${JSON.stringify(spoken)}`);
});

test('stop words are excluded from results', () => {
  const results = findEnglishCompanyNames('Long is the direction I want.', { lexicon: new Set(['LONG']) });
  const spoken = results.map((r) => r.spoken);
  assert.ok(!spoken.includes('Long'), `"Long" should be excluded, got: ${JSON.stringify(spoken)}`);
});

test('all-caps tickers are NOT returned by the name finder', () => {
  // All-caps tokens are handled by the symbol path in signalExtractor.js.
  const results = findEnglishCompanyNames('NVDA looks good here.', { lexicon: new Set(['NVDA']) });
  const spoken = results.map((r) => r.spoken);
  assert.ok(!spoken.includes('NVDA'), `"NVDA" should not be in name finder results, got: ${JSON.stringify(spoken)}`);
});

test('empty text returns empty array', () => {
  const results = findEnglishCompanyNames('', { lexicon: new Set() });
  assert.deepEqual(results, []);
});

test('null/undefined text returns empty array', () => {
  assert.deepEqual(findEnglishCompanyNames(null, { lexicon: new Set() }), []);
  assert.deepEqual(findEnglishCompanyNames(undefined, { lexicon: new Set() }), []);
});

test('duplicate names are deduplicated', () => {
  const results = findEnglishCompanyNames('Apple is up. Apple is strong.', { lexicon: new Set(['AAPL']) });
  const appleCount = results.filter((r) => r.spoken === 'Apple').length;
  assert.equal(appleCount, 1, `Expected 1 "Apple" result, got ${appleCount}`);
});

test('a person is not a company: "Trump" is the president, not DJT', () => {
  assert.equal(isEnglishNameCandidate('Trump'), false);
  const results = findEnglishCompanyNames('When Trump was saying this is the best economy', { lexicon: new Set(['DJT']) });
  assert.ok(!results.some((r) => r.ticker === 'DJT'), JSON.stringify(results));
});

test('index phrases resolve to the ETF a call on them is scored with', () => {
  const lexicon = new Set(['QQQ', 'SPY', 'IWM', 'DIA']);
  const cases = [
    ['the Qs held the 200 day', 'QQQ'],
    ['the rising 200 day for the cues', 'QQQ'],
    ['the Nasdaq is leading', 'QQQ'],
    ['the S&P 500 needs to hold 6800', 'SPY'],
    ['SPX tagged the level', 'SPY'],
    ['the Russell is lagging', 'IWM'],
    ['the Dow closed green', 'DIA'],
  ];
  for (const [text, ticker] of cases) {
    const found = findEnglishCompanyNames(text, { lexicon }).map((r) => r.ticker);
    assert.ok(found.includes(ticker), `${text} -> ${ticker}, got ${JSON.stringify(found)}`);
  }
});

test('an ordinary word that happens to read "cues" without "the" is not an index', () => {
  const found = findEnglishCompanyNames('he gave us cues', { lexicon: new Set(['QQQ']) });
  assert.deepEqual(found.map((r) => r.ticker), []);
});

test('a two-word name is one name, not two', () => {
  // "Goldman Sachs" is one company. Read as two words, "Goldman" matches
  // several registrants and neither word identifies the company.
  const lexicon = new Set(['GJS']);
  const found = findEnglishCompanyNames('Goldman Sachs is where the money is', { lexicon });
  assert.deepEqual(found.map((r) => r.ticker), ['GJS']);
  assert.equal(found[0].spoken, 'Goldman Sachs',
    'the pair is the name; the second word is not also a candidate');
});

test('caption acronyms that are also tickers are not read as tickers', () => {
  const { findTickers } = require('../src/sevcik/signalExtractor');
  const { ENGLISH_SYMBOL_STOPLIST } = require('../src/t3live/englishNames');
  const lexicon = new Set(['AI', 'ATR', 'MU', 'RSI']);
  const options = { requireCapsSymbols: true, symbolStoplist: ENGLISH_SYMBOL_STOPLIST, nameFinderFn: findEnglishCompanyNames };
  assert.deepEqual(findTickers('sell the condo to an AI engineer', lexicon, options), []);
  assert.deepEqual(findTickers('the ATR is wide and RSI is hot', lexicon, options), []);
  assert.deepEqual(findTickers('MU was a little bit better', lexicon, options).map((t) => t.ticker), ['MU']);
});

test('ENGLISH_STOP_WORDS contains key trading terms', () => {
  assert.ok(ENGLISH_STOP_WORDS.has('long'));
  assert.ok(ENGLISH_STOP_WORDS.has('short'));
  assert.ok(ENGLISH_STOP_WORDS.has('market'));
  assert.ok(ENGLISH_STOP_WORDS.has('sami'));
  assert.ok(ENGLISH_STOP_WORDS.has('scott'));
});
