'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pairSetupsForVideo, groupSetupsByDay, actionabilityScore } = require('../src/fundedmind/setupPairing');

test('pairs open + exit on same ticker into one closed setup', () => {
  const setups = pairSetupsForVideo([
    {
      video_id: 'v1',
      ticker: 'XAUUSD',
      action: 'open',
      bias: 'bullish',
      event_time_sec: 10,
      evidence_text: 'jsem nabral long',
      rationale: 'host=Oliver Pátek; kind=live_trading; side=long; ticker_from=prev_segment',
      parser_version: 'fundedmind-10',
    },
    {
      video_id: 'v1',
      ticker: 'XAUUSD',
      action: 'exit',
      bias: 'neutral',
      event_time_sec: 40,
      evidence_text: 'zavíral jsem to tady',
      rationale: 'host=Oliver Pátek; kind=live_trading; ticker_from=prev2_segment',
      parser_version: 'fundedmind-10',
    },
  ], { session_date: '20261106', host: 'Oliver Pátek', kind: 'live_trading' });

  assert.equal(setups.length, 1);
  assert.equal(setups[0].status, 'closed');
  assert.equal(setups[0].ticker, 'XAUUSD');
  assert.equal(setups[0].side, 'long');
  assert.equal(setups[0].events.length, 2);
  assert.ok(setups[0].score >= 3);
});

test('does not merge different tickers in one multi-instrument session', () => {
  const setups = pairSetupsForVideo([
    {
      video_id: 'v2', ticker: 'XAUUSD', action: 'open', bias: 'bearish', event_time_sec: 5,
      rationale: 'side=short; ticker_from=segment', evidence_text: 'short gold',
    },
    {
      video_id: 'v2', ticker: 'BTC', action: 'open', bias: 'bullish', event_time_sec: 15,
      rationale: 'side=long; ticker_from=segment', evidence_text: 'long btc',
    },
  ], { session_date: '20261105' });
  assert.equal(setups.length, 2);
  assert.deepEqual(setups.map((s) => s.ticker).sort(), ['BTC', 'XAUUSD']);
  assert.ok(setups.every((s) => s.status === 'still_open'));
});

test('flip closes prior opposite side on same ticker', () => {
  const setups = pairSetupsForVideo([
    {
      video_id: 'v3', ticker: 'NAS100', action: 'open', bias: 'bullish', event_time_sec: 1,
      rationale: 'side=long; ticker_from=session_default', evidence_text: 'nabral som long',
    },
    {
      video_id: 'v3', ticker: 'NAS100', action: 'open', bias: 'bearish', event_time_sec: 20,
      rationale: 'side=short; ticker_from=session_default', evidence_text: 'bral som short',
    },
  ], { session_date: '20261117', host: 'Michal Veselovský' });
  assert.equal(setups.length, 2);
  const flipped = setups.find((s) => s.status === 'flipped');
  const open = setups.find((s) => s.status === 'still_open');
  assert.ok(flipped);
  assert.equal(flipped.side, 'long');
  assert.ok(open);
  assert.equal(open.side, 'short');
});

test('groupSetupsByDay builds a day book', () => {
  const days = groupSetupsByDay([
    { session_date: '20261106', host: 'A', ticker: 'XAUUSD', score: 3, status: 'closed' },
    { session_date: '20261106', host: 'B', ticker: 'NAS100', score: 2, status: 'still_open' },
    { session_date: '20261105', host: 'A', ticker: 'BTC', score: 1, status: 'partial' },
  ]);
  assert.equal(days[0].session_date, '20261106');
  assert.equal(days[0].setup_count, 2);
  assert.deepEqual(days[0].tickers, ['NAS100', 'XAUUSD']);
});

test('actionability prefers named ticker sources', () => {
  const low = actionabilityScore({
    side: 'long', entry_price: 1, ticker_from: 'session_default', status: 'still_open', targets: [], events: [{ action: 'open' }],
  });
  const high = actionabilityScore({
    side: 'long', entry_price: 1, ticker_from: 'prev_segment', status: 'closed',
    stop_price: 1, targets: [2], events: [{ action: 'open' }],
  });
  assert.ok(high > low);
});
