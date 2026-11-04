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
/**
 * Bias-aligned return: positive when the market moved the claimed way.
 * @param {string} bias
 * @param {number|null} ret
 * @returns {number|null}
 */
function alignedReturn(bias, ret) {
  if (!Number.isFinite(ret)) return null;
  if (bias === 'bullish') return ret;
  if (bias === 'bearish') return -ret;
  return null;
}

/**
 * Wilson score interval lower/upper for a binomial hit rate.
 * @param {number} hits
 * @param {number} n
 * @param {number} [z]
 * @returns {{low: number, high: number}|null}
 */
function wilsonInterval(hits, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const phat = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return {
    low: Number(Math.max(0, (center - margin) / denom).toFixed(4)),
    high: Number(Math.min(1, (center + margin) / denom).toFixed(4)),
  };
}

/**
 * Honest label for a hit-rate given sample size and optional baseline.
 * @param {object} opts
 * @returns {string}
 */
function assessEdge(opts) {
  const n = Number(opts.n) || 0;
  const hitRate = opts.hitRate;
  const baseline = opts.baseline;
  if (n < 30) return 'insufficient_n';
  if (!Number.isFinite(hitRate)) return 'unscored';
  if (Number.isFinite(baseline)) {
    const delta = hitRate - baseline;
    if (Math.abs(delta) < 0.03) return 'no_clear_edge';
    if (delta >= 0.08 && n >= 50) return 'possible_edge';
    if (delta <= -0.08 && n >= 50) return 'possible_negative_edge';
    return 'no_clear_edge';
  }
  if (hitRate >= 0.58 && n >= 50) return 'possible_edge';
  if (hitRate <= 0.42 && n >= 50) return 'possible_negative_edge';
  return 'no_clear_edge';
}

/**
 * Score one forward setup (directional claim) against later prices.
 * @param {object} setup
 * @param {object} prices
 * @returns {object}
 */
function scoreSetupOutcome(setup, prices) {
  const bias = String(setup.bias || '');
  const ret1w = simpleReturn(prices.entry, prices.week);
  const ret1m = simpleReturn(prices.entry, prices.month);
  const hit1w = directionHit(bias, ret1w);
  const hit1m = directionHit(bias, ret1m);
  const meta = prices.meta || {};
  return {
    source: 'setup',
    video_id: setup.video_id || '',
    upload_date: setup.upload_date || '',
    event_date: toIsoDate(setup.upload_date || setup.event_date || ''),
    ticker: setup.ticker || '',
    yahoo_symbol: yahooSymbolFor(setup.ticker),
    bias,
    claim_kind: setup.claim_kind || 'forward',
    is_prediction: setup.is_prediction ? 1 : 0,
    action: '',
    state: setup.state || '',
    confidence_label: setup.certainty_level || '',
    confidence_score: setup.certainty_confidence === '' || setup.certainty_confidence == null
      ? null
      : Number(setup.certainty_confidence),
    entry_price: Number.isFinite(prices.entry) ? prices.entry : null,
    price_1w: Number.isFinite(prices.week) ? prices.week : null,
    price_1m: Number.isFinite(prices.month) ? prices.month : null,
    return_1w: ret1w === null ? null : Number(ret1w.toFixed(6)),
    return_1m: ret1m === null ? null : Number(ret1m.toFixed(6)),
    aligned_return_1w: (() => {
      const v = alignedReturn(bias, ret1w);
      return v === null ? null : Number(v.toFixed(6));
    })(),
    aligned_return_1m: (() => {
      const v = alignedReturn(bias, ret1m);
      return v === null ? null : Number(v.toFixed(6));
    })(),
    hit_1w: hit1w,
    hit_1m: hit1m,
    price_status: meta.status || '',
    evidence_text: setup.evidence_text || '',
  };
}

function scoreSignalOutcome(signal, prices) {
  const bias = String(signal.bias || '');
  const ret1w = simpleReturn(prices.entry, prices.week);
  const ret1m = simpleReturn(prices.entry, prices.month);
  const hit1w = directionHit(bias, ret1w);
  const hit1m = directionHit(bias, ret1m);
  const meta = prices.meta || {};

  return {
    source: signal.source || 'signal',
    video_id: signal.video_id || '',
    upload_date: signal.upload_date || '',
    event_date: toIsoDate(signal.upload_date || signal.event_date || ''),
    ticker: signal.ticker || '',
    yahoo_symbol: yahooSymbolFor(signal.ticker),
    bias,
    claim_kind: signal.claim_kind || 'forward',
    is_prediction: (bias === 'bullish' || bias === 'bearish') ? 1 : 0,
    action: signal.action || '',
    state: '',
    confidence_label: signal.confidence_label || '',
    confidence_score: signal.confidence_score === '' || signal.confidence_score == null
      ? null
      : Number(signal.confidence_score),
    entry_price: Number.isFinite(prices.entry) ? prices.entry : null,
    price_1w: Number.isFinite(prices.week) ? prices.week : null,
    price_1m: Number.isFinite(prices.month) ? prices.month : null,
    return_1w: ret1w === null ? null : Number(ret1w.toFixed(6)),
    return_1m: ret1m === null ? null : Number(ret1m.toFixed(6)),
    aligned_return_1w: (() => {
      const v = alignedReturn(bias, ret1w);
      return v === null ? null : Number(v.toFixed(6));
    })(),
    aligned_return_1m: (() => {
      const v = alignedReturn(bias, ret1m);
      return v === null ? null : Number(v.toFixed(6));
    })(),
    hit_1w: hit1w,
    hit_1m: hit1m,
    price_status: meta.status || '',
    evidence_text: signal.evidence_text || '',
  };
}

/**
 * @param {Array<object>} rows
 * @param {object} [options]
 * @param {object|null} [options.baseline] SPY (or other) horizon hit rates / returns
 * @returns {object}
 */
function summarizeOutcomes(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const scored1w = list.filter((row) => row.hit_1w === true || row.hit_1w === false);
  const scored1m = list.filter((row) => row.hit_1m === true || row.hit_1m === false);
  const hits1w = scored1w.filter((row) => row.hit_1w === true).length;
  const hits1m = scored1m.filter((row) => row.hit_1m === true).length;

  const avg = (key, subset) => {
    const vals = subset.map((row) => Number(row[key])).filter((v) => Number.isFinite(v));
    if (!vals.length) return null;
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4));
  };

  const byTicker = new Map();
  for (const row of list) {
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
        aligned_1w: [],
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
    if (Number.isFinite(row.aligned_return_1w)) bucket.aligned_1w.push(row.aligned_return_1w);
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
    avg_aligned_return_1w: bucket.aligned_1w.length
      ? Number((bucket.aligned_1w.reduce((a, b) => a + b, 0) / bucket.aligned_1w.length).toFixed(4))
      : null,
    scored_1w: bucket.scored_1w,
    scored_1m: bucket.scored_1m,
  })).sort((a, b) => b.signals - a.signals || a.ticker.localeCompare(b.ticker));

  const hitRate1w = scored1w.length ? Number((hits1w / scored1w.length).toFixed(3)) : null;
  const hitRate1m = scored1m.length ? Number((hits1m / scored1m.length).toFixed(3)) : null;
  const baseline = options.baseline || null;
  const spyHit1w = baseline && Number.isFinite(baseline.hit_rate_1w) ? baseline.hit_rate_1w : null;
  const spyHit1m = baseline && Number.isFinite(baseline.hit_rate_1m) ? baseline.hit_rate_1m : null;

  const bySource = {};
  for (const source of ['signal', 'setup']) {
    const subset = list.filter((row) => (row.source || 'signal') === source);
    if (!subset.length) continue;
    const s1w = subset.filter((row) => row.hit_1w === true || row.hit_1w === false);
    const s1m = subset.filter((row) => row.hit_1m === true || row.hit_1m === false);
    const h1w = s1w.filter((row) => row.hit_1w === true).length;
    const h1m = s1m.filter((row) => row.hit_1m === true).length;
    bySource[source] = {
      count: subset.length,
      scored_1w: s1w.length,
      hit_rate_1w: s1w.length ? Number((h1w / s1w.length).toFixed(3)) : null,
      scored_1m: s1m.length,
      hit_rate_1m: s1m.length ? Number((h1m / s1m.length).toFixed(3)) : null,
      avg_aligned_return_1w: avg('aligned_return_1w', subset),
      assessment_1w: assessEdge({
        n: s1w.length,
        hitRate: s1w.length ? h1w / s1w.length : null,
        baseline: spyHit1w,
      }),
    };
  }

  const ci1w = wilsonInterval(hits1w, scored1w.length);
  const ci1m = wilsonInterval(hits1m, scored1m.length);

  return {
    signal_count: list.length,
    claim_count: list.length,
    scored_1w: scored1w.length,
    scored_1m: scored1m.length,
    hit_rate_1w: hitRate1w,
    hit_rate_1m: hitRate1m,
    hit_rate_1w_ci: ci1w,
    hit_rate_1m_ci: ci1m,
    avg_return_1w: avg('return_1w', list),
    avg_return_1m: avg('return_1m', list),
    avg_aligned_return_1w: avg('aligned_return_1w', list),
    avg_aligned_return_1m: avg('aligned_return_1m', list),
    missing_prices: list.filter((row) => !Number.isFinite(row.entry_price)).length,
    baseline_symbol: baseline && baseline.symbol ? baseline.symbol : '',
    baseline_hit_rate_1w: spyHit1w,
    baseline_hit_rate_1m: spyHit1m,
    baseline_avg_return_1w: baseline && Number.isFinite(baseline.avg_return_1w) ? baseline.avg_return_1w : null,
    baseline_avg_return_1m: baseline && Number.isFinite(baseline.avg_return_1m) ? baseline.avg_return_1m : null,
    edge_vs_baseline_1w: hitRate1w != null && spyHit1w != null
      ? Number((hitRate1w - spyHit1w).toFixed(3))
      : null,
    edge_vs_baseline_1m: hitRate1m != null && spyHit1m != null
      ? Number((hitRate1m - spyHit1m).toFixed(3))
      : null,
    assessment_1w: assessEdge({ n: scored1w.length, hitRate: hitRate1w, baseline: spyHit1w }),
    assessment_1m: assessEdge({ n: scored1m.length, hitRate: hitRate1m, baseline: spyHit1m }),
    min_n_for_edge: 30,
    note: scored1w.length < 30
      ? `Only ${scored1w.length} scored 1w claims — treat hit rates as descriptive, not proof of edge.`
      : 'Sample large enough for a rough read; still not a live trading mandate.',
    by_source: bySource,
    tickers,
  };
}

/**
 * Build a long-only SPY baseline across the same event dates as claims.
 * A bullish baseline "hit" is SPY up over the horizon; bearish is SPY down.
 *
 * @param {Array<{event_date:string, bias:string}>} claims
 * @param {object} provider yahoo price provider
 * @param {{weekDays:number, monthDays:number, asOfDate:string}} horizons
 * @returns {Promise<object>}
 */
async function buildSpyBaseline(claims, provider, horizons) {
  const symbol = 'SPY';
  const dates = [...new Set(claims.map((c) => c.event_date).filter(Boolean))];
  let scored1w = 0;
  let hits1w = 0;
  let scored1m = 0;
  let hits1m = 0;
  const rets1w = [];
  const rets1m = [];

  for (const eventDate of dates) {
    const weekDate = shiftIsoDate(eventDate, horizons.weekDays);
    const monthDate = shiftIsoDate(eventDate, horizons.monthDays);
    const entry = await provider.getPricePoint(symbol, eventDate);
    const entryPx = Number(entry && entry.price);
    if (!Number.isFinite(entryPx) || entryPx <= 0) continue;

    if (weekDate && weekDate <= horizons.asOfDate) {
      const week = await provider.getPricePoint(symbol, weekDate);
      const weekPx = Number(week && week.price);
      const ret = simpleReturn(entryPx, weekPx);
      if (Number.isFinite(ret)) {
        scored1w += 1;
        rets1w.push(ret);
        // long-only baseline: up = hit
        if (ret > 0) hits1w += 1;
      }
    }
    if (monthDate && monthDate <= horizons.asOfDate) {
      const month = await provider.getPricePoint(symbol, monthDate);
      const monthPx = Number(month && month.price);
      const ret = simpleReturn(entryPx, monthPx);
      if (Number.isFinite(ret)) {
        scored1m += 1;
        rets1m.push(ret);
        if (ret > 0) hits1m += 1;
      }
    }
  }

  return {
    symbol,
    scored_1w: scored1w,
    scored_1m: scored1m,
    hit_rate_1w: scored1w ? Number((hits1w / scored1w).toFixed(3)) : null,
    hit_rate_1m: scored1m ? Number((hits1m / scored1m).toFixed(3)) : null,
    avg_return_1w: rets1w.length
      ? Number((rets1w.reduce((a, b) => a + b, 0) / rets1w.length).toFixed(4))
      : null,
    avg_return_1m: rets1m.length
      ? Number((rets1m.reduce((a, b) => a + b, 0) / rets1m.length).toFixed(4))
      : null,
    method: 'long_only_spy_on_claim_event_dates',
  };
}

/**
 * Is this setup eligible for market scoring?
 * @param {object} setup
 * @returns {boolean}
 */
function isScorableSetup(setup) {
  const kind = String(setup.claim_kind || 'forward');
  if (kind === 'retrospective') return false;
  if (setup.direction_uncertain) return false;
  if (setup.is_prediction === 0 || setup.is_prediction === false) {
    // allow if bias is clean even when flag missing on old rows
    if (!(setup.bias === 'bullish' || setup.bias === 'bearish')) return false;
  } else if (!(setup.bias === 'bullish' || setup.bias === 'bearish')) {
    return false;
  }
  return true;
}

module.exports = {
  alignedReturn,
  assessEdge,
  buildSpyBaseline,
  directionHit,
  isScorableSetup,
  scoreSetupOutcome,
  scoreSignalOutcome,
  shiftIsoDate,
  simpleReturn,
  summarizeOutcomes,
  toIsoDate,
  wilsonInterval,
  yahooSymbolFor,
};
