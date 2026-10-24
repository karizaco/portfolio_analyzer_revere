'use strict';

// Regression tests for the GLYPH MERGE rule in src/video/positionColumn.js.
//
// extractWords grows a glyph by chaining row runs that overlap it. The
// original test was "does the candidate cover more than 40 % of the
// SHORTER of the two runs", which is symmetric and therefore lets a 1 px
// run join a 51 px one in either direction — the small run is wholly
// inside the big one, so it always covers 100 % of itself.
//
// That is how the 2023 sidebar's header RULE (51 px wide) fused with the
// panel BORDER (1 px) below it into a single glyph spanning the whole
// table. The consume step then deleted the ticker of every row in
// between, so the positions table lost its middle rows and published
// nothing.
//
// The fix adds a second, asymmetric test: the candidate must also cover
// MIN_MERGE_SUPPORT of the LONGER of the two. A letter's stem (1 px in a
// 7 px bar) still merges; chrome does not.
//
// These tests are hermetic — a synthetic mask, no OCR, no files on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractWords } = require('../src/video/positionColumn');

// The threshold the module uses. Duplicated here on purpose: if the module
// changes the number, this test must fail loudly rather than track it.
const MIN_MERGE_SUPPORT = 0.03;

/**
 * A white-on-black mask, built from rectangles.
 *
 * @param {number} width
 * @param {number} height
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Uint8Array}
 */
function makeMask(width, height, rects) {
  const mask = new Uint8Array(width * height);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || x >= width) continue;
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/** The words whose bounding box covers a point. */
function wordsAt(words, x, y) {
  return words.filter((w) => x >= w.x0 && x <= w.x1 && y >= w.top && y <= w.bottom);
}

test('the merge rule is asymmetric: a 1 px run does not join a 51 px run', () => {
  const width = 80;
  const height = 30;

  // A wide rule at the top, a 1 px border below it on the rule's left
  // edge, and a ticker letter in each of three rows under the rule.
  const mask = makeMask(width, height, [
    { x: 10, y: 0, w: 51, h: 1 },   // the header rule
    { x: 10, y: 1, w: 1, h: 20 },   // the panel border
    { x: 30, y: 5, w: 3, h: 7 },    // a ticker letter
    { x: 30, y: 12, w: 3, h: 7 },
    { x: 30, y: 19, w: 3, h: 7 },
  ]);

  const words = extractWords(mask, width, height, {});

  // No single word may span the rule AND the ticker rows: that is the
  // merged-glyph bug, and it is what eats the tickers.
  const spanning = words.filter((w) => w.top <= 0 && w.bottom >= 19);
  assert.equal(spanning.length, 0,
    `a glyph spans the whole table: ${JSON.stringify(spanning)}`);

  // Every ticker letter must survive as its own glyph.
  for (const y of [5, 12, 19]) {
    const covering = wordsAt(words, 31, y);
    assert.ok(covering.length > 0, `the ticker letter at y=${y} was consumed`);
    for (const w of covering) {
      assert.ok(w.top >= 5 && w.bottom <= 26,
        `the ticker letter at y=${y} was fused into a glyph at y ${w.top}..${w.bottom}`);
    }
  }
});

test('the merge rule still joins a letter stem to its bar', () => {
  const width = 40;
  const height = 10;

  // A 20 px bar with a 1 px stem in the middle of it — the shape of a
  // "T". 1/20 = 0.05 is above the threshold, so the two rows are ONE
  // glyph.
  const mask = makeMask(width, height, [
    { x: 10, y: 0, w: 20, h: 1 },
    { x: 20, y: 1, w: 1, h: 4 },
  ]);

  const words = extractWords(mask, width, height, {});
  const covering = wordsAt(words, 20, 2);
  assert.equal(covering.length, 1,
    `expected one glyph over the stem, got ${JSON.stringify(covering)}`);
  assert.equal(covering[0].top, 0, 'the stem did not merge with the bar');
  assert.equal(covering[0].bottom, 4);
});

test('the threshold separates the two cases by a factor of two', () => {
  // The chrome case: a 1 px run against a 51 px run.
  // The stem case:   a 1 px run against a 20 px run.
  assert.ok(1 / 51 < MIN_MERGE_SUPPORT, 'the chrome case must be blocked');
  assert.ok(1 / 20 >= MIN_MERGE_SUPPORT, 'the stem case must be allowed');
});

// The frame that exposed the bug: qmg_20230609.png, captured twice into
// two different runs. The copy in the 20261017 run used to yield the
// WATCHLIST ladder (17 rows ending at y 636) instead of the positions
// table (16 rows at y 658..931).
//
// The frames live under the gitignored scratch tree, so this test skips
// itself when they are absent rather than failing the suite.
const REAL_FRAMES = [
  path.join(__dirname, '..', 'data', 'video_scan_test', '_rerun',
    'qmg-easyocr-20261017', 'snapshots', 'qmg_20230609.png'),
  path.join(__dirname, '..', 'data', 'video_scan_test', '_rerun',
    'qmg-easyocr-20261012', 'snapshots', 'qmg_20230609.png'),
];
const REAL_FRAME = REAL_FRAMES.find((f) => fs.existsSync(f));

test('the real 2023 sidebar frame keeps its positions ladder',
  { skip: !REAL_FRAME }, () => {
    const { findTickerColumnByInkRuns } = require('../src/video/positionColumn');
    return findTickerColumnByInkRuns(REAL_FRAME, {}).then((result) => {
      assert.ok(result.column, 'no ticker column was found');
      // The positions table sits at x 1697..1739 and has 16 rows.
      assert.equal(result.rows.length, 16,
        `expected 16 rows, got ${result.rows.length} (${result.rows.map((r) => r.top).join(',')})`);
      assert.ok(result.column.left >= 1690 && result.column.left <= 1700,
        `the column moved to x ${result.column.left}`);
      assert.ok(result.rows[0].top >= 650 && result.rows[0].top <= 670,
        `the first row is at y ${result.rows[0].top}, not the positions table`);
      assert.ok(result.rows[result.rows.length - 1].top >= 920,
        `the last row is at y ${result.rows[result.rows.length - 1].top}`);
    });
  });
