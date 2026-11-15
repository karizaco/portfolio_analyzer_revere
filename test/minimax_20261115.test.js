'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectFramesForOcr
} = require('../src/video/ocrScanLogic');

test('selectFramesForOcr returns no frames when every score is invalid', () => {
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: undefined },
    { frameIndex: 1, prefilterScore: NaN },
    { frameIndex: 2, prefilterScore: 'abc' }
  ], {
    maxFrames: 1,
    minFrames: 1,
    minScore: 14,
    uniformSampleCount: 0
  });

  assert.deepEqual(selected, []);
});
