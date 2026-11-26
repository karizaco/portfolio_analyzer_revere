'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mediaVideoId } = require('../tools/mediaVideoId.js');

test('strips an 8-digit upload_date prefix', () => {
  assert.equal(mediaVideoId('20260612_xC63a7idsGQ.mp4'), 'xC63a7idsGQ');
  assert.equal(mediaVideoId('20200808_438_cyYQ888.mp4'), '438_cyYQ888');
});

test('keeps a bare id unchanged', () => {
  assert.equal(mediaVideoId('0_inu2Isf4k.mp4'), '0_inu2Isf4k');
  assert.equal(mediaVideoId('-3qtA_s7g9c.mp4'), '-3qtA_s7g9c');
  assert.equal(mediaVideoId('438_cyYQ888.mp4'), '438_cyYQ888');
});

test('does NOT truncate an id that starts with digits', () => {
  // The old `^\d+_` strip turned these into 10- and 7-character strings,
  // which matched no row and made the video look missing from disk.
  assert.equal(mediaVideoId('438_cyYQ888.mp4'), '438_cyYQ888');
  assert.equal(mediaVideoId('0_inu2Isf4k.mp4'), '0_inu2Isf4k');
  assert.equal(mediaVideoId('12345678_9o5_4iZ0zjI.mp4'), '9o5_4iZ0zjI');
});

test('a date-looking id is still only stripped once', () => {
  // "20200808_438_cyYQ888" — one date prefix, then an id that itself begins
  // with digits. The id must survive intact.
  assert.equal(mediaVideoId('20200808_438_cyYQ888.mp4'), '438_cyYQ888');
  assert.equal(mediaVideoId('20200808_20200808.mp4'), '20200808');
});

test('is case-insensitive about the extension', () => {
  assert.equal(mediaVideoId('20260612_xC63a7idsGQ.MP4'), 'xC63a7idsGQ');
});
