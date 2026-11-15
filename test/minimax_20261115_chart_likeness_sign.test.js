'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreFramePrefilter
} = require('../src/video/ocrScanLogic');

test('chart_stream prefilter rewards chart-like geometry', () => {
  const chartLike = {
    brightRatio: 0.04,
    darkRatio: 0.55,
    edgeRatio: 0.10,
    stdDev: 55,
    meanLuma: 70,
    horizontalEdgeRatio: 0.10,
    verticalEdgeRatio: 0.20,
    rowDensity: 150,
    multiColStripeCount: 3,
    midToneRatioTicker: 0.50
  };
  const neutral = {
    ...chartLike,
    verticalEdgeRatio: 0.01
  };

  const chartScore = scoreFramePrefilter(
    chartLike,
    'snapshot',
    'chart_stream',
    Infinity
  );
  const neutralScore = scoreFramePrefilter(
    neutral,
    'snapshot',
    'chart_stream',
    Infinity
  );

  assert.ok(
    chartScore > neutralScore,
    `expected chart-like frame ${chartScore} to score above neutral frame ${neutralScore}`
  );
});
