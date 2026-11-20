'use strict';

// The Komar market card's theme titles, found by their accent colour.
//
// WHY THE COLOUR
//
// The card prints the theme names in ORANGE on a green card, and the
// OCR flattens the whole card into one line -- so the name, its
// description and its leaders end up in one string and the name cannot
// be told from the description.
//
// The orange ink is what separates them. But the accent ink also
// catches the badge, the footnote and (on a chart-heavy card) ordinary
// chart ink, so the boxes have to be FILTERED:
//
//   - a title is short: 28 characters at most
//   - a title is WORDS: at least 72% letters
//
// and the names are only USED when their count matches the number of
// leader groups. A name that is off by one is worse than no name.

const assert = require('node:assert/strict');
const test = require('node:test');

const { findAccentBoxes, isAccentPixel } = require('../src/komar/cardThemes');

const WIDTH = 400;
const HEIGHT = 300;
const CHANNELS = 3;

/**
 * A synthetic card with orange ink at the given places.
 *
 * @param {Array<object>} bands - { left, top, width, height }
 * @returns {{data: Buffer, info: object}}
 */
function syntheticCard(bands) {
  const data = Buffer.alloc(WIDTH * HEIGHT * CHANNELS);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    // A dark green background.
    data[i * CHANNELS] = 38;
    data[i * CHANNELS + 1] = 87;
    data[i * CHANNELS + 2] = 25;
  }
  const info = { channels: CHANNELS, height: HEIGHT, width: WIDTH };

  for (const band of bands) {
    for (let y = band.top; y < band.top + band.height; y += 1) {
      for (let x = band.left; x < band.left + band.width; x += 1) {
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
        const offset = (y * WIDTH + x) * CHANNELS;
        data[offset] = 232;
        data[offset + 1] = 151;
        data[offset + 2] = 57;
      }
    }
  }
  return { data, info };
}

test('the accent orange is told from the card background', () => {
  assert.equal(isAccentPixel(232, 151, 57), true);
  assert.equal(isAccentPixel(38, 87, 25), false);
  assert.equal(isAccentPixel(255, 255, 255), false);
});

test('two orange titles in one row are two boxes', () => {
  const card = syntheticCard([
    { height: 20, left: 20, top: 200, width: 60 },
    { height: 20, left: 150, top: 200, width: 70 },
  ]);
  const boxes = findAccentBoxes(card.data, card.info);
  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].left < boxes[1].left);
});

test('a wrapped title is one box', () => {
  const card = syntheticCard([
    { height: 18, left: 20, top: 180, width: 60 },
    { height: 18, left: 20, top: 200, width: 60 },
  ]);
  const boxes = findAccentBoxes(card.data, card.info);
  assert.equal(boxes.length, 1);
  // 180..217 inclusive is 38 rows, not 39: the two bands do not touch.
});

test('no accent ink means no titles', () => {
  const card = syntheticCard([]);
  assert.deepEqual(findAccentBoxes(card.data, card.info), []);
});

