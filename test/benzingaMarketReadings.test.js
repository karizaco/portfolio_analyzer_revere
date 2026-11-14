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

// THE STANCE RULES, and the measurement behind them.
//
// On 2026-11-13 a hand-labelled sample of 40 published readings was
// scored: 29 correct, 11 wrong -- a precision of 72.5 %. The wrong ones
// fall into two classes:
//
//   * the direction word is in ANOTHER CLAUSE ("were weak, and yet the
//     S&P 500 was up 40 points" read as a bearish reading on the S&P);
//   * the direction word is the subject's OBJECTIVE predicate ("rates
//     crashed the market", "Treasury rising"), so it comes BEFORE the
//     subject.
//
// The second class is why the rule is NOT "the direction word must come
// after the subject": in English the subject is often the object of the
// verb, and then its predicate precedes it. What separates a claim from
// a stray direction word is the CLAUSE, not the order.
//
// The rules are SELECTABLE, and the default is unchanged until the
// decision is made. Measured on the sample:
//
//   shipped              40 survive, 29 right = 72.5 %  (215 corpus readings)
//   same-clause          33 survive, 26 right = 78.8 %  (195)
//   after-only           21 survive, 19 right = 90.5 %  (161)
//   same-clause+after    20 survive, 19 right = 95.0 %  (149)

test('the shipped rule still reads a stance from either side of the subject', () => {
  // The predicate FOLLOWS the subject: "the financials are strong".
  const text = 'the financials are very strong here today';
  assert.equal(stanceNear(text, text.indexOf('financials')), 'bullish');
  // And the FALLBACK still works: the subject is the object of the verb.
  const before = 'rates crashed the market and it was ugly';
  assert.equal(stanceNear(before, before.indexOf('the market')), 'bearish');
});

test('the same-clause rule ignores a direction word from another clause', () => {
  // "were weak" belongs to the small caps, and the S&P "held its own" --
  // which is not a direction word. The shipped rule has no word after
  // the subject, so it FALLS BACK to the one before it, across a clause
  // boundary, and reads the index as bearish. The same-clause rule
  // refuses the word from the previous clause and publishes nothing.
  const text = 'markets were weak, and yet the S&P 500 held its own';
  const at = text.indexOf('S&P 500');
  assert.equal(stanceNear(text, at), 'bearish', 'the shipped rule takes the stray word');
  assert.equal(stanceNear(text, at, { sameClause: true }), null,
    'the same-clause rule finds no direction word in its own clause');
});

test('an index move stated in points is a direction', () => {
  // "up 40 points" is how a show states an index's move, and it is the
  // most common form of the claim there is. Before the vocabulary
  // carried it, this segment had NO direction word after the subject
  // and the reading was taken from the "weak" of a previous clause.
  const text = 'the small caps were weak, and yet the S&P 500 was up 40 points';
  const at = text.indexOf('S&P 500');
  assert.equal(stanceNear(text, at), 'bullish');
});

test('the after-only rule refuses a direction word before the subject', () => {
  // The subject is the object of the verb, so its predicate comes first.
  const text = 'rates crashed the market and it was ugly';
  const at = text.indexOf('the market');
  assert.equal(stanceNear(text, at, { afterOnly: true }), null,
    'no direction word follows the subject, so there is no reading');
});

test('the extractor takes the stance rule from its options', () => {
  const text = 'markets were weak, and yet the S&P 500 held its own on the day';
  const loose = extractReadings(segments(text), { stanceOptions: {} });
  const strict = extractReadings(segments(text), { stanceOptions: { sameClause: true } });
  const spx = (rows) => rows.find((r) => r.subject === 'the S&P 500');
  assert.ok(spx(loose), 'the shipped rule publishes a reading on the index');
  assert.equal(spx(loose).stance, 'bearish', 'and it is the wrong one');
  assert.equal(spx(strict), undefined,
    'the strict rule publishes nothing, because there is no direction word in its clause');
});

test('a move stated as a PERCENT is a move, in either direction', () => {
  // "The SPY was up 0.69%" is the same claim as "up 40 points" in a
  // different unit -- and it is the form a PER-NAME move takes, where a
  // points count is an index's. The number is what makes it a move: a
  // bare "up" is "pick up", and a bare "down" is "back down".
  const up = extractReadings(segments('The SPY was up 0.69% at the open on Wednesday morning.'));
  const spx = up.find((r) => r.subject === 'the S&P 500');
  assert.ok(spx, 'the ETF name reaches the S&P subject');
  assert.equal(spx.stance, 'bullish');

  const down = extractReadings(segments('QQQ down 1.4% into the close after that weak tape.'));
  const ndx = down.find((r) => r.subject === 'the Nasdaq');
  assert.ok(ndx);
  assert.equal(ndx.stance, 'bearish');

  // And a bare word is still not a move.
  assert.equal(stanceNear('we will pick up the pieces on that name', 20), null);
});

test('a percentage move is a move and a data print is not', () => {
  // "PPI was higher than expected" describes a RELEASE, not a market
  // direction -- so the comparatives stay out of the vocabulary. The
  // measurement over 6,000 subject-naming caption lines found exactly
  // this: the one form the vocabulary was missing by more than five
  // readings was "were higher", and four of its five samples were data
  // prints rather than market calls.
  assert.equal(stanceNear('the PPI numbers were higher than expected', 24), null,
    'a higher data print is not a bullish market reading');
});
