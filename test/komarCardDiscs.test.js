'use strict';

// The Komar market card's arrow discs, read from pixels.
//
// WHY THIS FILE EXISTS
//
// The card's trend arrows are IMAGES -- coloured discs with a white
// arrow glyph -- and no OCR reads a picture of an arrow. The direction
// is carried by the disc's COLOUR, and the corpus's own cards use three:
//
//   green  rgb(83,190,107)    up
//   amber  rgb(232,179,64)    flat / sideways
//   red    rgb(209,56,49)     down
//
// THE THREE FAILURE MODES THIS PINS
//
// 1. The disc's colour must not be confused with the card's BACKGROUND,
//    which is also green (rgb(38,87,25)) and is broken up by a chart
//    photograph (rgb(69,100,33)).
// 2. The white ARROW GLYPH lies across the disc and cuts it into
//    pieces, so a flood fill of the disc's colour finds fragments
//    rather than the disc. The disc has to be found by its CENTRE.
// 3. The rows have to be matched to the indices by ORDER, because the
//    card's index names are not next to their discs -- the discs are in
//    a lattice to the right of the names.
//
// And a row with no disc is 'unknown', never 'flat': a missing reading
// and a flat reading are different facts.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyDiscColour,
  findArrowDiscs,
  readTrendFromDiscs,
} = require('../src/komar/cardDiscs');

const WIDTH = 200;
const HEIGHT = 160;
const CHANNELS = 3;

/** The card's background green. */
const BACKGROUND = [38, 87, 25];

/** The disc colours, measured from the corpus's own cards. */
const COLOURS = {
  down: [209, 56, 49],
  flat: [232, 179, 64],
  up: [83, 190, 107],
};

/**
 * A synthetic card: a background with discs on it.
 *
 * @param {Array<object>} discs - { x, y, colour }
 * @returns {{data: Buffer, info: object}}
 */
function syntheticCard(discs) {
  const data = Buffer.alloc(WIDTH * HEIGHT * CHANNELS);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    data[i * CHANNELS] = BACKGROUND[0];
    data[i * CHANNELS + 1] = BACKGROUND[1];
    data[i * CHANNELS + 2] = BACKGROUND[2];
  }
  const info = { channels: CHANNELS, height: HEIGHT, width: WIDTH };

  for (const disc of discs) {
    const colour = COLOURS[disc.colour];
    for (let dy = -18; dy <= 18; dy += 1) {
      for (let dx = -18; dx <= 18; dx += 1) {
        if (dx * dx + dy * dy > 18 * 18) continue;
        const x = disc.x + dx;
        const y = disc.y + dy;
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
        const offset = (y * WIDTH + x) * CHANNELS;
        // A white arrow glyph across the disc, which is what splits it.
        const onGlyph = Math.abs(dx - dy) < 4 && Math.abs(dx + dy) < 16;
        data[offset] = onGlyph ? 255 : colour[0];
        data[offset + 1] = onGlyph ? 255 : colour[1];
        data[offset + 2] = onGlyph ? 255 : colour[2];
      }
    }
  }
  return { data, info };
}

test('a disc is told from the card background by its colour', () => {
  assert.equal(classifyDiscColour(83, 190, 107), 'up');
  assert.equal(classifyDiscColour(232, 179, 64), 'flat');
  assert.equal(classifyDiscColour(209, 56, 49), 'down');
  // The background is not a disc.
  assert.equal(classifyDiscColour(38, 87, 25), '');
  assert.equal(classifyDiscColour(69, 100, 33), '');
});

test('the discs are found even though the arrow glyph splits them', () => {
  const card = syntheticCard([
    { colour: 'up', x: 60, y: 30 },
    { colour: 'up', x: 110, y: 30 },
    { colour: 'flat', x: 60, y: 70 },
    { colour: 'down', x: 110, y: 70 },
  ]);
  const discs = findArrowDiscs(card.data, card.info);
  assert.equal(discs.length, 4);
  assert.deepEqual(
    discs.map((disc) => disc.direction).sort(),
    ['down', 'flat', 'up', 'up']
  );
});

test('the rows are matched to the indices by order', () => {
  const card = syntheticCard([
    { colour: 'up', x: 60, y: 30 },
    { colour: 'up', x: 110, y: 30 },
    { colour: 'flat', x: 60, y: 70 },
    { colour: 'flat', x: 110, y: 70 },
    { colour: 'down', x: 60, y: 110 },
    { colour: 'down', x: 110, y: 110 },
  ]);
  const discs = findArrowDiscs(card.data, card.info);
  const rows = readTrendFromDiscs(discs);
  assert.equal(rows.nasdaq, 'up');
  assert.equal(rows.sp500, 'flat');
  assert.equal(rows.russell2000, 'down');
});

test('a missing row is unknown, never flat', () => {
  // Only the first row has discs. The other two rows are NOT flat --
  // they were not read.
  const card = syntheticCard([
    { colour: 'up', x: 60, y: 30 },
    { colour: 'up', x: 110, y: 30 },
  ]);
  const discs = findArrowDiscs(card.data, card.info);
  const rows = readTrendFromDiscs(discs);
  assert.equal(rows.nasdaq, 'up');
  assert.equal(rows.sp500, 'unknown');
  assert.equal(rows.russell2000, 'unknown');
});

test('the per-horizon reading is kept whole', () => {
  const card = syntheticCard([
    { colour: 'up', x: 60, y: 30 },
    { colour: 'up', x: 110, y: 30 },
    { colour: 'up', x: 160, y: 30 },
  ]);
  const discs = findArrowDiscs(card.data, card.info);
  const rows = readTrendFromDiscs(discs);
  // Three columns are Long, Mid and Short, in that order.
  assert.deepEqual(rows.horizons, ['Long', 'Mid', 'Short']);
  assert.deepEqual(rows.byHorizon.nasdaq, { Long: 'up', Mid: 'up', Short: 'up' });
});

test('no discs means no reading', () => {
  const rows = readTrendFromDiscs([]);
  assert.equal(rows.nasdaq, 'unknown');
  assert.equal(rows.sp500, 'unknown');
  assert.equal(rows.russell2000, 'unknown');
  assert.deepEqual(rows.horizons, []);
});

test('the background is not read as a disc', () => {
  const card = syntheticCard([]);
  const discs = findArrowDiscs(card.data, card.info);
  assert.equal(discs.length, 0);
});
