'use strict';

// The positions panel prints its OWN row count in its footer:
//
//   N Items in Personal WatchList          the whole list
//   1 Item in Personal WatchList           singular when the total is one
//   K of N Items in Personal WatchList     a row is selected; K is that row's
//                                          INDEX, not a scroll range
//
// N is the number of rows ON SCREEN — the panel is not scrolled, so all N rows
// are visible at once. That makes it an INDEPENDENT check on a reading: a
// reading with a different number of tickers has provably dropped a row or
// invented one.
//
// This test pins the reader's rules, which are the ones the ground-truth
// audit had to discover by hand:
//
//   * N is the digit IMMEDIATELY before "Item(s)", so "5 of 7 Items" gives 7
//     (the total) and not 5 (the selected row's index);
//   * the footer must be BELOW the positions header, because "Personal
//     WatchList" does NOT identify the panel — the 2022-era frame carries
//     THREE right-hand widgets and TWO of them print that wording;
//   * the count is REPORTED, never acted on.
//
// The last point is the important one, and it is a property of the PARSER,
// not of this function: a count read low would truncate a correct reading,
// and that is exactly the case where acting on it would do the most damage.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readPanelRowCount } = require('../src/parse/parseChartStream');

/**
 * Build a word list from a list of lines, each given as
 * `[lineNumber, [[left, text], ...]]`.
 */
function wordsFromLines(lines) {
  const words = [];
  for (const [line, cells] of lines) {
    for (const [left, text] of cells) {
      words.push({ text, line, left, top: line * 90, width: 40, height: 30, conf: 0.9 });
    }
  }
  return words;
}

/** The positions header on line 10, at y 900. */
const HEADER = [[10, [[100, 'A'], [160, '-'], [200, 'Positions']]]];

test('the whole-list footer gives its count', () => {
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, '8'], [200, 'Items'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.ok(result, 'the footer should have been read');
  assert.equal(result.count, 8);
  assert.equal(result.line, 20);
});

test('the singular form is read', () => {
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, '1'], [200, 'Item'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.ok(result);
  assert.equal(result.count, 1);
});

test('"K of N Items" gives the TOTAL, not the selected row index', () => {
  // This is the trap. "5 of 7" means row 5 is selected out of 7 — the panel
  // has SEVEN rows on screen, not five.
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, '5'], [200, 'of'], [300, '7'], [400, 'Items'], [520, 'in'], [600, 'Personal'], [760, 'WatchList']]],
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.ok(result);
  assert.equal(result.count, 7, 'the count must be the total, not the selected index');
});

test('a footer ABOVE the positions header is not the positions table', () => {
  // The 2022-era frame carries three right-hand widgets and TWO of them print
  // "Personal WatchList". The upper widget's footer sits ABOVE the
  // "A - Positions" header, so the header is the bound that tells the two
  // apart — the wording cannot.
  const words = wordsFromLines([
    [2, [[100, '1'], [200, '-'], [300, 'WL']]],
    [5, [[100, '8'], [200, 'Items'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
    ...HEADER,
    [20, [[100, '7'], [200, 'Items'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.ok(result);
  assert.equal(result.count, 7, 'the bottom-most footer below the header is the positions table');
});

test('the middle screener\'s "Items in WatchList" footer is not read', () => {
  // The plain form (no "Personal") belongs to the middle screener panel, and
  // it is above the positions header anyway.
  const words = wordsFromLines([
    [5, [[100, '3'], [200, 'Items'], [320, 'in'], [400, 'WatchList']]],
    ...HEADER,
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.equal(result, null, 'the screener panel\'s footer is not the positions table\'s');
});

test('no header means no count, rather than a count from the wrong panel', () => {
  // Without the header there is no way to tell which panel a footer came from,
  // and a count with no panel is worse than no count.
  const words = wordsFromLines([
    [20, [[100, '8'], [200, 'Items'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  assert.equal(readPanelRowCount(words, null, null), null);
});

test('a footer that is not a footer is not read', () => {
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, '8'], [200, 'Shares'], [320, 'Held']]],
  ]);
  assert.equal(readPanelRowCount(words, 10, 900), null);
});

test('a footer with no readable number is not read', () => {
  // The count is read as letters ("ll Items"): there is nothing to report, and
  // a guess would be worse than nothing.
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, 'll'], [200, 'Items'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  assert.equal(readPanelRowCount(words, 10, 900), null);
});

test('an OCR-shaped "Items" is still read', () => {
  // "I" rendered as "l" is the common misread of the unit word.
  const words = wordsFromLines([
    ...HEADER,
    [20, [[100, '11'], [200, 'ltems'], [320, 'in'], [400, 'Personal'], [560, 'WatchList']]],
  ]);
  const result = readPanelRowCount(words, 10, 900);
  assert.ok(result);
  assert.equal(result.count, 11);
});

test('a footer with no words is not read', () => {
  assert.equal(readPanelRowCount([], 10, 900), null);
  assert.equal(readPanelRowCount(null, 10, 900), null);
});
