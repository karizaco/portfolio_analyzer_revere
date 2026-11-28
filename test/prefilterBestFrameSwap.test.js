'use strict';

// The chart-stream profile's best-frame swap.
//
// THE DEFECT THIS FILE PINS
//
// `selectFramesForOcr` reserves its budget for a uniform time-stride, and
// the stride-based reserve is sized to keep each stride under ~10 s of
// video. For a long video that reserve alone fills the whole budget, so
// the SEED branch never runs -- and the seed branch is the only part of the
// selector that consults the prefilter score. The frames that get OCR'd
// are therefore a blind stride, and `--prefilter-threshold` has no effect.
//
// Measured on 20220218 (689 frames sampled at 0.25 fps, chart_stream
// defaults): the 12 selected frames are a 228-second stride, and the
// best-scoring frame in the video -- t=132 s, score 22.27 -- is not one of
// them. Five of the twelve score below the profile's own absolute
// threshold of 8; the last four score below zero.
//
// THE FIX
//
// The frame the profile scored highest takes the slot of the LEAST legible
// selected frame, gated by the profile's threshold with the same 60 %
// relaxation `selectFramesForOcr` applies.
//
// The eviction rule is "lowest score", not the table profile's "nearest
// frame", and the difference is deliberate: the table profile's budget is
// 3 frames taken seconds apart, so its nearest uniform frame is redundant
// with the best one; the chart-stream frames are MINUTES apart, so no
// selected frame is redundant with another.
//
// What is pinned here is the RULE, not the recall: a chart-stream re-scan
// costs 8-13 minutes per video, so the effect on holdings recovered can
// only be measured by a sweep.

const test = require('node:test');
const assert = require('node:assert/strict');

const { swapInBestPrefilterFrame } = require('../src/video/ocrScanLogic');

const BEST = { frameIndex: 33, prefilterScore: 22.27, timestamp: 132 };

function selected(...scores) {
  return scores.map((prefilterScore, index) => ({
    frameIndex: index * 57,
    prefilterScore,
    timestamp: index * 57 * 4,
  }));
}

test('the best-scoring frame takes the slot of the LEAST legible selected frame', () => {
  const rows = selected(15.43, 10.96, 10.20, 9.65, 6.35, 6.13, 5.00, 0.70, 10.68, 4.35, -8.75, -2.42);
  const result = swapInBestPrefilterFrame(rows, BEST, { minScore: 8 });

  assert.equal(result.swapped, true);
  // The evicted frame is the LOWEST-scoring one (-8.75), which is neither
  // the last frame of the stride (-2.42) nor the nearest one to the best
  // frame (10.96).
  assert.equal(result.evicted.prefilterScore, -8.75);
  assert.equal(rows.length, 12, 'the swap is cost-neutral: no frame is added or removed');
  assert.ok(rows.some((row) => row.frameIndex === 33), 'the best frame is now selected');
});

test('the evicted frame is the lowest-scoring one even when it is not the last', () => {
  const rows = selected(15.43, 10.96, 10.20, 9.65, 6.35, 6.13, 5.00, 0.70, 10.68, 4.35, -8.75, -2.42);
  const result = swapInBestPrefilterFrame(rows, BEST, { minScore: 8 });

  assert.equal(result.evicted.prefilterScore, -8.75);
  assert.notEqual(result.index, rows.length - 1,
    'the last frame is not privileged -- the least legible frame is');
});

test('a best frame that is already selected does not consume a slot', () => {
  const rows = selected(15.43, 22.27, 10.20);
  const alreadyThere = { frameIndex: 57, prefilterScore: 22.27, timestamp: 228 };
  const result = swapInBestPrefilterFrame(rows, alreadyThere, { minScore: 8 });

  assert.equal(result.swapped, false);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].frameIndex, 57);
});

test('a best frame below the threshold does not take a slot', () => {
  // A genuinely weak video: the best frame really IS the best, and it is
  // still below even the relaxed threshold (8 * 0.6 = 4.8).
  const rows = selected(2.0, 1.5);
  const weak = { frameIndex: 33, prefilterScore: 1.5, timestamp: 132 };
  const result = swapInBestPrefilterFrame(rows, weak, { minScore: 8 });

  assert.equal(result.swapped, false);
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((row) => row.frameIndex === 33));
});

test('a weak video is judged against 60 % of the threshold, as the selector does', () => {
  // The whole video scores below minScore, so selectFramesForOcr relaxes
  // its threshold to 60 % of it. The swap must relax the same way, or the
  // chart-stream profile would never swap on a dim video -- the case the
  // relaxation exists for.
  const rows = selected(7.2, 6.1, 5.4);
  const weak = { frameIndex: 33, prefilterScore: 7.2, timestamp: 132 };
  const result = swapInBestPrefilterFrame(rows, weak, { minScore: 8 });

  assert.equal(result.swapped, true, '7.2 clears the relaxed threshold of 4.8');
  assert.equal(result.evicted.prefilterScore, 5.4);
});

test('the swap is a no-op when the video is weak enough to fail even the relaxed threshold', () => {
  const rows = selected(4.4, 4.1);
  const weak = { frameIndex: 33, prefilterScore: 4.4, timestamp: 132 };
  const result = swapInBestPrefilterFrame(rows, weak, { minScore: 8 });

  assert.equal(result.swapped, false, '4.4 is below the relaxed threshold of 4.8');
  assert.equal(rows.length, 2);
});
