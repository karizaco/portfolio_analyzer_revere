'use strict';

// Aggregate the T3Live trade signals into the report outputs.
//
// HOW THIS DIFFERS FROM aggregateSevcikSignals.js
//
// The Sevcik aggregator produces one row per video and one row per ticker.
// T3Live has MULTIPLE SHOWS, so this aggregator also produces per-show
// breakdowns: the Actionable Swing signals and the 630 Club signals are
// written to their own CSV files so a reader can look at one show without
// filtering the full corpus.
//
// The show classification is computed from the video title at aggregation
// time (see src/t3live/contentFilter.js). No schema change is needed.
//
// WHAT IT WRITES
//
//   data/t3live_signals.csv                    every signal, with show and host
//   data/t3live_daily_summary.csv              one row per video
//   data/t3live_ticker_summary.csv             one row per ticker (all shows)
//   data/t3live_signals_actionable_swings.csv  Sami's Actionable Swing signals
//   data/t3live_signals_630club.csv            Scott's 630 Club signals
//   data/t3live_signals_options_in_play.csv    the Options In Play series
//   data/t3live_signals_morning_call.csv       Morning Call
//   data/t3live_signals_daily_recap.csv        Daily Recap, every host
//   data/t3live_signals.json                   the same, for the dashboard
//
// Usage:
//   node tools/aggregateT3liveSignals.js
//   node tools/aggregateT3liveSignals.js --json

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
const { classifyT3liveVideo, T3LIVE_SHOWS } = require('../src/t3live/contentFilter');
const { T3LIVE_CHANNEL } = require('../src/t3live/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

// Columns for the per-show signal files — same as the full signals file
// but with show and host added at the front so the show is immediately visible.
const T3LIVE_SIGNAL_COLUMNS = ['show', 'host', ...TRADE_SIGNAL_COLUMNS];

const T3LIVE_DAILY_COLUMNS = ['show', 'host', ...TRADE_SIGNAL_DAILY_COLUMNS];

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const signals = loadSignals(db);
  const videos = loadVideos(db);
  db.close();

  const daily = buildDailySummary(signals, videos);
  const tickers = buildTickerSummary(signals);

  // One file per recurring series. The host drawers and "other" stay in the
  // full file; they are not a series.
  const seriesFiles = {};
  for (const show of Object.values(T3LIVE_SHOWS)) {
    if (show === T3LIVE_SHOWS.SCOTT_MISC || show === T3LIVE_SHOWS.SAMI_MISC || show === T3LIVE_SHOWS.OTHER) continue;
    seriesFiles[show] = `t3live_signals_${show}.csv`;
  }
  const byShow = {};
  for (const show of Object.values(T3LIVE_SHOWS)) {
    byShow[show] = signals.filter((s) => s.show === show).length;
  }
  for (const [show, file] of Object.entries(seriesFiles)) {
    await writeCsv(
      path.join(OUTPUT_DIR, file),
      T3LIVE_SIGNAL_COLUMNS,
      signals.filter((s) => s.show === show),
    );
  }

  await writeCsv(path.join(OUTPUT_DIR, 't3live_signals.csv'), T3LIVE_SIGNAL_COLUMNS, signals);
  await writeCsv(path.join(OUTPUT_DIR, 't3live_daily_summary.csv'), T3LIVE_DAILY_COLUMNS, daily);
  await writeCsv(path.join(OUTPUT_DIR, 't3live_ticker_summary.csv'), TRADE_SIGNAL_TICKER_COLUMNS, tickers);

  const payload = {
    generated_at: new Date().toISOString(),
    channel: T3LIVE_CHANNEL,
    signal_count: signals.length,
    video_count: videos.length,
    unique_tickers: tickers.length,
    by_show: byShow,
    signals,
    daily,
    tickers,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 't3live_signals.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );

  // The dashboard reads the same payload, plus the outcome summary when one has
  // been scored. A missing summary is reported as "not scored yet" rather than
  // as zeros, so the two files can be regenerated independently.
  const { renderT3liveReport } = require('../src/report/t3liveReport');
  const outcomesPath = path.join(OUTPUT_DIR, 't3live_outcome_summary.json');
  let outcomes = null;
  if (fs.existsSync(outcomesPath)) {
    try { outcomes = JSON.parse(fs.readFileSync(outcomesPath, 'utf8')); } catch { outcomes = null; }
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 't3live_report.html'),
    renderT3liveReport(payload, outcomes),
    'utf8',
  );

  if (asJson) {
    console.log(JSON.stringify({
      signals: signals.length,
      videos: videos.length,
      tickers: tickers.length,
      by_show: payload.by_show,
    }, null, 2));
  } else {
    console.log(`[t3live-aggregate] ${signals.length} signal(s), ${videos.length} video(s), ${tickers.length} ticker(s)`);
    console.log(`[t3live-aggregate] by show: ${Object.entries(byShow).map(([show, n]) => `${show}=${n}`).join(' ')}`);
  }
}

/**
 * Every signal for the T3Live channel, with the video's date, show, and host.
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
    + "WHERE v.channel = 't3live' "
    + 'ORDER BY v.upload_date DESC, s.event_time_sec ASC, s.ticker ASC',
  ).all();

  return rows.map((row) => {
    const classification = classifyT3liveVideo(row.title || '');
    return {
      show: classification.show,
      host: classification.host,
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
 * All T3Live videos, with show and host classification.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadVideos(db) {
  return db.prepare(
    'SELECT v.video_id, v.upload_date, v.title, t.provider FROM videos v '
    + 'LEFT JOIN video_transcripts t ON t.video_id = v.video_id '
    + "WHERE v.channel = 't3live' ORDER BY v.upload_date DESC",
  ).all().map((row) => {
    const classification = classifyT3liveVideo(row.title || '');
    return {
      video_id: row.video_id,
      upload_date: row.upload_date || '',
      title: row.title || '',
      provider: row.provider || '',
      show: classification.show,
      host: classification.host,
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
        host: signal.host,
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
      host: entry.host || '',
      upload_date: entry.upload_date,
      video_id: entry.video_id,
      title: entry.title,
      provider: entry.provider,
      signal_count: rows.length,
      bullish_count: rows.filter((row) => row.bias === 'bullish').length,
      bearish_count: rows.filter((row) => row.bias === 'bearish').length,
      neutral_count: rows.filter((row) => row.bias === 'neutral').length,
      mixed_count: rows.filter((row) => row.bias === 'mixed').length,
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
  console.error(`[t3live-aggregate] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
