'use strict';

// plechac's 2025-12-22 XTB "Overview" pictures: the ENGLISH table, and
// it is the one that carries the WEIGHT.
//
// The fixture is the EasyOCR read of the five pictures, frozen: the
// reader is measured against the words it will really see, and the test
// costs no OCR.
//
// THE FIVE PICTURES ARE ONE TABLE, SCROLLED
//
// The table says "1-86 of 86" and the pictures are consecutive scroll
// positions of it, so the BOOK is read by merging them: one row per
// holding, and a holding a picture with a weight read wins over the same
// holding read by a picture without one.
//
// AND THE MERGE IS CHECKED BY THE BOOK'S OWN ARITHMETIC: the weights
// have to add up. They do -- 98.27 % across 84 holdings, and the cash
// row is the missing 1.57 %.
//
// THE CUT-OFF ROW IS THE TRAP
//
// Each picture's LAST row is cut off by the image's edge, and the OCR
// reads that row's numbers without their decimal points: "0.78 %" comes
// back as "78 %" and "1.61 %" as "161 %". The weight is the one that
// breaks, and the reader must not publish it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  mergeInto,
  readPositionsTable,
} = require('../src/discord/plechac/portfolioReader');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plechac_portfolio', 'xtb_overview_20251222.json');

function readFixture() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const reads = fixture.pictures.map((picture) => ({
    attachment_id: picture.attachment_id,
    read: readPositionsTable({ words: picture.words }),
  }));
  const rows = new Map();
  for (const { attachment_id: picture, read } of reads) {
    for (const position of read.positions) {
      mergeInto(rows, position, 'discord_portfolio_screenshot', picture);
    }
  }
  return { fixture, reads, rows };
}

test('the English header is read, and it carries the WEIGHT', () => {
  const { reads } = readFixture();
  const first = reads[0].read;
  // The columns are found from the header words, and the weight column is
  // the English "Allocation" -- the same column the Czech table calls
  // "VAHA".
  const weight = first.columns.find((column) => column.key === 'weight_pct');
  assert.ok(weight, 'the weight column is found');
  assert.ok(/ALLOCATION/i.test(weight.text), `the weight column is Allocation, got ${weight.text}`);
  // And the daily change is its OWN column, because it is a different
  // fact: "1D Gain %" is today, and "Unr. Gain %" is the unrealised
  // gain.
  const change = first.columns.find((column) => column.key === 'change_pct');
  assert.ok(change, 'the daily change column is found');
  assert.notEqual(change.text, weight.text, 'the change is not the weight');
});

test('the BOOK is read whole, and its weights add up', () => {
  const { rows } = readFixture();
  // 83 holdings: the broker holds 84 LINES, and two of them are two
  // exchange lines of one company (ASML.AS and ASML), which are ONE
  // market ticker -- so the book has 83 holdings, and the two lines'
  // weights ADD.
  assert.equal(rows.size, 83);
  const weights = [...rows.values()].map((row) => row.weight_pct);
  assert.ok(weights.every((weight) => Number.isFinite(weight)), 'every holding has a weight');
  const sum = weights.reduce((total, weight) => total + weight, 0);
  // The broker's own book is 98.27 % of holdings plus a 1.57 % "$ Cash"
  // row, so the reading lands on the broker's number exactly.
  assert.ok(Math.abs(sum - 98.27) < 0.05, `the weights sum to ${sum.toFixed(2)} %`);
});

test('TWO BROKER LINES of one holding are ONE holding, and their weights ADD', () => {
  const { rows } = readFixture();
  // He holds the Amsterdam line and the Nasdaq line of ASML. The
  // Overview view's OCR drops the dot, so the Amsterdam line is read
  // "ASMLAS" -- and the source's own vocabulary is what tells the two
  // lines apart: "ASML.AS" is the Amsterdam line and "ASML" is the
  // Nasdaq one, and the lossy read resolves to the Amsterdam line.
  const asml = [...rows.values()].find((row) => row.ticker === 'ASML');
  assert.ok(asml, 'ASML is read');
  assert.ok(Math.abs(asml.weight_pct - 3.39) < 0.011, `ASML weighs ${asml.weight_pct} %, expected 3.39 %`);
  assert.equal(asml.merged_lines, 2, 'and it is two broker lines');
  assert.deepEqual(
    asml.merged_symbols.slice().sort(),
    ['ASML', 'ASMLAS'],
    'the two lines are recorded',
  );
});

test('the SCROLL OVERLAP is not added, because it is the same line read twice', () => {
  const { rows } = readFixture();
  // The five pictures are consecutive scroll positions of ONE table, so
  // the same row appears in two of them. Six holdings sit in that
  // overlap -- XOM, EVO.ST, IQQW.DE, HTWO.L, RTX, FLXLDE -- and each of
  // them is ONE holding, not two.
  const overlap = { 'EVO.ST': 0.78, 'IQQW.DE': 0.55, 'HTWO.L': 0.54, RTX: 0.53, FLXLDE: 0.53 };
  for (const [ticker, weight] of Object.entries(overlap)) {
    const row = [...rows.values()].find((candidate) => candidate.ticker === ticker);
    assert.ok(row, `${ticker} is read`);
    assert.ok(
      Math.abs(row.weight_pct - weight) < 0.011,
      `${ticker} weighs ${row.weight_pct} %, expected ${weight} % -- the overlap must not be added`,
    );
  }
});

test('the weights the PICTURE shows are the weights the book has', () => {
  const { rows } = readFixture();
  // These are read off the picture by hand: the first picture's rows.
  // The tickers are the MARKET's, because the source's own vocabulary
  // translates the broker's spelling -- and the Overview view's OCR
  // LOSES THE DOT, so "IDUSL" has to find its way back to IDUS.L.
  const expected = {
    'IDUS.L': 4.36,
    'MC.PA': 3.67,
    'EQQQ.DE': 3.61,
    ASML: 3.39,
    C: 3.01,
    LMT: 2.76,
    GOOG: 2.7,
    GOLD: 2.41,
    NVO: 2.38,
    BABA: 2.18,
    'BRK-B': 2.16,
    AMZN: 1.99,
    WFC: 1.9,
    OXY: 1.85,
    TSM: 1.68,
    BTI: 1.64,
  };
  for (const [ticker, weight] of Object.entries(expected)) {
    const row = [...rows.values()].find((candidate) => candidate.ticker === ticker);
    assert.ok(row, `${ticker} was read`);
    assert.ok(Math.abs(row.weight_pct - weight) < 0.011, `${ticker} weighs ${row.weight_pct} %, expected ${weight} %`);
  }
});

test('the CUT-OFF row is not published, and the next picture has it right', () => {
  const { reads } = readFixture();
  // The first picture's last row is cut off: the OCR reads its weight as
  // "161" and the row is REJECTED.
  const first = reads[0].read;
  assert.ok(
    first.unread.some((line) => /weight 161 is outside/.test(line)),
    `the cut-off row is rejected, and the reader says so: ${JSON.stringify(first.unread)}`,
  );
  assert.ok(!first.positions.some((position) => position.weight_pct > 100), 'no impossible weight is published');
  // And the SECOND picture has that holding, read properly.
  const second = reads[1].read;
  const intc = second.positions.find((position) => position.ticker === 'INTC');
  assert.ok(intc, 'INTC is read from the second picture');
  assert.ok(Math.abs(intc.weight_pct - 1.61) < 0.011, `INTC weighs ${intc.weight_pct} %`);
  // And the weight is a SHARE of the book, so it is inside (0, 100].
  assert.ok(intc.weight_pct > 0 && intc.weight_pct <= 100);
});

test('a weight that breaks the column ORDER is repaired, and the repair is checked', () => {
  const { reads } = readFixture();
  // The fourth picture's cut-off row reads "78 %" where the picture
  // shows "0.78 %" -- a hundred times too big, and it breaks the
  // descending order of the column. It is repaired by dividing by 100,
  // and ONLY because that restores the order.
  const fourth = reads[3].read;
  const evo = fourth.positions.find((position) => position.ticker === 'EVO.ST');
  // (the broker's own spelling -- the vocabulary has no EVO row)
  assert.ok(evo, 'EVO.ST is read from the fourth picture');
  assert.ok(Math.abs(evo.weight_pct - 0.78) < 0.011, `EVO.ST weighs ${evo.weight_pct} %, expected 0.78 %`);
});

test('the DAILY CHANGE is read, and it is not the weight', () => {
  const { reads } = readFixture();
  const first = reads[0].read;
  // The reader's own rows carry the BROKER's spelling -- the market's
  // is the merge's business -- and the Overview's OCR loses the dot.
  const idusl = first.positions.find((position) => position.ticker === 'IDUSL');
  assert.ok(idusl, 'the first picture reads IDUSL');
  assert.equal(idusl.weight_pct, 4.36);
  assert.ok(Math.abs(idusl.change_pct - 0.3) < 0.011, `the daily change is ${idusl.change_pct} %`);
  // And the market's symbol is what the record carries.
  const merged = [...readFixture().rows.values()].find((row) => row.ticker === 'IDUS.L');
  assert.ok(merged, 'and the merged record says IDUS.L');
});
