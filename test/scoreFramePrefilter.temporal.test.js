'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreFramePrefilter } = require('../src/video/ocrScanLogic');

function makeStats(overrides = {}) {
  return {
    meanLuma: 70,
    stdDev: 55,
    horizontalEdgeRatio: 0.05,
    verticalEdgeRatio: 0.08,
    edgeRatio: 0.13,
    brightRatio: 0.04,
    darkRatio: 0.55,
    ...overrides,
  };
}

test('chart_stream: explicit timestamp arg yields finite boosted score', () => {
  const early = scoreFramePrefilter(makeStats(), 'snapshot', 'chart_stream', 600, 0);
  const late = scoreFramePrefilter(makeStats(), 'snapshot', 'chart_stream', 600, 590);
  assert.ok(Number.isFinite(early), `early score must be finite, got ${early}`);
  assert.ok(Number.isFinite(late), `late score must be finite, got ${late}`);
  assert.ok(early > late, `early (${early}) should beat late (${late}) under temporal decay`);
});

test('chart_stream: stats.timestamp yields finite boosted score', () => {
  const early = scoreFramePrefilter(makeStats({ timestamp: 0 }), 'snapshot', 'chart_stream', 600);
  const late = scoreFramePrefilter(makeStats({ timestamp: 590 }), 'snapshot', 'chart_stream', 600);
  assert.ok(Number.isFinite(early));
  assert.ok(Number.isFinite(late));
  assert.ok(early > late);
});

test('chart_stream: missing timestamp does not produce NaN', () => {
  const score = scoreFramePrefilter(makeStats(), 'snapshot', 'chart_stream', 600, null);
  assert.ok(Number.isFinite(score), `score must be finite when timestamp is null, got ${score}`);
});

test('whiteboard profile ignores temporal decay even if timestamp provided', () => {
  const base = {
    meanLuma: 200,
    brightRatio: 0.72,
    darkRatio: 0.08,
    edgeRatio: 0.09,
    stdDev: 60,
    horizontalEdgeRatio: 0.08,
    verticalEdgeRatio: 0.03,
  };
  const a = scoreFramePrefilter(makeStats({ ...base }), 'whiteboard', 'whiteboard', 600, 0);
  const b = scoreFramePrefilter(makeStats({ ...base }), 'whiteboard', 'whiteboard', 600, 99999);
  assert.equal(a, b, 'whiteboard profile must not apply temporal decay');
});
