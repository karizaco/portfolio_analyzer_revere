'use strict';

/**
 * Score a source's READINGS against what the price did next.
 *
 * WHY ONE MODULE AND NOT THREE TOOLS
 *
 * The Discord reading sources -- Monoszon, Martin Klass, and HariSeldon's
 * option legs -- have the same shape: a claim about the future, on an
 * instrument, with a date and a sentence it was read from. The scoring is
 * identical, and it was copied twice before this module existed.
 *
 * The Benzinga source already taught this project what copies cost: "The
 * extractors were copies, and the copies drifted. ... There is now ONE
 * runner and it always replaces." A copy that scores prices is worse than
 * a copy that parses text, because a drift in the copy is a WRONG
 * NUMBER in a report.
 *
 * So the scoring lives here once, and each source's tool is a thin
 * wrapper: it loads its own readings, calls this, and prints.
 *
 * WHAT IS SCORED, AND WHAT IS NOT
 *
 * Only FORWARD claims with a direction and an instrument. A reported or
 * retrospective claim is about something that has already happened, and
 * a fact has already had its move.
 *
 * THE ENTRY IS THE CLOSE ON THE DAY OF THE CLAIM
 *
 * The project's price model enters at the close, because the model is
 * close-to-close and a limit level is not a fill. A claim made intraday
 * is therefore scored from the close of the day, which leaves the day's
 * own move out of the measured return. That is conservative, and it is
 * stated rather than hidden.
 *
 * (`tools/measureEntryRule.js` measures what that rule is worth against
 * the alternatives. It is an INSTRUMENT, and it does not change what the
 * sources publish.)
 *
 * THE HORIZONS ARE THE PROJECT'S
 *
 * +7 and +30 calendar days, the same as every other source here. A claim
 * whose horizon has not elapsed yet is left unscored, never guessed.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createYahooPriceProvider } = require('../analysis/priceProvider');
const {
  buildSpyBaseline,
  scoreSignalOutcome,
  shiftIsoDate,
  summarizeOutcomes,
  toIsoDate,
  yahooSymbolFor,
} = require('../sevcik/outcomeAnalysis');
const { writeCsv } = require('../write/writeCsv');

const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');

/**
 * A price, or null.
 *
 * @param {*} value
 * @returns {number|null}
 */
function finitePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The same call made on SPY, on the same dates.
 *
 * @param {object} row  a scored outcome (mutated)
 * @param {object} provider
 * @param {string} asOfDate
 */
async function attachSameCallOnSpy(row, provider, asOfDate) {
  const sign = row.bias === 'bullish' ? 1 : row.bias === 'bearish' ? -1 : 0;
  for (const [h, days] of [['1w', HORIZON_1W_DAYS], ['1m', HORIZON_1M_DAYS]]) {
    row[`spy_return_${h}`] = null;
    row[`spy_same_call_hit_${h}`] = null;
    row[`excess_aligned_${h}`] = null;
    const ownReturn = row[`return_${h}`];
    if (!sign || !row.event_date || !Number.isFinite(ownReturn)) continue;
    const exitDate = shiftIsoDate(row.event_date, days);
    if (exitDate > asOfDate) continue;
    const entry = finitePrice((await provider.getPricePoint('SPY', row.event_date)).price);
    const exit = finitePrice((await provider.getPricePoint('SPY', exitDate)).price);
    if (!entry || !exit) continue;
    const spyReturn = exit / entry - 1;
    row[`spy_return_${h}`] = Number(spyReturn.toFixed(6));
    row[`spy_same_call_hit_${h}`] = sign * spyReturn > 0;
    row[`excess_aligned_${h}`] = Number((sign * (ownReturn - spyReturn)).toFixed(6));
  }
}

/**
 * The hit rate, the same call on SPY, and the mean excess.
 *
 * @param {Array<object>} rows
 * @param {string} h
 * @returns {object}
 */
function sameCallStats(rows, h) {
  const scored = rows.filter((row) => (row[`hit_${h}`] === true || row[`hit_${h}`] === false)
    && Number.isFinite(row[`excess_aligned_${h}`]));
  const n = scored.length;
  if (!n) {
    return {
      n: 0,
      hit_rate: null,
      spy_same_call_hit_rate: null,
      edge_pp: null,
      mean_excess_aligned: null,
      excess_ci95: null,
    };
  }
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

/**
 * The scored row as it is written to the CSV.
 *
 * @param {object} row
 * @returns {object}
 */
function serializeOutcome(row) {
  const blank = (v) => (v === null || v === undefined ? '' : v);
  return {
    ...row,
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

/**
 * Score a source's readings and write the artifacts.
 *
 * @param {object} config
 * @param {string} config.sourceName
 * @param {object[]} config.readings  the source's readings, in the shape
 *   the reader produces: {id, date, subject, proxy_ticker, scope, stance,
 *   claim_kind, horizon, confidence, evidence_text}
 * @param {object} config.coverage
 * @param {string} config.entryRuleNote
 * @param {string} config.outputJson
 * @param {string} config.outputCsv
 * @param {string[]} config.csvColumns
 * @param {function} [config.rowFields]  the extra fields for one row
 * @param {string} [config.logPrefix]
 * @param {object} [config.extraSummary]  merged into the payload
 * @param {function} [config.after]  called with the payload before it is written
 * @returns {object} the payload
 */
async function analyseReadings(config) {
  const logPrefix = config.logPrefix || `[${config.sourceName}-outcomes]`;
  const readings = Array.isArray(config.readings) ? config.readings : [];
  const scorable = readings.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && row.proxy_ticker);

  if (!scorable.length) {
    console.log(`${logPrefix} no forward readings with an instrument -- nothing to score`);
    return null;
  }

  const dates = [...new Set(scorable.map((row) => toIsoDate(row.date)).filter(Boolean))].sort();
  const asOfDate = new Date().toISOString().slice(0, 10);
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: dates[0] ? shiftIsoDate(dates[0], -5) : '',
    defaultToDate: dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : asOfDate,
    prefetchConcurrency: 2,
  });
  const symbols = [...new Set([
    ...scorable.map((row) => yahooSymbolFor(row.proxy_ticker)),
    'SPY',
  ].filter(Boolean))];
  console.log(`${logPrefix} forward=${scorable.length} symbols=${symbols.length}`);
  await provider.prefetchTickers(symbols);

  const outcomes = [];
  for (const reading of scorable) {
    const eventDate = toIsoDate(reading.date);
    let prices;
    if (!eventDate) {
      prices = { entry: null, week: null, month: null, meta: { status: 'missing_event_date' } };
    } else {
      const symbol = yahooSymbolFor(reading.proxy_ticker);
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
      prices = {
        entry: finitePrice(entry.price),
        week: finitePrice(week.price),
        month: finitePrice(month.price),
        meta: { status },
      };
    }
    const scored = scoreSignalOutcome({
      source: 'reading',
      video_id: String(reading.id || ''),
      upload_date: reading.date,
      ticker: reading.proxy_ticker,
      bias: reading.stance,
      claim_kind: reading.claim_kind,
      confidence_label: reading.confidence,
      confidence_score: null,
      evidence_text: reading.evidence_text,
    }, prices);
    const row = {
      ...scored,
      as_of_date: reading.date,
      subject: reading.subject,
      proxy_ticker: reading.proxy_ticker,
      scope: reading.scope,
      stance: reading.stance,
      claim_kind: reading.claim_kind,
      horizon: reading.horizon,
      confidence: reading.confidence,
      ...(config.rowFields ? config.rowFields(reading) : {}),
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

  const overall = await summarize(outcomes);
  const bySubject = {};
  for (const subject of [...new Set(outcomes.map((row) => row.subject).filter(Boolean))]) {
    const subset = outcomes.filter((row) => row.subject === subject);
    if (subset.length) bySubject[subject] = await summarize(subset);
  }
  const byBias = {};
  for (const bias of ['bullish', 'bearish']) {
    const subset = outcomes.filter((row) => row.bias === bias);
    if (subset.length) byBias[bias] = await summarize(subset);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: config.sourceName,
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
    entry_rule: config.entryRuleNote,
    coverage: config.coverage,
    overall,
    by_subject: bySubject,
    by_bias: byBias,
    ...(config.extraSummary ? config.extraSummary(outcomes) : {}),
  };
  if (config.after) config.after(payload, outcomes);

  await writeCsv(config.outputCsv, config.csvColumns, outcomes.map(serializeOutcome));
  fs.writeFileSync(config.outputJson, JSON.stringify(payload, null, 2), 'utf8');

  const line = (label, s) => {
    const w = s.same_call_on_spy['1w'];
    const m = s.same_call_on_spy['1m'];
    console.log(`${logPrefix} ${label.padEnd(16)} calls=${String(s.claim_count).padStart(3)}`
      + ` | 1w n=${w.n} hit=${w.hit_rate} same-call-on-SPY=${w.spy_same_call_hit_rate} excess=${w.mean_excess_aligned} ci=${JSON.stringify(w.excess_ci95)}`
      + ` | 1m n=${m.n} hit=${m.hit_rate} same-call-on-SPY=${m.spy_same_call_hit_rate} excess=${m.mean_excess_aligned}`);
  };
  line('overall', overall);
  for (const [subject, s] of Object.entries(bySubject)) line(subject, s);

  return payload;
}

module.exports = {
  HORIZON_1M_DAYS,
  HORIZON_1W_DAYS,
  analyseReadings,
  attachSameCallOnSpy,
  finitePrice,
  sameCallStats,
  serializeOutcome,
};
