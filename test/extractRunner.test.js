'use strict';

// The shared extract runner.
//
// TWO BEHAVIOURS ARE PINNED HERE, AND BOTH WERE DEFECTS:
//
//   1. A video's rows are ALWAYS replaced -- including with zero rows. The
//      Sevcik copy replaced only when the new run found signals, so a video
//      whose calls went to zero kept its OLD rows, from an OLD parser
//      version. Measured on the shipped catalog: 8 rows from parser
//      versions 3 and 4 survived on 4 videos, and they were still
//      aggregated and scored.
//
//   2. A quarantined video is not read, and its rows are not touched. The
//      Sevcik copy also never revisited a quarantined video, so its rows
//      were never cleared either.
//
// The runner is what every transcript source uses, so these are the
// project's rules, not one tool's.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { runExtraction } = require('../src/transcript/extractRunner');

const SCHEMA = fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8');

function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-runner-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const segmentsPath = path.join(dir, 'transcript_segments.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insertVideo = db.prepare(
    "INSERT INTO videos (video_id, video_url, upload_date, channel, title, status, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, ?, 'pending', 'x', 'x')",
  );
  const insertTranscript = db.prepare(
    "INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, checksum, fetched_at) "
    + "VALUES (?, 'youtube_auto', 'en', 'x.json', 2, 'sum', 'x')",
  );
  for (const row of rows) {
    insertVideo.run(row.video_id, `https://www.youtube.com/watch?v=${row.video_id}`, row.upload_date, row.channel, row.title);
    insertTranscript.run(row.video_id);
  }
  return { dir, db, dbPath, segmentsPath };
}

function signal(ticker, parserVersion) {
  return {
    video_id: 'v1',
    transcript_id: null,
    segment_start_index: 0,
    segment_end_index: 1,
    event_time_sec: 1,
    ticker,
    action: 'buy',
    bias: 'bullish',
    claim_kind: 'forward',
    confidence_label: 'high',
    confidence_score: 0.7,
    entry_price: null,
    target_price_low: null,
    target_price_high: null,
    stop_price: null,
    horizon_text: '',
    rationale: '',
    evidence_text: 'because',
    parser_version: parserVersion,
  };
}

test('a video whose signals go to zero loses its old rows', () => {
  const { db, segmentsPath } = makeDb([{ video_id: 'v1', upload_date: '20260101', channel: 'benzinga', title: 'x' }]);
  db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, ticker, '
    + 'evidence_text, parser_version) VALUES (?, 1, 0, 1, ?, ?, ?)',
  ).run('v1', 'OLD', 'old evidence', 'old-parser');

  runExtraction(db, {
    channel: 'benzinga',
    segmentsPath,
    dryRun: false,
    extract: () => [],
  });

  const rows = db.prepare('SELECT ticker FROM trade_signals WHERE video_id = ?').all('v1').map((r) => ({ ...r }));
  assert.deepEqual(rows, []);
  db.close();
});

test('the new rows replace the old ones, and carry the parser version', () => {
  const { db, segmentsPath } = makeDb([{ video_id: 'v1', upload_date: '20260101', channel: 'benzinga', title: 'x' }]);
  db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, ticker, '
    + 'evidence_text, parser_version) VALUES (?, 1, 0, 1, ?, ?, ?)',
  ).run('v1', 'OLD', 'old evidence', 'old-parser');

  runExtraction(db, {
    channel: 'benzinga',
    segmentsPath,
    dryRun: false,
    extract: () => [signal('NVDA', 'benzinga-signals-1')],
  });

  const rows = db.prepare('SELECT ticker, parser_version FROM trade_signals WHERE video_id = ?').all('v1')
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ ticker: 'NVDA', parser_version: 'benzinga-signals-1' }]);
  db.close();
});

test('a quarantined video is not read and its rows are left alone', () => {
  const { db, segmentsPath } = makeDb([{ video_id: 'v1', upload_date: '20260101', channel: 'benzinga', title: 'x' }]);
  db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, ticker, '
    + 'evidence_text, parser_version) VALUES (?, 1, 0, 1, ?, ?, ?)',
  ).run('v1', 'KEPT', 'old evidence', 'old-parser');

  let read = 0;
  const result = runExtraction(db, {
    channel: 'benzinga',
    segmentsPath,
    dryRun: false,
    quarantine: () => ({ quarantined: true, reason: 'earnings_call' }),
    extract: () => { read += 1; return []; },
  });

  assert.equal(result.videos, 0);
  assert.equal(read, 0);
  const rows = db.prepare('SELECT ticker FROM trade_signals WHERE video_id = ?').all('v1').map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ ticker: 'KEPT' }]);
  db.close();
});

test('the runner only touches the channel it was given', () => {
  const { db, segmentsPath } = makeDb([
    { video_id: 'v1', upload_date: '20260101', channel: 'benzinga', title: 'x' },
    { video_id: 'v2', upload_date: '20260101', channel: 't3live', title: 'y' },
  ]);
  const result = runExtraction(db, {
    channel: 'benzinga',
    segmentsPath,
    dryRun: true,
    extract: () => [],
  });
  assert.equal(result.videos, 1);
  db.close();
});
