'use strict';

// How much of each Benzinga show is SPOKEN tickers.
//
// WHAT IT MEASURES
//
// The extractor can only publish a claim when a ticker is IN THE SPEECH.
// So the ceiling on recall is set by how often the hosts say a ticker
// out loud -- and for a chart-driven live show, that is often.
//
// Measured on the pilot corpus (2026-11-12): a Drift episode has 4,092
// segments, and only 199 of them (5%) name a ticker at all. The host
// says "I'm buying here" and the ticker is on the screen, not in the
// words. A spoken-ticker extractor cannot recover that.
//
// So this report is the measurement that decides which shows are worth
// transcribing at all.
//
// Usage:
//   node tools/measureBenzingaSpeech.js
//   node tools/measureBenzingaSpeech.js --json

const fs = require('node:fs');
const path = require('node:path');

const { classifyBenzingaVideo } = require('../src/benzinga/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

const { DatabaseSync } = require('node:sqlite');
process.removeAllListeners('warning');
process.on('warning', () => {});

const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

/** The words that are not tickers. */
const NOT_TICKER = new Set([
  'THE', 'AND', 'FOR', 'WITH', 'ALL', 'NOW', 'GET', 'NEW', 'THIS', 'THAT', 'WHAT', 'JUST',
  'LIKE', 'GUYS', 'OK', 'SO', 'DO', 'WE', 'IT', 'MY', 'DOES', 'DID', 'CAN', 'ONE', 'TWO', 'UP',
  'AT', 'IS', 'AS', 'BE', 'ON', 'IF', 'IN', 'TO', 'OF', 'OR', 'BY', 'GO', 'NO', 'ME', 'HE',
  'WELL', 'YEAH', 'RIGHT', 'LOOK', 'GOING', 'GOT', 'GONNA', 'WANT', 'THINK', 'KNOW', 'SOMETHING',
  'ANYTHING', 'EVERYTHING', 'NOTHING', 'GIVE', 'TAKE', 'COME', 'MAKE', 'MADE', 'SAID', 'SAY',
  'SELLING', 'BUYING', 'SHORT', 'LONG', 'PUT', 'CALL', 'BULL', 'BEAR', 'HERE', 'THERE', 'THEN',
  'WHEN', 'WHERE', 'WHO', 'WHY', 'HOW', 'BUT', 'HAVE', 'HAD', 'WAS', 'WEREN', 'WILL', 'WOULD',
  'COULD', 'SHOULD', 'BECAUSE', 'ABOUT', 'AFTER', 'BEFORE', 'RIGHT', 'BETWEEN', 'WORLD', 'TODAY',
  'MARKET', 'MARKETS', 'STOCK', 'STOCKS', 'SHARE', 'SHARES', 'TRADE', 'TRADES', 'TRADING',
  'OPTION', 'OPTIONS', 'PREMIUM', 'STRIKE', 'EXPIRATION', 'DELTA', 'HEDGE', 'HEDGING', 'LOT',
  'LOTS', 'CONTRACT', 'CONTRACTS', 'SHARES', 'MONEY', 'PRICE', 'PRICES', 'LEVEL', 'LEVELS',
  'TARGET', 'STOP', 'ENTRY', 'EXIT', 'RISK', 'REWARD', 'POSITION', 'POSITIONS', 'LONG', 'SHORT',
]);

/** The indicator acronyms that are not tickers. */
const INDICATOR = new Set([
  'DMA', 'SMA', 'EMA', 'RSI', 'MACD', 'ATR', 'OBV', 'ADX', 'VWAP', 'CCI', 'DXY', 'VIX', 'PCR',
  'OI', 'IV', 'EPS', 'GAAP', 'PEG', 'AUM', 'NAV', 'ROE', 'ROI', 'ATH', 'ATL', 'YTD', 'TTM',
  'FOMC', 'CPI', 'PPI', 'PCE', 'GDP', 'NFP', 'PMIs', 'IPO', 'SEC', 'FDA', 'DOJ', 'EU', 'UK',
]);

const DIRECTION = /\b(?:buy(?:ing)?|bought|sell(?:ing)?|sold|short(?:ing)?|long(?:ing)?|bullish|bearish|puts?|calls?|adding|trimming|cover(?:ing)?|exit(?:ed|ing)?)\b/i;

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(
    "SELECT v.video_id, v.upload_date, v.title, t.segment_count FROM videos v "
    + 'JOIN video_transcripts t ON t.video_id = v.video_id '
    + "WHERE v.channel = 'benzinga' ORDER BY v.upload_date DESC",
  ).all();
  db.close();

  const results = [];
  for (const row of rows) {
    const file = path.join(TRANSCRIPTS_DIR, `${row.video_id}.json`);
    if (!fs.existsSync(file)) continue;
    let body;
    try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const segments = body.segments || [];
    if (!segments.length) continue;

    let tickerSegments = 0;
    let directionSegments = 0;
    let bothSegments = 0;
    let tickerMentions = 0;
    const tickers = new Set();
    for (const segment of segments) {
      const text = String(segment.text || '');
      const tokens = (text.match(/\b[A-Z]{2,5}\b/g) || [])
        .filter((token) => !NOT_TICKER.has(token) && !INDICATOR.has(token));
      if (tokens.length) {
        tickerSegments += 1;
        tickerMentions += tokens.length;
        tokens.forEach((token) => tickers.add(token));
      }
      const hasDirection = DIRECTION.test(text);
      if (hasDirection) directionSegments += 1;
      if (tokens.length && hasDirection) bothSegments += 1;
    }

    results.push({
      video_id: row.video_id,
      upload_date: row.upload_date,
      title: row.title,
      show: classifyBenzingaVideo({ title: row.title }).show,
      segments: segments.length,
      ticker_segments: tickerSegments,
      ticker_mentions: tickerMentions,
      direction_segments: directionSegments,
      both_segments: bothSegments,
      distinct_tickers: tickers.size,
      ticker_density: Number((tickerSegments / segments.length).toFixed(4)),
    });
  }

  const byShow = new Map();
  for (const entry of results) {
    const bucket = byShow.get(entry.show) || { show: entry.show, videos: 0, segments: 0, ticker_segments: 0, both: 0, tickers: 0 };
    bucket.videos += 1;
    bucket.segments += entry.segments;
    bucket.ticker_segments += entry.ticker_segments;
    bucket.both += entry.both_segments;
    bucket.tickers += entry.distinct_tickers;
    byShow.set(entry.show, bucket);
  }

  if (asJson) {
    console.log(JSON.stringify({ results, by_show: [...byShow.values()] }, null, 2));
    return;
  }

  console.log('=== per show: how much of the speech names a ticker ===');
  console.log('show                videos  hours   segments  ticker-seg  both  distinct');
  for (const bucket of [...byShow.values()].sort((a, b) => b.ticker_segments - a.ticker_segments)) {
    const hours = (bucket.segments * 4) / 3600; // ~4 s per segment
    console.log(`  ${bucket.show.padEnd(18)} ${String(bucket.videos).padStart(4)} ${hours.toFixed(1).padStart(7)}`
      + ` ${String(bucket.segments).padStart(9)} ${String(bucket.ticker_segments).padStart(11)}`
      + ` ${String(bucket.both).padStart(6)} ${String(bucket.tickers).padStart(9)}`
      + `   ${((bucket.ticker_segments / bucket.segments) * 100).toFixed(1)}% of segments`);
  }
  console.log('\n=== per video ===');
  for (const entry of results.sort((a, b) => b.ticker_segments - a.ticker_segments)) {
    console.log(`  ${entry.show.padEnd(18)} ${entry.upload_date} ${String(entry.segments).padStart(5)} seg`
      + ` ${String(entry.ticker_segments).padStart(4)} ticker-seg (${(entry.ticker_density * 100).toFixed(1)}%)`
      + ` ${String(entry.both_segments).padStart(4)} both  ${String(entry.distinct_tickers).padStart(4)} names  ${entry.title.slice(0, 46)}`);
  }
}

main();
