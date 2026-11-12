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
