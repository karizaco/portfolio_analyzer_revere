const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cellAt,
  cellsFromSeparators,
  detectSeparators,
} = require('../src/asym/sectorGeometry');
const {
  PANEL_SCALE,
  identifyColumns,
  isBareFragment,
  layoutFromCells,
  repairNumber,
} = require('../src/asym/sectorTable');

/**
 * A fake frame: a dark panel with dim grey vertical rules.
 *
 * @param {number} width
 * @param {number} height
 * @param {number[]} rules - the x positions of the rules
 * @returns {{data: Buffer, info: object}}
 */
function fakeFrame(width, height, rules) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels, 0);
  for (const x of rules) {
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * channels;
      data[offset] = 70;
      data[offset + 1] = 70;
      data[offset + 2] = 70;
    }
  }
  return { data, info: { width, height, channels } };
}

test('the vertical rules of the table are found', () => {
  const frame = fakeFrame(200, 100, [24, 90, 150]);
  const found = detectSeparators(frame.data, frame.info, { top: 0, height: 100, xMax: 200 });
  assert.deepEqual(found, [24, 90, 150]);
});

test('the white numbers are not mistaken for rules', () => {
  const frame = fakeFrame(200, 100, [24, 90]);
  // A block of white, as a number would be.
  for (let y = 10; y < 40; y += 1) {
    for (let x = 40; x < 70; x += 1) {
      const offset = (y * 200 + x) * 3;
      frame.data[offset] = 255;
      frame.data[offset + 1] = 255;
      frame.data[offset + 2] = 255;
    }
  }
  const found = detectSeparators(frame.data, frame.info, { top: 0, height: 100, xMax: 200 });
  assert.deepEqual(found, [24, 90]);
});

test('a coloured number is not mistaken for a rule either', () => {
  const frame = fakeFrame(200, 100, [24, 90]);
  for (let y = 10; y < 60; y += 1) {
    for (let x = 40; x < 70; x += 1) {
      const offset = (y * 200 + x) * 3;
      frame.data[offset] = 220;
      frame.data[offset + 1] = 40;
      frame.data[offset + 2] = 40;
    }
  }
  const found = detectSeparators(frame.data, frame.info, { top: 0, height: 100, xMax: 200 });
  assert.deepEqual(found, [24, 90]);
});

test('the rules cut the panel into cells', () => {
  const cells = cellsFromSeparators([24, 90, 150], 200);
  assert.deepEqual(cells, [
    { left: 0, right: 24 },
    { left: 24, right: 90 },
    { left: 90, right: 150 },
    { left: 150, right: 200 },
  ]);
});

test('a pixel belongs to the cell that holds it', () => {
  const cells = cellsFromSeparators([24, 90, 150], 200);
  assert.equal(cellAt(cells, 10), 0);
  assert.equal(cellAt(cells, 24), 1);
  assert.equal(cellAt(cells, 89), 1);
  assert.equal(cellAt(cells, 90), 2);
  assert.equal(cellAt(cells, 199), 3);
  assert.equal(cellAt(cells, 400), -1);
});

/**
 * A row of the table, in the panel's own pixels.
 *
 * @param {Array<[number, string]>} items - the x and the text of each word
 * @returns {object}
 */
function row(items) {
  return {
    middle: 10,
    words: items.map(([x, text]) => ({ text, left: x * PANEL_SCALE, top: 0, width: 10, height: 20, conf: 90 })),
  };
}

test('the columns are found by what is in the cells', () => {
  const cells = cellsFromSeparators([8, 24, 130, 176, 208, 235, 296, 357], 420);
  const rows = [];
  for (const name of ['Energy', 'Utilities', 'Healthcare', 'Technology', 'Real Estate']) {
    rows.push(row([
      [30, name],
      [150, '4.16'],
      [258, '+0.69%'],
      [330, '4.88'],
    ]));
  }
  const columns = identifyColumns({ cells, rows });
  assert.ok(columns, 'the table was read');
  assert.equal(columns.nameCell, 2, 'the cell that holds the names');
  assert.equal(columns.rocCell, 3, 'the cell right after it');
  assert.equal(columns.changeCell, 6, 'the cell that holds the percent signs');
  assert.equal(columns.yearCell, 7, 'the cell right after that');
});

test('a post with FOUR checkmark columns is read the same way', () => {
  // The four checkmark columns sit between the two rates of change.
  const cells = cellsFromSeparators([8, 24, 136, 181, 213, 240, 273, 334, 377], 420);
  const rows = [];
  for (const name of ['Energy', 'Utilities', 'Healthcare', 'Technology', 'Real Estate']) {
    rows.push(row([
      [30, name],
      [156, '9.99'],
      [292, '+0.34%'],
      [364, '34'],
    ]));
  }
  const columns = identifyColumns({ cells, rows });
  assert.ok(columns, 'the table was read');
  assert.equal(columns.nameCell, 2);
  assert.equal(columns.rocCell, 3);
  assert.equal(columns.changeCell, 7, 'the percent signs, not a checkmark column');
  assert.equal(columns.yearCell, 8);
});

test('a table that cannot be read gives no columns', () => {
  const cells = cellsFromSeparators([24, 90], 200);
  assert.equal(identifyColumns({ cells, rows: [row([[30, 'Energy']])] }), null);
});

test('the layout follows the cells', () => {
  const cells = cellsFromSeparators([24, 130, 176, 235, 296, 357], 420);
  const layout = layoutFromCells(cells, { nameCell: 1, rocCell: 2, changeCell: 4, yearCell: 5 });
  assert.equal(layout.source, 'detected');
  assert.equal(layout.nameMaxX, 130);
  assert.equal(layout.rocStrip.min, 132);
  assert.equal(layout.rocStrip.max, 174);
  assert.equal(layout.changeBand.min, 237);
  assert.equal(layout.changeBand.max, 294);
  assert.equal(layout.yearStrip.min, 298);
  assert.equal(layout.yearStrip.max, 355);
});

test('a bare integer of one or two digits is a fragment, not a reading', () => {
  assert.equal(isBareFragment('34'), true);
  assert.equal(isBareFragment('2'), true);
  assert.equal(isBareFragment('03571'), false, 'five digits is a lost point, not a fragment');
  assert.equal(isBareFragment('34.71'), false);
  assert.equal(isBareFragment('-34'), true);
  assert.equal(isBareFragment(''), false);
  assert.equal(isBareFragment('abc'), false);
});

test('a reading whose integer part has a leading zero is not a number', () => {
  // "-0.51%" read as "03571%" -- the digits are not a number that
  // lost its point, they are a reading that went wrong.
  assert.equal(repairNumber('03571%').value, null);
  assert.equal(repairNumber('03571%').complete, false);
  // But a real zero is a real zero.
  assert.equal(repairNumber('051').value, 0.51);
  assert.equal(repairNumber('005').value, 0.05);
  assert.equal(repairNumber('147').value, 1.47);
});
