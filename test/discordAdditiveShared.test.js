'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { repairOcrTicker } = require('../src/discord/shared/ocrConfusables');
const { EXPOSURE_KINDS } = require('../src/discord/shared/exposureKinds');

test('repairOcrTicker strips leading S confusions', () => {
  assert.equal(repairOcrTicker('SPLTR'), 'PLTR');
  assert.equal(repairOcrTicker('SCRDO'), 'CRDO');
  assert.equal(repairOcrTicker('NVA'), 'NVDA');
  assert.equal(repairOcrTicker('$HNGE'), 'HNGE');
});

test('exposure kinds are stable strings', () => {
  assert.equal(EXPOSURE_KINDS.HOLDING, 'holding');
  assert.equal(EXPOSURE_KINDS.IDEA, 'idea');
  assert.equal(EXPOSURE_KINDS.REGIME, 'regime');
});
