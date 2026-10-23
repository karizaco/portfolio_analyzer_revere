'use strict';

// Unit tests for the Qullamaggie position-list STRUCTURE pipeline:
//
//   - src/video/positionTable.js   — grid-line geometry of a TradingView table
//   - src/video/positionColumn.js  — the ticker column, found from white ink
//   - src/ocr/positionCellOcr.js   — the fuzzy "Sym" header match
//   - src/normalize/tickerDecode.js — lexicon-constrained decoding of a read
//
// These tests are in-process (no ffmpeg, no OCR engine): the frames are
// synthesised with sharp, so they check the GEOMETRY and the DECODING, not
// the recogniser. What the recogniser does with real pixels is measured by
// tools/buildPositionCorpus.js against the ground truth.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  detectPositionTables,
  isSeparatorPixel,
  findHeaderSlotIndex,
} = require('../src/video/positionTable');
const {
  findTickerColumnByInkRuns,
  splitBlocks,
  fitLadder,
  closeMask,
} = require('../src/video/positionColumn');
const { symWordScore, editDistance } = require('../src/ocr/positionCellOcr');
const {
  decodeCell,
  weightedEditDistance,
  substitutionCost,
  loadCharConfusion,
} = require('../src/normalize/tickerDecode');
const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');

const PANEL_BG = { r: 26, g: 27, b: 30 };
const GRID = { r: 69, g: 70, b: 74 };
const WHITE = { r: 235, g: 235, b: 240 };
const GREEN = { r: 40, g: 200, b: 90 };

function fillRect(pixels, width, x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0) continue;
      const o = (y * width + x) * 3;
      pixels[o] = colour.r;
      pixels[o + 1] = colour.g;
      pixels[o + 2] = colour.b;
    }
  }
}

/**
 * Draw a synthetic TradingView-style position table.
 *
 * The layout mirrors the real one: a title bar, a column-header row, then
 * data rows. The ticker column is left-aligned; the "% Change" column is
 * right-aligned and coloured.
 */
function drawPositionTable(pixels, width, options = {}) {
  const {
    left = 100,
    top = 40,
    flagWidth = 30,
    columnWidth = 60,
    priceColumnWidth = 80,
    rowCount = 8,
    rowPitch = 18,
    headerHeight = 16,
    tickers = ['UPST', 'DVN', 'NRGU', 'MOS', 'TQQQ', 'PLTR', 'GTLB', 'IOT'],
  } = options;

  const height = top + headerHeight + rowCount * rowPitch + 20;
  const tableWidth = flagWidth + columnWidth + priceColumnWidth;
  const symLeft = left + flagWidth;

  // Column separators: the table's left edge, then Flag | Sym | % Change.
  fillRect(pixels, width, left, top, 1, headerHeight + rowCount * rowPitch, GRID);
  fillRect(pixels, width, symLeft, top, 1, headerHeight + rowCount * rowPitch, GRID);
  fillRect(pixels, width, symLeft + columnWidth, top, 1, headerHeight + rowCount * rowPitch, GRID);
  fillRect(pixels, width, symLeft + columnWidth + priceColumnWidth, top, 1, headerHeight + rowCount * rowPitch, GRID);

  // Horizontal separators: the rule above the header row, and one under each
  // data row.
  fillRect(pixels, width, left, top, tableWidth, 1, GRID);
  fillRect(pixels, width, left, top + headerHeight, tableWidth, 1, GRID);
  for (let i = 1; i <= rowCount; i++) {
    fillRect(pixels, width, left, top + headerHeight + i * rowPitch, tableWidth, 1, GRID);
  }

  // The header labels.
  drawWord(pixels, width, symLeft + 4, top + 4, 'Sym', 2);
  drawWord(pixels, width, left + 4, top + 4, 'Flag', 2, 4);
  // A coloured value in the price column, right-aligned.
  fillRect(pixels, width, symLeft + columnWidth + priceColumnWidth - 14, top + headerHeight + 6, 10, 6, GREEN);

  // The tickers: each letter is a separate 3x7 block with a 2px gap, which is
  // what the real 6px glyphs look like once the anti-aliasing is dropped.
  for (let i = 0; i < rowCount && i < tickers.length; i++) {
    const text = tickers[i];
    const y = top + headerHeight + i * rowPitch + 5;
    let x = symLeft + 4;
    for (const ch of text) {
      fillRect(pixels, width, x, y, 3, 7, WHITE);
      x += 5;
    }
  }
  return height;
}

/**
 * Draw a word as a row of small blocks. Only the shape matters here — the
 * ink mask does not care which letter it is.
 */
function drawWord(pixels, width, x0, y0, text, cellWidth, gap = 2) {
  let x = x0;
  for (const ch of text) {
    fillRect(pixels, width, x, y0, cellWidth, 7, WHITE);
    x += cellWidth + gap;
  }
}

async function makeFrame(draw, width = 420, height = 260) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-table-'));
  const filePath = path.join(dir, 'frame.png');
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = PANEL_BG.r;
    pixels[i + 1] = PANEL_BG.g;
    pixels[i + 2] = PANEL_BG.b;
  }
  const usedHeight = draw(pixels, width) || height;
  await sharp(pixels, { raw: { width, height: usedHeight, channels: 3 } })
    .png()
    .toFile(filePath);
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('isSeparatorPixel accepts a mid-grey rule and rejects text and colour', () => {
  // A grid line: achromatic and mid-toned.
  assert.equal(isSeparatorPixel(69, 70, 74), true);
  // White text is brighter than a rule.
  assert.equal(isSeparatorPixel(235, 235, 240), false);
  // A green percentage is saturated.
  assert.equal(isSeparatorPixel(40, 200, 90), false);
  // The panel background is darker than a rule.
  assert.equal(isSeparatorPixel(26, 27, 30), false);
});

test('detectPositionTables finds the row slots and the column slots', async () => {
  const frame = await makeFrame((pixels, width) => drawPositionTable(pixels, width, { rowCount: 8 }));
  try {
    const { tables } = await detectPositionTables(frame.filePath);
    assert.ok(tables.length >= 1, 'expected at least one table');

    const table = tables[0];
    // A title row plus eight data rows.
    assert.ok(table.slots.length >= 8, `expected >= 8 slots, got ${table.slots.length}`);
    // Flag | Sym | % Change  ->  three column slots.
    assert.ok(table.columns.length >= 3, `expected >= 3 columns, got ${table.columns.length}`);

    // The data rows are evenly pitched.
    const dataRows = table.slots.slice(table.headerSlotIndex + 1);
    assert.ok(dataRows.length >= 7, `expected >= 7 data rows, got ${dataRows.length}`);
    const pitches = [];
    for (let i = 1; i < dataRows.length; i++) {
      pitches.push(dataRows[i].top - dataRows[i - 1].top);
    }
    const median = pitches.sort((a, b) => a - b)[Math.floor(pitches.length / 2)];
    assert.ok(Math.abs(median - 18) <= 2, `expected an 18px pitch, got ${median}`);
  } finally {
    frame.cleanup();
  }
});

test('findHeaderSlotIndex returns 0 when there is no interior separator to learn from', () => {
  assert.equal(findHeaderSlotIndex([{ start: 0, end: 0, y0: 0, y1: 10 }], [
    { top: 0, bottom: 10 },
  ]), 0);
});

test('findTickerColumnByInkRuns finds the left-aligned symbol column', async () => {
  const frame = await makeFrame((pixels, width) => drawPositionTable(pixels, width, { rowCount: 8 }));
  try {
    const result = await findTickerColumnByInkRuns(frame.filePath);
    assert.ok(result.column, 'expected a ticker column');
    // The column starts at the symbol column's left edge (the ticker glyphs
    // begin at x 134 in the fixture, so the column is 132 after the padding).
    assert.ok(result.column.left >= 130 && result.column.left <= 134,
      `column starts at the wrong x: ${result.column.left}`);
    // And it stops before the % Change column, so a price can never be
    // merged into a ticker.
    assert.ok(result.column.right < 190, `column is too wide: ${result.column.right}`);
    // One row per holding.
    assert.ok(result.rows.length >= 7, `expected >= 7 rows, got ${result.rows.length}`);
    // Every row starts at the same x — that is what makes it a symbol column.
    const lefts = result.rows.map((r) => r.left);
    assert.equal(Math.max(...lefts) - Math.min(...lefts), 0);
  } finally {
    frame.cleanup();
  }
});

test('splitBlocks separates two tables that share a left edge', () => {
  // A watchlist of 5 rows at pitch 18, then a positions list of 6 rows after
  // a 120px gap — the shape of the 2023 sidebar.
  const centres = [];
  for (let i = 0; i < 5; i++) centres.push(100 + i * 18);
  for (let i = 0; i < 6; i++) centres.push(280 + i * 18);

  const blocks = splitBlocks(centres);
  assert.equal(blocks.length, 2, `expected 2 blocks, got ${blocks.length}`);
  assert.equal(blocks[0].length, 5);
  assert.equal(blocks[1].length, 6);
});

test('fitLadder finds the pitch and the rows of an evenly spaced ladder', () => {
  const centres = [];
  for (let i = 0; i < 9; i++) centres.push(50 + i * 18);
  const ladder = fitLadder(centres);
  assert.ok(ladder, 'expected a ladder');
  assert.ok(Math.abs(ladder.pitch - 18) < 0.01, `expected pitch 18, got ${ladder.pitch}`);
  assert.equal(ladder.rows.length, 9);
});

test('closeMask fills a one-pixel gap without moving the boundary', () => {
  // A 3x3 block with its middle pixel missing, inside a 5x5 empty frame.
  const width = 5;
  const height = 5;
  const raw = new Uint8Array(width * height);
  raw[6] = 1; raw[7] = 1; raw[8] = 1;
  raw[11] = 1;              // the hole
  raw[12] = 1; raw[13] = 1;
  const closed = closeMask(raw, width, height, 1);
  assert.equal(closed[11], 1, 'the gap should be closed');
  assert.equal(closed[7], 1, 'the block should survive');
  assert.equal(closed[0], 0, 'the empty frame must stay empty');
  assert.equal(closed[24], 0, 'the empty frame must stay empty');
});

test('symWordScore accepts mangled header labels and rejects unrelated words', () => {
  // Measured misreads of the "Sym" header.
  assert.equal(symWordScore('Sym'), 0);
  // "Syrn" is two edits from "sym" (drop the r, read the n as m) — still
  // inside the tolerance of 2.
  assert.equal(symWordScore('Syrn'), 2);
  assert.equal(symWordScore('Svm'), 1);
  // "Sym g" is a superstring — containment, no distance needed.
  assert.equal(symWordScore('Sym g'), 0);
  // A word nothing like "Sym" must not match.
  assert.equal(symWordScore('PLTR'), -1);
  assert.equal(symWordScore('Flag'), -1);
  assert.equal(symWordScore(''), -1);
});

test('editDistance counts the differences between two short strings', () => {
  assert.equal(editDistance('SYM', 'SYM'), 0);
  assert.equal(editDistance('SYM', 'SVM'), 1);
  assert.equal(editDistance('SYM', 'XYM'), 1);
  // "SYM" -> "XYZM" is a substitution plus an insertion, not one edit.
  assert.equal(editDistance('SYM', 'XYZM'), 2);
});

test('weightedEditDistance charges an indel more than a substitution', () => {
  const cost = (a, b) => (a === b ? 0 : 1);
  assert.equal(weightedEditDistance('TSLA', 'TSLA', cost), 0);
  // One substitution of the same length.
  assert.equal(weightedEditDistance('TSLA', 'TSUA', cost), 1);
  // One deletion costs INDEL_COST, which is more than a substitution.
  assert.equal(weightedEditDistance('TSLA', 'TSL', cost), 1.5);
  assert.ok(weightedEditDistance('TSLA', 'TSL', cost) > weightedEditDistance('TSLA', 'TSUA', cost));
});

test('substitutionCost is 0 for a match and highest for an unexplained pair', () => {
  const model = { pairs: new Map([['O>Q', 10]]), max: 10 };
  assert.equal(substitutionCost('Q', 'Q', model), 0);
  // An observed confusion is cheap.
  assert.ok(substitutionCost('O', 'Q', model) < 0.5);
  // An unexplained one is expensive — that is what keeps precision up.
  assert.equal(substitutionCost('O', 'Z', model), 1.0);
  // With no model at all, every substitution is unexplained.
  assert.equal(substitutionCost('O', 'Q', { pairs: new Map(), max: 0 }), 1.0);
});

test('decodeCell returns an exact lexicon hit at cost 0', () => {
  const lexicon = { tickers: ['TQQQ', 'AAPL', 'TSLA'], tickerSet: new Set(['TQQQ', 'AAPL', 'TSLA']) };
  const decoded = decodeCell([{ text: 'TQQQ', conf: 0.9 }], { lexicon });
  assert.ok(decoded);
  assert.equal(decoded.ticker, 'TQQQ');
  assert.equal(decoded.cost, 0);
});

test('decodeCell rejects a read that is not close to any ticker', () => {
  const lexicon = { tickers: ['TQQQ', 'AAPL', 'TSLA'], tickerSet: new Set(['TQQQ', 'AAPL', 'TSLA']) };
  // "XYZZY" is not one edit away from anything in the lexicon.
  assert.equal(decodeCell([{ text: 'XYZZY', conf: 0.9 }], { lexicon }), null);
});

test('decodeCell refuses a read that two tickers explain equally well', () => {
  // "AC" is one cheap substitution away from both "AB" and "AD", so the read
  // does not identify one ticker and must decode to nothing.
  const lexicon = { tickers: ['AB', 'AD'], tickerSet: new Set(['AB', 'AD']) };
  const decoded = decodeCell([{ text: 'AC', conf: 0.9 }], {
    lexicon,
    confusion: { pairs: new Map([['C>B', 4], ['C>D', 4]]), max: 4 },
  });
  assert.equal(decoded, null, 'an ambiguous read must decode to nothing');
});

test('decodeCell uses the learned confusion model to make a substitution cheap', () => {
  const lexicon = { tickers: ['TQQQ', 'AAPL'], tickerSet: new Set(['TQQQ', 'AAPL']) };
  // "TOQQ" -> "TQQQ" is one substitution. Without a model that costs 1.0,
  // which is above the acceptance threshold.
  const withoutModel = decodeCell([{ text: 'TOQQ', conf: 0.9 }], {
    lexicon,
    confusion: { pairs: new Map(), max: 0 },
  });
  assert.equal(withoutModel, null, 'an unexplained substitution must not be accepted');

  // With O->Q observed, the same read is accepted.
  const withModel = decodeCell([{ text: 'TOQQ', conf: 0.9 }], {
    lexicon,
    confusion: { pairs: new Map([['O>Q', 4]]), max: 4 },
  });
  assert.ok(withModel);
  assert.equal(withModel.ticker, 'TQQQ');
  assert.ok(withModel.cost < 0.85);
});

test('decodeCell picks the reading both engines agree on', () => {
  const lexicon = { tickers: ['TQQQ', 'AAPL', 'TSLA'], tickerSet: new Set(['TQQQ', 'AAPL', 'TSLA']) };
  const decoded = decodeCell([
    { text: 'TOQQ', conf: 0.4, source: 'easyocr' },
    { text: 'TQQQ', conf: 0.8, source: 'rapidocr' },
  ], { lexicon, confusion: { pairs: new Map([['Q>O', 4]]), max: 4 } });
  assert.ok(decoded);
  assert.equal(decoded.ticker, 'TQQQ');
  assert.equal(decoded.cost, 0, 'the exact hit must win outright');
});

test('loadCharConfusion reads a "from,to,count" matrix and ignores comments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confusion-'));
  const csvPath = path.join(dir, 'confusion.csv');
  fs.writeFileSync(csvPath, [
    '# learned by tools/learnCharConfusion.js',
    '#   skipped=2 used=5',
    'from,to,count',
    'Q,O,4',
    'T,I,3',
    '',
  ].join('\n'));
  try {
    const model = loadCharConfusion(csvPath);
    assert.equal(model.max, 4);
    assert.equal(model.pairs.get('Q>O'), 4);
    assert.equal(model.pairs.get('T>I'), 3);
    assert.equal(model.pairs.size, 2, 'the header row must not become a pair');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped lexicon contains the tickers the decoder is meant to repair', () => {
  const lexicon = loadSeedLexiconSync();
  for (const ticker of ['TQQQ', 'AAPL', 'TSLA', 'PLTR', 'IOT']) {
    assert.ok(lexicon.tickerSet.has(ticker), `lexicon is missing ${ticker}`);
  }
});
