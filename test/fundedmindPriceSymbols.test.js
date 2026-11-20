'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fundedmindPriceSymbolFor } = require('../src/fundedmind/priceSymbols');

test('FundedMind instruments map to liquid Yahoo proxies', () => {
  assert.equal(fundedmindPriceSymbolFor('XAUUSD'), 'GC=F');
  assert.equal(fundedmindPriceSymbolFor('NAS100'), '^NDX');
  assert.equal(fundedmindPriceSymbolFor('EURUSD'), 'EURUSD=X');
  assert.equal(fundedmindPriceSymbolFor('USDJPY'), 'JPY=X');
  assert.equal(fundedmindPriceSymbolFor('US30'), '^DJI');
  assert.equal(fundedmindPriceSymbolFor('DXY'), 'DX-Y.NYB');
  assert.equal(fundedmindPriceSymbolFor('USOIL'), 'CL=F');
  assert.equal(fundedmindPriceSymbolFor('ES'), '^GSPC');
  assert.equal(fundedmindPriceSymbolFor('ETH'), 'ETH-USD');
  assert.equal(fundedmindPriceSymbolFor('BTC'), 'BTC-USD');
});

test('unknown FundedMind tickers pass through unchanged', () => {
  assert.equal(fundedmindPriceSymbolFor('AAPL'), 'AAPL');
});
