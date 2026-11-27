'use strict';

// The BROKER LINE a symbol belongs to.
//
// The source's vocabulary is keyed by the broker's own spelling, and its
// value is the market's ticker. So a symbol resolves to the vocabulary
// key it belongs to, and that key is the LINE.
//
// The Overview view's OCR DROPS THE DOT -- "ASMLAS" for "ASML.AS" --
// so a lossy read and the line it came from must resolve to the SAME
// key, or the merge would add one holding's weight to itself.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canonicalBrokerLine,
  marketTickerOf,
} = require('../src/discord/plechac/symbols');

test('a symbol the vocabulary knows exactly is its own line', () => {
  assert.equal(canonicalBrokerLine('ASML.AS'), 'ASML.AS');
  assert.equal(canonicalBrokerLine('IDUS.L'), 'IDUS.L');
});

test('a symbol the OCR read with the dot dropped is the SAME line', () => {
  assert.equal(canonicalBrokerLine('ASMLAS'), 'ASML.AS');
  assert.equal(canonicalBrokerLine('IDUSL'), 'IDUS.L');
  assert.equal(canonicalBrokerLine('EQQQDE'), 'EQQQ.DE');
});

test('TWO broker lines of one company are TWO lines', () => {
  // The Amsterdam line and the Nasdaq line of ASML. Both map to the
  // market ticker ASML, and both are lines of the broker's own table.
  assert.equal(canonicalBrokerLine('ASML.AS'), 'ASML.AS');
  assert.equal(canonicalBrokerLine('ASML'), 'ASML');
  assert.notEqual(
    canonicalBrokerLine('ASML.AS'),
    canonicalBrokerLine('ASML'),
    'and they are not the same line',
  );
  assert.equal(marketTickerOf('ASML.AS'), 'ASML');
  assert.equal(marketTickerOf('ASML'), 'ASML');
});

test('a symbol the vocabulary does not know is its own line', () => {
  assert.equal(canonicalBrokerLine('FLXLDE'), 'FLXLDE');
  assert.equal(canonicalBrokerLine('RZUS.LSE'), 'RZUS.LSE');
});
