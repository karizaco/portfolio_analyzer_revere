'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs
} = require('../src/video/ocrScanArgs');

test('accepts a pipeline profile belonging to a declared profile set', () => {
  const options = parseArgs([
    '--video', 'fixture.mp4',
    '--pipeline-profile', 'qmg-prefilter-v1',
    '--pipeline-profile-set', 'qmg-five-ideas'
  ]);

  assert.equal(options.pipelineProfile, 'qmg-prefilter-v1');
  assert.equal(options.pipelineProfileSet, 'qmg-five-ideas');
});

test('accepts the default legacy profile with the qmg-five-ideas set', () => {
  const options = parseArgs([
    '--video', 'fixture.mp4',
    '--pipeline-profile-set', 'qmg-five-ideas'
  ]);

  assert.equal(options.pipelineProfile, 'legacy');
  assert.equal(options.pipelineProfileSet, 'qmg-five-ideas');
});

test('rejects a pipeline profile outside a declared profile set', () => {
  assert.throws(() => parseArgs([
    '--video', 'fixture.mp4',
    '--pipeline-profile', 'whiteboard-experimental-v1',
    '--pipeline-profile-set', 'qmg-five-ideas'
  ]), /not part of set/);
});

test('rejects an unknown pipeline profile set', () => {
  assert.throws(() => parseArgs([
    '--video', 'fixture.mp4',
    '--pipeline-profile-set', 'missing-set'
  ]), /Unknown pipeline profile set/);
});
