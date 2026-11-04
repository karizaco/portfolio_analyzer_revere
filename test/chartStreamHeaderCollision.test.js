'use strict';

// A ticker that is also a word of the positions table's column header.
//
// The table's header row reads "Flag  Sym  % Change  ADR % 20  Dol Vol  Vol
// Buzz". "Sym" sits at the left edge of the ticker column, where every
// holding sits -- and SYM (Symbotic) is a real Qullamaggie holding on
// 20231201 and 20231215 (pixel-verified 2026-11-04). It cannot be
// blocklisted, and it cannot be told from the header by case: the OCR read
// the header as "Sym" and the real row as "SyM" on the same frame.
//
// What separates them is the ROW. A holding's row carries number cells to its
// right; the header row carries the other header words and no number.
//
// Measured on 20220222 (where "Sym" is the header and SYM is no holding):
// the first version of the guard published a false SYM, because the header
// row carried a stray "0" cell and the OCR had merged "Nol Buzz" into one
// token. Both are pinned below.
//
//   node --test test/chartStreamHeaderCollision.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const LIST_X = 780;

// A positions panel: a title line, a header row, then data rows. `header` is
// the header row's cells as [text, left]; `rows` are [ticker, ...cells].
function panel({ header, rows }) {
  const lines = [];
  const words = [];
  let line = 1;
  const add = (cells) => {
    const parts = [];
    for (const [text, left] of cells) {
      words.push({ text, left, top: 100 + line * 60, width: 8 * String(text).length + 20, height: 30, line });
      parts.push(text);
    }
    lines.push(parts.join(' '));
    line += 1;
  };
  add([['A', 700], ['Positions', 740]]);
  add(header);
  for (const [ticker, ...cells] of rows) {
    add([[ticker, LIST_X], ...cells.map((c, i) => [c, 900 + i * 110])]);
  }
  return { text: lines.join('\n'), lines, words };
}

const DATA_ROWS = [
  ['PDD', '-1,99%', '3,57', '312.7M'],
  ['PLTR', '-0,10%', '4,73', '148.0M'],
  ['PINS', '+0,41%', '2,33', '26.4M'],
  ['DDOG', '+0,49%', '3,39', '35.6M'],
  ['PATH', '+19,84%', '4,22', '319.2M'],
];

const list = (ocr) => (parseChartStreamPositionList({ ocr }).position_list || []);

test('SYM on a data row with number cells is a holding', () => {
  const ocr = panel({
    header: [['Flag', 640], ['Sym', LIST_X], ['%', 900], ['Change', 940], ['Dol', 1120], ['Vol', 1160]],
    rows: [['SYM', '-0,06%', '8,57', '16.3M'], ...DATA_ROWS],
  });
  assert.ok(list(ocr).includes('SYM'), `SYM was dropped: ${JSON.stringify(list(ocr))}`);
});

test('SYM on the header row is not a holding', () => {
  const ocr = panel({ header: [['Flag', 640], ['Sym', LIST_X], ['%', 900], ['Change', 940], ['Dol', 1120], ['Vol', 1160]], rows: DATA_ROWS });
  assert.ok(!list(ocr).includes('SYM'), `the header was published as a holding: ${JSON.stringify(list(ocr))}`);
  // Control: the frame still reads its real rows.
  assert.ok(list(ocr).includes('PDD'), `the frame must still read its holdings: ${JSON.stringify(list(ocr))}`);
});

test('a header row carrying a stray digit and a merged "Nol Buzz" token is still the header', () => {
  // The 20220222 shape: "Sym" shares its line with a lone "0" and "Nol Buzz".
  const ocr = panel({
    header: [['Fuo', 611], ['Sym', LIST_X], ['0', 899], ['Gur', 925], ['Nol Buzz', 1126]],
    rows: DATA_ROWS,
  });
  assert.ok(!list(ocr).includes('SYM'), `a header with a stray digit was published as SYM: ${JSON.stringify(list(ocr))}`);
});

test('the guard applies only to header-collision tickers', () => {
  // PDD on a data row is unaffected, and an ordinary ticker needs no
  // number cell to its right to be kept.
  const ocr = panel({
    header: [['Flag', 640], ['Sym', LIST_X], ['%', 900], ['Change', 940]],
    rows: DATA_ROWS,
  });
  for (const t of ['PDD', 'PLTR', 'PINS', 'DDOG']) {
    assert.ok(list(ocr).includes(t), `${t} was lost: ${JSON.stringify(list(ocr))}`);
  }
});
