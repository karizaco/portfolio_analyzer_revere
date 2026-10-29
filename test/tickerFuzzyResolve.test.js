'use strict';

// The fuzzy resolver is the piece that decides what an OCR token IS. It is
// the one place where a wrong answer becomes a wrong HOLDING in a portfolio
// report, so its refusals matter as much as its corrections.
//
// The lexicon used here is SYNTHETIC on purpose: the real seed lexicon is
// tracked and editable, and a test that asserted "SPXL is not reportable"
// would fail the day somebody adds SPXL to config/ticker_lexicon_seed.csv —
// which is a change that should be visible in the diff, not hidden behind a
// test edit. The real lexicons are exercised for what they are FOR
// (seed = the allow list, observed = the match list) further down.

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_MAX_EDIT_DISTANCE,
  levenshtein,
  resolveTickerToken,
  splitFusedTicker,
} = require('../src/normalize/tickerFuzzyResolve');

// The allow list (what may be REPORTED) is a subset of the match list (what a
// token MAY be). SPXL is in the match list only: it is a real ticker the seed
// does not know, and it must resolve to ITSELF rather than to its neighbour
// SOXL, which is a different instrument.
const MATCH = ['TQQQ', 'NCLD', 'SPXL', 'SOXL', 'IBIT', 'IOT', 'DOCN', 'LITE', 'U', 'P', 'MP', 'SPY', 'MU', 'SNOW', 'SHOP', 'UPRo'];
const ALLOW = ['TQQQ', 'NCLD', 'SOXL', 'IBIT', 'IOT', 'DOCN', 'LITE', 'U', 'P', 'MP', 'SPY', 'MU', 'SNOW', 'SHOP'];

function ctx(overrides) {
  return Object.assign({
    matchTickers: MATCH,
    matchSet: new Set(MATCH),
    allowSet: new Set(ALLOW),
  }, overrides || {});
}

test('levenshtein counts the edits, not the letters', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('ABC', 'ABC'), 0);
  assert.equal(levenshtein('ABC', 'ABD'), 1);
  assert.equal(levenshtein('ABC', 'AB'), 1);
  assert.equal(levenshtein('', 'ABC'), 3);
  assert.equal(levenshtein('TGQQ', 'TQQQ'), 1);
  assert.equal(levenshtein('OOCN', 'DOCN'), 1);
  // A transposition is two edits, not one.
  assert.equal(levenshtein('AB', 'BA'), 2);
});

test('a token the lexicon knows resolves to itself', () => {
  const result = resolveTickerToken('TQQQ', ctx());
  assert.equal(result.status, 'exact');
  assert.equal(result.ticker, 'TQQQ');
  assert.equal(result.corrected, false);
  assert.equal(result.reportable, true);
});

test('a token is matched case-insensitively but reported in capitals', () => {
  const result = resolveTickerToken('tqqq', ctx());
  assert.equal(result.status, 'exact');
  assert.equal(result.ticker, 'TQQQ');
});

test('a real ticker the allow list does not know resolves to ITSELF, not to a neighbour', () => {
  // SPXL is in the match list and not in the allow list. It must not be
  // rewritten to SOXL: that is a different instrument, and reporting it as a
  // holding would be a lie.
  const result = resolveTickerToken('SPXL', ctx());
  assert.equal(result.status, 'exact');
  assert.equal(result.ticker, 'SPXL');
  assert.equal(result.reportable, false, 'it is known but not reportable');
});

test('a unique correction is applied', () => {
  const result = resolveTickerToken('TGQQ', ctx());
  assert.equal(result.status, 'corrected');
  assert.equal(result.ticker, 'TQQQ');
  assert.equal(result.corrected, true);
  assert.equal(result.distance, 1);
  assert.equal(result.reportable, true);
});

test('a correction to a ticker outside the allow list is still not reportable', () => {
  const result = resolveTickerToken('SPXI', ctx());
  assert.equal(result.status, 'corrected');
  assert.equal(result.ticker, 'SPXL');
  assert.equal(result.reportable, false);
});

test('a token with several equally close candidates is AMBIGUOUS, and is dropped', () => {
  // IBT is one edit from both IBIT and IOT. The parser cannot know which
  // instrument was meant, so the token is dropped rather than guessed.
  const result = resolveTickerToken('IBT', ctx());
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ticker, null);
  assert.deepEqual(result.candidates.sort(), ['IBIT', 'IOT']);
});

test('a token with no close candidate is unknown', () => {
  const result = resolveTickerToken('ZZZZZZZZ', ctx());
  assert.equal(result.status, 'unknown');
  assert.equal(result.ticker, null);
});

test('the edit distance is bounded', () => {
  // A one-ticker lexicon, so the nearest candidate is never in doubt.
  const tight = { matchTickers: ['ABCD'], matchSet: new Set(['ABCD']), allowSet: new Set(['ABCD']) };
  assert.equal(resolveTickerToken('ABCX', tight).status, 'corrected', 'one edit');
  assert.equal(resolveTickerToken('AB', tight).status, 'corrected', 'two edits');
  assert.equal(resolveTickerToken('A', tight).status, 'unknown', 'three edits is too far');
  assert.equal(DEFAULT_MAX_EDIT_DISTANCE, 2);
  assert.equal(resolveTickerToken('A', { ...tight, maxDistance: 3 }).status, 'corrected');
});

test('an empty token is unknown', () => {
  assert.equal(resolveTickerToken('', ctx()).status, 'unknown');
  assert.equal(resolveTickerToken(null, ctx()).status, 'unknown');
});

test('a fused token splits into its tickers', () => {
  // Tesseract loses the comma between two holdings and renders the loss as
  // nothing at all.
  const split = splitFusedTicker('TQQNCLD', ctx());
  assert.ok(split, 'TQQNCLD splits');
  assert.deepEqual(split.map((p) => p.text), ['TQQ', 'NCLD']);
  assert.equal(split[0].resolution.ticker, 'TQQQ');
  assert.equal(split[1].resolution.ticker, 'NCLD');
});

test('a fused token splits even when the second part needs a correction', () => {
  const split = splitFusedTicker('SPXLIBIT', ctx());
  assert.ok(split, 'SPXLIBIT splits');
  assert.deepEqual(split.map((p) => p.resolution.ticker).sort(), ['IBIT', 'SPXL']);
});

test('a two-character part must BE a ticker, not correct into one', () => {
  // "SPX" could split as "SP" + "X" if a two-character part were allowed to
  // correct: "SP" is one edit from "SPY", which would invent a holding.
  const split = splitFusedTicker('SPX', ctx());
  assert.equal(split, null, 'SPX does not split');
  // And a genuine two-character ticker is accepted as a part.
  const withP = splitFusedTicker('MUIBIT', ctx());
  assert.ok(withP, 'MUIBIT splits');
  assert.deepEqual(withP.map((p) => p.resolution.ticker).sort(), ['IBIT', 'MU']);
});

test('a token that cannot be split is not split', () => {
  assert.equal(splitFusedTicker('ZZZZZZ', ctx()), null);
  // Two tickers need at least four characters.
  assert.equal(splitFusedTicker('TQQQ', ctx()), null, 'one ticker is not a split');
});

test('a split prefers the most parts, then the fewest corrections', () => {
  const split = splitFusedTicker('TQQQNCLD', ctx());
  assert.ok(split);
  assert.deepEqual(split.map((p) => p.resolution.ticker).sort(), ['NCLD', 'TQQQ']);
});

test('the real lexicons keep their two jobs', () => {
  const { loadSeedLexiconSync, loadDecodeLexiconSync } = require('../src/normalize/tickerScan');
  const seed = loadSeedLexiconSync();
  const decode = loadDecodeLexiconSync();

  // The decode lexicon is the seed PLUS the observed tickers.
  assert.ok(decode.tickers.length > seed.tickers.length);
  for (const ticker of seed.tickers) {
    assert.ok(decode.tickerSet.has(ticker), `${ticker} is in the match list`);
  }
  // The allow list is the seed.
  assert.deepEqual([...seed.tickerSet].sort(), [...seed.tickers].sort());
  // Every seed ticker is reportable.
  for (const ticker of seed.tickers) {
    const result = resolveTickerToken(ticker, {
      matchTickers: decode.tickers,
      matchSet: decode.tickerSet,
      allowSet: seed.tickerSet,
    });
    assert.equal(result.status, 'exact');
    assert.equal(result.reportable, true, `${ticker} is reportable`);
  }
});
