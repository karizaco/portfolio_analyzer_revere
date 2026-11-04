'use strict';

// The setup segmenter and the certainty scale.
//
// WHAT THESE TESTS PIN
//
// Two things that were measured on the 12-stream corpus and then had to
// be got right:
//
//   1. The segmenter finds a setup for EVERY ticker the speaker sets up,
//      and does not blend two tickers into one setup.
//
//   2. The certainty scale reads the SPEAKER'S language, and refuses to
//      read a negated "one hundred percent" as certainty -- because he
//      says it to DENY that any of his calls is a certainty.
//
// The corpus is untracked, so the real numbers cannot be asserted here.
// What IS assertable is the behaviour, and that is what these tests do.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSetupRuns,
  findSetups,
  readSetupState,
} = require('../src/sevcik/setupSegmenter');

const {
  readCertainty,
  readSetupCertainty,
  certaintyConfidence,
} = require('../src/sevcik/certainty');

// The lexicon the tests use. The names in it are the CONFIRMED ones, so
// the name matcher resolves them the way it resolves a real name.
const LEXICON = new Set(['TSLA', 'AAPL', 'MSFT', 'INTC', 'GOOG', 'AMZN', 'NVDA']);

function seg(text, startSec = 0) {
  return { start_sec: startSec, end_sec: startSec + 2, text };
}

// -- THE SEGMENTER -----------------------------------------------------

test('a setup is found for the ticker it is about', () => {
  const segments = [
    seg('Takže to 10 Tesla nevypadá špatně. Nová predikce na Tesla.'),
    seg('Pokud překoná horní hranu kanálu, tak je to Long.'),
  ];
  const setups = findSetups({ segments, lexicon: LEXICON });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].ticker, 'TSLA');
});

test('the state is read off the words', () => {
  assert.equal(readSetupState('predikce vyšla'), 'worked');
  assert.equal(readSetupState('predikce nevyšla'), 'failed');
  assert.equal(readSetupState('predikce zneplatněna'), 'invalidated');
  assert.equal(readSetupState('mám tady novou predikci'), 'new');
  assert.equal(readSetupState('predikce běží'), 'running');
});

test('two tickers are two setups, not one blended setup', () => {
  const segments = [
    seg('Takže to 10 Tesla. Nová predikce na Tesla je Long.'),
    seg('A teď Microsoft. Takže nová predikce na Microsoft je Long.'),
  ];
  const setups = findSetups({ segments, lexicon: LEXICON });
  const tickers = setups.map((setup) => setup.ticker).sort();
  assert.deepEqual(tickers, ['MSFT', 'TSLA']);
  // And neither setup carries the other's evidence.
  const tsla = setups.find((setup) => setup.ticker === 'TSLA');
  const msft = setups.find((setup) => setup.ticker === 'MSFT');
  assert.ok(tsla.evidence.join(' ').includes('Tesla'));
  assert.ok(!tsla.evidence.join(' ').includes('Microsoft'));
  assert.ok(msft.evidence.join(' ').includes('Microsoft'));
});

test('a setup is found even when the ticker is named further away', () => {
  // The measured failure of the nearest-ticker rule: the ticker was
  // named six segments before the "predikce" sentence, and the setup
  // was dropped entirely.
  const segments = [
    seg('Dnes se podíváme na Intel.'),
    seg('Máme tady kanál.'),
    seg('Úroveň je kolem 25.'),
    seg('Tady se drží.'),
    seg('A ještě něco.'),
    seg('No a co na to říkáte?'),
    seg('Tady je predikce, pokud půjde do Longu.'),
  ];
  const setups = findSetups({ segments, lexicon: LEXICON });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].ticker, 'INTC');
});

test('the LAST state is the state the setup is in', () => {
  const segments = [
    seg('Takže to 10 Tesla. Tahle ta predikce vyšla.'),
    seg('A ale jinak. Predikce na Tesla běží dál.'),
  ];
  const setups = findSetups({ segments, lexicon: LEXICON });
  assert.equal(setups[0].state, 'running');
  assert.ok(setups[0].worked, 'the setup did work at one point');
  assert.ok(setups[0].still_running, 'and it is still running');
});

test('an invalidated setup is marked as invalidated', () => {
  const segments = [
    seg('Takže to 10 Tesla. Tahle ta predikce běží.'),
    seg('A tady prodejce do Long byla zneplatněná.'),
  ];
  const setups = findSetups({ segments, lexicon: LEXICON });
  assert.equal(setups[0].state, 'invalidated');
  assert.ok(setups[0].invalidated);
});

test('the run owns the speech that follows the name', () => {
  const runs = buildSetupRuns([
    seg('Řekl jsme si, že to 10 Tesla bude fungovat.'),
    seg('Pokud překoná hranu kanálu, tak je to Long.'),
  ], LEXICON);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ticker, 'TSLA');
  assert.ok(runs[0].text.includes('bude fungovat'));
});

test('a transcript with no setup marker has no setup', () => {
  const segments = [seg('Takže to 10 Tesla nevypadá špatně.')];
  assert.equal(findSetups({ segments, lexicon: LEXICON }).length, 0);
});

test('an empty transcript has no setup', () => {
  assert.deepEqual(findSetups({ segments: [], lexicon: LEXICON }), []);
});

// -- THE CERTAINTY SCALE ------------------------------------------------

test('a strong signal is HIGH certainty', () => {
  const result = readCertainty('tak je to silnější signál do Longu');
  assert.equal(result.level, 'high');
});

test('a very strong signal is HIGH certainty', () => {
  const result = readCertainty('bude to velmi silný signál');
  assert.equal(result.level, 'high');
});

test('a conditional call is CONDITIONAL, not low', () => {
  // "podmineny" is his DEFAULT form for a live setup, so it is not a
  // point on the high-to-low scale.
  const result = readCertainty('Tahle je podmíněný short, pokud propadne pod');
  assert.equal(result.level, 'conditional');
});

test('even odds are EVEN', () => {
  const result = readCertainty('znamená to, že je to 50 na 50');
  assert.equal(result.level, 'even');
});

test('"I do not know" is LOW certainty', () => {
  const result = readCertainty('nevím, kam půjdou akcie');
  assert.equal(result.level, 'low');
  assert.ok(result.direction_uncertain, 'and it says the direction is unknown');
});

test('a NEGATED "one hundred percent" is not certainty', () => {
  // He says this: "Není to žádná stoprocentní jistota, nikdy to nebyla.
  // Je to jenom počítání pravděpodobnosti."
  const result = readCertainty('Není to žádná stoprocentní jistota, nikdy to nebyla.');
  assert.notEqual(result.level, 'certain');
  assert.equal(result.level, 'low');
  assert.ok(result.negated);
});

test('an un-negated "one hundred percent" IS certainty', () => {
  const result = readCertainty('tohle tvrzení bude teďka stoprocentně fungovat');
  assert.equal(result.level, 'certain');
});

test('"jasne" alone is NOT certainty', () => {
  // 66 of the 68 "jasny" in the corpus are the filler "Jasne!" --
  // "Of course!" -- and only two are about a signal.
  const result = readCertainty('Jasně, ahoj Davide, prosím ještě by mě zajímalo');
  assert.equal(result.level, 'unknown');
});

test('"jasny signal" IS certainty', () => {
  const result = readCertainty('vydal jasný signál');
  assert.equal(result.level, 'high');
});

test('a stated probability is recorded', () => {
  const result = readCertainty('a 40% pravděpodobnost');
  assert.equal(result.probability, 40);
});

test('the scale is ordered', () => {
  assert.ok(certaintyConfidence('certain') > certaintyConfidence('high'));
  assert.ok(certaintyConfidence('high') > certaintyConfidence('even'));
  assert.ok(certaintyConfidence('even') > certaintyConfidence('conditional'));
  assert.ok(certaintyConfidence('conditional') > certaintyConfidence('low'));
});

test('a setup keeps its hedge visible when it states a strong signal', () => {
  // "I am bullish on it... actually, I don't know where it goes from
  // here" is a strong setup with an uncertain DIRECTION, and the two
  // are separate questions.
  const result = readSetupCertainty(
    'Tady je velmi silný signál do Longu. Ale nevím, jestli to stane tady nebo tady.',
  );
  assert.equal(result.level, 'high');
  assert.ok(result.hedged, 'the hedge is recorded');
  assert.ok(result.direction_uncertain, 'and the direction is uncertain');
});

test('a setup with no certainty language is UNKNOWN', () => {
  const result = readSetupCertainty('Takže to 10 Tesla. Nová predikce na Tesla.');
  assert.equal(result.level, 'unknown');
});
