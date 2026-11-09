'use strict';

// The T3Live dashboard's contract: it renders from the aggregate payload, it
// says so when the outcomes have not been scored, and it never renders a
// signal's evidence as markup.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderT3liveReport } = require('../src/report/t3liveReport');

const payload = {
  generated_at: '2026-11-09T00:00:00Z',
  signal_count: 2,
  unique_tickers: 1,
  by_show: { actionable_swings: 1, '630club': 1, other: 0 },
  tickers: [{ ticker: 'NVDA', signal_count: 2, bullish_count: 1, bearish_count: 1, video_count: 2 }],
  signals: [
    { upload_date: '20261102', show: 'actionable_swings', ticker: 'NVDA', bias: 'bullish',
      entry_price: 525, stop_price: 478, evidence_text: 'long over 525, stop under 478' },
    { upload_date: '20261103', show: '630club', ticker: 'NVDA', bias: 'bearish',
      entry_price: '', stop_price: '', evidence_text: 'short under <Friday> low & stop' },
  ],
};

test('an unscored dashboard says the outcomes have not been scored', () => {
  const html = renderT3liveReport(payload, null);
  assert.match(html, /Not scored yet/);
  assert.doesNotMatch(html, /hit 1w/);
});

test('a scored dashboard shows the verdict per show', () => {
  const outcomes = {
    entry_rule: 'close on the upload date',
    conflicting_claims: 3,
    overall: { signal_count: 10, hit_rate_1w: 0.5, same_call_hit_rate_1w: 0.55,
      same_call_excess_1w: 0.003, same_call_excess_1w_ci: { low: -0.01, high: 0.016 } },
    by_show: { actionable_swings: { signal_count: 7, hit_rate_1w: 0.49, same_call_hit_rate_1w: 0.53,
      same_call_excess_1w: 0.002, same_call_excess_1w_ci: { low: -0.01, high: 0.014 } } },
    by_bias: {},
  };
  const html = renderT3liveReport(payload, outcomes);
  assert.match(html, /Actionable Swings/);
  assert.match(html, /50\.0%/);
  assert.doesNotMatch(html, /Not scored yet/);
});

test('evidence is escaped, so a caption cannot inject markup', () => {
  const html = renderT3liveReport(payload, null);
  assert.match(html, /short under &lt;Friday&gt; low &amp; stop/);
  assert.doesNotMatch(html, /<Friday>/);
});
