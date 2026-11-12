'use strict';

// Aggregate the AsymTrading readings into the report outputs.
//
// WHAT IT AGGREGATES, AND WHY THERE ARE TWO KINDS OF THING
//
// This source produces two different kinds of reading, and they are kept
// apart on purpose:
//
//   1. THE ARTICLE. Every free post is a written Market Pulse -- a market
//      recap, a sector analysis and a plan for the week ahead. Those
//      readings live in `asym_articles`, and they are the reason the
//      source is worth reading at all.
//
//   2. THE SIGNALS. The spoken part of the video is transcribed and run
//      through the shared extraction engine, so the ticker calls live in
//      `trade_signals` with a video_id of `asym_<post_id>`.
//
// The two are reported side by side because they answer different
// questions. The article says what the market did; the signals say what
// to do about a name.
//
// WHY THE SIGNALS ARE FILTERED ON asym_posts AND NOT ON videos
//
// Every other aggregator in the project filters with
// `WHERE v.channel = '...'` over a LEFT JOIN on `videos`. A Substack post
// has no `videos` row -- the project keeps the two catalogs apart -- so
// that filter cannot be used here. The equivalent filter is a join to
// `asym_posts`, which is exactly what this tool does.
//
// The other direction is safe too: the Sevcik and T3Live aggregators
// filter on `videos.channel`, and an AsymTrading signal has no `videos`
// row, so `v.channel` is NULL and the row is excluded. Measured, not
// assumed -- see `test/asymPipeline.test.js`.
//
// WHAT IT WRITES
//
//   data/asym_articles.csv        the market readings, one row per post
//   data/asym_signals.csv         every ticker call
//   data/asym_daily_summary.csv   one row per post
//   data/asym_ticker_summary.csv  one row per ticker
//   data/asym_signals.json        the same, for the dashboard
//   data/asym_report.html         the dashboard
//
// Usage:
//   node tools/aggregateAsymSignals.js
//   node tools/aggregateAsymSignals.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  TRADE_SIGNAL_COLUMNS,
  TRADE_SIGNAL_DAILY_COLUMNS,
  TRADE_SIGNAL_TICKER_COLUMNS,
} = require('../src/config/schema');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

/** The extra column that says which series a post belongs to. */
const ASYM_SIGNAL_COLUMNS = ['series', ...TRADE_SIGNAL_COLUMNS];
const ASYM_DAILY_COLUMNS = ['series', ...TRADE_SIGNAL_DAILY_COLUMNS];

/** The columns of the article file -- the market readings. */
const ARTICLE_COLUMNS = [
  'upload_date', 'video_id', 'series', 'title', 'has_media', 'word_count',
  'backdrop', 'trend', 'breadth', 'momentum',
  'cap_sizes', 'sectors', 'plan_sections', 'scenarios', 'bottom_line', 'index_tickers',
];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');


/**
 * The article-vs-table consistency rows, when they have been computed.
 *
 * @returns {Array<object>}
 */
function loadSectorConsistency() {
  const file = path.join(OUTPUT_DIR, 'asym_sector_consistency.csv');
  if (!fs.existsSync(file)) return [];
  // Prefer the JSON companion when present -- it carries typed numbers.
  const jsonPath = path.join(OUTPUT_DIR, 'asym_sectors.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const body = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return Array.isArray(body.consistency) ? body.consistency : [];
    } catch { /* fall through */ }
  }
  return [];
}

/**
 * The on-screen sector rows, when they have been parsed.
 *
 * @returns {Array<object>}
 */
function loadSectors() {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      return db.prepare('SELECT video_id, sector, roc_1mo, pct_change, sign_source FROM asym_sectors ORDER BY video_id, roc_1mo DESC').all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const signals = loadSignals(db);
  const posts = loadPosts(db);
  const articles = loadArticles(db);
  db.close();

  const daily = buildDailySummary(signals, posts, articles);
  const tickers = buildTickerSummary(signals);

  await writeCsv(path.join(OUTPUT_DIR, 'asym_signals.csv'), ASYM_SIGNAL_COLUMNS, signals);
  await writeCsv(path.join(OUTPUT_DIR, 'asym_daily_summary.csv'), ASYM_DAILY_COLUMNS, daily);
  await writeCsv(path.join(OUTPUT_DIR, 'asym_ticker_summary.csv'), TRADE_SIGNAL_TICKER_COLUMNS, tickers);
  await writeCsv(path.join(OUTPUT_DIR, 'asym_articles.csv'), ARTICLE_COLUMNS, articles);

  const payload = {
    generated_at: new Date().toISOString(),
    channel: 'asymtrading',
    coverage: loadCoverage(),
    signal_count: signals.length,
    post_count: posts.length,
    article_count: articles.length,
    unique_tickers: tickers.length,
    signals,
    daily,
    tickers,
    articles,
    sector_consistency: loadSectorConsistency(),
    sectors: loadSectors(),
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'asym_signals.json'),
    JSON.stringify(payload, null, 2),
    'utf8',
  );

  // The outcome summary is OPTIONAL, exactly as in the T3Live aggregator:
  // a dashboard built before the outcomes have been scored says so rather
  // than showing zeros.
  const { renderAsymReport } = require('../src/report/asymReport');
  const outcomesPath = path.join(OUTPUT_DIR, 'asym_outcome_summary.json');
  let outcomes = null;
  if (fs.existsSync(outcomesPath)) {
    try { outcomes = JSON.parse(fs.readFileSync(outcomesPath, 'utf8')); } catch { outcomes = null; }
  }
  const sectorOutcomesPath = path.join(OUTPUT_DIR, 'asym_sector_outcome_summary.json');
  let sectorOutcomes = null;
  if (fs.existsSync(sectorOutcomesPath)) {
    try { sectorOutcomes = JSON.parse(fs.readFileSync(sectorOutcomesPath, 'utf8')); } catch { sectorOutcomes = null; }
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'asym_report.html'),
    renderAsymReport(payload, outcomes, sectorOutcomes),
    'utf8',
  );

  if (asJson) {
    console.log(JSON.stringify({
      signals: signals.length,
      posts: posts.length,
      articles: articles.length,
      tickers: tickers.length,
      coverage: payload.coverage,
    }, null, 2));
  } else {
    console.log(`[asym-aggregate] ${signals.length} signal(s), ${posts.length} post(s),`
      + ` ${articles.length} article(s), ${tickers.length} ticker(s)`);
  }
}

/**
 * Every AsymTrading signal, with the post's date and series.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadSignals(db) {
  const rows = db.prepare(
    'SELECT s.video_id, p.upload_date, p.series, t.provider, s.event_time_sec, s.ticker, s.action, s.bias, '
    + 's.claim_kind, s.confidence_label, s.confidence_score, s.entry_price, s.target_price_low, s.target_price_high, '
    + 's.stop_price, s.horizon_text, s.rationale, s.evidence_text, s.parser_version '
    + 'FROM trade_signals s '
    + 'JOIN asym_posts p ON p.video_id = s.video_id '
    + 'LEFT JOIN video_transcripts t ON t.video_id = s.video_id '
    + 'ORDER BY p.upload_date DESC, s.event_time_sec ASC, s.ticker ASC',
  ).all();

  return rows.map((row) => ({
    series: row.series || '',
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
  }));
}

/**
 * Every catalogued post, with its media and transcript state.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadPosts(db) {
  const rows = db.prepare(`
    SELECT p.video_id, p.upload_date, p.series, p.title, p.slug, p.access,
           p.has_media, p.quarantined, p.quarantine_reason, p.word_count,
           m.status AS media_status, m.duration_sec, m.segment_count AS media_segment_count,
           (SELECT COUNT(*) FROM video_transcripts t WHERE t.video_id = p.video_id) AS transcript_rows
      FROM asym_posts p
      LEFT JOIN asym_media m ON m.video_id = p.video_id
     ORDER BY p.upload_date DESC, p.video_id ASC
  `).all();

  return rows.map((row) => ({
    video_id: row.video_id,
    upload_date: row.upload_date || '',
    series: row.series || '',
    title: row.title || '',
    slug: row.slug || '',
    access: row.access || '',
    has_media: Number(row.has_media) || 0,
    quarantined: Number(row.quarantined) || 0,
    quarantine_reason: row.quarantine_reason || '',
    word_count: Number(row.word_count) || 0,
    media_status: row.media_status || '',
    duration_sec: row.duration_sec === null ? '' : row.duration_sec,
    transcript: Number(row.transcript_rows) > 0 ? 'yes' : 'no',
  }));
}

/**
 * The parsed market readings of every free post.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function loadArticles(db) {
  const rows = db.prepare(`
    SELECT p.upload_date, p.video_id, p.series, p.title, p.has_media, p.word_count,
           a.backdrop, a.trend, a.breadth, a.momentum, a.cap_sizes, a.sectors,
           a.plan_sections, a.scenarios, a.bottom_line, a.index_tickers
      FROM asym_articles a
      JOIN asym_posts p ON p.video_id = a.video_id
     ORDER BY p.upload_date DESC, p.video_id ASC
  `).all();

  return rows.map((row) => ({
    upload_date: row.upload_date || '',
    video_id: row.video_id,
    series: row.series || '',
    title: row.title || '',
    has_media: Number(row.has_media) || 0,
    word_count: Number(row.word_count) || 0,
    backdrop: row.backdrop || '',
    trend: row.trend || '',
    breadth: row.breadth || '',
    momentum: row.momentum || '',
    cap_sizes: row.cap_sizes || '',
    sectors: row.sectors || '',
    plan_sections: row.plan_sections || '',
    scenarios: row.scenarios || '',
    bottom_line: row.bottom_line || '',
    index_tickers: row.index_tickers || '',
  }));
}

/**
 * How much of the source the pipeline actually reached.
 *
 * The corpus is the publication's whole output; the free posts are what
 * the paywall lets us read; the media and the transcripts are what the
 * media pipeline reached. Reporting all four keeps the number honest
 * instead of flattering.
 *
 * @returns {object}
 */
function loadCoverage() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const posts = db.prepare('SELECT COUNT(*) c FROM asym_posts').get().c;
    const free = db.prepare("SELECT COUNT(*) c FROM asym_posts WHERE access = 'free'").get().c;
    // The stored value is 'paywalled', not 'paid' -- it is the reason
    // asymAccess() returns, not the access column's own vocabulary.
    const paid = db.prepare("SELECT COUNT(*) c FROM asym_posts WHERE access = 'paywalled'").get().c;
    const withMedia = db.prepare('SELECT COUNT(*) c FROM asym_posts WHERE has_media = 1').get().c;
    const downloaded = db.prepare("SELECT COUNT(*) c FROM asym_media WHERE status = 'downloaded'").get().c;
    const transcribed = db.prepare(
      "SELECT COUNT(*) c FROM video_transcripts WHERE video_id LIKE 'asym\\_%' ESCAPE '\\'",
    ).get().c;
    const articles = db.prepare('SELECT COUNT(*) c FROM asym_articles').get().c;
    let frames = 0;
    let sectors = 0;
    let monitorDays = 0;
    let monitorSheets = 0;
    try { frames = db.prepare('SELECT COUNT(*) c FROM asym_frames').get().c; } catch { /* optional */ }
    try { sectors = db.prepare('SELECT COUNT(*) c FROM asym_sectors').get().c; } catch { /* optional */ }
    try { monitorDays = db.prepare('SELECT COUNT(*) c FROM asym_monitor_days').get().c; } catch { /* optional */ }
    try { monitorSheets = db.prepare('SELECT COUNT(*) c FROM asym_monitor_sheets').get().c; } catch { /* optional */ }
    return {
      posts, free, paid, with_media: withMedia, downloaded, transcribed, articles,
      frames, sectors, monitor_days: monitorDays, monitor_sheets: monitorSheets,
    };
  } finally {
    db.close();
  }
}

/**
 * One row per post.
 *
 * @param {Array<object>} signals
 * @param {Array<object>} posts
 * @param {Array<object>} articles
 * @returns {Array<object>}
 */
function buildDailySummary(signals, posts, articles) {
  const articleById = new Map(articles.map((article) => [article.video_id, article]));

  const byVideo = new Map();
  for (const post of posts) {
    byVideo.set(post.video_id, { ...post, signals: [] });
  }
  for (const signal of signals) {
    if (!byVideo.has(signal.video_id)) {
      byVideo.set(signal.video_id, {
        video_id: signal.video_id,
        upload_date: signal.upload_date,
        series: signal.series,
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
    const article = articleById.get(entry.video_id) || {};
    return {
      series: entry.series || '',
      upload_date: entry.upload_date,
      video_id: entry.video_id,
      title: entry.title || '',
      provider: entry.provider || '',
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
      backdrop: article.backdrop || '',
      trend: article.trend || '',
      breadth: article.breadth || '',
      momentum: article.momentum || '',
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

  return [...byTicker.entries()]
    .map(([ticker, rows]) => {
      const confidences = rows.map((row) => Number(row.confidence_score)).filter(Number.isFinite);
      const entries = rows.map((row) => Number(row.entry_price)).filter(Number.isFinite);
      const targets = rows.map((row) => Number(row.target_price_low)).filter(Number.isFinite);
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
  console.error(`[asym-aggregate] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});