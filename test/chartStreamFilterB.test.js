'use strict';

// Filter B — the position-aware vertical bound.
//
// THE DEFECT THIS FILE PINS
//
// Filter B used to be a window around the median of the accepted tickers'
// bbox centres: `[yMedian - 8*lineHeight, yMedian + 8*lineHeight]`. The
// intent was EIGHT ROWS either side of the median, but `lineHeight` is the
// median word HEIGHT (~54 px in the 5x-scaled EasyOCR crop) where a row is
// ~90 px. The window therefore spanned only ~4.8 rows either side of the
// median, and it clipped the first and last row of any list longer than about
// nine rows.
//
// Measured corpus-wide, that window dropped 50 ground-truth holdings.
//
// THE FIX
//
// A position list is a CONTIGUOUS vertical stack of rows at a constant pitch.
// The stack is found directly — the column's words are grouped into rows by
// their OCR line, the row pitch is estimated, and the words are split into
// runs wherever the gap between two rows exceeds the pitch — and a ticker is
// a holding when ONE of its OCR occurrences sits on one of the run's rows.
//
// The panel's own upper bound is the second half of the rule: nothing above
// the "A - Positions" header is a position, whatever the run says.
//
// The corpus is UNTRACKED, so the replay numbers cannot be asserted here — a
// fresh clone has no probe logs to score. What IS assertable is the parser's
// BEHAVIOUR on the geometry, and that is what this file pins.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

// The geometry is the one measured on a real frame: a 1345 px EasyOCR crop of
// the 2023-era sidebar, whose tickers are ~130 px wide, ~30 px tall and start
// at the same x, one every ~90 px.
const LIST_X = 780;
const TICKER_W = 130;
const TICKER_H = 30;
const ROW_PITCH = 90;
const PRICE_X = 960;

// Twelve seed-lexicon tickers, so the list is longer than the legacy window
// could hold. None of them is a token the repair pass would rewrite, so a
// missing row here is the filter's doing and not the decoder's.
const LIST = [
  'AAPL', 'MSFT', 'TSLA', 'VLO', 'AMD', 'INTC',
  'MU', 'MSTR', 'UPRO', 'NFLX', 'LABU', 'SPXL',
];

function word(text, { left, top, width = TICKER_W, height = TICKER_H, line }) {
  return { text, left, top, width, height, line };
}

/**
 * A position list of `LIST.length` rows plus the chart-area token that Filter
 * B exists to keep out.
 *
 * The chart token is a seed-lexicon ticker at the CHART's x, on the same
 * lines as the list, so nothing but the vertical bound can reject it.
 *
 * `aboveHeaderToken` puts a ticker in the column's x but ABOVE the
 * "POSITIONS" header — a scanner panel sitting above the list.
 */
function frame({ chartToken = 'NVDA', aboveHeaderToken = null, rows = LIST } = {}) {
  const words = [];
  const lines = [];

  // The "A - Positions" header.
  words.push(word('POSITIONS', { left: 700, top: 100, width: 90, line: 1 }));
  lines.push('POSITIONS');

  if (aboveHeaderToken) {
    words.push(word(aboveHeaderToken, { left: LIST_X, top: 40, width: TICKER_W, line: 1 }));
  }

  // The chart-area token, on the first list row's line but far to the left.
  words.push(word(chartToken, { left: 300, top: 200, width: TICKER_W, line: 2 }));

  rows.forEach((ticker, i) => {
    const line = i + 2;
    const top = 200 + i * ROW_PITCH;
    words.push(word(ticker, { left: LIST_X, top, line }));
    words.push(word('$12.34', { left: PRICE_X, top, width: 60, line }));
    lines.push(`${ticker} $12.34`);
  });

  return { text: lines.join('\n'), lines, words };
}

test('a list longer than the legacy window keeps its first and last row', () => {
  // The legacy window was `yMedian +- 8 * lineHeight` = `yMedian +- 240` for
  // a 30 px word, while the list spans 990 px — so its first two and last two
  // rows fell outside it and were dropped.
  const result = parseChartStreamPositionList({ ocr: frame() });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  for (const ticker of LIST) {
    assert.ok(list.includes(ticker),
      `every row of the list must survive: ${ticker} missing from ${JSON.stringify(list)}`);
  }
  assert.equal(list.length, LIST.length,
    `the list must hold exactly the list's rows: ${JSON.stringify(list)}`);
});

test('the chart-area token is rejected even though it is on the list\'s lines', () => {
  const result = parseChartStreamPositionList({ ocr: frame() });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(!list.includes('NVDA'),
    `a chart-area token must not be published: ${JSON.stringify(list)}`);
});

test('a ticker above the Positions header is rejected', () => {
  // The panel's own upper bound. A scanner panel above the list sits in the
  // column's x, so the column test alone cannot reject it.
  const result = parseChartStreamPositionList({
    ocr: frame({ aboveHeaderToken: 'COIN' }),
  });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(!list.includes('COIN'),
    `nothing above the Positions header is a position: ${JSON.stringify(list)}`);
});

test('the filter reports the rule it applied and the rows it found', () => {
  const result = parseChartStreamPositionList({ ocr: frame() });
  const bbox = result.bbox_filter || {};

  assert.equal(bbox.rule, 'list_rows',
    `the list's own rows are the shipped rule: ${JSON.stringify(bbox)}`);
  assert.ok(bbox.list_rows && bbox.list_rows.rows === LIST.length,
    `the run must cover every row of the list: ${JSON.stringify(bbox.list_rows)}`);
  assert.ok(bbox.list_rows.pitch > 0 && Math.abs(bbox.list_rows.pitch - ROW_PITCH) <= 2,
    `the row pitch must be measured, not assumed: ${JSON.stringify(bbox.list_rows)}`);
});

test('a frame whose column cannot be identified falls back to the y-window', () => {
  // No column, no rows to test against — the legacy window is all that is
  // left, and the filter must say so rather than silently dropping
  // everything.
  const words = [
    word('AAPL', { left: 300, top: 200, line: 1 }),
    word('MSFT', { left: 300, top: 300, line: 2 }),
    word('TSLA', { left: 300, top: 400, line: 3 }),
  ];
  const result = parseChartStreamPositionList({
    ocr: { text: 'AAPL MSFT TSLA', words },
  });

  assert.equal((result.bbox_filter || {}).rule, 'y_window',
    `with no column the filter must fall back: ${JSON.stringify(result.bbox_filter)}`);
});
