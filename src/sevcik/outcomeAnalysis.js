'use strict';

// Score Sevcik signals against subsequent market moves.
//
// A signal is a claim about direction. The only way to know whether the claim
// aged well is to look at the price AFTER the stream. This module does that
// bookkeeping only: given an entry price and later prices, it returns the
// return and whether the direction was right. It does not fetch prices.

/**
 * @param {string} value YYYYMMDD or YYYY-MM-DD
 * @returns {string} YYYY-MM-DD or ''
 */
function toIsoDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return '';
}

/**
 * @param {string} iso YYYY-MM-DD
 * @param {number} days
 * @returns {string}
 */
function shiftIsoDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Map spoken / extracted tickers onto Yahoo symbols when needed.
 *
 * Most US large caps pass through unchanged. A few Czech / European / crypto
 * names need an exchange suffix or a different contract id.
 *
 * @param {string} ticker
 * @returns {string}
 */
function yahooSymbolFor(ticker) {
  const raw = String(ticker || '').trim();
  const upper = raw.toUpperCase();
  const aliases = {
    'ČEZ': 'CEZ.PR',
    CEZ: 'CEZ.PR',
    MONETA: 'MONET.PR',
    BTC: 'BTC-USD',
    RHM: 'RHM.DE',
    // IPR is residual noise in this corpus; leave unmapped.
  };
  if (aliases[raw]) return aliases[raw];
  if (aliases[upper]) return aliases[upper];
  // Keep exchange suffixes dotted; only share-class dots become dashes.
  const match = upper.match(/^([A-Z0-9]+)[\.\-]([A-Z]{1,4})$/);
  if (!match) return upper;
  const exchanges = new Set(['PR','DE','L','TO','HK','PA','AS','SW','MI','MC','VI','ST','CO','HE','OL','T','AX','F']);
  if (exchanges.has(match[2])) return match[1] + '.' + match[2];
  return match[1] + '-' + match[2];
}

/**
 * Did the market move the way the bias claimed?
 *
 * @param {string} bias
 * @param {number|null} ret
 * @returns {boolean|null}
 */
function directionHit(bias, ret) {
  if (!Number.isFinite(ret)) return null;
  if (bias === 'bullish') return ret > 0;
  if (bias === 'bearish') return ret < 0;
  return null;
}

/**
 * @param {number} entry
 * @param {number} exit
 * @returns {number|null}
 */
function simpleReturn(entry, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  return (exit - entry) / entry;
}

/**
 * Score one signal against a pair of later prices.
 *
 * @param {object} signal
 * @param {object} prices
 * @param {number|null} prices.entry
 * @param {number|null} prices.week
 * @param {number|null} prices.month
 * @param {object} [prices.meta]
 * @returns {object}
 */
function scoreSignalOutcome(signal, prices) {
  const bias = String(signal.bias || '');
  const ret1w = simpleReturn(prices.entry, prices.week);
  const ret1m = simpleReturn(prices.entry, prices.month);
  const hit1w = directionHit(bias, ret1w);
  const hit1m = directionHit(bias, ret1m);

  return {
    video_id: signal.video_id || '',
    upload_date: signal.upload_date || '',
    event_date: toIsoDate(signal.upload_date || signal.event_date || ''),
    ticker: signal.ticker || '',
    yahoo_symbol: yahooSymbolFor(signal.ticker),
    bias,
    claim_kind: signal.claim_kind || 'forward',
    action: signal.action || '',
    confidence_label: signal.confidence_label || '',
    confidence_score: signal.confidence_score === '' || signal.confidence_score == null
      ? null
      : Number(signal.confidence_score),
    entry_price: Number.isFinite(prices.entry) ? prices.entry : null,
    price_1w: Number.isFinite(prices.week) ? prices.week : null,
    price_1m: Number.isFinite(prices.month) ? prices.month : null,
    return_1w: ret1w === null ? null : Number(ret1w.toFixed(6)),
    return_1m: ret1m === null ? null : Number(ret1m.toFixed(6)),
    hit_1w: hit1w,
    hit_1m: hit1m,
    price_status: (prices.meta && prices.meta.status) || '',
    evidence_text: signal.evidence_text || '',
  };
}

/**
 * Roll outcomes up for the dashboard.
 *
 * @param {Array<object>} outcomes
 * @returns {object}
 */
function summarizeOutcomes(outcomes) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  const scored1w = rows.filter((row) => row.hit_1w === true || row.hit_1w === false);
  const scored1m = rows.filter((row) => row.hit_1m === true || row.hit_1m === false);
  const hits1w = scored1w.filter((row) => row.hit_1w === true).length;
  const hits1m = scored1m.filter((row) => row.hit_1m === true).length;
  const avg = (key, list) => {
    const vals = list.map((row) => Number(row[key])).filter((v) => Number.isFinite(v));
    if (!vals.length) return null;
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4));
  };

  const byTicker = new Map();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) {
      byTicker.set(row.ticker, {
        ticker: row.ticker,
        signals: 0,
        scored_1w: 0,
        hits_1w: 0,
        scored_1m: 0,
        hits_1m: 0,
        returns_1w: [],
        returns_1m: [],
      });
    }
    const bucket = byTicker.get(row.ticker);
    bucket.signals += 1;
    if (row.hit_1w === true || row.hit_1w === false) {
      bucket.scored_1w += 1;
      if (row.hit_1w) bucket.hits_1w += 1;
    }
    if (row.hit_1m === true || row.hit_1m === false) {
      bucket.scored_1m += 1;
      if (row.hit_1m) bucket.hits_1m += 1;
    }
    if (Number.isFinite(row.return_1w)) bucket.returns_1w.push(row.return_1w);
    if (Number.isFinite(row.return_1m)) bucket.returns_1m.push(row.return_1m);
  }

  const tickers = [...byTicker.values()].map((bucket) => ({
    ticker: bucket.ticker,
    signals: bucket.signals,
    hit_rate_1w: bucket.scored_1w
      ? Number((bucket.hits_1w / bucket.scored_1w).toFixed(3))
      : null,
    hit_rate_1m: bucket.scored_1m
      ? Number((bucket.hits_1m / bucket.scored_1m).toFixed(3))
      : null,
    avg_return_1w: bucket.returns_1w.length
      ? Number((bucket.returns_1w.reduce((a, b) => a + b, 0) / bucket.returns_1w.length).toFixed(4))
      : null,
    avg_return_1m: bucket.returns_1m.length
      ? Number((bucket.returns_1m.reduce((a, b) => a + b, 0) / bucket.returns_1m.length).toFixed(4))
      : null,
    scored_1w: bucket.scored_1w,
    scored_1m: bucket.scored_1m,
  })).sort((a, b) => b.signals - a.signals || a.ticker.localeCompare(b.ticker));

  return {
    signal_count: rows.length,
    scored_1w: scored1w.length,
    scored_1m: scored1m.length,
    hit_rate_1w: scored1w.length ? Number((hits1w / scored1w.length).toFixed(3)) : null,
    hit_rate_1m: scored1m.length ? Number((hits1m / scored1m.length).toFixed(3)) : null,
    avg_return_1w: avg('return_1w', rows),
    avg_return_1m: avg('return_1m', rows),
    missing_prices: rows.filter((row) => !Number.isFinite(row.entry_price)).length,
    tickers,
  };
}

module.exports = {
  directionHit,
  scoreSignalOutcome,
  shiftIsoDate,
  simpleReturn,
  summarizeOutcomes,
  toIsoDate,
  yahooSymbolFor,
};

