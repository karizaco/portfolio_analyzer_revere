'use strict';

// The ENTRY RULE -- the price a reader pays when a claim is acted on.
//
// The rules here were measured against the published numbers of nine
// sources (tools/measureEntryRule.js), and this file pins the RULES
// themselves: what each one pays, when it produces no trade at all, and
// what happens to a price that is on a different basis from the close.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  adjustedBar, allRules, entryForRule, exitPrice, horizonElapsed, makeLimitRule, resolveBars,
} = require('../src/analysis/entryRule');

/** A bar: the adjusted close, and the raw open/high/low. */
function bar(date, close, open, high, low, price) {
  return {
    date,
    close,
    open: open === undefined ? close : open,
    high: high === undefined ? close : high,
    low: low === undefined ? close : low,
    price: price === undefined ? close : price,
  };
}

const BARS = [
  bar('2026-01-02', 100),
  bar('2026-01-05', 110, 106, 112, 104),
  bar('2026-01-06', 120, 118, 122, 115),
];

test('the signal day is the last bar at or before the claim date', () => {
  // A claim made on a Saturday belongs to Friday's close.
  const weekend = resolveBars(BARS, '2026-01-04');
  assert.equal(weekend.d0.date, '2026-01-02');
  assert.equal(weekend.d1.date, '2026-01-05');
  // And a claim made on the day itself is that day's bar.
  const onDay = resolveBars(BARS, '2026-01-05');
  assert.equal(onDay.d0.date, '2026-01-05');
  assert.equal(onDay.d1.date, '2026-01-06');
  // A claim before the first bar has no signal day.
  assert.equal(resolveBars(BARS, '2025-12-01').d0, null);
});

test('close_d0 pays the close of the signal day', () => {
  const bars = resolveBars(BARS, '2026-01-05');
  const rule = { name: 'close_d0', needsFill: false };
  assert.deepEqual(entryForRule(rule, bars, 'bullish'), { entry: 110, status: 'ok' });
});

test('open_d1 and close_d1 pay the NEXT session', () => {
  const bars = resolveBars(BARS, '2026-01-05');
  // The next session is the 6th: it opened at 118 and closed at 120.
  const open = entryForRule({ name: 'open_d1', needsFill: false }, bars, 'bullish');
  assert.equal(open.entry, 118);
  const close = entryForRule({ name: 'close_d1', needsFill: false }, bars, 'bullish');
  assert.equal(close.entry, 120);
});

test('a rule that needs the next session says so when there is none', () => {
  const bars = { d0: BARS[BARS.length - 1], d1: null };
  const open = entryForRule({ name: 'open_d1', needsFill: false }, bars, 'bullish');
  assert.equal(open.entry, null);
  assert.equal(open.status, 'no_next_session');
  // And the close rule still works on the last bar.
  assert.equal(entryForRule({ name: 'close_d0', needsFill: false }, bars, 'bullish').entry, 120);
});

test('a limit fills only when the market trades through it', () => {
  const rule = makeLimitRule(0.01);
  // A bullish limit sits BELOW the close: 100 -> 99. The next session
  // traded down to 98, so the limit filled.
  const fills = entryForRule(rule, {
    d0: bar('2026-01-05', 100),
    d1: bar('2026-01-06', 101, 100, 102, 98),
  }, 'bullish');
  assert.equal(fills.status, 'filled');
  // AND THE LIMIT IS THE WORST CASE: a limit order fills at the limit
  // or better, and reporting the limit is the conservative choice.
  assert.equal(Math.round(fills.entry * 100) / 100, 99);

  // A session that never traded down to the limit does not fill.
  const noFill = entryForRule(rule, {
    d0: bar('2026-01-05', 100),
    d1: bar('2026-01-06', 101, 100, 102, 99.5),
  }, 'bullish');
  assert.equal(noFill.entry, null);
  assert.equal(noFill.status, 'not_filled');
});

test('a bearish limit sits ABOVE the close and fills on a rally', () => {
  const rule = makeLimitRule(0.01);
  // A sell limit at 110 -> 111.1. The next session's high is 112, so it fills.
  const fills = entryForRule(rule, resolveBars(BARS, '2026-01-05'), 'bearish');
  assert.equal(fills.status, 'filled');
  assert.equal(Math.round(fills.entry * 100) / 100, 111.1);

  // And a session that rallies no higher does not fill.
  const noFill = entryForRule(rule, {
    d0: bar('2026-01-05', 100),
    d1: bar('2026-01-06', 100, 99, 100.5, 98),
  }, 'bearish');
  assert.equal(noFill.status, 'not_filled');
});

test('every bar is put on the ADJUSTED basis, so a split is not a loss', () => {
  // The cache stores the adjusted close next to the RAW open. A bar
  // whose raw close is 800 and whose adjusted close is 100 was split
  // 8:1, and its raw open has to be scaled with it.
  const adjusted = adjustedBar({
    date: '2026-01-05',
    close: 800,
    price: 100,
    open: 810,
    high: 820,
    low: 790,
  });
  assert.equal(adjusted.close, 100);
  assert.equal(Math.round(adjusted.open * 100) / 100, 101.25);
  assert.equal(Math.round(adjusted.high * 100) / 100, 102.5);
  assert.equal(Math.round(adjusted.low * 100) / 100, 98.75);
});

test('the exit is the last close at or before the horizon', () => {
  // A week after the 2nd is the 9th, and the last close at or before it
  // is the 6th's.
  assert.equal(exitPrice(BARS, '2026-01-02', 7), 120);
  // A day after the 5th is the 6th.
  assert.equal(exitPrice(BARS, '2026-01-05', 1), 120);
  // A horizon past the last bar carries the LAST available close
  // forward -- the same rule the price provider uses everywhere, and the
  // same one the published numbers were made with.
  assert.equal(exitPrice(BARS, '2026-01-02', 90), 120);
});

test('a horizon that has not ELAPSED has no exit at all', () => {
  assert.equal(horizonElapsed('2026-01-02', 7, '2026-01-20'), true);
  assert.equal(horizonElapsed('2026-01-02', 7, '2026-01-05'), false);
  // And the exit is refused for the same horizon, so a PARTIAL window
  // is never measured and reported as a full one.
  assert.equal(exitPrice(BARS, '2026-01-02', 7), 120);
});

test('the registry holds the three executable rules and the limit sweep', () => {
  const names = allRules().map((rule) => rule.name);
  assert.deepEqual(names.slice(0, 3), ['close_d0', 'open_d1', 'close_d1']);
  assert.ok(names.includes('limit_d0_1_0'));
  assert.ok(names.includes('limit_d0_0_5'));
  assert.ok(names.includes('limit_d0_2_0'));
});
