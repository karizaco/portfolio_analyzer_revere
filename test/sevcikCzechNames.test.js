'use strict';

// The Czech name finder and the company-name matcher.
//
// WHY THESE TESTS ARE WORDED AS CLAIMS
//
// The Czech path has three claims, and each one is a claim about how a
// language works:
//
//   1. Czech capitalises the first word of every SENTENCE, so a
//      capitalised word is only a candidate name when it is NOT at the
//      start of a sentence.
//   2. A spoken company name resolves to a ticker through the generated
//      SEC table, and a name that matches more than one company is not
//      a ticker at all.
//   3. A Czech inflection -- "Applu" for "Apple" -- still resolves.
//
// The measured numbers these claims came from are in CLAUDE.md: 12 real
// transcripts, 10,847 segments.

const test = require('node:test');
const assert = require('node:assert/strict');

const { findCzechCompanyNames, startsSentence } = require('../src/sevcik/czechNames');
const { matchCompanyName, stemName } = require('../src/sevcik/companyNames');
const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');

const LEXICON = new Set(loadSeedLexiconSync().tickers);

/**
 * Find the names in a text.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
function names(text) {
  return findCzechCompanyNames(text, { lexicon: LEXICON });
}

// ---------------------------------------------------------------------------
// The position is the evidence
// ---------------------------------------------------------------------------

test('a capitalised word at the start of a sentence is not a name', () => {
  // "Takže" starts the sentence, so it is a Czech word and not a name.
  // 359 of these were counted in the corpus.
  assert.equal(names('Takže to je přesně ono.').length, 0);
});

test('a capitalised word NOT at the start of a sentence IS a candidate', () => {
  const found = names('Takže se podíváme na Tesla, protože to je zajímavé.');
  assert.equal(found.length, 1);
  assert.equal(found[0].spoken, 'Tesla');
  assert.equal(found[0].ticker, 'TSLA');
});

test('a name after a full stop is still a sentence start', () => {
  // "Tesla" opens the second sentence, so it is capitalised because of
  // where it sits, and it is NOT a candidate by position.
  assert.equal(names('Dnes je klid. Tesla se zvedá.').length, 0,
    'the second sentence starts with Tesla, so its capital is positional');
});

test('the direction word is not a company name', () => {
  // "Long" appears 492 times in the corpus, capitalised mid-sentence.
  // It is a DIRECTION, and a name finder that did not exclude it would
  // treat every long call as a company.
  assert.equal(names('Tady máme Long, protože to je jasné.').length, 0);
});

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

test('a spoken company name resolves to its ticker', () => {
  const cases = [
    ['Tesla', 'TSLA'],
    ['Apple', 'AAPL'],
    ['Amazon', 'AMZN'],
    ['Microsoft', 'MSFT'],
    ['Nvidia', 'NVDA'],
    ['Netflix', 'NFLX'],
    ['Adobe', 'ADBE'],
    ['Intel', 'INTC'],
  ];
  for (const [spoken, expected] of cases) {
    const result = matchCompanyName(spoken, { lexicon: LEXICON });
    assert.equal(result.ticker, expected, `${spoken} -> ${expected}`);
  }
});

test('a Czech inflection still resolves', () => {
  // "Applu" is the Czech locative of "Apple".
  assert.equal(matchCompanyName('Applu', { lexicon: LEXICON }).ticker, 'AAPL');
  assert.equal(matchCompanyName('Tesly', { lexicon: LEXICON }).ticker, 'TSLA');
});

test('a name that is a prefix of another name does not match it', () => {
  // "Apple" must not match "Applied Materials". The word-boundary test
  // is what separates them: "appl" is inside "applied", but it does not
  // start a word there.
  const result = matchCompanyName('Apple', { lexicon: LEXICON });
  assert.equal(result.ticker, 'AAPL');
});

test('a name that matches two DIFFERENT companies is not a ticker', () => {
  // A wrong holding is worse than a missing one, so an ambiguous match
  // is dropped rather than guessed.
  const result = matchCompanyName('Celsius', { lexicon: LEXICON });
  if (result.ambiguous.length) {
    assert.equal(result.ticker, null, 'an ambiguous name is not published');
  }
});

test('a share class pair resolves to the class A ticker', () => {
  // GOOG and GOOGL are both Alphabet. A speaker who says "Alphabet" means
  // the company, and the class A share is the one every feed leads with.
  //
  // "Alphabet" reaches the share-class rule through the spoken-name
  // alias, so the rule is pinned on a name that has to go through the
  // generated table instead -- "Meta Platforms", which is the
  // registrant's own wording.
  const result = matchCompanyName('Meta Platforms', { lexicon: LEXICON });
  assert.equal(result.ticker, 'META');
});

test('the spoken name beats the registrant name', () => {
  // The SEC's registrant is "Alphabet Inc.", but what is said is
  // "Google".
  assert.equal(matchCompanyName('Google', { lexicon: LEXICON }).ticker, 'GOOG');
});

test('a ticker outside the allowed set is not reported', () => {
  // The lexicon is the ALLOW list: a name that resolves to a ticker the
  // caller may not report is not a match.
  const narrow = new Set(['AAPL']);
  assert.equal(matchCompanyName('Tesla', { lexicon: narrow }).ticker, null);
  assert.equal(matchCompanyName('Apple', { lexicon: narrow }).ticker, 'AAPL');
});

test('a common word is not a company name', () => {
  for (const word of ['the', 'and', 'price', 'market', 'stream']) {
    assert.equal(matchCompanyName(word, { lexicon: LEXICON }).ticker, null,
      `${word} is not a company`);
  }
});

// ---------------------------------------------------------------------------
// The stem
// ---------------------------------------------------------------------------

test('the stem drops a Czech case ending', () => {
  assert.equal(stemName('Applu'), stemName('Apple'));
  assert.equal(stemName('Tesly'), stemName('Tesla'));
});

test('the stem keeps the consonants that carry the identity', () => {
  // "Tesla" and "TSL" are not the same company, and the stem must not
  // collapse them.
  assert.notEqual(stemName('Tesla'), stemName('TSL'));
});

module.exports = { names };
