'use strict';

// Reject nonsense price levels attached to the wrong instrument.
//
// Spoken Czech streams mix share prices, index points, BTC levels, and
// chat dollar amounts. A bare "34000" next to USB is not a USB price.

/** @type {Record<string, {min: number, max: number}>} */
const TICKER_PRICE_BANDS = {
  // Mega-cap / common US
  AAPL: { min: 50, max: 500 },
  MSFT: { min: 50, max: 800 },
  GOOG: { min: 50, max: 400 },
  GOOGL: { min: 50, max: 400 },
  AMZN: { min: 50, max: 400 },
  META: { min: 50, max: 1200 },
  NVDA: { min: 5, max: 1500 }, // allow pre-split style levels // split-adjusted band; pre-split also handled by relative check
  AMD: { min: 20, max: 300 },
  INTC: { min: 5, max: 100 },
  NFLX: { min: 50, max: 1500 },
  TSLA: { min: 50, max: 600 },
  ADBE: { min: 100, max: 800 },
  ASML: { min: 200, max: 1500 },
  SPY: { min: 200, max: 800 },
  QQQ: { min: 150, max: 800 },
  IWM: { min: 100, max: 400 },
  SOFI: { min: 1, max: 80 },
  IREN: { min: 1, max: 100 },
  WIX: { min: 20, max: 400 },
  DJT: { min: 5, max: 200 },
  USB: { min: 10, max: 120 },
  UPS: { min: 50, max: 300 },
  // CZ / EU
  'ČEZ': { min: 200, max: 2000 },
  CEZ: { min: 200, max: 2000 },
  MONETA: { min: 20, max: 300 },
  CSGNF: { min: 5, max: 200 },
  RHM: { min: 100, max: 3000 },
  VOW3: { min: 50, max: 400 },
  // Crypto quoted in USD
  BTC: { min: 1000, max: 500000 },
  ETH: { min: 100, max: 50000 },
  // Misc / noisy
  SPCX: { min: 5, max: 200 },
  IPR: { min: 0.1, max: 50 },
};

const DEFAULT_BAND = { min: 0.5, max: 20000 };
const RELATIVE_MAX_RATIO = 25;

/**
 * @param {string} ticker
 * @returns {{min: number, max: number}}
 */
function bandForTicker(ticker) {
  const raw = String(ticker || '').trim();
  if (TICKER_PRICE_BANDS[raw]) return TICKER_PRICE_BANDS[raw];
  const upper = raw.toUpperCase();
  if (TICKER_PRICE_BANDS[upper]) return TICKER_PRICE_BANDS[upper];
  return DEFAULT_BAND;
}

/**
 * @param {string} ticker
 * @param {number} price
 * @returns {boolean}
 */
function isPlausiblePrice(ticker, price) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const band = bandForTicker(ticker);
  return price >= band.min && price <= band.max;
}

/**
 * Filter price hits for one ticker. Also drops outliers that disagree with
 * the median of the surviving set by more than RELATIVE_MAX_RATIO.
 *
 * @param {string} ticker
 * @param {Array<{role: string, value: number, low?: number, high?: number}>} prices
 * @returns {Array<object>}
 */
function sanitizePricesForTicker(ticker, prices) {
  const list = Array.isArray(prices) ? prices : [];
  const bandOk = list.filter((p) => {
    const value = Number(p.value);
    const low = Number(p.low != null ? p.low : value);
    const high = Number(p.high != null ? p.high : value);
    return isPlausiblePrice(ticker, value)
      && isPlausiblePrice(ticker, low)
      && isPlausiblePrice(ticker, high);
  });
  if (bandOk.length <= 1) return bandOk;

  const values = bandOk.map((p) => Number(p.value)).sort((a, b) => a - b);
  const mid = values[Math.floor(values.length / 2)];
  if (!Number.isFinite(mid) || mid <= 0) return bandOk;

  return bandOk.filter((p) => {
    const v = Number(p.value);
    const ratio = v > mid ? v / mid : mid / v;
    return ratio <= RELATIVE_MAX_RATIO;
  });
}

module.exports = {
  DEFAULT_BAND,
  RELATIVE_MAX_RATIO,
  TICKER_PRICE_BANDS,
  bandForTicker,
  isPlausiblePrice,
  sanitizePricesForTicker,
};
