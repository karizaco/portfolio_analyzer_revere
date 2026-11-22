'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveChartTitle } = require('../src/discord/clement/chartTitleResolve');

test('chart title Ethereum / Tether -> ETH', () => {
  const hits = resolveChartTitle('Ethereum / TetherUS 1D KuCoin');
  assert.ok(hits.some((h) => h.ticker === 'ETH'));
});

test('chart title IWM / Russell', () => {
  const hits = resolveChartTitle('iShares Russell 2000 ETF (IWM)');
  assert.ok(hits.some((h) => h.ticker === 'IWM'));
});

test('ETHUSDT token', () => {
  const hits = resolveChartTitle('ETHUSDT Perpetual');
  assert.ok(hits.some((h) => h.ticker === 'ETH'));
});
