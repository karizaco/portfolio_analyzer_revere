'use strict';

// FundedMind speakers name CFD/futures shorthand, while the shared price
// provider expects Yahoo Finance symbols. Keep this translation local to the
// FundedMind source so its instrument vocabulary cannot change other sources.
const PRICE_SYMBOLS = {
  XAUUSD: 'GC=F',
  NAS100: '^NDX',
  EURUSD: 'EURUSD=X',
  BTC: 'BTC-USD',
  ES: '^GSPC',
  USDJPY: 'JPY=X',
  US30: '^DJI',
  DXY: 'DX-Y.NYB',
  ETH: 'ETH-USD',
  USOIL: 'CL=F',
};

function fundedmindPriceSymbolFor(ticker) {
  const key = String(ticker || '').trim().toUpperCase();
  return PRICE_SYMBOLS[key] || key;
}

module.exports = {
  PRICE_SYMBOLS,
  fundedmindPriceSymbolFor,
};
