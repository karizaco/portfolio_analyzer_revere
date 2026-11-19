'use strict';

// The Komar PANEL reader's rules, without the OCR.
//
// The reader itself is scored in `test/manual/komarPanelReader.test.js`
// -- it runs the real OCR over the pinned frames and takes minutes --
// and this file pins the rules the score depends on, so that a change
// to the rules is caught without the OCR.
//
// THE THREE DEFECTS ITERATION 3 FIXED
//
//   (a) THE ICON WAS READ AS THE SYMBOL. The panel draws a coloured
//       icon before every symbol and Tesseract reads some of them as
//       letters ("VPOWLE", the US flag as "C", the "S" logo as "S").
//       The icon is now REMOVED -- painted white in the OCR's own box
//       for it -- rather than cut away, because a cut lands on the
//       icon's antialiased edge and one pixel of pale blue is enough
//       for Tesseract to read a letter out of it.
//   (b) THE DETAIL CARD WAS READ AS ROWS, because the CHART'S PRICE
//       AXIS bridges the gap between the table and the card. Only the
//       panel's own columns are read now.
//   (c) THE THEME GROUP HEADERS WERE NOT RECOGNISED, because the
//       author's theme names (MEDICAL, DRONES, OIL / GAS / COAL) are
//       not an enumerable set. A group header is a row with NO
//       NUMBERS -- and a row whose numbers could not be read is still
//       a position when the lexicon knows its symbol.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clusterRows,
  columnsFromHeader,
  looksNumeric,
  parseNumber,
  symbolFromWords,
} = require('../src/komar/panelReader');

test('a number is a number, and the panel\'s other text is not', () => {
  // The whole-region read is loose: "418.08" comes back as "a18.08",
  // and "1.86%" as "1.86%".
  assert.equal(looksNumeric('216.09'), true);
  assert.equal(looksNumeric('a18.08'), true);
  assert.equal(looksNumeric('-3.77%'), true);
  assert.equal(looksNumeric('25276'), true);
  assert.equal(looksNumeric('0.0195'), true);
  // And the panel's other text is not a number.
  assert.equal(looksNumeric('Symbol'), false);
  assert.equal(looksNumeric('CLOSED'), false);
  assert.equal(looksNumeric('Market'), false);
  assert.equal(looksNumeric('TER'), false);
  // The detail card's own values ARE numbers ("418.23x100"); what
  // keeps them out of the table is their POSITION -- they are not in
  // the panel's columns -- and not this test.
  assert.equal(looksNumeric('418.23x100'), true);
});

test('a number is read without its punctuation', () => {
  assert.equal(parseNumber('216.09'), 216.09);
  assert.equal(parseNumber('-3.77%'), -3.77);
  assert.equal(parseNumber('1.86%'), 1.86);
  assert.equal(parseNumber('none'), null);
});

test('the header says "Symbol", not "Sym", and the columns come from it', () => {
  const columns = columnsFromHeader([
    { left: 54, text: 'Symbol', width: 48 },
    { left: 141, text: 'Last', width: 30 },
    { left: 233, text: 'Chg%', width: 35 },
  ]);
  assert.deepEqual(columns.map((column) => column.field), ['symbol', 'last', 'chg_pct']);
  assert.equal(columns[0].left, 54);
});

test('the rows are clusters, and a row\'s words do not share a top', () => {
  const clusters = clusterRows([
    { bottom: 66, height: 10, left: 72, text: 'DELL', top: 39 },
    { bottom: 66, height: 8, left: 129, text: '216.09', top: 41 },
    { bottom: 92, height: 10, left: 72, text: 'TER', top: 72 },
  ], 25);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].words.length, 2);
  assert.equal(clusters[1].words[0].text, 'TER');
});

test('the symbol is a token of its own, and the icon is not one', () => {
  // The whole-region read gives the icon as a WORD of its own, so the
  // ticker is a separate token. The panel's trailing dot is not part
  // of the ticker.
  assert.equal(symbolFromWords([{ text: 'MU' }, { text: '»' }], null), 'MU');
  assert.equal(symbolFromWords([{ text: '©' }, { text: 'TER»' }], null), 'TER');
  assert.equal(symbolFromWords([{ text: 'DELL' }, { text: '»' }], null), 'DELL');
});

test('the lexicon arbitrates when it knows the ticker', () => {
  const lexicon = new Set(['MU', 'APLD']);
  // The lexicon knows MU, so MU wins over the icon's letter.
  assert.equal(symbolFromWords([{ text: 'O' }, { text: 'MU»' }], lexicon), 'MU');
  // And it knows APLD.
  assert.equal(symbolFromWords([{ text: '@®' }, { text: 'APLD »' }], lexicon), 'APLD');
});

test('a word that is not ticker-shaped is not a symbol', () => {
  assert.equal(symbolFromWords([{ text: 'Market' }, { text: 'closed' }], null), '');
  assert.equal(symbolFromWords([{ text: '4.2160' }], null), '');
});
