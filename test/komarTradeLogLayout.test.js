'use strict';

// The Komar trade log: the sheet's GEOMETRY, its columns, and its
// values.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The shared table reader finds a grid by NEAR-BLACK rules (luma <= 40)
// on a white spreadsheet. The Komar sheet's gridlines are NEUTRAL
// GREY -- measured luma 165..248 -- so the shared detector finds
// NOTHING on the raw pixels and the whole 2048x1715 image reads as one
// cell. That is why this source has its own rule detection, and why
// the numbers below are pinned against the fixture's own pixels.
//
// The second rule is the one that cost four of the eighteen columns
// their mapping: a cell's words are read in READING ORDER (line by
// line), not in left-edge order. The sheet wraps "Breakout short-" /
// "term" and "Risk" / "Capital", and the second line starts a pixel to
// the LEFT of the first -- so the left-edge order reads
// "term Breakout short-" and "Capital Risk".
//
// The third rule is the sheet's own arithmetic: W/L % IS the return on
// the average price, so a row can be checked against itself.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sharp = require('sharp');

const {
  TRADE_LOG_COLUMNS,
  cellText,
  cleanCellText,
  findFillEdgeRules,
  findGreyHorizontalRules,
  findGreyVerticalRules,
  isNeutralGrey,
  isSaturatedFill,
  mergeBoundaries,
  parseRating,
  parseTradeDate,
  parseTradeNumber,
  signFromBackground,
} = require('../src/komar/tradeLogLayout');
const { assignColumns } = require('../src/oconnell/positionLayout');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'komar_tradelog');
const FIXTURE = path.join(FIXTURE_DIR, 'trade_log_sheet.png');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

test('the fixture is the sheet it claims to be', () => {
  const info = manifest();
  const bytes = fs.readFileSync(FIXTURE);
  assert.equal(
    crypto.createHash('md5').update(bytes).digest('hex'),
    info.image.md5,
    'the fixture is the pinned image'
  );
  assert.equal(bytes.length, info.image.bytes);
  assert.equal(info.measured_geometry.row_count, 32);
  assert.equal(info.measured_geometry.column_count, 18);
});

test('the sheet\'s gridlines are grey, so the shared detector cannot see them', async () => {
  // The premise of this source's own rule detection.
  const { findHorizontalRules } = require('../src/table/tableGrid');
  const source = await sharp(FIXTURE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const nearBlack = findHorizontalRules(source.data, source.info, {
    xEnd: source.info.width,
    xStart: 0,
  });
  assert.equal(nearBlack.length, 0, 'the shared detector finds no rules at all');
  // And the same pixels ARE grey.
  let grey = 0;
  let samples = 0;
  for (let x = 0; x < source.info.width; x += 7) {
    const offset = (172 * source.info.width + x) * source.info.channels;
    samples += 1;
    if (isNeutralGrey(source.data[offset], source.data[offset + 1], source.data[offset + 2])) {
      grey += 1;
    }
  }
  assert.ok(grey / samples > 0.8, 'the row separator is neutral grey');
});

test('the horizontal rules are the sheet\'s own rows', async () => {
  const source = await sharp(FIXTURE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rules = findGreyHorizontalRules(source.data, source.info);
  const expected = manifest().measured_geometry.horizontal_rules;
  assert.deepEqual(rules, expected);
  // The two that matter structurally: the header block's edges and the
  // last row's bottom.
  assert.equal(rules[0], 33, 'the title band ends at 33');
  assert.equal(rules[1], 123, 'the header block ends at 123');
  assert.equal(rules[rules.length - 1], 1695, 'the last row ends at 1695');
});

test('the vertical rules are the sheet\'s 19 column boundaries', async () => {
  const source = await sharp(FIXTURE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const geometry = manifest().measured_geometry;
  const lines = findGreyVerticalRules(source.data, source.info, 124, 1695);
  const edges = findFillEdgeRules(source.data, source.info, 124, 1695);
  const merged = mergeBoundaries(lines, edges, source.data, source.info, 124, 1695);
  assert.equal(merged.length, 19, '18 columns need 19 boundaries');
  // Every boundary is within a few pixels of the measured one: the
  // fills cover the rules they sit on, so the fill edge and the drawn
  // line disagree by a pixel or two.
  geometry.vertical_rules.forEach((expected, index) => {
    assert.ok(
      Math.abs(merged[index] - expected) <= 5,
      `boundary ${index}: ${merged[index]} is within 5px of ${expected}`
    );
  });
});

test('the filled cells are saturated, and their edges are the missing boundaries', async () => {
  const source = await sharp(FIXTURE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const edges = findFillEdgeRules(source.data, source.info, 124, 1695);
  const unique = [...new Set(edges)].sort((a, b) => a - b);
  // 960 is the W/L % column's left edge and 1030 the W/L R column's --
  // both hidden under the conditional fills, so the grey coverage
  // cannot see them.
  assert.ok(unique.some((x) => Math.abs(x - 960) <= 6), 'the W/L % left edge is found');
  assert.ok(unique.some((x) => Math.abs(x - 1030) <= 6), 'the W/L R left edge is found');
  // And the fills are saturated, not grey.
  const offset = (145 * source.info.width + 1000) * source.info.channels;
  assert.ok(isSaturatedFill(
    source.data[offset], source.data[offset + 1], source.data[offset + 2]
  ), 'the green W/L fill is saturated');
  assert.ok(!isNeutralGrey(
    source.data[offset], source.data[offset + 1], source.data[offset + 2]
  ), 'and it is not grey');
});

test('a cell is read in line order, not left-edge order', () => {
  // The sheet's own wrapped cells: "Breakout short-" / "term", where
  // the second line starts a pixel to the LEFT of the first.
  const cell = {
    text: 'term Breakout short-',
    words: [
      { text: 'term', left: 232, top: 1575 },
      { text: 'Breakout', left: 233, top: 1555 },
      { text: 'short-', left: 300, top: 1555 },
    ],
  };
  assert.equal(cellText(cell), 'Breakout short- term');
  assert.equal(cleanCellText(cellText(cell), true), 'Breakout short-term');
});

test('the header labels match the sheet\'s own eighteen columns', () => {
  // The labels as the sheet prints them, wrapped the way the sheet
  // wraps them: "Risk" over "Capital", "MMTS" over "Opening".
  const labels = [
    'Date opened', 'Date closed', 'Entry type', 'Ticker',
    'Avg. openin g price', 'Avg. close price', 'Stop loss', 'Stop loss %',
    'Risk Capital', 'Exit type', 'MMTS Opening', 'MMTS close',
    'W/L %', 'W/L R', 'Initial rating', 'After close rating', 'Review', 'Comment',
  ];
  const cells = labels.map((text) => ({ text }));
  const mapping = assignColumns(cells, TRADE_LOG_COLUMNS);
  const matched = new Set([...mapping.values()].map((column) => column.field));
  for (const column of TRADE_LOG_COLUMNS) {
    assert.ok(matched.has(column.field), `${column.field} is matched`);
  }
  assert.equal(matched.size, 18);
});

test('a number is read with the sheet\'s decimal comma', () => {
  assert.equal(parseTradeNumber('7,18'), 7.18);
  assert.equal(parseTradeNumber('0,56 %'), 0.56);
  assert.equal(parseTradeNumber('-0,19 %'), -0.19);
  assert.equal(parseTradeNumber('38,02 %'), 38.02);
  assert.equal(parseTradeNumber('10%'), 10);
  // A number that WRAPPED inside its cell comes back space-joined, and
  // the fragments concatenate: the sheet's IREN row prints "18,63" and
  // a "3" under it, which is 18,633.
  assert.equal(parseTradeNumber('18,63 3'), 18.633);
  assert.equal(parseTradeNumber('40,77 9'), 40.779);
  assert.equal(parseTradeNumber('17,10 15'), 17.1015);
  // The OCR sometimes returns a dot for the comma.
  assert.equal(parseTradeNumber('-1.39'), -1.39);
  // The stray characters a percent sign comes back as are dropped, so
  // a cell still reads as its number.
  assert.equal(parseTradeNumber('-10,43 ¢'), -10.43);
  assert.equal(parseTradeNumber('-10,71°'), -10.71);
});

test('a value outside its column\'s range is refused', () => {
  // A lost decimal point reads a hundred times too large; it must not
  // be published.
  assert.equal(parseTradeNumber('21419', [0, 1000]), null);
  assert.equal(parseTradeNumber('-139', [-20, 20]), null);
  assert.equal(parseTradeNumber('-10,43', [-100, 100]), -10.43);
  assert.equal(parseTradeNumber('', [0, 1000]), null);
  assert.equal(parseTradeNumber('abc'), null);
});

test('a date is read day-first, in both of the sheet\'s forms', () => {
  assert.equal(parseTradeDate('08.07.25'), '20250708');
  assert.equal(parseTradeDate('29.07.2025'), '20250729');
  assert.equal(parseTradeDate('01.08.2025'), '20250801');
  // A day that cannot be a day is not a date.
  assert.equal(parseTradeDate('31.31.25'), '');
  assert.equal(parseTradeDate('not a date'), '');
  assert.equal(parseTradeDate(''), '');
});

test('a star rating is a number, and zero is a value', () => {
  assert.equal(parseRating('4.5 stars'), 4.5);
  assert.equal(parseRating('5 stars'), 5);
  assert.equal(parseRating('0 stars'), 0);
  // An empty cell is an absent rating, never a zero.
  assert.equal(parseRating(''), null);
});

test('the W/L sign comes from the fill when the text has lost it', () => {
  assert.equal(signFromBackground({ r: 88, g: 216, b: 48 }), 1);
  assert.equal(signFromBackground({ r: 232, g: 32, b: 8 }), -1);
  assert.equal(signFromBackground({ r: 248, g: 248, b: 248 }), 0);
  assert.equal(signFromBackground(null), 0);
});
