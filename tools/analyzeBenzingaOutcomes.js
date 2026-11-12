'use strict';

// Score the Benzinga directional calls against what the price did next.
//
// The same bookkeeping as tools/analyzeT3liveOutcomes.js -- it reuses
// src/sevcik/outcomeAnalysis.js -- with four differences that matter here:
//
//   1. ONE CLAIM PER NAME PER VIDEO. A host can come back to the same
//      ticker three times in one video; scoring each mention would count
//      one call as three correlated wins or losses. Mentions of one ticker
//      in one video are merged into one claim. If they disagree on the
//      direction, the claim is not scored (it is reported as conflicting).
//
//   2. ONLY FORWARD CLAIMS ARE SCORED. Benzinga is a news channel, so its
//      corpus also holds reported opinions ("Wedbush's Dan Ives remains
//      bullish"), recaps of what already happened, and sponsors' segments.
//      None of those is a prediction. They are kept in the signal table and
//      left out of the scoring.
//
//   3. PER SHOW and PER PARTNER. The daily PreMarket Playbook and the
//      weekly The Drift sit on different calendars, so each gets its OWN
//      SPY baseline on its own event dates. And the "PreMarket Playbook +
//      T3 Live" episodes feature people whose calls are also in the t3live
//      corpus, so they are scored apart from the rest.
//
//   4. THE ENTRY. The entry is the close on the upload date, or the
//      previous trading day's close for a weekend upload. A pre-market
//      show airs before the open, so a same-day close leaves the first
//      day's move OUT of the measured return. That is conservative, and it
//      is stated here rather than hidden.
//
// Horizons: +7 and +30 calendar days. A call whose horizon has not
// elapsed yet is left unscored, never guessed.
//
// Usage:
//   node tools/aggregateBenzingaSignals.js   (writes data/benzinga_signals.json)
//   node tools/analyzeBenzingaOutcomes.js
//   node tools/analyzeBenzingaOutcomes.js --show premarket_playbook
//   node tools/analyzeBenzingaOutcomes.js --json

const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const {
  buildSpyBaseline,
  scoreSignalOutcome,
  shiftIsoDate,
  summarizeOutcomes,
  toIsoDate,
  yahooSymbolFor,
} = require('../src/sevcik/outcomeAnalysis');
const { writeCsv } = require('../src/write/writeCsv');
const { BENZINGA_SHOWS } = require('../src/benzinga/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const INPUT_JSON = path.join(ROOT, 'data', 'benzinga_signals.json');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const OUTCOME_COLUMNS = [
  'show', 'partner', 'category', 'video_id', 'upload_date', 'event_date', 'ticker', 'yahoo_symbol', 'bias',
  'mentions', 'confidence_label', 'confidence_score', 'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'spy_return_1w', 'spy_same_call_hit_1w', 'excess_aligned_1w',
  'spy_return_1m', 'spy_same_call_hit_1m', 'excess_aligned_1m',
  'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];
const OUTCOME_TICKER_COLUMNS = [
  'ticker', 'signals', 'scored_1w', 'hit_rate_1w', 'avg_return_1w', 'avg_aligned_return_1w',
  'scored_1m', 'hit_rate_1m', 'avg_return_1m',
];

/** Index calls: scored on their own, because "beat SPY" is meaningless for SPY. */
const MARKET_TICKERS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);

const argv = process.argv.slice(2);
const options = {
  json: argv.includes('--json'),
  show: readFlag(argv, '--show') || '',
};

/**
 * Merge the mentions of one ticker in one video into one claim.
 *
 * @param {Array<object>} signals
 * @returns {{claims: Array<object>, conflicting: Array<object>}}
 */
function toClaims(signals) {
  const groups = new Map();
  for (const signal of signals) {
    const key = `${signal.video_id}|${signal.ticker}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  const claims = [];
  const conflicting = [];
  for (const rows of groups.values()) {
    const biases = new Set(rows.map((row) => row.bias));
    if (biases.size > 1) {
      conflicting.push({ video_id: rows[0].video_id, ticker: rows[0].ticker, biases: [...biases] });
      continue;
    }
    // The strongest reading carries the confidence and the evidence.
    const best = rows.slice().sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0))[0];
    claims.push({ ...best, mentions: rows.length });
  }
  return { claims, conflicting };
}

async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`No ${INPUT_JSON}. Run node tools/aggregateBenzingaSignals.js first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));

  const forward = (payload.signals || []).filter((signal) => {
    if (signal.bias !== 'bullish' && signal.bias !== 'bearish') return false;
    // ONLY forward claims are predictions. A reported opinion, a recap
    // and a sponsor's segment are not.
    if (String(signal.claim_kind || 'forward') !== 'forward') return false;
    if (options.show && signal.show !== options.show) return false;
    return true;
  });
  const { claims, conflicting } = toClaims(forward);

  const dates = claims.map((claim) => toIsoDate(claim.upload_date)).filter(Boolean).sort();
  const asOfDate = new Date().toISOString().slice(0, 10);
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: dates[0] ? shiftIsoDate(dates[0], -5) : '',
    defaultToDate: dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : asOfDate,
    prefetchConcurrency: 2,
  });

  const symbols = [...new Set([...claims.map((claim) => yahooSymbolFor(claim.ticker)), 'SPY'].filter(Boolean))];
  console.log(`[benzinga-outcomes] signals=${forward.length} claims=${claims.length}`
    + ` conflicting=${conflicting.length} symbols=${symbols.length}`);
  await provider.prefetchTickers(symbols);

  const outcomes = [];
  for (const claim of claims) {
    const eventDate = toIsoDate(claim.upload_date);
    let prices;
    if (!eventDate) {
      prices = { entry: null, week: null, month: null, meta: { status: 'missing_event_date' } };
    } else {
      const symbol = yahooSymbolFor(claim.ticker);
      const weekDate = shiftIsoDate(eventDate, HORIZON_1W_DAYS);
      const monthDate = shiftIsoDate(eventDate, HORIZON_1M_DAYS);
      const entry = await provider.getPricePoint(symbol, eventDate);
      const week = weekDate <= asOfDate
        ? await provider.getPricePoint(symbol, weekDate)
        : { price: '', priceStatus: 'horizon_not_elapsed' };
      const month = monthDate <= asOfDate
        ? await provider.getPricePoint(symbol, monthDate)
        : { price: '', priceStatus: 'horizon_not_elapsed' };
      const status = [entry.priceStatus, week.priceStatus, month.priceStatus]
        .filter((value) => value && !String(value).startsWith('ok'))
        .join('|') || 'ok';
      prices = { entry: finitePrice(entry.price), week: finitePrice(week.price), month: finitePrice(month.price), meta: { status } };
    }
    const scored = scoreSignalOutcome(claim, prices);
    const row = {
      ...scored,
      show: claim.show || '',
      partner: claim.partner || '',
      category: MARKET_TICKERS.has(String(claim.ticker || '').toUpperCase()) ? 'market' : 'stock',
      mentions: claim.mentions,
    };
    await attachSameCallOnSpy(row, provider, asOfDate);
    outcomes.push(row);
  }

  const horizons = { weekDays: HORIZON_1W_DAYS, monthDays: HORIZON_1M_DAYS, asOfDate };
  const summarize = async (rows) => {
    const baseline = await buildSpyBaseline(rows.filter((row) => row.event_date), provider, horizons);
    const summary = summarizeOutcomes(rows, { baseline });
    delete summary.tickers;
    delete summary.by_source;
    summary.same_call_on_spy = { '1w': sameCallStats(rows, '1w'), '1m': sameCallStats(rows, '1m') };
    return summary;
  };

  const overallBaseline = await buildSpyBaseline(outcomes.filter((row) => row.event_date), provider, horizons);
  const overall = summarizeOutcomes(outcomes, { baseline: overallBaseline });
  const byShow = {};
  for (const show of Object.values(BENZINGA_SHOWS)) {
    const subset = outcomes.filter((row) => row.show === show);
    if (subset.length) byShow[show] = await summarize(subset);
  }
  const byPartner = {};
  for (const partner of [...new Set(outcomes.map((row) => row.partner).filter(Boolean))]) {
    const subset = outcomes.filter((row) => row.partner === partner);
    if (subset.length) byPartner[partner] = await summarize(subset);
  }
  const byBias = {};
  for (const bias of ['bullish', 'bearish']) {
    const subset = outcomes.filter((row) => row.bias === bias);
    if (subset.length) byBias[bias] = await summarize(subset);
  }
  const byCategory = {};
  for (const category of ['stock', 'market']) {
    const subset = outcomes.filter((row) => row.category === category);
    if (subset.length) byCategory[category] = await summarize(subset);
  }
  overall.same_call_on_spy = { '1w': sameCallStats(outcomes, '1w'), '1m': sameCallStats(outcomes, '1m') };

  const summary = {
    generated_at: new Date().toISOString(),
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
    entry_rule: 'close on the upload date; previous trading day for a weekend upload',
    input_signals: forward.length,
    claims: claims.length,
    conflicting_claims: conflicting.length,
    overall: { ...overall, tickers: undefined, by_source: undefined },
    by_show: byShow,
    by_partner: byPartner,
    by_bias: byBias,
    by_category: byCategory,
    conflicting,
  };

  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_outcomes.csv'), OUTCOME_COLUMNS, outcomes.map(serializeOutcome));
  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_outcome_ticker_summary.csv'), OUTCOME_TICKER_COLUMNS,
    (overall.tickers || []).map((row) => ({
      ticker: row.ticker,
      signals: row.signals,
      scored_1w: row.scored_1w,
      hit_rate_1w: row.hit_rate_1w === null ? '' : row.hit_rate_1w,
      avg_return_1w: row.avg_return_1w === null ? '' : row.avg_return_1w,
      avg_aligned_return_1w: row.avg_aligned_return_1w === null ? '' : row.avg_aligned_return_1w,
      scored_1m: row.scored_1m,
      hit_rate_1m: row.hit_rate_1m === null ? '' : row.hit_rate_1m,
      avg_return_1m: row.avg_return_1m === null ? '' : row.avg_return_1m,
    })));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'benzinga_outcome_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const line = (label, s) => {
    const w = s.same_call_on_spy['1w'];
    const m = s.same_call_on_spy['1m'];
    console.log(`[benzinga-outcomes] ${label.padEnd(20)} claims=${String(s.claim_count).padStart(4)}`
      + ` | 1w n=${w.n} hit=${w.hit_rate} same-call-on-SPY=${w.spy_same_call_hit_rate} excess=${w.mean_excess_aligned} ci=${JSON.stringify(w.excess_ci95)}`
      + ` | 1m n=${m.n} hit=${m.hit_rate} same-call-on-SPY=${m.spy_same_call_hit_rate} excess=${m.mean_excess_aligned} ci=${JSON.stringify(m.excess_ci95)}`);
  };
  line('overall', overall);
  for (const [show, s] of Object.entries(byShow)) line(show, s);
  for (const [partner, s] of Object.entries(byPartner)) line(`partner:${partner}`, s);
  for (const [bias, s] of Object.entries(byBias)) line(`bias:${bias}`, s);
  for (const [category, s] of Object.entries(byCategory)) line(`category:${category}`, s);
  console.log('[benzinga-outcomes] wrote data/benzinga_outcomes.csv, data/benzinga_outcome_ticker_summary.csv, data/benzinga_outcome_summary.json');
}

function finitePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The same call made on SPY, on the same dates.
 *
 * @param {object} row - a scored outcome (mutated)
 * @param {object} provider
 * @param {string} asOfDate
 */
async function attachSameCallOnSpy(row, provider, asOfDate) {
  const sign = row.bias === 'bullish' ? 1 : row.bias === 'bearish' ? -1 : 0;
  for (const [h, days] of [['1w', HORIZON_1W_DAYS], ['1m', HORIZON_1M_DAYS]]) {
    row[`spy_return_${h}`] = null;
    row[`spy_same_call_hit_${h}`] = null;
    row[`excess_aligned_${h}`] = null;
    const stockReturn = row[`return_${h}`];
    if (!sign || !row.event_date || !Number.isFinite(stockReturn)) continue;
    const exitDate = shiftIsoDate(row.event_date, days);
    if (exitDate > asOfDate) continue;
    const entry = finitePrice((await provider.getPricePoint('SPY', row.event_date)).price);
    const exit = finitePrice((await provider.getPricePoint('SPY', exitDate)).price);
    if (!entry || !exit) continue;
    const spyReturn = exit / entry - 1;
    row[`spy_return_${h}`] = Number(spyReturn.toFixed(6));
    row[`spy_same_call_hit_${h}`] = sign * spyReturn > 0;
    row[`excess_aligned_${h}`] = Number((sign * (stockReturn - spyReturn)).toFixed(6));
  }
}

/**
 * Hit rate against the same call on SPY, and the mean excess return with a
 * normal-approximation 95% interval.
 *
 * @param {Array<object>} rows
 * @param {string} h
 */
function sameCallStats(rows, h) {
  const scored = rows.filter((row) => (row[`hit_${h}`] === true || row[`hit_${h}`] === false)
    && Number.isFinite(row[`excess_aligned_${h}`]));
  const n = scored.length;
  if (!n) return { n: 0, hit_rate: null, spy_same_call_hit_rate: null, edge_pp: null, mean_excess_aligned: null, excess_ci95: null };
  const hits = scored.filter((row) => row[`hit_${h}`] === true).length;
  const spyHits = scored.filter((row) => row[`spy_same_call_hit_${h}`] === true).length;
  const excess = scored.map((row) => row[`excess_aligned_${h}`]);
  const mean = excess.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / n);
  const round = (v, d = 4) => Number(v.toFixed(d));
  return {
    n,
    hit_rate: round(hits / n, 3),
    spy_same_call_hit_rate: round(spyHits / n, 3),
    edge_pp: round((hits - spyHits) / n * 100, 1),
    mean_excess_aligned: round(mean),
    excess_ci95: [round(mean - half), round(mean + half)],
  };
}

function serializeOutcome(row) {
  const blank = (v) => (v === null || v === undefined ? '' : v);
  return {
    ...row,
    confidence_score: blank(row.confidence_score),
    entry_price: blank(row.entry_price),
    price_1w: blank(row.price_1w),
    price_1m: blank(row.price_1m),
    return_1w: blank(row.return_1w),
    return_1m: blank(row.return_1m),
    aligned_return_1w: blank(row.aligned_return_1w),
    aligned_return_1m: blank(row.aligned_return_1m),
    spy_return_1w: blank(row.spy_return_1w),
    spy_same_call_hit_1w: row.spy_same_call_hit_1w === null ? '' : (row.spy_same_call_hit_1w ? 1 : 0),
    excess_aligned_1w: blank(row.excess_aligned_1w),
    spy_return_1m: blank(row.spy_return_1m),
    spy_same_call_hit_1m: row.spy_same_call_hit_1m === null ? '' : (row.spy_same_call_hit_1m ? 1 : 0),
    excess_aligned_1m: blank(row.excess_aligned_1m),
    hit_1w: row.hit_1w === null ? '' : (row.hit_1w ? 1 : 0),
    hit_1m: row.hit_1m === null ? '' : (row.hit_1m ? 1 : 0),
  };
}

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return '';
  return arr[index + 1] || '';
}

main().catch((error) => {
  console.error(`[benzinga-outcomes] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
