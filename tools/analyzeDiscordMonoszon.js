'use strict';

/**
 * Score David's calls against what the price did next.
 *
 * WHAT IS SCORED
 *
 * His FORWARD calls on an instrument, against the instrument's proxy
 * (QQQ for the Nasdaq 100 future, SPY for the S&P 500 future, GLD for
 * gold) and against SPY.
 *
 * WHAT IS NOT SCORED, AND WHY
 *
 *   retrospective  "dnes byl krásný long na GC" -- a fact, not a call
 *   present        "dnes uzavírám třetinu BTAL longu" -- a position he
 *                  holds, which has already had its move
 *   mixed          a sentence that does not pick a side
 *
 * THE ENTRY IS THE CLOSE ON THE DAY HE WROTE IT
 *
 * He names a level ("abych změnil na bearish, potřeboval bych vidět
 * spx uzavírat pod 6550") and the level is recorded with the reading --
 * but the project's price model enters at the close, because the entry
 * model is close-to-close and a limit level is not a fill. A call made
 * intraday is therefore scored from the close of the day, which leaves
 * the day's own move out of the measured return. That is conservative,
 * and it is stated rather than hidden.
 *
 * THE HORIZONS ARE THE PROJECT'S
 *
 * +7 and +30 calendar days, the same as every other source here. A call
 * whose horizon has not elapsed yet is left unscored, never guessed.
 *
 * Usage:
 *   node tools/analyzeDiscordMonoszon.js
 *   node tools/analyzeDiscordMonoszon.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
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
const { SOURCE_NAME } = require('../src/discord/monoszon/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const OUTCOME_COLUMNS = [
  'as_of_date', 'subject', 'proxy_ticker', 'scope', 'stance', 'claim_kind', 'horizon',
  'level', 'confidence', 'event_date', 'yahoo_symbol', 'bias',
  'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'spy_return_1w', 'spy_same_call_hit_1w', 'excess_aligned_1w',
  'spy_return_1m', 'spy_same_call_hit_1m', 'excess_aligned_1m',
  'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];

const options = { json: process.argv.includes('--json') };

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

async function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  const all = db.prepare(`
    SELECT id, as_of_date, posted_at, scope, subject, proxy_ticker, stance, claim_kind,
           horizon, horizon_text, level, confidence, evidence_text, message_id
      FROM monoszon_readings
     WHERE parser_version = (SELECT MAX(parser_version) FROM monoszon_readings)
  `).all();

  const coverage = {
    readings: all.length,
    by_kind: {},
    by_stance: {},
    forward: 0,
    forward_with_proxy: 0,
    unscored_no_proxy: 0,
  };
  for (const row of all) {
    coverage.by_kind[row.claim_kind] = (coverage.by_kind[row.claim_kind] || 0) + 1;
    coverage.by_stance[row.stance] = (coverage.by_stance[row.stance] || 0) + 1;
  }

  const scorable = all.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && row.proxy_ticker);
  coverage.forward = all.filter((row) => row.claim_kind === 'forward').length;
  coverage.forward_with_proxy = scorable.length;
  coverage.unscored_no_proxy = all.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && !row.proxy_ticker).length;

  if (!scorable.length) {
    console.log('[monoszon-outcomes] no forward readings with a proxy -- run tools/buildDiscordMonoszonReadings.js first');
    db.close();
    return;
  }

  const dates = [...new Set(scorable.map((row) => toIsoDate(row.as_of_date)).filter(Boolean))].sort();
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
  console.log(`[monoszon-outcomes] forward=${scorable.length} symbols=${symbols.length} (${symbols.join(', ')})`);
  await provider.prefetchTickers(symbols);

  const outcomes = [];
  for (const reading of scorable) {
    const eventDate = toIsoDate(reading.as_of_date || reading.posted_at);
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
      video_id: String(reading.message_id || ''),
      upload_date: reading.as_of_date,
      ticker: reading.proxy_ticker,
      bias: reading.stance,
      claim_kind: reading.claim_kind,
      confidence_label: reading.confidence,
      confidence_score: null,
      evidence_text: reading.evidence_text,
    }, prices);
    const row = {
      ...scored,
      as_of_date: reading.as_of_date,
      subject: reading.subject,
      proxy_ticker: reading.proxy_ticker,
      scope: reading.scope,
      stance: reading.stance,
      claim_kind: reading.claim_kind,
      horizon: reading.horizon,
      level: reading.level,
      confidence: reading.confidence,
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

  // The SPY-PROXIED CALLS ARE DEGENERATE AGAINST SPY, and that is said.
  //
  // A call on the S&P 500 future is scored on SPY, so "the same call on
  // SPY" IS the call, and the excess is zero by construction. The
  // numbers that carry information for those rows are the hit rate and
  // the average return -- not the edge.
  const spyProxied = outcomes.filter((row) => row.proxy_ticker === 'SPY');
  const degenerate = {
    calls: spyProxied.length,
    note: 'scored on SPY, so the excess against SPY is zero by construction;'
      + ' the hit rate and the average return are the numbers that mean something',
  };

  const summary = {
    generated_at: new Date().toISOString(),
    source: SOURCE_NAME,
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
    entry_rule: 'close on the date he wrote it; the level he names is recorded but is not the entry',
    coverage,
    overall,
    by_subject: bySubject,
    by_bias: byBias,
    spy_proxied: degenerate,
  };

  await writeCsv(path.join(OUTPUT_DIR, 'discord_monoszon_outcomes.csv'), OUTCOME_COLUMNS,
    outcomes.map(serializeOutcome));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'discord_monoszon.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    db.close();
    return;
  }
  const line = (label, s) => {
    const w = s.same_call_on_spy['1w'];
    const m = s.same_call_on_spy['1m'];
    console.log(`[monoszon-outcomes] ${label.padEnd(16)} calls=${String(s.claim_count).padStart(3)}`
      + ` | 1w n=${w.n} hit=${w.hit_rate} same-call-on-SPY=${w.spy_same_call_hit_rate} excess=${w.mean_excess_aligned} ci=${JSON.stringify(w.excess_ci95)}`
      + ` | 1m n=${m.n} hit=${m.hit_rate} same-call-on-SPY=${m.spy_same_call_hit_rate} excess=${m.mean_excess_aligned}`);
  };
  line('overall', overall);
  for (const [subject, s] of Object.entries(bySubject)) line(subject, s);
  console.log(`[monoszon-outcomes] coverage: ${JSON.stringify(coverage.by_kind)}`);
  console.log('[monoszon-outcomes] wrote data/discord_monoszon.json, data/discord_monoszon_outcomes.csv');
  db.close();
}

main().catch((error) => {
  console.error(`[monoszon-outcomes] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
