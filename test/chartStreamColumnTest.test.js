'use strict';

// The column test of the curated-alias rescue: is a token INSIDE the
// position-list column?
//
// THE DEFECT THIS FILE PINS
//
// The rescue asks that question by comparing the token's CENTRE with the
// column's median centre, within a hardcoded +-25 px (`columnWidth = 50`,
// `src/parse/parseChartStream.js`). A position list is a LEFT-aligned table,
// so every ticker in it starts at the same x no matter how many characters it
// has — and the centre of a short ticker therefore sits far to the left of the
// column's median centre.
//
// Measured on the real `20230609` capture: every ticker in the column starts
// at x 515-518 and the one-character `A` starts at x 518 too, but its centre
// is 545 against a median centre of 581.5 — `|545 - 581.5| = 36.5 > 25`, so
// the token was rejected before the alias was ever consulted. The same holds
// for `Al` on `20230608` (centre 87, median centre 125.5).
//
// So the `A -> AI` and `AL -> AI` rows of `config/ticker_ocr_confusions.csv`
// could not fire, and `AI` was a miss on every date.
//
// THE FIX
//
// The column's LEFT edge is computed (the median left of the column's own
// members) and the token's left edge is compared with it. The centre test is
// kept as an ALTERNATIVE rather than replaced, so the union of the two tests
// cannot reject a token the old gate accepted — a right-aligned or centred
// layout is still judged by its centres.
//
// Measured over the replay corpus (`node tools/evalParserReplay.js`, no OCR):
//
//   default roots : 66/89 (74.2 %) -> 71/89 (79.8 %) recall,
//                   predictions 69 -> 74, so the three false positives are
//                   UNCHANGED and precision rises 95.7 % -> 95.9 %.
//   wide corpus   : 113/170 (66.5 %) -> 117/170 (68.8 %) recall,
//                   predictions 136 -> 140, false positives unchanged at 23.
//
// The corpus is UNTRACKED, so those numbers cannot be asserted here — a fresh
// clone has no probe logs. What IS assertable is the parser's BEHAVIOUR on
// the geometry, and that is what this file pins.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

// The geometry is the one measured on the real frame: a 1345 px EasyOCR crop
// of the 2023-era sidebar, whose tickers are ~130 px wide and start at the
// same x.
const LIST_X = 780;
const WIDE_TOKEN_W = 130;   // a four-character ticker
const NARROW_TOKEN_W = 54;  // the one-character glyph

/**
 * A position list whose tickers are all LEFT-aligned at `LIST_X`.
 *
 * `narrow` puts a one-character token ("A") in the column. Its centre is
 * `LIST_X + 27` while the column's median centre is `LIST_X + 65`, so the
 * centre test rejects it by 38 px — the real defect, reproduced.
 *
 * The row carries a garbled price ("$lO5.OO" for "$105.00"), which is what
 * makes the row non-price-aligned and therefore invisible to the in-column
 * repair pass. Only the curated-alias rescue can reach it.
 */
function leftAlignedFrame({ narrowToken = 'A', narrowBelowWatchlist = false } = {}) {
  const rows = [
    { token: 'POSITIONS', x: 700, w: 90 },
    { token: 'AAPL', x: LIST_X, w: WIDE_TOKEN_W, price: '$214.50' },
    { token: 'MSFT', x: LIST_X, w: WIDE_TOKEN_W, price: '$412.30' },
    { token: 'TSLA', x: LIST_X, w: WIDE_TOKEN_W, price: '$342.10' },
    { token: 'VLO', x: LIST_X, w: WIDE_TOKEN_W, price: '$lO5.OO' },
  ];
  const narrow = { token: narrowToken, x: LIST_X, w: NARROW_TOKEN_W, price: '$lO5.OO' };
  if (!narrowBelowWatchlist) rows.push(narrow);
  rows.push({ token: 'WATCHLIST', x: 700, w: 90 });
  rows.push({ token: 'GSII', x: LIST_X, w: WIDE_TOKEN_W, price: '$lO8.OO' });
  if (narrowBelowWatchlist) rows.push(narrow);

  const words = [];
  const lines = [];
  rows.forEach((row, i) => {
    row.line = i + 1;
    const parts = [row.token];
    words.push({
      text: row.token,
      left: row.x,
      top: 100 + row.line * 60,
      width: row.w,
      height: 30,
      line: row.line,
    });
    if (row.price) {
      parts.push(row.price);
      words.push({
        text: row.price,
        left: 960,
        top: 100 + row.line * 60,
        width: 60,
        height: 30,
        line: row.line,
      });
    }
    lines.push(parts.join(' '));
  });
  return { text: lines.join('\n'), lines, words };
}

test('a short ticker in the column is rescued by its LEFT edge, not its centre', () => {
  const result = parseChartStreamPositionList({ ocr: leftAlignedFrame() });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(list.includes('AI'),
    `the one-character token in the column must be rescued into AI: ${JSON.stringify(list)}`);
  assert.ok(!list.includes('A'),
    `the garbled form must not be published verbatim: ${JSON.stringify(list)}`);
});

test('the column reports its LEFT edge as a diagnostic', () => {
  const result = parseChartStreamPositionList({ ocr: leftAlignedFrame() });
  const filter = result.column_filter || {};

  assert.ok(filter.dominant_x != null, 'the column must be identified');
  assert.equal(filter.dominant_left, LIST_X,
    `the column's left edge is the median left of its own members: ${JSON.stringify(filter)}`);
});

test('a short token in the CHART AREA is still not rescued', () => {
  // The left-edge test must not widen the gate into the chart. A token at
  // x=300 is nowhere near the column's left edge.
  const frame = leftAlignedFrame();
  const words = frame.words.map((w) => ({ ...w }));
  const narrow = words.find((w) => w.text === 'A');
  narrow.left = 300;

  const result = parseChartStreamPositionList({
    ocr: { text: frame.text, lines: frame.lines, words },
  });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(!list.includes('AI'),
    `a chart-area token must not be rescued: ${JSON.stringify(list)}`);
});

test('a short token below the Personal WatchList header is still not rescued', () => {
  const result = parseChartStreamPositionList({
    ocr: leftAlignedFrame({ narrowBelowWatchlist: true }),
  });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(!list.includes('AI'),
    `a watchlist-row token must not be rescued: ${JSON.stringify(list)}`);
});
