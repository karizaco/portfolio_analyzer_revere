'use strict';

// The market, sector and macro-event readings.
//
// THE THREE THINGS THAT WERE WRONG, and each of them was measured on the
// pilot corpus (2026-11-12):
//
//   1. A direction word ANYWHERE in a caption became the stance of a
//      subject ANYWHERE in it. "We'll see what happens on General
//      Electric today if I'm able to nail this one. Let's get to some
//      other stocks" was published as a BEARISH reading on Consumer
//      Staples. YouTube's captions are rolling fragments, so a caption
//      holds the tail of one thought and the head of the next.
//
//   2. A MIXED reading was published at all. "the Nasdaq is down a lot"
//      inside a sentence that also says "I like" is not a mixed view of
//      the Nasdaq; it is a fragment with two unrelated halves.
//
//   3. A QUESTION was published as a claim. "What's the most overvalued
//      stock in the S&P 500?" is the host asking.
//
// And one thing that is a REPORTED reading: "all the headlines say, 'Oh,
// rates crashed the market'" is the market's opinion, not the host's.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractReadings, stanceNear, stanceOf } = require('../src/benzinga/marketReadings');

function segments(...texts) {
  return texts.map((text, index) => ({ start_sec: index * 5, end_sec: index * 5 + 5, text, confidence: null }));
}

test('a sector with a direction near it is a reading', () => {
  const out = extractReadings(segments('the banks were very strong all through the morning session today'), {});
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, 'sector');
  assert.equal(out[0].subject, 'Financials');
  assert.equal(out[0].stance, 'bullish');
  assert.equal(out[0].proxy_ticker, 'XLF');
});

test('a direction far from the subject is not its stance', () => {
  // The direction word is more than the window away from "Consumer
  // Staples", so the reading is not made.
  const text = `Consumer Staples ${'x'.repeat(80)} those names are selling off hard today`;
  const out = extractReadings(segments(text), {});
  assert.equal(out.length, 0);
});

test('a question is not a reading', () => {
  const out = extractReadings(segments("What's the most overvalued stock in the S&P 500 these days?"), {});
  assert.equal(out.length, 0);
});

test('a quoted opinion is reported, not the host\'s', () => {
  const out = extractReadings(segments('all the headlines say, "Oh, rates crashed the market" and people agree'), {});
  assert.ok(out.length >= 1, 'the sentence produced a reading');
  for (const reading of out) assert.equal(reading.claim_kind, 'reported');
});

test('a fragment shorter than the minimum is not a reading', () => {
  assert.equal(extractReadings(segments('semis up'), {}).length, 0);
});

test('a reading in a recap is retrospective', () => {
  const out = extractReadings(segments('yesterday the semiconductors were very weak and the market followed them down'), {
    sectionAt: () => 'recap',
  });
  assert.ok(out.length >= 1, 'the sentence produced a reading');
  for (const reading of out) assert.equal(reading.claim_kind, 'retrospective');
});

test('the same subject and stance is published once per video', () => {
  const out = extractReadings(segments(
    'the financials were very strong today',
    'and the financials are still very strong this afternoon',
  ), {});
  assert.equal(out.length, 1);
});

test('a negation reverses the stance', () => {
  assert.equal(stanceOf('I am not bullish on the financials right now'), 'bearish');
  assert.equal(stanceOf('I am not bearish on the financials right now'), 'bullish');
});

test('a weak word is not a direction', () => {
  // "I like it" rates the setup, not the direction -- the T3Live
  // extractor measured 1,021 occurrences of it, said about shorts as
  // often as about longs.
  assert.equal(stanceOf('I like the financials a lot'), null);
});

test('the stance is the direction NEAR the subject', () => {
  const text = 'the financials are strong but the semiconductors are very weak today';
  const financialsAt = text.indexOf('financials');
  assert.equal(stanceNear(text, financialsAt), 'bullish');
  const semisAt = text.indexOf('semiconductors');
  assert.equal(stanceNear(text, semisAt), 'bearish');
});

test('an index phrase is a market reading with an ETF proxy', () => {
  const out = extractReadings(segments('the Nasdaq is going to gap up here on the open this morning'), {});
  assert.equal(out.length, 1);
  assert.equal(out[0].scope, 'market');
  assert.equal(out[0].proxy_ticker, 'QQQ');
  assert.equal(out[0].stance, 'bullish');
});

test('a macro event is a reading of its own scope', () => {
  const out = extractReadings(segments('CPI is the event of the week and stocks fall'), {});
  const cpi = out.find((reading) => reading.subject === 'CPI');
  assert.ok(cpi, 'the CPI reading is there');
  assert.equal(cpi.scope, 'macro_event');
});
