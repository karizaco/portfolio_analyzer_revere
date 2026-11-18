'use strict';

/**
 * Score the Komar SETUPS against what the prices did.
 *
 * WHAT THIS STAGE DOES
 *
 * A setup is what the author SAID he was watching, and the trade log
 * is what he DID. This stage asks the question that closes the loop:
 * did the calls work?
 *
 * The scoring is the SHARED one -- `src/sevcik/outcomeAnalysis.js` --
 * the same forward-return machinery the Sevcik, T3Live and Benzinga
 * outcomes use: the return at +7 and +30 calendar days, the SPY
 * baseline over the same window, and the Wilson interval.
 *
 * THE DATE A SETUP IS SCORED FROM
 *
 * The SETUP's video's session date -- the date of the report it was
 * made in. And here is the honest limit: **only 32 of the corpus's 116
 * videos carry a session date** (the rest are the 2023-2024 sessions,
 * whose reports were never dated), so only the setups from those can
 * be scored. The coverage funnel says so rather than counting them as
 * zero.
 *
 * Usage:
 *   node tools/analyzeKomarOutcomes.js --dry-run
 *   node tools/analyzeKomarOutcomes.js --limit 20
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const {
  assessEdge,
  buildSpyBaseline,
  scoreSetupOutcome,
  summarizeOutcomes,
  yahooSymbolFor,
} = require('../src/sevcik/outcomeAnalysis');
const { writeCsv } = require('../src/write/writeCsv');
const { buildKomarReportHtml } = require('../src/report/komarReport');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const OUTPUT_DIR = path.join(ROOT, 'data');

const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  limit: Number(readFlag(argv, '--limit')) || 0,
};

/**
 * A date as YYYY-MM-DD.
 *
 * @param {string} value
 * @returns {string}
 */
function toIsoDate(value) {
  const text = String(value || '');
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

/**
 * A date, shifted by days.
 *
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
function shiftIsoDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The setups, with the date of the report they were made in.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listSetups(db) {
  return db.prepare(`
    SELECT s.*, v.session_date AS video_session_date, v.title AS video_title
    FROM komar_setups s
    LEFT JOIN komar_videos v ON v.video_id = s.video_id
    ORDER BY v.session_date, s.video_id, s.segment_start_index
  `).all();
}

/**
 * The SPY baseline over the same window.
 *
 * The shared one (`src/sevcik/outcomeAnalysis.js`) -- the same baseline
 * the Sevcik, T3Live and Benzinga outcomes are measured against, so
 * the numbers are comparable.
 */
async function komarSpyBaseline(outcomes, provider, settings) {
  return buildSpyBaseline(outcomes, provider, settings);
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  const setups = listSetups(db);
  const dated = setups.filter((setup) => toIsoDate(setup.video_session_date));
  const undated = setups.length - dated.length;

  console.log(`[komar-outcomes] ${setups.length} setups, ${dated.length} with a session date, ${undated} without`);
  if (options.dryRun) {
    console.log('dry run: no prices fetched');
    db.close();
    return;
  }

  const claimPlan = options.limit > 0 ? dated.slice(0, options.limit) : dated;
  const dates = claimPlan.map((setup) => toIsoDate(setup.video_session_date)).sort();
  const fromDate = dates[0] ? shiftIsoDate(dates[0], -5) : '';
  const toDate = dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : '';
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: fromDate,
    defaultToDate: toDate || new Date().toISOString().slice(0, 10),
    prefetchConcurrency: 4,
  });
  const symbols = [...new Set([
    ...claimPlan.map((setup) => yahooSymbolFor(setup.ticker)),
    'SPY',
  ].filter(Boolean))];
  console.log(`[komar-outcomes] scoring ${claimPlan.length} setups over ${symbols.length} symbols`);
  await provider.prefetchTickers(symbols);

  const asOfDate = new Date().toISOString().slice(0, 10);
  const outcomes = [];
  for (const setup of claimPlan) {
    const eventDate = toIsoDate(setup.video_session_date);
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
    outcomes.push(scoreSetupOutcome({
      bias: setup.bias,
      certainty_confidence: setup.confidence_score,
      certainty_level: setup.confidence_label,
      evidence_text: setup.evidence_text,
      ticker: setup.ticker,
      upload_date: eventDate,
      video_id: setup.video_id,
    }, {
      entry: Number.isFinite(entry.price) ? entry.price : null,
      week: Number.isFinite(week.price) ? week.price : null,
      month: Number.isFinite(month.price) ? month.price : null,
      meta: { status },
    }));
  }

  const baseline = await buildSpyBaseline(
    outcomes.filter((row) => row.event_date),
    provider,
    { weekDays: HORIZON_1W_DAYS, monthDays: HORIZON_1M_DAYS, asOfDate }
  );
  const summary = summarizeOutcomes(outcomes, { baseline });
  summary.generated_at = new Date().toISOString();
  summary.horizons = { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS };
  summary.baseline = baseline;
  summary.input_setups = setups.length;
  summary.undated_setups = undated;

  const payload = {
    baseline,
    generated_at: summary.generated_at,
    horizons: summary.horizons,
    outcomes,
    summary,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'komar_outcomes.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeCsv(
    path.join(OUTPUT_DIR, 'komar_outcomes.csv'),
    ['ticker', 'video_id', 'event_date', 'bias', 'confidence_score', 'entry_price', 'price_1w', 'price_1m',
      'return_1w', 'return_1m', 'hit_1w', 'hit_1m', 'price_status', 'evidence_text'],
    outcomes.map((row) => ({
      bias: row.bias,
      confidence_score: row.confidence_score,
      entry_price: row.entry_price,
      evidence_text: row.evidence_text,
      event_date: row.event_date,
      hit_1m: row.hit_1m,
      hit_1w: row.hit_1w,
      price_1m: row.price_1m,
      price_1w: row.price_1w,
      price_status: row.price_status,
      return_1m: row.return_1m,
      return_1w: row.return_1w,
      ticker: row.ticker,
      video_id: row.video_id,
    }))
  );

  const trades = db.prepare('SELECT * FROM komar_trade_log ORDER BY date_opened, row_index').all();
  const cards = db.prepare(`
    SELECT c.*, d.session_date AS session_date
    FROM komar_market_cards c
    LEFT JOIN komar_documents d ON d.doc_id = c.doc_id
    ORDER BY d.session_date
  `).all();
  const readings = db.prepare(`
    SELECT r.*, d.session_date AS doc_date
    FROM komar_summary_readings r
    LEFT JOIN komar_documents d ON d.doc_id = r.doc_id
    ORDER BY d.session_date, r.reading_index
  `).all();
  const videosTotal = db.prepare('SELECT COUNT(*) AS c FROM komar_videos').get().c;
  const videosTranscribed = db.prepare('SELECT COUNT(*) AS c FROM komar_transcripts').get().c;
  const setupsTotal = db.prepare('SELECT COUNT(*) AS c FROM komar_setups').get().c;

  const html = buildKomarReportHtml({
    baseline,
    cards,
    generated_at: summary.generated_at,
    outcomes,
    readings,
    readings_total: readings.length,
    setups_total: setupsTotal,
    summary,
    trades,
    trades_total: trades.length,
    undated_setups: undated,
    videos_total: videosTotal,
    videos_transcribed: videosTranscribed,
    // The watchlist rung of the funnel: the tickers the corpus NAMES,
    // in its summaries and its cards.
    watchlist_tickers: new Set([
      ...readings.filter((row) => row.kind === 'holding').map((row) => row.subject),
      ...db.prepare('SELECT DISTINCT ticker FROM komar_theme_leaders').all().map((row) => row.ticker),
    ]).size,
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'komar_report.html'), html, 'utf8');

  db.close();
  console.log(`[komar-outcomes] ${outcomes.length} scored, ${summary.hit_rate_1w || 0} hit at 1w`);
  console.log(`[komar-outcomes] wrote data/komar_outcomes.json, data/komar_outcomes.csv, data/komar_report.html`);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
