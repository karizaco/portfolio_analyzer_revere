'use strict';

/**
 * Score the O'Connell setups against what the price did next.
 *
 * The bookkeeping is `src/sevcik/outcomeAnalysis.js` -- the same
 * returns, the same hits, the same SPY baseline, the same Wilson
 * interval -- with four differences that matter here.
 *
 *   1. ONLY A SETUP THAT STATES A DIRECTION IS SCORED. A setup with no
 *      direction is a WATCH, not a call: "AVGO → 200D SMA Reclaim" says
 *      what he is watching and not what he thinks will happen, and
 *      scoring it as a long would be measuring the author's silence.
 *      The setups with no direction are counted and reported as
 *      unscored, not quietly dropped.
 *
 *   2. THE EVENT DATE IS THE SESSION THE ISSUE COVERS, NOT THE DAY
 *      THE PDF WAS PRINTED. The corpus is a set of print-to-PDF renders,
 *      and the print timestamp is months later for some of them -- the
 *      20240108 issue was printed on 29 March 2025. The filename's date
 *      is the session the issue analyses, and that is the date the
 *      entry is taken from.
 *
 *   3. THE ENTRY IS THE CLOSE OF THAT SESSION. The newsletter reaches
 *      the reader the MORNING AFTER the session it analyses, so the
 *      close of the session it covers is the last price before the
 *      call was made. Measuring from there leaves the analysed session
 *      itself out of the measured return, which is the conservative
 *      choice.
 *
 *   4. THE EVIDENCE IS THE THESIS. The setup's `evidence_text` is his
 *      own words, so the scored row can be checked against the words it
 *      came from.
 *
 * Horizons: +7 and +30 calendar days. A setup whose horizon has not
 * elapsed yet is left unscored, never guessed.
 *
 * Usage:
 *   node tools/analyzeOconnellOutcomes.js
 *   node tools/analyzeOconnellOutcomes.js --json
 */

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

const ROOT = path.resolve(__dirname, '..');
const INPUT_JSON = path.join(ROOT, 'data', 'oconnell_signals.json');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const OUTCOME_COLUMNS = [
  'doc_id', 'source_date', 'event_date', 'ticker', 'yahoo_symbol', 'bias',
  'setup_label', 'setup_kind', 'direction', 'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];

const OUTCOME_TICKER_COLUMNS = [
  'ticker', 'setups', 'scored_1w', 'hit_rate_1w', 'avg_return_1w',
  'avg_aligned_return_1w', 'scored_1m', 'hit_rate_1m', 'avg_return_1m',
];

const argv = process.argv.slice(2);
const options = { json: argv.includes('--json') };

/**
 * The bias a setup's direction implies.
 *
 * @param {string} direction
 * @returns {string} 'bullish', 'bearish' or ''
 */
function biasFor(direction) {
  if (direction === 'long') return 'bullish';
  if (direction === 'short') return 'bearish';
  return '';
}

function finitePrice(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`No ${INPUT_JSON}. Run node tools/aggregateOconnellSignals.js first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));

  const setups = payload.setups || [];
  const scorable = setups.filter((setup) => biasFor(setup.direction));
  const unscored = setups.filter((setup) => !biasFor(setup.direction));

  const dates = scorable.map((setup) => toIsoDate(setup.source_date)).filter(Boolean).sort();
  const asOfDate = new Date().toISOString().slice(0, 10);
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: dates[0] ? shiftIsoDate(dates[0], -5) : '',
    defaultToDate: dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : asOfDate,
    prefetchConcurrency: 2,
  });

  const symbols = [...new Set([
    ...scorable.map((setup) => yahooSymbolFor(setup.ticker)), 'SPY',
  ].filter(Boolean))];
  console.log(`[oconnell-outcomes] setups=${setups.length} scorable=${scorable.length}`
    + ` without_a_direction=${unscored.length} symbols=${symbols.length}`);
  await provider.prefetchTickers(symbols);

  const outcomes = [];
  for (const setup of scorable) {
    const eventDate = toIsoDate(setup.source_date);
    let prices;
    if (!eventDate) {
      prices = { entry: null, week: null, month: null, meta: { status: 'missing_event_date' } };
    } else {
      const symbol = yahooSymbolFor(setup.ticker);
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
        month: finitePrice(month.price),
        meta: { status },
        week: finitePrice(week.price),
      };
    }

    const scored = scoreSignalOutcome({
      action: 'buy',
      bias: biasFor(setup.direction),
      claim_kind: setup.claim_kind || 'forward',
      evidence_text: setup.evidence_text || setup.thesis || '',
      source: 'oconnell',
      ticker: setup.ticker,
      upload_date: setup.source_date,
      video_id: setup.doc_id,
    }, prices);

    outcomes.push({
      ...scored,
      direction: setup.direction,
      doc_id: setup.doc_id,
      setup_kind: setup.setup_kind || '',
      setup_label: setup.setup_label || '',
      source_date: setup.source_date,
    });
  }

  const horizons = { asOfDate, monthDays: HORIZON_1M_DAYS, weekDays: HORIZON_1W_DAYS };
  const baseline = await buildSpyBaseline(outcomes.filter((row) => row.event_date), provider, horizons);
  const overall = summarizeOutcomes(outcomes, { baseline });

  const byDirection = {};
  for (const direction of ['long', 'short']) {
    const subset = outcomes.filter((row) => row.direction === direction);
    if (!subset.length) continue;
    const subsetBaseline = await buildSpyBaseline(
      subset.filter((row) => row.event_date), provider, horizons
    );
    byDirection[direction] = summarizeOutcomes(subset, { baseline: subsetBaseline });
  }

  const summary = {
    as_of_date: asOfDate,
    by_direction: byDirection,
    entry_rule: 'close of the session the issue covers; the newsletter reaches the reader the next morning',
    generated_at: new Date().toISOString(),
    horizons: { '1m_days': HORIZON_1M_DAYS, '1w_days': HORIZON_1W_DAYS },
    overall: { ...overall, tickers: undefined, by_source: undefined },
    setups: setups.length,
    setups_scored: scorable.length,
    setups_without_a_direction: unscored.length,
    tickers: overall.tickers || [],
  };

  await writeCsv(path.join(OUTPUT_DIR, 'oconnell_outcomes.csv'), OUTCOME_COLUMNS,
    outcomes.map((row) => ({
      aligned_return_1m: row.aligned_return_1m === null ? '' : row.aligned_return_1m,
      aligned_return_1w: row.aligned_return_1w === null ? '' : row.aligned_return_1w,
      bias: row.bias,
      direction: row.direction,
      doc_id: row.doc_id,
      entry_price: row.entry_price === null ? '' : row.entry_price,
      evidence_text: row.evidence_text,
      event_date: row.event_date,
      hit_1m: row.hit_1m === null ? '' : row.hit_1m,
      hit_1w: row.hit_1w === null ? '' : row.hit_1w,
      price_1m: row.price_1m === null ? '' : row.price_1m,
      price_1w: row.price_1w === null ? '' : row.price_1w,
      price_status: row.price_status,
      return_1m: row.return_1m === null ? '' : row.return_1m,
      return_1w: row.return_1w === null ? '' : row.return_1w,
      setup_kind: row.setup_kind,
      setup_label: row.setup_label,
      source_date: row.source_date,
      ticker: row.ticker,
      yahoo_symbol: row.yahoo_symbol,
    })));

  await writeCsv(path.join(OUTPUT_DIR, 'oconnell_outcome_ticker_summary.csv'), OUTCOME_TICKER_COLUMNS,
    (overall.tickers || []).map((row) => ({
      avg_aligned_return_1w: row.avg_aligned_return_1w === null ? '' : row.avg_aligned_return_1w,
      avg_return_1w: row.avg_return_1w === null ? '' : row.avg_return_1w,
      hit_rate_1w: row.hit_rate_1w === null ? '' : row.hit_rate_1w,
      scored_1m: row.scored_1m,
      scored_1w: row.scored_1w,
      setups: row.signals,
      ticker: row.ticker,
    })));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'oconnell_outcomes.json'),
    `${JSON.stringify({ rows: outcomes, summary }, null, 2)}\n`,
    'utf8'
  );

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const line = (label, summaryRow) => {
    console.log(`[oconnell-outcomes] ${label.padEnd(18)} scored=${String(summaryRow.claim_count).padStart(4)}`
      + ` | 1w n=${summaryRow.scored_1w} hit=${summaryRow.hit_rate_1w}`
      + ` | 1m n=${summaryRow.scored_1m} hit=${summaryRow.hit_rate_1m}`);
  };
  line('overall', overall);
  for (const [direction, summaryRow] of Object.entries(byDirection)) line(`direction:${direction}`, summaryRow);
  console.log('[oconnell-outcomes] wrote data/oconnell_outcomes.csv, '
    + 'data/oconnell_outcome_ticker_summary.csv, data/oconnell_outcomes.json');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = { biasFor };
