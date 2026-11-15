'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreFramePrefilter } = require('../src/video/ocrScanLogic');

test('whiteboard profile does not apply temporal decay', () => {
  const stats = {
    meanLuma: 200,
    stdDev: 60,
    horizontalEdgeRatio: 0.08,
    verticalEdgeRatio: 0.03,
    edgeRatio: 0.09,
    brightRatio: 0.72,
    darkRatio: 0.08
  };

  const early = scoreFramePrefilter(stats, 'whiteboard', 'whiteboard', 600, 0);
  const late = scoreFramePrefilter(stats, 'whiteboard', 'whiteboard', 600, 99999);

  assert.equal(early, late);
});
