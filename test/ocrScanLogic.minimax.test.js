'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractObservedDate,
  groupContiguousCandidates,
  selectFramesForOcr
} = require('../src/video/ocrScanLogic');

test('extractObservedDate rejects impossible calendar dates', () => {
  assert.equal(extractObservedDate('Tuesday, February 31, 2026'), null);
});

test('groupContiguousCandidates sorts candidates by frame index', () => {
  const windows = groupContiguousCandidates([
    { frameIndex: 3, score: 1 },
    { frameIndex: 1, score: 1 },
    { frameIndex: 2, score: 1 }
  ]);

  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].map((row) => row.frameIndex), [1, 2, 3]);
});

test('selectFramesForOcr ignores rows with missing scores', () => {
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: undefined },
    { frameIndex: 1, prefilterScore: 20 }
  ], {
    maxFrames: 1,
    minFrames: 1,
    minScore: 14,
    uniformSampleCount: 0
  });

  assert.deepEqual(selected.map((row) => row.frameIndex), [1]);
});
