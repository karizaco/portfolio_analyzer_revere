'use strict';

// The Benzinga corrections to the shared extractor.
//
// THREE DEFECTS, THREE MEASURED CASES
//
//   1. A REPORTED opinion was published as the host's own call.
//      "Wedbush's Dan Ives remains very bullish on Tesla" became a bullish
//      TSLA at confidence 0.83 (shared extractor, T3Live's English
//      settings, 2026-11-11).
//
//   2. SELLING PUTS was published as a bearish call. Selling a put is a
//      BULLISH position -- the seller is paid to buy the stock at the
//      strike. "I'm going to sell some puts" became a bearish CRWV with
//      action `sell`.
//
//   3. A recap is history. A claim in a recap of what already happened is
//      not a prediction.
//
// The corrections are a POST-PASS on the shared engine's output, so
// Sevcik's and T3Live's numbers cannot move.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reportedClaim, isBrokerMention } = require('../src/benzinga/attribution');
const { optionsDirection } = require('../src/benzinga/options');
const { sectionAt } = require('../src/benzinga/sections');
const { applyBenzingaRules, PARSER_VERSION } = require('../tools/extractBenzingaSignals');

// ─── Attribution ───────────────────────────────────────────────────────────

test('an analyst\'s opinion is reported, not the host\'s call', () => {
  const result = reportedClaim("Wedbush's Dan Ives remains very bullish on Tesla heading into next week.");
  assert.equal(result.reported, true);
});

test('a price target is reported', () => {
  const result = reportedClaim('Morgan Stanley raised its price target on Nvidia to 250 dollars, they are bullish on the name.');
  assert.equal(result.reported, true);
});

test('"according to" is reported', () => {
  assert.equal(reportedClaim('According to Morgan Stanley, NVDA is a buy.').reported, true);
});

test('the host\'s own bullishness is NOT reported', () => {
  assert.equal(reportedClaim('I remain bullish on Nvidia here.').reported, false);
  assert.equal(reportedClaim('We are bullish on the market today.').reported, false);
  assert.equal(reportedClaim('My price target on TSLA is 300.').reported, false);
  assert.equal(reportedClaim('I expect NVDA to run to new highs.').reported, false);
});

test('a plain call with no attribution is not reported', () => {
  assert.equal(reportedClaim('I am going to buy NVDA here and add on weakness.').reported, false);
});

// ─── Options ───────────────────────────────────────────────────────────────

test('selling puts is bullish', () => {
  assert.deepEqual(optionsDirection("I'm going to sell some puts here at the 80 strike."), {
    direction: 'bullish', kind: 'sell_put',
  });
});

test('buying puts is bearish', () => {
  assert.equal(optionsDirection('I am buying puts on CRWV here.').direction, 'bearish');
});

test('selling calls is bearish and buying calls is bullish', () => {
  assert.equal(optionsDirection('I sold calls on NVDA to finance the put.').direction, 'bearish');
  assert.equal(optionsDirection('I bought calls on TSLA for the breakout.').direction, 'bullish');
});

test('a bull put spread is bullish and a bear put spread is bearish', () => {
  assert.equal(optionsDirection('Looking at a bull put spread on PLTR.').direction, 'bullish');
  assert.equal(optionsDirection('Looking at a bear put spread on PLTR.').direction, 'bearish');
});

test('ordinary language has no options direction', () => {
  assert.equal(optionsDirection('I am selling some of my NVDA here.'), null);
});

// ─── Sections ──────────────────────────────────────────────────────────────

function segments(...texts) {
  return texts.map((text, index) => ({ start_sec: index * 5, end_sec: index * 5 + 5, text, confidence: null }));
}

test('a recap cue puts the claim in the recap', () => {
  const segs = segments('Good morning everybody.', 'Yesterday the market sold off hard.', 'We will talk about what to do next.');
  assert.equal(sectionAt(segs, 2), 'recap');
});

test('a preview cue puts the claim in the preview', () => {
  const segs = segments('Good morning.', 'Looking ahead to next week, here is the calendar.', 'CPI lands Wednesday.');
  assert.equal(sectionAt(segs, 2), 'preview');
});

test('a sponsor cue puts the claim in the sponsor segment', () => {
  const segs = segments('This segment is brought to you by our partner.', 'Use the promo code when you sign up.');
  assert.equal(sectionAt(segs, 1), 'sponsor');
});

// ─── The post-pass ─────────────────────────────────────────────────────────

function baseSignal(evidence, extra = {}) {
  return {
    video_id: 'v1',
    transcript_id: null,
    segment_start_index: 0,
    segment_end_index: 0,
    event_time_sec: 0,
    ticker: 'NVDA',
    action: 'buy',
    bias: 'bullish',
    claim_kind: 'forward',
    confidence_label: 'high',
    confidence_score: 0.8,
    entry_price: null,
    target_price_low: null,
    target_price_high: null,
    stop_price: null,
    horizon_text: '',
    rationale: '',
    evidence_text: evidence,
    parser_version: 'sevcik-signals-5',
    ...extra,
  };
}

test('a reported claim is tagged, neutralised and not scored', () => {
  const out = applyBenzingaRules(
    [baseSignal("Wedbush's Dan Ives remains very bullish on Tesla heading into next week.")],
    segments('Some context.'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].claim_kind, 'reported');
  assert.equal(out[0].bias, 'neutral');
  assert.equal(out[0].confidence_score, null);
  assert.equal(out[0].parser_version, PARSER_VERSION);
});

test('the host\'s own call is left alone', () => {
  const out = applyBenzingaRules(
    [baseSignal('I am going to buy NVDA here and add on weakness.')],
    segments('Some context.'),
  );
  assert.equal(out[0].claim_kind, 'forward');
  assert.equal(out[0].bias, 'bullish');
  assert.equal(out[0].confidence_score, 0.8);
});

test('selling puts is republished as bullish', () => {
  const out = applyBenzingaRules(
    [baseSignal("On CRWV I'm going to sell some puts here at the 80 strike.", { ticker: 'CRWV', bias: 'bearish', action: 'sell' })],
    segments('Some context.'),
  );
  assert.equal(out[0].bias, 'bullish');
  assert.equal(out[0].options_kind, 'sell_put');
});

test('a strike price is not published as an entry price', () => {
  const out = applyBenzingaRules(
    [baseSignal("On CRWV I'm going to sell some puts here at the 80 strike.", { entry_price: 80 })],
    segments('Some context.'),
  );
  assert.equal(out[0].entry_price, null);
});

test('a claim in a recap is retrospective', () => {
  const segs = segments('Yesterday the market sold off.', 'NVDA held up better than the rest.');
  const out = applyBenzingaRules([baseSignal('NVDA held up better than the rest.')], segs);
  assert.equal(out[0].claim_kind, 'retrospective');
});

test('a broker\'s own name never becomes a call on the broker', () => {
  const out = applyBenzingaRules(
    [baseSignal('Morgan Stanley raised its price target on Nvidia, they are bullish.', { ticker: 'MS' })],
    segments('Some context.'),
  );
  assert.equal(out[0].claim_kind, 'reported');
  assert.equal(out[0].bias, 'neutral');
});

test('the broker check needs the broker\'s own name in the window', () => {
  assert.equal(isBrokerMention('Morgan Stanley raised its price target on Nvidia.', 'MS'), true);
  assert.equal(isBrokerMention('Nvidia is running today.', 'MS'), false);
});

// THE PEOPLE, AND THE FRAGMENTS OF LONGER WORDS.
//
// The 725-transcript corpus published 100 holdings that are PEOPLE --
// the hosts bring their analysts on by name, and the names arrive as
// INITIALS, and the symbol path publishes on capitals alone:
//
//   "bring AB in here"                        (64 signals)
//   "we've had CC legator on this show"       (16)
//   "of my bearish BL process"                (4)
//   "we're gonna BR Kenny on here too"        (3)  -- "bring Kenny"
//   "RC the AL Royal Caribbean"                (2)  -- the ticker is RCL
//
// And 47 that are a caption's cut of a longer word:
//
//   "the S PS in to the upside"               (38)  -- "the S&P"
//   "if GD real simple, if GDP growth is 3%"  (1)
//   "good liquid ET uh uh ETF for AI"          (1)
//   "it SM it for you, it Smooths it"         (2)
//   "morphic ticker MF which is skyrocketing"  (2)
//   "you go into the iwm OR into value"       (1)
//   "sometimes they were the VC money"        (1)

const {
  BENZINGA_PEOPLE_AND_FRAGMENTS, benzingaSymbolStoplist,
} = require('../src/benzinga/symbols');

test('the people the hosts address are not holdings', () => {
  const stoplist = benzingaSymbolStoplist();
  for (const token of ['AB', 'AG', 'BL', 'BR', 'CC', 'RC', 'SE', 'TP']) {
    assert.ok(BENZINGA_PEOPLE_AND_FRAGMENTS.has(token), `${token} is on the list`);
    assert.ok(stoplist.has(token), `${token} reaches the extractor's stoplist`);
  }
});

test('a caption\'s cut of a longer word is not a holding', () => {
  const stoplist = benzingaSymbolStoplist();
  for (const token of ['PS', 'GD', 'ET', 'SM', 'MF', 'OR', 'VC']) {
    assert.ok(stoplist.has(token), `${token} reaches the extractor's stoplist`);
  }
});

test('the stoplist does not take a real holding with it', () => {
  const stoplist = benzingaSymbolStoplist();
  // "CC" and "AG" are real tickers, which is why the list is a
  // SOURCE's stoplist and not the lexicon's. But the holdings this
  // corpus actually trades are not on it.
  for (const ticker of ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'MARA', 'GS', 'IREN', 'RKLB']) {
    assert.ok(!stoplist.has(ticker), `${ticker} must still be publishable`);
  }
});

// "JP MORGAN" IS JPMORGAN, NOT MORGAN STANLEY.
//
// The name finder cannot form the pair, because its token pattern
// starts with a capital followed by a lower-case letter, and "JP" is all
// capitals -- so "Morgan" alone reaches the confirmed row
// `morgan -> MS`. Measured over the corpus: 42 of the 106 MS signals
// name "JP Morgan", and 20 of them were published as calls on Morgan
// Stanley.
//
// The fix is by the NAME IN THE WINDOW, not by the token, so it is
// right even when the ticker was mis-resolved.

test('a broker named in the window is never a call on the broker', () => {
  for (const text of [
    'JP Morgan up seven and a half bought the SPXs are down a buck 75',
    'Morgan Stanley came out and he is always bullish',
    'a wild Fargo up 3% you do not make money buying wild Fargo',
    'Goldman come in with a lot of volume',
  ]) {
    assert.ok(isBrokerMention(text, 'MS') || isBrokerMention(text, 'WFC')
      || isBrokerMention(text, 'GS'), `"${text.slice(0, 30)}" names a broker`);
  }
  assert.equal(isBrokerMention('I bought NVDA today', 'NVDA'), false);
});

test('the broker action verbs come in every tense the captions use', () => {
  // Only the past tense was matched, and the corpus writes the present.
  for (const text of [
    'Morgan raises price Target on FedEx',
    'Morgan maintains equal weight on FedEx',
    'Bank of America cut its target to 28',
    'Morgan upgrades Lockheed Martin to overweight raise their price Target to 518',
  ]) {
    assert.equal(reportedClaim(text).reported, true, `"${text.slice(0, 34)}" is reported`);
  }
});

test("the host's own call is still the host's own call", () => {
  for (const text of [
    'I am buying Nvidia here, I think it is going higher',
    'I remain bullish on Tesla',
    'my price target for NVDA is 250',
  ]) {
    assert.equal(reportedClaim(text).reported, false, `"${text.slice(0, 30)}" is the host's`);
  }
});
