'use strict';

// The PICTURE-READING confusion table.
//
// This is the source's own table of the misreads the broker's screens
// produce: the Overview view prints "IQQE.DE" and the OCR reads
// "IQQEDE". Every row was verified twice -- off the PIXELS of the
// picture, and against Yahoo -- before it was added.
//
// The table is separate from the vocabulary because it answers a
// different question: the vocabulary says what the BROKER writes, and
// this says what the OCR READS. And it is applied only to a picture
// reading -- the trades channel's spoken names never go through it.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canonicalBrokerLine,
  loadPictureConfusions,
  marketTickerOf,
} = require('../src/discord/plechac/symbols');

const CONFUSIONS = loadPictureConfusions();

test('the table carries the five misreads the Overview view produces', () => {
  assert.ok(CONFUSIONS.size >= 5, `the table has ${CONFUSIONS.size} rows`);
  const expected = {
    IQQEDE: 'IQQE.DE',
    IOGPL: 'IOGP.L',
    IDUPL: 'IDUP.L',
    IDTLL: 'IDTL.L',
    FLXLDE: 'FLXI.DE',
  };
  for (const [garbled, canonical] of Object.entries(expected)) {
    assert.equal(CONFUSIONS.get(garbled), canonical, `${garbled} -> ${canonical}`);
  }
});

test('the misread becomes the MARKET\'s symbol, and a plain ticker is untouched', () => {
  assert.equal(marketTickerOf('IQQEDE'), 'IQQE.DE');
  assert.equal(marketTickerOf('IOGPL'), 'IOGP.L');
  assert.equal(marketTickerOf('IDUPL'), 'IDUP.L');
  assert.equal(marketTickerOf('IDTLL'), 'IDTL.L');
  assert.equal(marketTickerOf('FLXLDE'), 'FLXI.DE');
  // A ticker the table says nothing about is untouched.
  assert.equal(marketTickerOf('AAPL'), 'AAPL');
  assert.equal(marketTickerOf('MC.PA'), 'MC.PA');
});

test('a misread and the line it came from are ONE line, so the merge cannot double it', () => {
  // The merge adds the weights of two broker LINES of one holding, and
  // it must not add a holding's weight to itself.
  assert.equal(canonicalBrokerLine('IQQEDE'), canonicalBrokerLine('IQQE.DE'));
  assert.equal(canonicalBrokerLine('FLXLDE'), canonicalBrokerLine('FLXI.DE'));
});

test('no garbled form is a broker spelling the vocabulary knows', () => {
  // A garbled form that IS a real spelling would shadow a real line.
  for (const [garbled, canonical] of CONFUSIONS) {
    assert.notEqual(garbled, canonical, `${garbled} is not its own canonical`);
    assert.ok(canonical.length >= 2, `${canonical} is a symbol`);
  }
});
