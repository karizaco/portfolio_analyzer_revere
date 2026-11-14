'use strict';

// The table GEOMETRY: finding a grid in an image.
//
// Two rules carry the weight, and both were found by measuring a real
// position log:
//
//   1. THE RULES ARE NEAR-BLACK, NOT DARK. A spreadsheet's cell
//      borders are pure black, and the FILLED cells are coloured -- a
//      solid red (rgb 255,0,0, luma 54) behind a white "BELOW". A
//      detector that accepts "dark" finds the fill's columns as well as
//      the rules, and a column of pixels running through a red cell is
//      "dark" for the whole height of the cell, so it looks exactly
//      like a rule.
//
//   2. A RULE IS CONTINUOUS. Text is black too, but only where a
//      glyph stroke happens to be, so a rule is a column that is black
//      down the WHOLE band.

const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const {
  INK_LUMA,
  bandsBetween,
  cellsBetween,
  findHorizontalRules,
  findVerticalRules,
  inkComponents,
  luma,
} = require('../src/table/tableGrid');

/**
 * A synthetic spreadsheet: a bordered grid of cells, some of them
 * filled with a saturated colour, some with black text.
 *
 * @param {object} [options]
 * @returns {Promise<{buffer: Buffer, info: object}>}
 */
async function makeGrid(options = {}) {
  const width = options.width || 400;
  const height = options.height || 200;
  const columns = options.columns || [0, 60, 140, 220, 300, 399];
  const rows = options.rows || [0, 40, 80, 120, 159];
  const fills = options.fills || {};

  const data = Buffer.alloc(width * height * 3, 255);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
  };

  // The horizontal rules.
  for (const row of rows) {
    for (let x = 0; x < width; x += 1) put(x, row, 0, 0, 0);
  }
  // The vertical rules.
  for (const column of columns) {
    for (let y = 0; y < height; y += 1) put(column, y, 0, 0, 0);
  }
  // The filled cells, in the saturated colour that must NOT be mistaken
  // for a rule.
  for (const [key, colour] of Object.entries(fills)) {
    const [columnIndex, rowIndex] = key.split(':').map(Number);
    const left = columns[columnIndex] + 1;
    const right = columns[columnIndex + 1] - 1;
    const top = rows[rowIndex] + 1;
    const bottom = rows[rowIndex + 1] - 1;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) put(x, y, colour[0], colour[1], colour[2]);
    }
  }

  return {
    buffer: data,
    info: { channels: 3, height, width },
  };
}

test('the horizontal rules of a grid are found', async () => {
  const { buffer, info } = await makeGrid();
  const rules = findHorizontalRules(buffer, info, { xEnd: info.width, xStart: 0 });
  assert.deepEqual(rules, [0, 40, 80, 120, 159]);
});

test('the vertical rules of a grid are found', async () => {
  const { buffer, info } = await makeGrid();
  const rules = findVerticalRules(buffer, info, { yEnd: info.height, yStart: 0 });
  assert.deepEqual(rules, [0, 60, 140, 220, 300, 399]);
});

test('a saturated fill is not a rule', async () => {
  // The measured case: a solid red cell behind a white "BELOW". The
  // red has a luma of 54, and the rule threshold is 40, so the fill's
  // columns are not rules.
  const { buffer, info } = await makeGrid({
    fills: { '1:1': [255, 0, 0], '2:1': [255, 0, 0] },
  });
  const rules = findVerticalRules(buffer, info, { yEnd: info.height, yStart: 0 });
  assert.ok(!rules.includes(61), 'the red fill must not read as a rule');
  assert.ok(!rules.includes(141), 'the red fill must not read as a rule');
  assert.ok(rules.includes(60), 'the real rule must still be found');
});

test('the ink threshold excludes the red fill and includes the black rules', () => {
  assert.ok(luma(255, 0, 0) > INK_LUMA, 'the red fill is lighter than the ink threshold');
  assert.ok(luma(0, 0, 0) <= INK_LUMA, 'a black rule is at the ink threshold');
});

test('the bands between the rules are the rows', async () => {
  const { buffer, info } = await makeGrid();
  const rules = findHorizontalRules(buffer, info, { xEnd: info.width, xStart: 0 });
  const bands = bandsBetween(rules, { from: 0, to: info.height });
  // The band between the rule at 40 and the one at 80.
  const second = bands.find((band) => band.top === 40);
  assert.deepEqual(second, { bottom: 79, top: 40 });
});

test('the cells between the rules are the columns', async () => {
  const { buffer, info } = await makeGrid();
  const rules = findVerticalRules(buffer, info, { yEnd: info.height, yStart: 0 });
  const cells = cellsBetween(rules, { from: 0, to: info.width });
  // The cell between the rule at 60 and the one at 140.
  const second = cells.find((cell) => cell.left === 60);
  assert.deepEqual(second, { left: 60, right: 139 });
  // Every rule is a boundary of some cell.
  for (const rule of rules) {
    assert.ok(
      cells.some((cell) => cell.left === rule || cell.right === rule - 1),
      `the rule at ${rule} must bound a cell`
    );
  }
});

test('the position-sizing stars are counted as shapes', async () => {
  // Three stars, three blobs of the same size -- which is what the
  // 20261112 position log measures: 17x16 pixels and 130 ink pixels
  // each.
  const width = 120;
  const height = 40;
  const data = Buffer.alloc(width * height * 3, 255);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  };
  for (const start of [10, 40, 70]) {
    for (let y = 12; y < 28; y += 1) {
      for (let x = start; x < start + 16; x += 1) put(x, y);
    }
  }
  const info = { channels: 3, height, width };
  const components = inkComponents(data, info, { bottom: 39, left: 0, right: 119, top: 0 });
  assert.equal(components.length, 3);
  assert.equal(components[0].width, 16);
  assert.equal(components[0].height, 16);
});

test('a single star is one shape, and the lettering is not', async () => {
  const width = 120;
  const height = 40;
  const data = Buffer.alloc(width * height * 3, 255);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  };
  // One star.
  for (let y = 12; y < 28; y += 1) {
    for (let x = 10; x < 26; x += 1) put(x, y);
  }
  // And the word "MSOS", which is four narrow strokes.
  for (const start of [50, 62, 74, 86]) {
    for (let y = 14; y < 26; y += 1) {
      for (let x = start; x < start + 4; x += 1) put(x, y);
    }
  }
  const info = { channels: 3, height, width };
  const components = inkComponents(data, info, { bottom: 39, left: 0, right: 119, top: 0 });
  assert.equal(components.length, 5);
  // The star is the wide one; the letters are narrow.
  const wide = components.filter((component) => component.width >= 12);
  assert.equal(wide.length, 1);
});
