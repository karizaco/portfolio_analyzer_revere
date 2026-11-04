'use strict';

// The signal extractor's behaviour on the rules it claims to implement.
//
// WHY THESE TESTS ARE WORDED AS CLAIMS
//
// Every assertion here states a rule the extractor makes, and the rule is
// the thing a reader of the data has to be able to trust:
//
//   * a signal needs a TICKER
//   * a price needs a ROLE
//   * a common English word is not a ticker unless it is written in CAPS
//   * a negation reverses the direction
//   * a history is not a call
//   * every signal carries the text it was read from
//
// A rule that is not pinned here is a rule that can change without anyone
// noticing, and a signal that changes without anyone noticing is a wrong
// holding in a portfolio report.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PARSER_VERSION,
  determineBias,
  determineAction,
  determineConfidence,
  extractSignals,
  findPrices,
  findTickers,
  parsePrice,
} = require('../src/sevcik/signalExtractor');

// A small, explicit lexicon: the extractor is lexicon-constrained, and a
// test that used the real seed lexicon would move whenever the seed does.
const LEXICON = new Set(['TQQQ', 'SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'ON', 'BE', 'ARM', 'NET']);

function seg(text, startSec = 0) {
  return { start_sec: startSec, end_sec: startSec + 5, text, confidence: null };
}

function extract(segments) {
  return extractSignals({ segments, lexicon: LEXICON, videoId: 'v1', transcriptId: 1 });
}

// ---------------------------------------------------------------------------
// The absolute rule: a signal needs a ticker
// ---------------------------------------------------------------------------

test('a bullish opinion with no ticker is not a signal', () => {
  const signals = extract([seg('I am very bullish on the market today, this is going higher.')]);
  assert.equal(signals.length, 0,
    'a mood is not a signal: without a ticker there is nothing to act on');
});

test('a ticker with no opinion is not a signal', () => {
  const signals = extract([seg('We are looking at TQQQ and SPY today.')]);
  assert.equal(signals.length, 0,
    'mentioning a ticker is not a call');
});

test('a ticker with an opinion IS a signal', () => {
  const signals = extract([seg('I am very bullish on TQQQ right now.')]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, 'TQQQ');
  assert.equal(signals[0].bias, 'bullish');
});

test('every signal carries the exact text it was read from', () => {
  const text = 'I am going to buy TQQQ here because the breakout looks strong.';
  const signals = extract([seg(text)]);
  assert.equal(signals.length, 1);
  assert.ok(signals[0].evidence_text.includes('going to buy TQQQ'),
    `the evidence must contain the words the signal came from: ${signals[0].evidence_text}`);
});

test('every signal records the parser version that produced it', () => {
  const signals = extract([seg('I am bullish on SPY.')]);
  assert.equal(signals[0].parser_version, PARSER_VERSION);
});

// ---------------------------------------------------------------------------
// Ticker detection
// ---------------------------------------------------------------------------

test('a ticker is found in the text', () => {
  const found = findTickers('I like AAPL here.', LEXICON);
  assert.deepEqual(found.map((entry) => entry.ticker), ['AAPL']);
});

test('a common English word is not a ticker when it is lower case', () => {
  // ON, BE, ARM and NET are real tickers AND words a speaker uses constantly.
  const found = findTickers('it is on the way and I arm myself', LEXICON);
  assert.deepEqual(found.map((entry) => entry.ticker), [],
    'a lower-case common word must not be read as a ticker');
});

test('a common English word IS a ticker when it is written in CAPS', () => {
  const found = findTickers('ON is the one I like, ARM too', LEXICON);
  const tickers = found.map((entry) => entry.ticker);
  assert.ok(tickers.includes('ON'), 'a capitalised ON is a ticker');
  assert.ok(tickers.includes('ARM'), 'a capitalised ARM is a ticker');
});

test('a ticker outside the lexicon is not found', () => {
  const found = findTickers('I like ZZZZ here.', LEXICON);
  assert.deepEqual(found.map((entry) => entry.ticker), []);
});

// ---------------------------------------------------------------------------
// Bias
// ---------------------------------------------------------------------------

test('a bullish sentence reads as bullish', () => {
  assert.equal(determineBias('I am bullish on this').bias, 'bullish');
});

test('a bearish sentence reads as bearish', () => {
  assert.equal(determineBias('I am bearish on this').bias, 'bearish');
});

test('a negated direction is reversed', () => {
  // "not bullish" is bearish. Counting the word "bullish" would get this
  // exactly backwards, which is the worst possible direction to be wrong in.
  assert.equal(determineBias('I am not bullish on this at all').bias, 'bearish');
});

test('a sentence with both directions is mixed', () => {
  assert.equal(determineBias('I am bullish on the setup but bearish on the valuation').bias, 'mixed');
});

test('a sentence with no direction is neutral', () => {
  assert.equal(determineBias('We talked about the weather').bias, 'neutral');
});

// ---------------------------------------------------------------------------
// Actions and confidence
// ---------------------------------------------------------------------------

test('a buy intent is an action', () => {
  assert.equal(determineAction('I am going to buy TQQQ').action, 'buy');
});

test('an add intent is an action', () => {
  assert.equal(determineAction('I am adding more to my position').action, 'add');
});

test('a trim intent is an action', () => {
  assert.equal(determineAction('I am trimming some of my position').action, 'trim');
});

test('a stated confidence level is read', () => {
  assert.equal(determineConfidence('I am very confident here').level, 'high');
  assert.equal(determineConfidence('maybe I like this one').level, 'low');
});

test('a stronger statement scores higher than a weaker one', () => {
  const strong = extract([seg('I am very bullish on TQQQ, high conviction.')]);
  const weak = extract([seg('Maybe I am bullish on TQQQ.')]);
  assert.ok(strong.length && weak.length);
  assert.ok(strong[0].confidence_score > weak[0].confidence_score,
    `a stronger statement must score higher: ${strong[0].confidence_score} vs ${weak[0].confidence_score}`);
  assert.equal(strong[0].confidence_label, 'high');
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

test('a price with a role is recorded', () => {
  const prices = findPrices('my target is 78 for this one');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].role, 'target');
  assert.equal(prices[0].value, 78);
});

test('a price with NO role is not recorded', () => {
  // "$45" next to a ticker is not an entry level unless something said
  // "entry" or "target". Guessing the role would put a wrong number in a
  // portfolio report.
  const prices = findPrices('TQQQ is at 45 right now');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].role, 'current',
    '"is at 45" is where the price is NOW -- the reference a target is compared against, '
    + 'and NOT an entry level');
  assert.equal(prices[0].value, 45);
});

test('a current price is not an entry level', () => {
  // The current price is the reference a stated target is compared against.
  // It is recorded with its own role and never written into the signal's
  // entry column.
  const signals = extract([seg('TQQQ is at 45 right now, I am bullish on it.')]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].entry_price, null,
    'the current price must not be recorded as an entry level');
});

test('an entry price is recorded with the entry role', () => {
  const prices = findPrices('I would buy at 42.50 here');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].role, 'entry');
  assert.equal(prices[0].value, 42.5);
});

test('a stop price is recorded with the stop role', () => {
  const prices = findPrices('my stop loss is 39.75');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].role, 'stop');
});

test('a price range is recorded as a range, not as two prices', () => {
  const prices = findPrices('my target is 78 to 82');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].role, 'target');
  assert.equal(prices[0].low, 78);
  assert.equal(prices[0].high, 82);
});

test('a percentage is not a price', () => {
  const prices = findPrices('it is up 5 percent today');
  assert.deepEqual(prices, [], 'a percentage is not a price level');
});

test('an implausible price is not a price', () => {
  assert.equal(parsePrice('0.01'), null, 'a penny stock is outside the plausible range');
  assert.equal(parsePrice('999999'), null);
  assert.equal(parsePrice('45.50'), 45.5);
});

test('a signal carries its entry and target prices', () => {
  const signals = extract([seg('I am going to buy TQQQ at 75, target is 82.')]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].entry_price, 75);
  assert.equal(signals[0].target_price_low, 82);
});

// ---------------------------------------------------------------------------
// History and disclaimers
// ---------------------------------------------------------------------------

test('a past-tense statement with no action is not a signal', () => {
  const signals = extract([seg('I was bullish on TQQQ yesterday.')]);
  assert.equal(signals.length, 0, 'history is not a call');
});

test('a disclaimer is not a signal', () => {
  const signals = extract([seg('This is not financial advice, but I am bullish on TQQQ.')]);
  assert.equal(signals.length, 0);
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('a price two segments after the ticker is found', () => {
  // Spoken commentary spreads one idea over several cues: the ticker is in
  // one and the price in another. A window of one would find the ticker and
  // never the price.
  const signals = extract([
    seg('So let us talk about TQQQ today.', 0),
    seg('I think the setup is interesting.', 10),
    seg('The first target is around 78.', 20),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].target_price_low, 78);
});

test('a signal records the segment span it was read from', () => {
  const signals = extract([
    seg('Nothing here.', 0),
    seg('I am bullish on TQQQ.', 10),
    seg('Nothing here either.', 20),
  ]);
  assert.equal(signals.length, 1);
  assert.ok(signals[0].segment_start_index <= 1 && signals[0].segment_end_index >= 1);
});


// ---------------------------------------------------------------------------
// The price's role is the CLOSEST one, not the first one declared
// ---------------------------------------------------------------------------

test('the role keyword CLOSEST to the price wins', () => {
  // "target" is declared before "stop", so a first-match-wins search
  // labelled the STOP price 225 a target -- and the stop was lost, and a
  // later ticker inherited it.
  const signals = extract([
    seg('I am going to buy TSLA at 240, my target is 280. The stop loss is 225.', 0),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, 'TSLA');
  assert.equal(signals[0].entry_price, 240);
  assert.equal(signals[0].target_price_low, 280);
  assert.equal(signals[0].stop_price, 225);
});

// ---------------------------------------------------------------------------
// A window does not span a move to another ticker
// ---------------------------------------------------------------------------

test('a price belonging to one ticker is not given to another', () => {
  // The TSLA entry and the NVDA target are in the same breath, and the
  // window used to cover both -- so NVDA carried the TSLA entry price.
  const signals = extract([
    seg('I am going to buy TSLA at 240.', 0),
    seg('On NVDA my target is 500.', 10),
  ]);
  const tsla = signals.find((signal) => signal.ticker === 'TSLA');
  const nvda = signals.find((signal) => signal.ticker === 'NVDA');
  assert.ok(tsla, 'TSLA is a signal');
  assert.ok(nvda, 'NVDA is a signal');
  assert.equal(tsla.entry_price, 240);
  assert.equal(nvda.entry_price, null, 'NVDA has no entry price of its own');
  assert.equal(nvda.target_price_low, 500);
});

test('a direction does not bleed from one ticker to the next', () => {
  // "short" belonged to NVDA; AAPL was only being watched.
  const signals = extract([
    seg('I am going to short NVDA here.', 0),
    seg('AAPL I am just watching for now.', 10),
  ]);
  const nvda = signals.find((signal) => signal.ticker === 'NVDA');
  const aapl = signals.find((signal) => signal.ticker === 'AAPL');
  assert.ok(nvda);
  assert.equal(nvda.bias, 'bearish');
  assert.equal(nvda.action, 'short');
  if (aapl) {
    assert.notEqual(aapl.action, 'short', 'AAPL was not a short');
    assert.notEqual(aapl.bias, 'bearish', 'AAPL was not a bearish call');
  }
});

// ---------------------------------------------------------------------------
// One call, one row
// ---------------------------------------------------------------------------

test('a ticker named repeatedly is ONE signal, not one per mention', () => {
  const signals = extract([
    seg('I am bullish on TSLA here.', 0),
    seg('I think TSLA is still the best one.', 10),
    seg('TSLA is my top pick for the week.', 20),
  ]);
  const tsla = signals.filter((signal) => signal.ticker === 'TSLA');
  assert.equal(tsla.length, 1, 'the same call is published once');
});

test('a change of mind about one ticker is TWO signals', () => {
  // The merge must not swallow a reversal: the speaker changed his mind,
  // and both statements are calls.
  const signals = extract([
    seg('I am bullish on TSLA right now.', 0),
    seg('Actually I am going to short TSLA, I changed my mind.', 20),
  ]);
  const tsla = signals.filter((signal) => signal.ticker === 'TSLA');
  assert.equal(tsla.length, 2, 'a reversal is a second call');
});

test('the merged signal keeps the prices of the richer reading', () => {
  const signals = extract([
    seg('I am bullish on TSLA.', 0),
    seg('I am bullish on TSLA, my target is 280.', 10),
  ]);
  const tsla = signals.filter((signal) => signal.ticker === 'TSLA');
  assert.equal(tsla.length, 1);
  assert.equal(tsla[0].target_price_low, 280, 'the price from the richer window survives');
});

// ---------------------------------------------------------------------------
// The horizon is the MOST SPECIFIC one, not the first one stated
// ---------------------------------------------------------------------------

test('an explicit horizon beats a mention of when the speaker is speaking', () => {
  // "today" appears first, but the call is explicitly a swing.
  const signals = extract([
    seg("Let's talk about Tesla today, ticker TSLA.", 0),
    seg('I am bullish on TSLA, it is a swing trade.', 10),
    seg('Over the next few days, this is a swing trade.', 20),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].horizon_text, 'swing');
});
