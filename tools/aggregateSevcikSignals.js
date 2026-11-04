'use strict';

// Aggregate the trade signals into the report outputs.
//
// WHAT IT WRITES
//
//   data/sevcik_signals.csv          every signal, with its evidence
//   data/sevcik_daily_summary.csv    one row per stream
//   data/sevcik_ticker_summary.csv   one row per ticker
//   data/sevcik_signals.json         the same, for the dashboard
//   data/sevcik_report.html          the dashboard
//
// The three rollups answer three different questions, and none of them
// answers another's:
//
//   per signal   what exactly was said, and about which ticker
//   per stream   what did this one video say
//   per ticker   what does this source think about this name, over time
//
// The per-ticker rollup is the one the dashboard leads with, because the
// question it answers -- "what has Sevcik been saying about TQQQ?" -- is
// the question a reader of this data actually has.
//
// Usage:
//   node tools/aggregateSevcikSignals.js
//   node tools/aggregateSevcikSignals.js --json

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
const { buildSevcikReportHtml } = require('../src/report/sevcikReport');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

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

  await writeCsv(path.join(OUTPUT_DIR, 'sevcik_signals.csv'), TRADE_SIGNAL_COLUMNS, signals);
  await writeCsv(path.join(OUTPUT_DIR, 'sevcik_daily_summary.csv'), TRADE_SIGNAL_DAILY_COLUMNS, daily);
  await writeCsv(path.join(OUTPUT_DIR, 'sevcik_ticker_summary.csv'), TRADE_SIGNAL_TICKER_COLUMNS, tickers);

  const payload = {
    generated_at: new Date().toISOString(),
    signal_count: signals.length,
    video_count: videos.length,
    unique_tickers: tickers.length,
    signals,
    daily,
    tickers,
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'sevcik_signals.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'sevcik_report.html'),
    buildSevcikReportHtml(payload),
    'utf8',
  );

  if (asJson) {
    console.log(JSON.stringify({
      signal_count: payload.signal_count,
      video_count: payload.video_count,
      unique_tickers: payload.unique_tickers,
      top_tickers: tickers.slice(0, 10).map((row) => row.ticker),
    }, null, 2));
  } else {
    console.log(`[sevcik-aggregate] ${signals.length} signal(s) across ${videos.length} video(s),`
      + ` ${tickers.length} ticker(s)`);
    console.log('[sevcik-aggregate] wrote data/sevcik_signals.csv, data/sevcik_daily_summary.csv,'
      + ' data/sevcik_ticker_summary.csv, data/sevcik_signals.json, data/sevcik_report.html');
  }
}

/**
 * Every signal, with the video's date and the transcript's provider.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadSignals(db) {
  const rows = db.prepare(
    'SELECT s.video_id, v.upload_date, t.provider, s.event_time_sec, s.ticker, s.action, s.bias, '
    + 's.confidence_label, s.confidence_score, s.entry_price, s.target_price_low, s.target_price_high, '
    + 's.stop_price, s.horizon_text, s.rationale, s.evidence_text, s.parser_version '
    + 'FROM trade_signals s '
    + 'LEFT JOIN videos v ON v.video_id = s.video_id '
    + 'LEFT JOIN video_transcripts t ON t.video_id = s.video_id '
    + 'ORDER BY v.upload_date DESC, s.event_time_sec ASC, s.ticker ASC',
  ).all();

  return rows.map((row) => ({
    video_id: row.video_id,
    upload_date: row.upload_date || '',
    provider: row.provider || '',
    event_time_sec: row.event_time_sec === null ? '' : row.event_time_sec,
    ticker: row.ticker,
    action: row.action || '',
    bias: row.bias,
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
  }));
}

/**
 * The videos the signals came from.
 *
 * @param {DatabaseSync} db
 * @returns {Array<{video_id: string, upload_date: string, title: string, provider: string}>}
 */
function loadVideos(db) {
  return db.prepare(
    'SELECT v.video_id, v.upload_date, v.title, t.provider FROM videos v '
    + 'LEFT JOIN video_transcripts t ON t.video_id = v.video_id '
    + "WHERE v.channel = 'davidsevcik' ORDER BY v.upload_date DESC",
  ).all().map((row) => ({
    video_id: row.video_id,
    upload_date: row.upload_date || '',
    title: row.title || '',
    provider: row.provider || '',
  }));
}

/**
 * One row per stream.
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
 * One row per ticker.
 *
 * @param {Array<object>} signals
 * @returns {Array<object>}
 */
function buildTickerSummary(signals) {
  const byTicker = new Map();
  for (const signal of signals) {
    if (!byTicker.has(signal.ticker)) byTicker.set(signal.ticker, []);
    byTicker.get(signal.ticker).push(signal);
  }

  const rows = [];
  for (const [ticker, group] of byTicker) {
    const confidences = group
      .map((row) => Number(row.confidence_score))
      .filter((value) => Number.isFinite(value));
    const entries = group
      .map((row) => Number(row.entry_price))
      .filter((value) => Number.isFinite(value) && value > 0);
    const targets = group
      .map((row) => Number(row.target_price_low))
      .filter((value) => Number.isFinite(value) && value > 0);
    const bullish = group.filter((row) => row.bias === 'bullish').length;
    const bearish = group.filter((row) => row.bias === 'bearish').length;
    const dates = group.map((row) => row.upload_date).filter(Boolean).sort();

    rows.push({
      ticker,
      signal_count: group.length,
      bullish_count: bullish,
      bearish_count: bearish,
      neutral_count: group.filter((row) => row.bias === 'neutral').length,
      mixed_count: group.filter((row) => row.bias === 'mixed').length,
      video_count: new Set(group.map((row) => row.video_id)).size,
      first_date: dates[0] || '',
      last_date: dates[dates.length - 1] || '',
      avg_confidence: confidences.length
        ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(3))
        : '',
      max_confidence: confidences.length ? Number(Math.max(...confidences).toFixed(3)) : '',
      high_confidence_count: group.filter((row) => row.confidence_label === 'high').length,
      signals_with_entry: entries.length,
      signals_with_target: targets.length,
      avg_entry_price: entries.length
        ? Number((entries.reduce((sum, value) => sum + value, 0) / entries.length).toFixed(2))
        : '',
      avg_target_price: targets.length
        ? Number((targets.reduce((sum, value) => sum + value, 0) / targets.length).toFixed(2))
        : '',
      bullish_ratio: bullish + bearish > 0
        ? Number((bullish / (bullish + bearish)).toFixed(3))
        : '',
    });
  }

  // The most-mentioned names first: that is the order a reader wants.
  rows.sort((a, b) => b.signal_count - a.signal_count
    || String(a.ticker).localeCompare(String(b.ticker)));
  return rows;
}

main().catch((error) => {
  console.error(`[sevcik-aggregate] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
