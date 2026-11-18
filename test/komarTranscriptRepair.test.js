'use strict';

// The ticker the provider SPLIT across a boundary, and the repair.
//
// WHY THIS IS HERE
//
// The Komar corpus's transcripts were checked boundary by boundary
// against the corpus's own lexicon: a ticker is BROKEN when its two
// halves fall on either side of a boundary and neither half is a
// ticker itself. Over the 116 transcripts' 50,884 boundaries that
// produced three candidates, and one of them is real:
//
//   "I bought into DF," | "DV. I see a lot of positive momentum"
//
// The provider's own WORD LIST says why: it carries "df" and "dv" as
// TWO words, and the boundary falls between them. So this is the
// provider's TOKENISATION, not its endpointing -- and a join in the
// shared segmenter could never have repaired it, because there is no
// whole word to recover.
//
// The repair is the Komar's own (it needs the corpus's tickers to
// decide) and it cannot invent a holding: the joined form has to BE a
// ticker the corpus knows.

const test = require('node:test');
const assert = require('node:assert/strict');

const { rejoinBrokenTickers } = require('../src/komar/transcriptRepair');
const { loadKomarKeyterms, loadKomarLexicon } = require('../src/komar/lexicon');

const lexicon = loadKomarLexicon();

/**
 * The segments of a two-boundary text.
 *
 * @param {string} left
 * @param {string} right
 */
function segments(left, right) {
  return [
    { confidence: 0.9, end_sec: 10, start_sec: 0, text: left },
    { confidence: 0.9, end_sec: 20, start_sec: 11, text: right },
  ];
}

test('a ticker split across a boundary is rejoined', () => {
  const result = rejoinBrokenTickers(
    segments('I bought into DF,', 'DV. I see a lot of positive momentum'),
    { lexicon },
  );
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].joined, 'DFDV');
  assert.equal(result.segments[0].text, 'I bought into DFDV.');
  assert.equal(result.segments[1].text, 'I see a lot of positive momentum');
});

test('the repair does not touch the stored transcript', () => {
  const stored = segments('I bought into DF,', 'DV. I see a lot of positive momentum');
  const result = rejoinBrokenTickers(stored, { lexicon });
  // The transcript is the provider's record. The repair is what the
  // extractor reads, and the stored file is never rewritten.
  assert.equal(stored[0].text, 'I bought into DF,');
  assert.equal(stored[1].text, 'DV. I see a lot of positive momentum');
});

test('ordinary speech is not joined into a ticker', () => {
  // "go go" is the phrase; GOGO is a ticker the corpus trades.
  const result = rejoinBrokenTickers(
    segments('and then only go', 'go from this optimum position size'),
    { lexicon },
  );
  assert.equal(result.repairs.length, 0);
});

test('a boundary after a ticker is a sentence boundary, not a split', () => {
  // "my trade in QS," | "I think QS was up more than 100%" -- the two
  // halves would join into QSI, which the corpus trades, but QS is a
  // ticker itself, so the join is refused.
  const result = rejoinBrokenTickers(
    segments('and this is based on the average opening price. So my trade in QS,', 'I think QS was up more than 100%'),
    { lexicon },
  );
  assert.equal(result.repairs.length, 0);
});

test('a joined form the corpus does not know is not joined', () => {
  const result = rejoinBrokenTickers(
    segments('I bought into XY,', 'ZW. It went up'),
    { lexicon },
  );
  assert.equal(result.repairs.length, 0);
});

test('a ticker that is already whole is not joined to itself', () => {
  const result = rejoinBrokenTickers(
    segments('I bought into DFDV,', 'and it went up'),
    { lexicon },
  );
  assert.equal(result.repairs.length, 0);
});

test('the repair needs a lexicon, and an empty one joins nothing', () => {
  const result = rejoinBrokenTickers(
    segments('I bought into DF,', 'DV. I see a lot of positive momentum'),
    { lexicon: new Set() },
  );
  assert.equal(result.repairs.length, 0);
  assert.equal(result.segments[0].text, 'I bought into DF,');
});

test('the corpus\'s own terms are the corpus\'s own tickers', () => {
  const terms = loadKomarKeyterms();
  assert.ok(terms.includes('DFDV'), 'DFDV is a corpus holding');
  assert.ok(terms.includes('ONDS'), 'ONDS is a corpus holding');
  // The terms are the CORPUS's, not the shared seed's: the Komar corpus
  // does not trade the seed's other sources' names.
  assert.ok(!terms.includes('TQQQ'), 'TQQQ is not a Komar holding');
  assert.ok(!terms.includes('PLTR'), 'PLTR is not a Komar holding');
});
