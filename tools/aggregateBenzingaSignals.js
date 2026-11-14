'use strict';

// Aggregate the Benzinga trade signals into the report outputs.
//
// HOW THIS DIFFERS FROM aggregateT3liveSignals.js
//
// Three things are Benzinga's own:
//
//   1. THE SHOW. The daily PreMarket Playbook, The Drift, the setup clips
//      and the long-form commentary are different things, and they are
//      scored separately -- a weekly options show and a daily pre-market
//      show sit on different calendars.
//
//   2. THE PARTNER. "PreMarket Playbook + T3 Live" episodes feature people
//      whose calls are ALSO in the t3live corpus, so those rows are not
//      independent of it. The partner is reported so the outcome analysis
//      can split by it.
//
//   3. THE SECTION. A claim in a recap of what already happened is not a
//      prediction, and a sponsor's segment is not a call at all.
//
// WHAT IT WRITES
//
//   data/benzinga_signals.csv                  every signal, with show, partner, section
//   data/benzinga_daily_summary.csv            one row per video
//   data/benzinga_ticker_summary.csv           one row per ticker
//   data/benzinga_signals_<show>.csv           one file per show
//   data/benzinga_readings.csv                 the market and sector readings
//   data/benzinga_signals.json                 the same, for the dashboard
//
// Usage:
//   node tools/aggregateBenzingaSignals.js
//   node tools/aggregateBenzingaSignals.js --json

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  TRADE_SIGNAL_COLUMNS,
  TRADE_SIGNAL_DAILY_COLUMNS,
  TRADE_SIGNAL_TICKER_COLUMNS,
} = require('../src/config/schema');
const { writeCsv } = require('../src/write/writeCsv');
const { classifyBenzingaVideo, BENZINGA_SHOWS } = require('../src/benzinga/contentFilter');
const { BENZINGA_CHANNEL } = require('../src/benzinga/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

// The show and the partner come first, so a reader sees which show a row
// is from without scrolling.
const BENZINGA_SIGNAL_COLUMNS = ['show', 'partner', 'section', ...TRADE_SIGNAL_COLUMNS];
const BENZINGA_DAILY_COLUMNS = ['show', 'partner', ...TRADE_SIGNAL_DAILY_COLUMNS];

const READING_COLUMNS = [
  'video_id', 'upload_date', 'show', 'scope', 'subject', 'proxy_ticker', 'stance',
  'claim_kind', 'section', 'horizon_text', 'event_date', 'evidence_text', 'parser_version',
];

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const videos = loadVideos(db);
  const signals = loadSignals(db);
  const readings = loadReadings(db);
  db.close();

  const daily = buildDailySummary(signals, videos);
  const tickers = buildTickerSummary(signals);

  // One file per show that is a real show. "other" is not one.
  const seriesFiles = {};
  for (const show of Object.values(BENZINGA_SHOWS)) {
    if (show === BENZINGA_SHOWS.OTHER) continue;
    seriesFiles[show] = `benzinga_signals_${show}.csv`;
  }
  const byShow = {};
  for (const show of Object.values(BENZINGA_SHOWS)) {
    byShow[show] = signals.filter((s) => s.show === show).length;
  }
  for (const [show, file] of Object.entries(seriesFiles)) {
    await writeCsv(
      path.join(OUTPUT_DIR, file),
      BENZINGA_SIGNAL_COLUMNS,
      signals.filter((s) => s.show === show),
    );
  }

  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_signals.csv'), BENZINGA_SIGNAL_COLUMNS, signals);
  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_daily_summary.csv'), BENZINGA_DAILY_COLUMNS, daily);
  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_ticker_summary.csv'), TRADE_SIGNAL_TICKER_COLUMNS, tickers);
  await writeCsv(path.join(OUTPUT_DIR, 'benzinga_readings.csv'), READING_COLUMNS, readings);

  const payload = {
    generated_at: new Date().toISOString(),
    channel: BENZINGA_CHANNEL,
    source: {
      id: 'benzinga',
      label: 'Benzinga',
      updatedAt: new Date().toISOString(),
      description: 'Video coverage, spoken market commentary, ticker calls, and source evidence.',
      capabilities: ['video', 'captions', 'transcripts', 'signals', 'market readings'],
      accent: '#a6492d',
    },
    signal_count: signals.length,
    video_count: videos.length,
    reading_count: readings.length,
    unique_tickers: tickers.length,
    by_show: byShow,
    signals,
    daily,
    tickers,
    readings,
    coverage: buildSourceCoverage(videos, signals, readings),
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'benzinga_signals.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );

  // The dashboard reads the same payload, plus the outcome summary when
  // one has been scored. A missing summary is reported as "not scored
  // yet" rather than as zeros.
  const { renderBenzingaReport } = require('../src/report/benzingaReport');
  const outcomesPath = path.join(OUTPUT_DIR, 'benzinga_outcome_summary.json');
  let outcomes = null;
  if (fs.existsSync(outcomesPath)) {
    try { outcomes = JSON.parse(fs.readFileSync(outcomesPath, 'utf8')); } catch { outcomes = null; }
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'benzinga_report.html'),
    renderBenzingaReport(payload, outcomes),
    'utf8',
  );

  if (asJson) {
    console.log(JSON.stringify({
      signals: signals.length,
      videos: videos.length,
      readings: readings.length,
      tickers: tickers.length,
      by_show: payload.by_show,
    }, null, 2));
  } else {
    console.log(`[benzinga-aggregate] ${signals.length} signal(s), ${readings.length} reading(s), `
      + `${videos.length} video(s), ${tickers.length} ticker(s)`);
    console.log(`[benzinga-aggregate] by show: ${Object.entries(byShow).map(([show, n]) => `${show}=${n}`).join(' ')}`);
  }
}

function buildSourceCoverage(videos, signals, readings) {
  const eligibleShows = new Set(['premarket_playbook', 'the_drift', 'stock_in_play', 'explainer']);
  const eligible = videos.filter((video) => eligibleShows.has(video.show));
  const transcribed = eligible.filter((video) => Boolean(video.provider)).length;
  return [
    { stage: 'catalogued', count: videos.length, denominator: videos.length, status: 'complete' },
    { stage: 'call-bearing shows', count: eligible.length, denominator: videos.length, status: 'complete', reason: 'Show taxonomy applied' },
    { stage: 'transcribed', count: transcribed, denominator: eligible.length, status: transcribed ? 'partial' : 'not_started' },
    { stage: 'signals extracted', count: signals.length, denominator: transcribed, status: signals.length ? 'partial' : 'not_started' },
    { stage: 'market readings', count: readings.length, denominator: transcribed, status: readings.length ? 'partial' : 'not_started' },
    { stage: 'outcomes scored', count: null, denominator: signals.length, status: 'unknown', reason: 'Outcome scoring is an optional separate run' },
  ];
}

/**
 * The listing facts of a video, so the show can be classified the same way
 * everywhere.
 *
 * @param {DatabaseSync} db
 * @param {string} videoId
 * @returns {{duration_sec: number|null, live_status: string, listing_kind: string}}
 */
function listingFacts(db, videoId) {
  const rows = db.prepare(
    'SELECT duration_sec, live_status, listing_kind FROM video_listing_entries WHERE video_id = ?',
  ).all(videoId);
  let duration = null;
  let liveStatus = '';
  let listingKind = '';
  for (const row of rows) {
    const value = row.duration_sec === null ? null : Number(row.duration_sec);
    if (value !== null && (duration === null || value > duration)) duration = value;
    if (row.live_status && row.live_status !== 'NA') liveStatus = row.live_status;
    if (row.listing_kind && row.listing_kind !== 'shorts') listingKind = row.listing_kind;
  }
  return { duration_sec: duration, live_status: liveStatus, listing_kind: listingKind };
}

/**
 * Every Benzinga video, with its show and partner.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadVideos(db) {
  const rows = db.prepare(
    'SELECT v.video_id, v.upload_date, v.title, t.provider FROM videos v '
    + 'LEFT JOIN video_transcripts t ON t.video_id = v.video_id '
    + "WHERE v.channel = 'benzinga' ORDER BY v.upload_date DESC",
  ).all();
  return rows.map((row) => {
    const facts = listingFacts(db, row.video_id);
    const classification = classifyBenzingaVideo({ title: row.title || '', ...facts });
    return {
      video_id: row.video_id,
      upload_date: row.upload_date || '',
      title: row.title || '',
      provider: row.provider || '',
      show: classification.show,
      partner: classification.partner,
    };
  });
}

/**
 * Every Benzinga signal, with its video's date, show, partner and section.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadSignals(db) {
  const rows = db.prepare(
    'SELECT s.video_id, v.upload_date, v.title, t.provider, s.event_time_sec, s.ticker, s.action, s.bias, '
    + 's.claim_kind, s.confidence_label, s.confidence_score, s.entry_price, s.target_price_low, s.target_price_high, '
    + 's.stop_price, s.horizon_text, s.rationale, s.evidence_text, s.parser_version '
    + 'FROM trade_signals s '
    + 'LEFT JOIN videos v ON v.video_id = s.video_id '
    + 'LEFT JOIN video_transcripts t ON t.video_id = s.video_id '
    + "WHERE v.channel = 'benzinga' "
    + 'ORDER BY v.upload_date DESC, s.event_time_sec ASC, s.ticker ASC',
  ).all();

  return rows.map((row) => {
    const facts = listingFacts(db, row.video_id);
    const classification = classifyBenzingaVideo({ title: row.title || '', ...facts });
    return {
      show: classification.show,
      partner: classification.partner,
      // The section is not stored on the signal row -- it is derived from
      // the transcript, which the aggregator does not read. The evidence
      // text carries the claim; the section is recomputed by the
      // extractor, and the row's own copy is used here when it has one.
      section: row.section || '',
      video_id: row.video_id,
      upload_date: row.upload_date || '',
      provider: row.provider || '',
      event_time_sec: row.event_time_sec === null ? '' : row.event_time_sec,
      ticker: row.ticker,
      action: row.action || '',
      bias: row.bias,
      claim_kind: row.claim_kind || 'forward',
      confidence_label: row.confidence_label || '',
      confidence_score: row.confidence_score === null ? '' : row.confidence_score,
      entry_price: row.entry_price === null ? '' : row.entry_price,
      target_price_low: row.target_price_low === null ? '' : row.target_price_low,
      target_price_high: row.target_price_high === null ? '' : row.target_price_high,
      stop_price: row.stop_price === null ? '' : row.stop_price,
      horizon_text: row.horizon_text || '',
      rationale: row.rationale || '',
      evidence_text: row.evidence_text || '',
      parser_version: row.parser_version || '',
    };
  });
}

/**
 * The market, sector and event readings.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadReadings(db) {
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='market_readings'",
  ).get();
  if (!hasTable) return [];
  const rows = db.prepare(
    'SELECT r.video_id, v.upload_date, v.title, r.scope, r.subject, r.proxy_ticker, r.stance, '
    + 'r.claim_kind, r.section, r.horizon_text, r.event_date, r.evidence_text, r.parser_version '
    + "FROM market_readings r LEFT JOIN videos v ON v.video_id = r.video_id "
    + "WHERE v.channel = 'benzinga' ORDER BY v.upload_date DESC, r.scope, r.subject",
  ).all();
  return rows.map((row) => {
    const facts = listingFacts(db, row.video_id);
    const classification = classifyBenzingaVideo({ title: row.title || '', ...facts });
    return {
      video_id: row.video_id,
      upload_date: row.upload_date || '',
      show: classification.show,
      scope: row.scope,
      subject: row.subject,
      proxy_ticker: row.proxy_ticker,
      stance: row.stance,
      claim_kind: row.claim_kind,
      section: row.section || '',
      horizon_text: row.horizon_text || '',
      event_date: row.event_date || '',
      evidence_text: row.evidence_text || '',
      parser_version: row.parser_version || '',
    };
  });
}

/**
 * One row per video.
 *
 * @param {Array<object>} signals
 * @param {Array<object>} videos
 * @returns {Array<object>}
 */
function buildDailySummary(signals, videos) {
  const byVideo = new Map();
  for (const video of videos) {
    byVideo.set(video.video_id, { ...video, signals: [] });
  }
  for (const signal of signals) {
    if (!byVideo.has(signal.video_id)) {
      byVideo.set(signal.video_id, {
        video_id: signal.video_id,
        upload_date: signal.upload_date,
        title: '',
        provider: signal.provider,
        show: signal.show,
        partner: signal.partner,
        signals: [],
      });
    }
    byVideo.get(signal.video_id).signals.push(signal);
  }

  return [...byVideo.values()].map((entry) => {
    const rows = entry.signals;
    const confidences = rows
      .map((row) => Number(row.confidence_score))
      .filter((value) => Number.isFinite(value));
    const tickers = [...new Set(rows.map((row) => row.ticker))].sort();
    return {
      show: entry.show || '',
      partner: entry.partner || '',
      upload_date: entry.upload_date,
      video_id: entry.video_id,
      title: entry.title,
      provider: entry.provider,
      signal_count: rows.length,
      bullish_count: rows.filter((row) => row.bias === 'bullish').length,
      bearish_count: rows.filter((row) => row.bias === 'bearish').length,
      neutral_count: rows.filter((row) => row.bias === 'neutral').length,
      mixed_count: rows.filter((row) => row.bias === 'mixed').length,
      forward_count: rows.filter((row) => row.claim_kind === 'forward').length,
      reported_count: rows.filter((row) => row.claim_kind === 'reported').length,
      retrospective_count: rows.filter((row) => row.claim_kind === 'retrospective').length,
      unique_tickers: tickers.length,
      avg_confidence: confidences.length
        ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(3))
        : '',
      high_confidence_count: rows.filter((row) => row.confidence_label === 'high').length,
      signals_with_entry: rows.filter((row) => row.entry_price !== '' && row.entry_price !== null).length,
      signals_with_target: rows.filter((row) => row.target_price_low !== '' && row.target_price_low !== null).length,
      tickers: tickers.join(' '),
    };
  });
}

/**
 * One row per ticker, across all shows.
 *
 * @param {Array<object>} signals
 * @returns {Array<object>}
 */
function buildTickerSummary(signals) {
  const byTicker = new Map();
  for (const signal of signals) {
    if (!byTicker.has(signal.ticker)) {
      byTicker.set(signal.ticker, []);
    }
    byTicker.get(signal.ticker).push(signal);
  }

  return [...byTicker.entries()]
    .map(([ticker, rows]) => {
      const confidences = rows
        .map((row) => Number(row.confidence_score))
        .filter((value) => Number.isFinite(value));
      const entries = rows
        .map((row) => Number(row.entry_price))
        .filter((value) => Number.isFinite(value));
      const targets = rows
        .map((row) => Number(row.target_price_low))
        .filter((value) => Number.isFinite(value));
      const dates = rows.map((row) => row.upload_date).filter(Boolean).sort();
      const bullish = rows.filter((row) => row.bias === 'bullish').length;
      const total = rows.length;
      return {
        ticker,
        signal_count: total,
        bullish_count: bullish,
        bearish_count: rows.filter((row) => row.bias === 'bearish').length,
        neutral_count: rows.filter((row) => row.bias === 'neutral').length,
        mixed_count: rows.filter((row) => row.bias === 'mixed').length,
        forward_count: rows.filter((row) => row.claim_kind === 'forward').length,
        reported_count: rows.filter((row) => row.claim_kind === 'reported').length,
        video_count: new Set(rows.map((row) => row.video_id)).size,
        first_date: dates[0] || '',
        last_date: dates[dates.length - 1] || '',
        avg_confidence: confidences.length
          ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(3))
          : '',
        max_confidence: confidences.length ? Math.max(...confidences) : '',
        high_confidence_count: rows.filter((row) => row.confidence_label === 'high').length,
        signals_with_entry: entries.length,
        signals_with_target: targets.length,
        avg_entry_price: entries.length
          ? Number((entries.reduce((sum, value) => sum + value, 0) / entries.length).toFixed(2))
          : '',
        avg_target_price: targets.length
          ? Number((targets.reduce((sum, value) => sum + value, 0) / targets.length).toFixed(2))
          : '',
        bullish_ratio: total ? Number((bullish / total).toFixed(3)) : '',
      };
    })
    .sort((a, b) => b.signal_count - a.signal_count);
}

main().catch((error) => {
  console.error(`[benzinga-aggregate] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
