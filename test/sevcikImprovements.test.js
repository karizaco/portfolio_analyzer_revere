'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isNonMarketSevcikTitle, sevcikVideoQuarantine } = require('../src/sevcik/contentFilter');
const { isPlausiblePrice, sanitizePricesForTicker } = require('../src/sevcik/priceSanity');
const {
  assessEdge,
  isScorableSetup,
  scoreSetupOutcome,
  summarizeOutcomes,
  wilsonInterval,
} = require('../src/sevcik/outcomeAnalysis');
const { readSetupCertainty, certaintyConfidence } = require('../src/sevcik/certainty');
const { findSetups } = require('../src/sevcik/setupSegmenter');

test('quarantines 14-day challenge titles', () => {
  assert.equal(isNonMarketSevcikTitle('DEN 5 ze 14 | Co je paka'), true);
  assert.equal(isNonMarketSevcikTitle('14 dní, po kterých budete znát strategie'), true);
  assert.equal(isNonMarketSevcikTitle('14 dnů naživo'), true);
  assert.equal(sevcikVideoQuarantine({ title: 'Startujeme 14 dní naživo | DEN 1' }).quarantined, true);
  assert.equal(isNonMarketSevcikTitle('Apple: rekordni trzby, predikce na MSFT'), false);
});

test('rejects absurd prices for a ticker', () => {
  assert.equal(isPlausiblePrice('USB', 35), true);
  assert.equal(isPlausiblePrice('USB', 34000), false);
  assert.equal(isPlausiblePrice('BTC', 34000), true);
  const cleaned = sanitizePricesForTicker('USB', [
    { role: 'level', value: 35, low: 35, high: 35 },
    { role: 'level', value: 34000, low: 34000, high: 34000 },
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].value, 35);
});

test('certainty structural baseline beats unknown when direction exists', () => {
  const bare = readSetupCertainty('nova predikce na Tesla je do Longu', {
    hasDirection: true,
    isPrediction: true,
  });
  assert.notEqual(bare.level, 'unknown');
  assert.ok(bare.confidence > certaintyConfidence('unknown'));
});

test('near-duplicate retrospective markers merge into one episode', () => {
  const LEXICON = new Set(['TSLA']);
  const seg = (text, i) => ({ start_sec: i * 2, end_sec: i * 2 + 2, text });
  const setups = findSetups({
    lexicon: LEXICON,
    segments: [
      seg('Takze Tesla. Tahle predikce vysla.', 0),
      seg('Predikce na Tesla znovu vysla dobre.', 1),
      seg('A ta stara predikce taky vysla.', 2),
    ],
  });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].claim_kind, 'retrospective');
  assert.ok(setups[0].mentions >= 2);
});

test('forward setup without direction is not a prediction', () => {
  const LEXICON = new Set(['TSLA']);
  const setups = findSetups({
    lexicon: LEXICON,
    segments: [
      { start_sec: 0, end_sec: 2, text: 'Takze Tesla. Mame tady novou predikci.' },
      { start_sec: 2, end_sec: 4, text: 'Budeme se na to divat.' },
    ],
  });
  assert.ok(setups.length >= 1);
  assert.equal(setups[0].is_prediction, false);
});

test('forward setup with long direction is a scorable prediction', () => {
  const LEXICON = new Set(['TSLA']);
  const setups = findSetups({
    lexicon: LEXICON,
    segments: [
      { start_sec: 0, end_sec: 2, text: 'Nova predikce na Tesla je do Longu, pokud udrzi uroven.' },
    ],
  });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].claim_kind, 'forward');
  assert.equal(setups[0].bias, 'bullish');
  assert.equal(setups[0].is_prediction, true);
  assert.equal(isScorableSetup(setups[0]), true);
});

test('setup outcomes and assessment require sample size', () => {
  const row = scoreSetupOutcome(
    { video_id: 'x', upload_date: '20260101', ticker: 'AAPL', bias: 'bullish', claim_kind: 'forward', is_prediction: 1, certainty_level: 'stated', certainty_confidence: 0.42, evidence_text: 'long' },
    { entry: 100, week: 105, month: 110, meta: { status: 'ok' } },
  );
  assert.equal(row.source, 'setup');
  assert.equal(row.hit_1w, true);
  assert.ok(row.aligned_return_1w > 0);

  const summary = summarizeOutcomes([row, row, row], {
    baseline: { symbol: 'SPY', hit_rate_1w: 0.55, hit_rate_1m: 0.52, avg_return_1w: 0.01, avg_return_1m: 0.02 },
  });
  assert.equal(summary.assessment_1w, 'insufficient_n');
  assert.ok(summary.note);
  assert.equal(assessEdge({ n: 80, hitRate: 0.56, baseline: 0.55 }), 'no_clear_edge');
  const ci = wilsonInterval(18, 33);
  assert.ok(ci.low < ci.high);
});
