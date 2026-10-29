'use strict';

// The curated benchmark frames must be TRACKED, and they must be the frames
// the benchmark actually scores.
//
// This is the fast half of the benchmark's clone safety. The expensive half
// is test/qmgGroundTruth.test.js, which takes 23 minutes of EasyOCR. This
// file checks in seconds that:
//
//   1. every curated case has a tracked frame;
//   2. the frame is wide enough to OCR (the prefilter renders are 640x360,
//      and cropping the chart-stream region out of one of those leaves a
//      ~90x79px patch that OCRs to nothing);
//   3. the frame is the one the manifest names — by md5.
//
// (3) is the important one. A frame's identity is its FILE, not its name:
// several DIFFERENT 1920x1080 images share each snapshot filename across
// run directories — five copies of qmg_20220606_2.png, three of them md5
// 93514908, which is the frame CLAUDE.md's position_table section describes
// as the bad one. Before the frames were pinned, which image the benchmark
// scored depended on directory-walk order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  CURATED_CASES,
  FIXTURE_FRAMES,
  FIXTURE_DIR,
  MIN_SNAPSHOT_WIDTH,
} = require('./qmgGroundTruth.test.js');

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

test('every curated case has a tracked frame', () => {
  assert.ok(CURATED_CASES.length >= 4, 'expected the four curated cases');
  for (const testCase of CURATED_CASES) {
    const key = `${testCase.dateKey}|${testCase.captureIndex}`;
    const frame = FIXTURE_FRAMES.get(key);
    assert.ok(frame, `no tracked frame for ${key} — the benchmark cannot run from a clone`);
    assert.equal(frame.case, testCase.mode, `${key}: the fixture and the curated case disagree on the mode`);
  }
});

test('every tracked frame exists and is at OCR resolution', async () => {
  const sharp = require('sharp');
  for (const frame of FIXTURE_FRAMES.values()) {
    const filePath = path.join(FIXTURE_DIR, frame.file);
    assert.ok(fs.existsSync(filePath), `${frame.file} is missing from test/fixtures/qmg_benchmark/`);
    const meta = await sharp(filePath).metadata();
    assert.ok(meta.width >= MIN_SNAPSHOT_WIDTH,
      `${frame.file} is ${meta.width}px wide — below the ${MIN_SNAPSHOT_WIDTH}px the benchmark requires`);
    assert.equal(meta.width, frame.width, `${frame.file}: the recorded width is wrong`);
    assert.equal(meta.height, frame.height, `${frame.file}: the recorded height is wrong`);
  }
});

test('every tracked frame is the frame the manifest names', () => {
  for (const frame of FIXTURE_FRAMES.values()) {
    const filePath = path.join(FIXTURE_DIR, frame.file);
    const actual = md5(filePath);
    assert.equal(actual, frame.md5,
      `${frame.file} has changed (md5 ${actual}, expected ${frame.md5}). A frame's identity is its `
      + 'FILE — if the frame was deliberately replaced, update the manifest and the recorded '
      + 'benchmark numbers together.');
  }
});

test('the tracked frames are not the prefilter renders', () => {
  // A 640x360 render is a different IMAGE that happens to share the name.
  // The md5s in the manifest are of the 1920x1080 frames.
  const tracked = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')
  );
  for (const frame of tracked.frames) {
    assert.equal(frame.width, 1920, `${frame.file}: expected a 1920-wide frame`);
    assert.equal(frame.height, 1080, `${frame.file}: expected a 1080-tall frame`);
  }
});

test('the manifest records where each frame came from', () => {
  const tracked = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')
  );
  for (const frame of tracked.frames) {
    assert.ok(frame.source, `${frame.file}: no source path recorded`);
    assert.ok(typeof frame.capture_index === 'number', `${frame.file}: no capture index recorded`);
    assert.equal(frame.snapshot_file_index, frame.capture_index + 1,
      `${frame.file}: the snapshot filename index is captureIndex + 1`);
  }
});
