'use strict';
// Cross-check Sevcik signals against subsequent market prices.
//
// For every directional signal this looks up the Yahoo close on the stream
// date, one week later, and one month later, then asks a simple question:
// did the price move the way the bias claimed?
//
// Usage:
//   node tools/analyzeSevcikOutcomes.js
//   node tools/analyzeSevcikOutcomes.js --limit 40
//   node tools/analyzeSevcikOutcomes.js --json
const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const {
  scoreSignalOutcome,
  shiftIsoDate,
  summarizeOutcomes,
  toIsoDate,
  yahooSymbolFor,
} = require('../src/sevcik/outcomeAnalysis');
const { writeCsv } = require('../src/write/writeCsv');
const ROOT = path.resolve(__dirname, '..');
const INPUT_JSON = path.join(ROOT, 'data', 'sevcik_signals.json');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;
/** Yahoo empty prices must not become 0 -- Number('') is 0 in JS. */
function finitePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const OUTCOME_COLUMNS = [
  'video_id', 'upload_date', 'event_date', 'ticker', 'yahoo_symbol', 'bias', 'claim_kind', 'action',
  'confidence_label', 'confidence_score', 'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];
const OUTCOME_TICKER_COLUMNS = [
  'ticker', 'signals', 'scored_1w', 'hit_rate_1w', 'avg_return_1w',
  'scored_1m', 'hit_rate_1m', 'avg_return_1m',
];
const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  json: argv.includes('--json'),
  ticker: readFlag(argv, '--ticker') || '',
};
async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`No ${INPUT_JSON}. Run npm run sevcik:aggregate first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
  let signals = (payload.signals || []).filter((signal) => {
    const bias = String(signal.bias || '');
    if (bias !== 'bullish' && bias !== 'bearish') return false;
    // Market ledger: only live/forward claims. Retrospective "predikce vyšla"
    // reviews are speech-ledger material, not ex-ante predictions.
    const kind = String(signal.claim_kind || 'forward');
    return kind !== 'retrospective';
  });
  if (options.ticker) {
    const wanted = options.ticker.toUpperCase();
    signals = signals.filter((signal) => String(signal.ticker || '').toUpperCase() === wanted);
  }
  if (options.limit) signals = signals.slice(0, options.limit);
  const dates = signals.map((signal) => toIsoDate(signal.upload_date)).filter(Boolean).sort();
  const fromDate = dates[0] ? shiftIsoDate(dates[0], -5) : '';
  const toDate = dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : '';
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: fromDate,
    defaultToDate: toDate || new Date().toISOString().slice(0, 10),
    prefetchConcurrency: 4,
  });
  const symbols = [...new Set(signals.map((signal) => yahooSymbolFor(signal.ticker)).filter(Boolean))];
  console.log(`[sevcik-outcomes] signals=${signals.length} symbols=${symbols.length}`);
  await provider.prefetchTickers(symbols);
  // Do not score a horizon that has not elapsed yet. Using the latest
  // available close as a stand-in for +30d invents a result for streams that
  // are still inside the window.
  const asOfDate = new Date().toISOString().slice(0, 10);
  const outcomes = [];
  for (const signal of signals) {
    const eventDate = toIsoDate(signal.upload_date);
    if (!eventDate) {
      outcomes.push(scoreSignalOutcome(signal, {
        entry: null, week: null, month: null,
        meta: { status: 'missing_event_date' },
      }));
      continue;
    }
    const symbol = yahooSymbolFor(signal.ticker);
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
    outcomes.push(scoreSignalOutcome(signal, {
      entry: finitePrice(entry.price),
      week: finitePrice(week.price),
      month: finitePrice(month.price),
      meta: { status },
    }));
  }
  const summary = summarizeOutcomes(outcomes);
  summary.generated_at = new Date().toISOString();
  summary.horizons = { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS };
  await writeCsv(path.join(OUTPUT_DIR, 'sevcik_outcomes.csv'), OUTCOME_COLUMNS, outcomes.map(serializeOutcome));
  await writeCsv(
    path.join(OUTPUT_DIR, 'sevcik_outcome_ticker_summary.csv'),
    OUTCOME_TICKER_COLUMNS,
    summary.tickers.map((row) => ({
      ticker: row.ticker,
      signals: row.signals,
      scored_1w: row.scored_1w,
      hit_rate_1w: row.hit_rate_1w === null ? '' : row.hit_rate_1w,
      avg_return_1w: row.avg_return_1w === null ? '' : row.avg_return_1w,
      scored_1m: row.scored_1m,
      hit_rate_1m: row.hit_rate_1m === null ? '' : row.hit_rate_1m,
      avg_return_1m: row.avg_return_1m === null ? '' : row.avg_return_1m,
    })),
  );
  const outPayload = { summary, outcomes };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'sevcik_outcomes.json'), JSON.stringify(outPayload, null, 2), 'utf8');
  // Fold into the main dashboard payload when present, so one HTML page can
  // show both the speech and the market check.
  try {
    const main = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
    main.outcomes = outcomes;
    main.outcome_summary = summary;
    fs.writeFileSync(INPUT_JSON, JSON.stringify(main, null, 2), 'utf8');
    const { buildSevcikReportHtml } = require('../src/report/sevcikReport');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'sevcik_report.html'), buildSevcikReportHtml(main), 'utf8');
  } catch (error) {
    console.error(`[sevcik-outcomes] dashboard refresh skipped: ${error.message}`);
  }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[sevcik-outcomes] scored_1w=${summary.scored_1w} hit_rate_1w=${summary.hit_rate_1w}`
      + ` scored_1m=${summary.scored_1m} hit_rate_1m=${summary.hit_rate_1m}`
      + ` missing_prices=${summary.missing_prices}`);
    console.log('[sevcik-outcomes] wrote data/sevcik_outcomes.csv, data/sevcik_outcome_ticker_summary.csv,'
      + ' data/sevcik_outcomes.json and refreshed data/sevcik_report.html');
  }
}
function serializeOutcome(row) {
  return {
    ...row,
    confidence_score: row.confidence_score === null ? '' : row.confidence_score,
    entry_price: row.entry_price === null ? '' : row.entry_price,
    price_1w: row.price_1w === null ? '' : row.price_1w,
    price_1m: row.price_1m === null ? '' : row.price_1m,
    return_1w: row.return_1w === null ? '' : row.return_1w,
    return_1m: row.return_1m === null ? '' : row.return_1m,
    hit_1w: row.hit_1w === null ? '' : (row.hit_1w ? 1 : 0),
    hit_1m: row.hit_1m === null ? '' : (row.hit_1m ? 1 : 0),
  };
}
function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}
main().catch((error) => {
  console.error(`[sevcik-outcomes] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
