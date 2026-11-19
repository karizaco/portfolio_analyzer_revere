'use strict';

// martinlukkt transcripts -> the trades he stated.
//
// The reader is src/martinlukkt/tradeRead.js. This tool only writes. A
// re-run replaces the video's rows, including with zero, through the shared
// runner. A review stream and a plan are stored and are not claim_kind
// 'forward', so the outcome scorer does not treat them as a call made that day.
//
// Usage:
//   node tools/extractMartinlukktSignals.js
//   node tools/extractMartinlukktSignals.js --dry-run
//   node tools/extractMartinlukktSignals.js --video-id abc123

const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');
const { purgeSupersededRows, replaceSignals, runExtraction } = require('../src/transcript/extractRunner');
const { MARTINLUKKT_CHANNEL } = require('../src/martinlukkt/channel');
const { martinlukktVideoQuarantine } = require('../src/martinlukkt/contentFilter');
const { PARSER_VERSION, signalRows, tradesFromSegments } = require('../src/martinlukkt/signalRows');

const DB_PATH = path.resolve('data/video_pipeline/state.sqlite');

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] || '';
}

function replaceActions(db, videoId, transcriptId, rows) {
  db.prepare('DELETE FROM martinlukkt_trade_actions WHERE video_id = ?').run(videoId);
  const insert = db.prepare(
    'INSERT INTO martinlukkt_trade_actions (parser_version, video_id, transcript_id, segment_index, '
    + 'event_time_sec, session_date, session_kind, kind, action, side, ticker, ticker_from, price, '
    + 'stop_price, verb, evidence_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      row.parser_version,
      videoId,
      transcriptId,
      row.segment_index,
      row.event_time_sec,
      row.session_date,
      row.session_kind,
      row.kind,
      row.raw_action,
      row.side,
      row.ticker,
      row.ticker_from,
      row.price,
      row.stop_price,
      row.verb,
      row.evidence_text,
    );
  }
}

function replaceBoth(db, videoId, transcriptId, rows) {
  replaceSignals(db, videoId, transcriptId, signalRows(rows));
  replaceActions(db, videoId, transcriptId, rows);
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const videoId = readFlag(argv, '--video-id') || '';
  const limit = Number(readFlag(argv, '--limit')) || 0;

  ensureDerivedSchema();
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  attachDerived(db);
  if (!dryRun && !videoId && !limit) {
    purgeSupersededRows(db, {
      channel: MARTINLUKKT_CHANNEL,
      table: 'trade_signals',
      version: PARSER_VERSION,
    });
  }

  const result = runExtraction(db, {
    channel: MARTINLUKKT_CHANNEL,
    dryRun,
    extract: (segments, video) => tradesFromSegments(segments, video),
    label: 'martinlukkt',
    limit: limit || undefined,
    parserVersion: PARSER_VERSION,
    quarantine: martinlukktVideoQuarantine,
    replace: replaceBoth,
    table: 'martinlukkt_trade_actions',
    videoId: videoId || undefined,
  });

  const named = result.perVideo.reduce(
    (sum, row) => sum + row.signals.filter((trade) => trade.ticker).length,
    0,
  );
  console.log(JSON.stringify({
    channel: MARTINLUKKT_CHANNEL,
    dry_run: dryRun,
    parser_version: PARSER_VERSION,
    statements: result.signals,
    videos: result.videos,
    with_ticker: named,
  }, null, 2));
  db.close();
}

if (require.main === module) main();

module.exports = {
  replaceActions,
  replaceBoth,
};
