'use strict';

// The one-glyph column rule: a one-character cell in the position list is
// ambiguous, and the COLUMN settles it.
//
// THE DEFECT THIS FILE PINS
//
// A one-glyph cell is either a genuine one-letter ticker ("X" — a real
// Qullamaggie holding on 20220301, 20220323 and 20220412) or a multi-glyph
// cell the OCR collapsed into one glyph ("U" — the LI row of 20230522). The
// shape cannot tell the two apart: both are one glyph about 42 px wide, at
// the same left edge of the Sym column.
//
// The column's own consistency can. Only four US tickers have a single
// letter (F, T, V, X), so a position list holding TWO of them is far less
// likely than a panel that collapses two cells — and a panel that collapses
// one cell is likely to collapse another. A column with a second one-glyph
// read has therefore demonstrated that it collapses cells, and none of its
// one-glyph reads can be taken at face value.
//
// Measured on the replay corpus (`node tools/evalParserReplay.js`, no OCR):
// the one-glyph run-only class is five readings — X on 20220301 (conf 0.980),
// X on 20220323 (0.963) and X on 20220412 (0.914), three hits, each the
// ONLY one-glyph member of its column; and U on 20230522 (0.616 and 0.743,
// two captures of one date), the collapsed LI row, in a column that also
// holds the collapsed AI row.
//
// The rule keeps the three Xs and drops the two Us. Before it, the wide
// corpus was 148/168/167 (88.1 % recall, 88.6 % precision); after it,
// 148/168/166 (88.1 %, 89.2 %) — the same hits, one false positive fewer,
// and no other date moved. The default roots return to 83/85/83, 100 %
// precision.
//
// Confidence CANNOT do this job: U reads at 0.616 on one capture and 0.743
// on the other, so any threshold low enough to catch it also catches the
// 0.534-confidence QBTS hit on 20230602 — and the corpus mixes OCR engines,
// whose confidence scales are not comparable.
//
// The corpus is UNTRACKED, so those numbers cannot be asserted here — a fresh
// clone has no probe logs. What IS assertable is the parser's BEHAVIOUR on
// the geometry, and that is what this file pins.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const LIST_X = 780;
const WIDE_TOKEN_W = 130;   // a four-character ticker
const NARROW_TOKEN_W = 42;   // the one-character glyph

/**
 * A position list whose tickers are all LEFT-aligned at `LIST_X`.
 *
 * `oneGlyphRows` are the rows whose ticker cell read as a single glyph. Each
 * carries a garbled price, which is what makes the row non-price-aligned and
 * therefore invisible to the price-alignment evidence: only the row stack
 * admits it.
 */
function oneGlyphFrame({ oneGlyphRows = ['X'], priceOnOneGlyph = false } = {}) {
  const rows = [
    { token: 'POSITIONS', x: 700, w: 90 },
    { token: 'AAPL', x: LIST_X, w: WIDE_TOKEN_W, price: '$214.50' },
    { token: 'MSFT', x: LIST_X, w: WIDE_TOKEN_W, price: '$412.30' },
    { token: 'TSLA', x: LIST_X, w: WIDE_TOKEN_W, price: '$342.10' },
  ];
  for (const token of oneGlyphRows) {
    rows.push({
      token,
      x: LIST_X,
      w: NARROW_TOKEN_W,
      price: priceOnOneGlyph ? '$12.34' : '$lO5.OO',
    });
  }
  rows.push({ token: 'WATCHLIST', x: 700, w: 90 });
  rows.push({ token: 'GSII', x: LIST_X, w: WIDE_TOKEN_W, price: '$lO8.OO' });

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

test('a lone one-glyph holding is published', () => {
  // "X" is the only one-glyph member of its column, so the column has not
  // demonstrated that it collapses cells and the read is taken at face value.
  const frame = oneGlyphFrame({ oneGlyphRows: ['X'] });
  const result = parseChartStreamPositionList({ ocr: frame });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(list.includes('X'),
    `a genuine one-letter holding must be published: ${JSON.stringify(list)}`);
});

test('a one-glyph read is dropped when the column holds ANOTHER one-glyph read', () => {
  // "U" and "A" — the collapsed LI row and the collapsed AI row of 20230522.
  const frame = oneGlyphFrame({ oneGlyphRows: ['U', 'A'] });
  const result = parseChartStreamPositionList({ ocr: frame });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(!list.includes('U'),
    `a one-glyph read in a column that collapses cells must be dropped: ${JSON.stringify(list)}`);
});

test('the curated rescue still reaches the cell the rule dropped', () => {
  // The rule rejects "A" the way it rejects "U", but "A" is a RECORDED
  // misread (A -> AI in config/ticker_ocr_confusions.csv), so the rescue
  // restores the holding after the gate. "U" cannot be rescued: it is a
  // genuine ticker (a holding on 20221117) and the alias table's invariant
  // forbids a row that would rewrite it.
  const frame = oneGlyphFrame({ oneGlyphRows: ['U', 'A'] });
  const result = parseChartStreamPositionList({ ocr: frame });
  const list = Array.isArray(result.position_list) ? result.position_list : [];

  assert.ok(list.includes('AI'),
    `the collapsed AI row must still be rescued: ${JSON.stringify(list)}`);
  assert.ok(!list.includes('A'),
    `the garbled form must not be published verbatim: ${JSON.stringify(list)}`);
});

test('the rule is the column\'s one-glyph COUNT, not the token\'s confidence', () => {
  // A confidence threshold cannot do this job: "U" reads at 0.616 on one
  // 20230522 capture and 0.743 on the other, so any threshold low enough to
  // catch it also catches the 0.534-confidence QBTS hit on 20230602 -- and
  // the corpus mixes OCR engines, whose confidence scales are not
  // comparable. These two frames differ ONLY in confidence, and the rule
  // must give the same answer for both.
  const lowConf = oneGlyphFrame({ oneGlyphRows: ['X'] });
  for (const w of lowConf.words) if (w.text === 'X') w.conf = 0.05;

  const highConf = oneGlyphFrame({ oneGlyphRows: ['U', 'A'] });
  for (const w of highConf.words) if (w.text === 'U') w.conf = 0.99;

  const kept = parseChartStreamPositionList({ ocr: lowConf });
  const keptList = Array.isArray(kept.position_list) ? kept.position_list : [];
  const dropped = parseChartStreamPositionList({ ocr: highConf });
  const droppedList = Array.isArray(dropped.position_list) ? dropped.position_list : [];

  assert.ok(keptList.includes('X'),
    `a low-confidence read in a one-one-glyph column is still published: ${JSON.stringify(keptList)}`);
  assert.ok(!droppedList.includes('U'),
    `a high-confidence read in a two-one-glyph column is still dropped: ${JSON.stringify(droppedList)}`);
});

test('a one-glyph read is never price-aligned, so this rule is its only guard', () => {
  // The column detector measures a cell's CENTRE, and in a left-aligned
  // table a one-glyph cell's centre sits ~44 px left of a four-glyph cell's
  // -- outside the detector's +-25 px column window. So a one-glyph token
  // can never join the price-aligned set, and the row stack is the only
  // evidence that admits it.
  const frame = oneGlyphFrame({ oneGlyphRows: ['X'], priceOnOneGlyph: true });
  const result = parseChartStreamPositionList({ ocr: frame });
  const filter = result.column_filter || {};

  assert.equal(filter.in_list_token_count, 3,
    `the one-glyph cell must not join the price-aligned column: ${JSON.stringify(filter)}`);
});
