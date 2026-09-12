'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreChartLikeness } = require('../src/video/ocrScanLogic');

test('scoreChartLikeness returns 0 for missing stats', () => {
  assert.equal(scoreChartLikeness(null), 0);
  assert.equal(scoreChartLikeness(undefined), 0);
});

test('scoreChartLikeness returns 0 for empty stats', () => {
  assert.equal(scoreChartLikeness({}), 0);
});

test('scoreChartLikeness returns negative penalty for chart-like stats (v >> h)', () => {
  // Candlestick chart: many vertical edges (candle wicks, grid lines) and
  // comparable horizontal edges (price bars, oscillator traces).
  const stats = {
    horizontalEdgeRatio: 0.12,
    verticalEdgeRatio: 0.20
  };
  const ratio = 0.20 / 0.12; // ≈ 1.67

  const score = scoreChartLikeness(stats);

  assert.ok(score < 0, `expected negative score, got ${score}`);
  // ratio - 1.2 = 0.47 * 8 = 3.76, capped at -6
  assert.ok(score >= -6, `expected score >= -6, got ${score}`);
});

test('scoreChartLikeness returns positive bonus for text-like stats (h > v)', () => {
  // Text on white: rows of horizontal strokes, very few vertical edges.
  const stats = {
    horizontalEdgeRatio: 0.12,
    verticalEdgeRatio: 0.04
  };
  const ratio = 0.04 / 0.12; // ≈ 0.33

  const score = scoreChartLikeness(stats);

  assert.ok(score > 0, `expected positive score, got ${score}`);
  // (0.7 - 0.33) * 4 = 1.48, capped at +2
  assert.ok(score <= 2, `expected score <= 2, got ${score}`);
});

test('scoreChartLikeness returns 0 for ambiguous stats (0.7 <= ratio <= 1.2)', () => {
  const ambiguousStats = {
    horizontalEdgeRatio: 0.10,
    verticalEdgeRatio: 0.10
  };
  assert.equal(scoreChartLikeness(ambiguousStats), 0);
});

test('scoreChartLikeness chart penalty magnitude exceeds text bonus magnitude', () => {
  const chartStats = { horizontalEdgeRatio: 0.10, verticalEdgeRatio: 0.25 };
  const textStats = { horizontalEdgeRatio: 0.10, verticalEdgeRatio: 0.03 };

  const chartScore = scoreChartLikeness(chartStats);
  const textScore = scoreChartLikeness(textStats);

  assert.ok(Math.abs(chartScore) > Math.abs(textScore), `chart penalty |${chartScore}| should exceed text bonus |${textScore}|`);
});

test('scoreChartLikeness caps chart penalty at -6 even for extreme ratios', () => {
  const extremeChart = { horizontalEdgeRatio: 0.01, verticalEdgeRatio: 0.30 };
  assert.ok(scoreChartLikeness(extremeChart) >= -6, 'chart penalty should be capped at -6');
});

test('scoreChartLikeness caps text bonus at +2 even for extreme ratios', () => {
  const extremeText = { horizontalEdgeRatio: 0.20, verticalEdgeRatio: 0.001 };
  assert.ok(scoreChartLikeness(extremeText) <= 2, 'text bonus should be capped at +2');
});

test('scoreChartLikeness treats zero horizontal edges as chart-like', () => {
  const stats = { horizontalEdgeRatio: 0, verticalEdgeRatio: 0.10 };
  const ratio = 0.10 / 0.01; // 10 → very chart-like
  const score = scoreChartLikeness(stats);
  assert.ok(score < 0, `expected negative for zero horizontal edges, got ${score}`);
});
