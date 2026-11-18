'use strict';

// The sentences measured on two martinlukkt transcripts (2026-11-18), and
// the claim each one makes. A caption fragment is not a Discord message, so
// these pin the transcript reader, not the Discord parser.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readSegment } = require('../src/martinlukkt/tradeRead');

test('a first-person buy is a trade he took', () => {
  const read = readSegment('I bought the breakout when it');
  assert.equal(read.kind, 'action');
  assert.equal(read.action, 'open');
  assert.equal(read.side, 'long');
});

test('a stated short is a plan, not a finished trade', () => {
  const read = readSegment("I'm going to short this one.");
  assert.equal(read.kind, 'plan');
  assert.equal(read.side, 'short');
});

test('a hedge is not a trade', () => {
  assert.equal(readSegment('If I have to short, I would wait for'), null);
  assert.equal(readSegment('I would like to short'), null);
  assert.equal(readSegment('Can you explain your crowd long and coin'), null);
});

test('someone else buying is not his trade', () => {
  assert.equal(readSegment('Probably you still bought there.'), null);
});

test('a stop percent is not a price', () => {
  const read = readSegment('is around 1.5% my stop.');
  assert.equal(read, null);
});
