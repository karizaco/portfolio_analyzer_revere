'use strict';

// The card's leader GROUPS and theme NAMES, read by POSITION.
//
// WHY THE POSITION AND NOT THE ORDER.
//
// Tesseract reads a multi-column card LINE BY LINE across the whole
// width, so the "Leaders:" runs of the 2026-05-09 card arrive
// interleaved:
//
//   Leaders: SNDK, MU,    Leaders: CIFR, HUT,    Leaders: FROG,
//   INTC and more.        NBIS and more.        DDOG, TWLO and more.
//
// and the text parser -- which walks the text in the order it arrives
// -- mixed the columns: the card's "Semis" group carried the "Data
// centers" leaders. **The leaders were right; their GROUPING was
// wrong.** So the groups are read by position: the "Leaders:" word is
// the anchor of a column, and every leader word belongs to the last
// anchor at or before it.
//
// And the theme NAMES are matched to the groups by position too: the
// title is centred in its box and the "Leaders:" line is at the box's
// left edge, so the title is the NEAREST one -- which is a different
// rule from the leaders', because they are left-aligned.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchThemesToGroups,
  parseLeaderGroups,
  parseThemeHeadings,
} = require('../src/komar/cardLayout');

/**
 * The 2026-05-09 card's theme region, as the OCR returns it.
 *
 * @returns {object[]}
 */
function words2026() {
  return [
    { height: 22, left: 116, text: 'Semis', top: 483 },
    { height: 22, left: 379, text: 'Data', top: 485 },
    { height: 22, left: 599, text: 'Software', top: 484 },
    { height: 22, left: 357, text: 'centers', top: 518 },
    { height: 20, left: 72, text: 'Strong', top: 563 },
    { height: 20, left: 130, text: 'demand', top: 562 },
    { height: 20, left: 325, text: 'Al', top: 563 },
    { height: 20, left: 72, text: 'Leaders:', top: 634 },
    { height: 20, left: 146, text: 'SNDK,', top: 635 },
    { height: 20, left: 202, text: 'MU,', top: 635 },
    { height: 20, left: 326, text: 'Leaders:', top: 634 },
    { height: 20, left: 399, text: 'CIFR,', top: 635 },
    { height: 20, left: 445, text: 'HUT,', top: 635 },
    { height: 20, left: 580, text: 'Leaders:', top: 634 },
    { height: 20, left: 654, text: 'FROG,', top: 635 },
    { height: 20, left: 73, text: 'INTC', top: 659 },
    { height: 20, left: 115, text: 'and', top: 659 },
    { height: 20, left: 152, text: 'more.', top: 662 },
    { height: 20, left: 326, text: 'NBIS', top: 659 },
    { height: 20, left: 369, text: 'and', top: 659 },
    { height: 20, left: 405, text: 'more.', top: 662 },
    { height: 20, left: 580, text: 'DDOG,', top: 659 },
    { height: 20, left: 640, text: 'TWLO', top: 659 },
    { height: 20, left: 693, text: 'and', top: 659 },
    { height: 20, text: 'more.', top: 686 },
  ];
}

test('the leader groups are the columns, not the order the words arrive in', () => {
  const groups = parseLeaderGroups(words2026());
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].leaders, ['SNDK', 'MU', 'INTC']);
  assert.deepEqual(groups[1].leaders, ['CIFR', 'HUT', 'NBIS']);
  assert.deepEqual(groups[2].leaders, ['FROG', 'DDOG', 'TWLO']);
});

test('a description above the "Leaders:" line is not a leader', () => {
  // "powered by AI theme" reads as "Al", and it is two lines above the
  // label -- so it is not a leader of that theme.
  const groups = parseLeaderGroups(words2026());
  for (const group of groups) {
    assert.ok(!group.leaders.includes('Al'), `"Al" is not a leader of ${group.x}`);
  }
});

test('a dollar sign and a comma are decoration, not part of the ticker', () => {
  const groups = parseLeaderGroups([
    { height: 20, left: 94, text: 'Leaders:', top: 1117 },
    { height: 20, left: 241, text: '$GEV,', top: 1114 },
    { height: 20, left: 348, text: '$AR,', top: 1114 },
    { height: 20, left: 92, text: '$VST,', top: 1156 },
  ]);
  assert.deepEqual(groups[0].leaders, ['GEV', 'AR', 'VST']);
});

test('a trailing lowercase letter is the OCR\'s noise, not the ticker', () => {
  // The 2026-03-14 card's "AAOI" reads as "AAOIl", and a ticker is
  // uppercase -- so the lowercase letter goes before the shape test,
  // which would otherwise reject the word before the lexicon sees it.
  const groups = parseLeaderGroups([
    { height: 20, left: 73, text: 'Leaders:', top: 633 },
    { height: 20, left: 146, text: 'TPL,', top: 634 },
    { height: 20, left: 186, text: 'BATL', top: 634 },
    { height: 20, left: 580, text: 'AAOIl', top: 658 },
  ]);
  assert.deepEqual(groups[0].leaders, ['TPL', 'BATL', 'AAOI']);
});

test('a wrapped tail belongs to its own column, not the one before it', () => {
  // The 2026-03-14 card's "AMPX," is at x 326 and its "Leaders:"
  // label is at x 327 -- a pixel to the LEFT of its own anchor. The
  // nearest-anchor rule keeps it; the "last anchor before it" rule
  // would hand it to the previous column.
  const groups = parseLeaderGroups([
    { height: 20, left: 73, text: 'Leaders:', top: 633 },
    { height: 20, left: 146, text: 'TPL,', top: 634 },
    { height: 20, left: 327, text: 'Leaders:', top: 633 },
    { height: 20, left: 401, text: 'RCAT,', top: 634 },
    { height: 20, left: 326, text: 'AMPX,', top: 658 },
    { height: 20, left: 581, text: 'Leaders:', top: 633 },
    { height: 20, left: 654, text: 'SNDK,', top: 634 },
    { height: 20, left: 580, text: 'AAOIl', top: 658 },
  ]);
  assert.deepEqual(groups[0].leaders, ['TPL']);
  assert.deepEqual(groups[1].leaders, ['RCAT', 'AMPX']);
  assert.deepEqual(groups[2].leaders, ['SNDK', 'AAOI']);
});

test('the theme names are matched to the groups by position', () => {
  const groups = parseLeaderGroups(words2026());
  const names = matchThemesToGroups([
    { left: 116, right: 202, text: 'Semis' },
    { left: 357, right: 468, text: 'Data centers' },
    { left: 599, right: 733, text: 'Software' },
  ], groups);
  assert.deepEqual(names, ['Semis', 'Data centers', 'Software']);
});

test('the names can be read from the OCR\'s words when the accent ink cannot', () => {
  // The 2025 card draws its theme boxes with a DOTTED border in the
  // same colour as the titles, so the accent ink merges them. The
  // title is then the topmost word-looking token in the column.
  const words = [
    { height: 40, left: 190, text: 'Energy', top: 803 },
    { height: 40, left: 511, text: 'Software', top: 798 },
    { height: 40, left: 922, text: '|', top: 798 },
    { height: 40, left: 1017, text: 'Datacenter', top: 803 },
    { height: 40, left: 1536, text: 'Chips', top: 796 },
    { height: 30, left: 94, text: 'Nuclear', top: 949 },
    { height: 30, left: 260, text: 'natural', top: 949 },
    { height: 30, left: 982, text: 'Data', top: 949 },
    { height: 30, left: 94, text: 'Leaders:', top: 1117 },
    { height: 30, left: 241, text: '$GEV,', top: 1114 },
    { height: 30, left: 538, text: 'Leaders:', top: 1117 },
    { height: 30, left: 685, text: '$VERX,', top: 1114 },
    { height: 30, left: 982, text: 'Leaders:', top: 1117 },
    { height: 30, left: 1129, text: '$AVGO,', top: 1114 },
    { height: 30, left: 1426, text: 'Leaders:', top: 1159 },
    { height: 30, left: 1573, text: '$SMTC,', top: 1156 },
  ];
  const groups = parseLeaderGroups(words);
  assert.equal(groups.length, 4);
  const names = parseThemeHeadings(words, groups);
  assert.deepEqual(names, ['Energy', 'Software', 'Datacenter', 'Chips']);
});

test('a description word is not a theme name', () => {
  // The 2026-03-14 card's first theme is "Oil", whose description
  // begins "Benefit from higher oil price." -- and the title itself is
  // unreadable (Tesseract merges its "il"), so the fallback would
  // pick "Benefit". The theme names SHARE A ROW, and "Benefit" is a
  // line below them, so it is refused.
  const words = [
    { height: 40, left: 140, text: 'o]]', top: 482 },
    { height: 40, left: 362, text: 'Drones', top: 484 },
    { height: 40, left: 624, text: 'Semis', top: 484 },
    { height: 30, left: 73, text: 'Benefit', top: 561 },
    { height: 30, left: 73, text: 'Leaders:', top: 633 },
    { height: 30, left: 146, text: 'TPL,', top: 634 },
    { height: 30, left: 327, text: 'Leaders:', top: 633 },
    { height: 30, left: 401, text: 'RCAT,', top: 634 },
    { height: 30, left: 581, text: 'Leaders:', top: 633 },
    { height: 30, left: 654, text: 'SNDK,', top: 634 },
  ];
  const groups = parseLeaderGroups(words);
  assert.equal(groups.length, 3);
  const names = parseThemeHeadings(words, groups);
  assert.deepEqual(names, ['', 'Drones', 'Semis']);
});
