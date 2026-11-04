'use strict';

// The Sevcik pipeline's database round-trip.
//
// WHY THIS TEST EXISTS
//
// The pipeline has three stages that write to the database -- the
// transcript, its segments, and the signals -- and three properties that
// only break when the stages are run together:
//
//   1. A RE-RUN does not duplicate anything. The transcript table has a
//      UNIQUE(video_id), the segments are keyed by (transcript, index), and
//      a re-run replaces a video's signals rather than adding to them.
//      A pipeline that doubled its rows on every run would report every
//      call twice, and a report that counts things twice is worse than a
//      report that counts nothing.
//
//   2. The schema applies to a FRESH database. The three new tables are
//      created by data/db/schema.sql, and a fresh clone gets them from
//      there -- not from a migration that only runs on an existing file.
//
//   3. Every signal carries its evidence. The evidence_text column is
//      NOT NULL, and the value it holds is the text the signal was read
//      from.
//
// The test runs against a temporary database built from the real schema
// file, so it needs no network, no media and no Deepgram key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { extractSignals } = require('../src/sevcik/signalExtractor');
const { normalizeTranscript, transcriptChecksum } = require('../src/transcript/transcriptNormalize');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = path.join(ROOT, 'data', 'db', 'schema.sql');

// The same upsert the fetcher tool does, reduced to what the test needs.
function upsertTranscript(db, row, provider, transcriptPath, segments, fetchedAt) {
  const checksum = transcriptChecksum(segments);
  const existing = db.prepare('SELECT id FROM video_transcripts WHERE video_id = ?').get(row.video_id);

  let transcriptId;
  if (existing) {
    transcriptId = Number(existing.id);
    db.prepare(
      'UPDATE video_transcripts SET provider = ?, transcript_path = ?, segment_count = ?, '
      + 'checksum = ?, fetched_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(provider, transcriptPath, segments.length, checksum, fetchedAt, transcriptId);
    db.prepare('DELETE FROM transcript_segments WHERE transcript_id = ?').run(transcriptId);
  } else {
    const result = db.prepare(
      'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
      + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.video_id, provider, 'en', transcriptPath, segments.length, checksum, fetchedAt);
    transcriptId = Number(result.lastInsertRowid);
  }

  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  segments.forEach((segment, index) => {
    insertSegment.run(
      transcriptId, row.video_id, index,
      segment.start_sec, segment.end_sec, segment.text,
      segment.confidence === null ? null : segment.confidence,
    );
  });

  return transcriptId;
}

function insertSignals(db, videoId, transcriptId, signals) {
  db.prepare('DELETE FROM trade_signals WHERE video_id = ?').run(videoId);
  const insert = db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, '
    + 'event_time_sec, ticker, action, bias, confidence_label, confidence_score, entry_price, '
    + 'target_price_low, target_price_high, stop_price, horizon_text, rationale, evidence_text, '
    + 'parser_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const signal of signals) {
    insert.run(
      signal.video_id, transcriptId, signal.segment_start_index, signal.segment_end_index,
      signal.event_time_sec, signal.ticker, signal.action, signal.bias, signal.confidence_label,
      signal.confidence_score, signal.entry_price, signal.target_price_low, signal.target_price_high,
      signal.stop_price, signal.horizon_text, signal.rationale, signal.evidence_text,
      signal.parser_version,
    );
  }
}

function fixtureDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sevcik-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return db;
}

const SEGMENTS = [
  { start_sec: 0, end_sec: 3, text: "So let's talk about TQQQ today.", confidence: null },
  { start_sec: 3, end_sec: 6, text: 'I am very bullish on TQQQ, high conviction.', confidence: 0.97 },
  { start_sec: 6, end_sec: 9, text: 'I am going to buy TQQQ at 75, target is 82.', confidence: 0.95 },
];

const LEXICON = new Set(['TQQQ', 'SPY']);

function insertVideo(db, videoId, channel = 'davidsevcik') {
  const now = '2026-01-01T00:00:00+00:00';
  db.prepare(
    'INSERT INTO videos (video_id, source_url, video_url, title, upload_date, channel, status, '
    + 'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    videoId, 'https://www.youtube.com/@davidsevcik-sved4697/streams',
    `https://www.youtube.com/watch?v=${videoId}`, 'A stream', '20260101', channel, 'pending', now, now,
  );
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

test('a fresh database gets the three new tables', (t) => {
  const db = fixtureDb(t);
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN "
    + "('video_transcripts','transcript_segments','trade_signals')",
  ).all().map((row) => row.name).sort();
  assert.deepEqual(names, ['trade_signals', 'transcript_segments', 'video_transcripts']);
  db.close();
});

test('the evidence text of a signal is NOT NULL', (t) => {
  const db = fixtureDb(t);
  const sql = fs.readFileSync(SCHEMA, 'utf8');
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS trade_signals (');
  assert.ok(start !== -1, 'schema.sql has no trade_signals table');
  const body = sql.slice(start, sql.indexOf(');', start));
  assert.match(body, /evidence_text\s+TEXT\s+NOT NULL/,
    'a signal without its evidence cannot be checked, so the column must be NOT NULL');
  db.close();
});

// ---------------------------------------------------------------------------
// The round-trip
// ---------------------------------------------------------------------------

test('a transcript, its segments and its signals are written and read back', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');

  const transcriptId = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'now');
  assert.ok(transcriptId > 0);

  const segments = db.prepare('SELECT * FROM transcript_segments WHERE transcript_id = ?').all(transcriptId);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].text, 'I am very bullish on TQQQ, high conviction.');
  assert.equal(segments[1].confidence, 0.97);

  const signals = extractSignals({
    segments: SEGMENTS, lexicon: LEXICON, videoId: 'vid1', transcriptId,
  });
  insertSignals(db, 'vid1', transcriptId, signals);

  const stored = db.prepare('SELECT * FROM trade_signals WHERE video_id = ?').all('vid1');
  assert.ok(stored.length >= 1, 'the pipeline produced signals');
  assert.equal(stored[0].ticker, 'TQQQ');
  assert.ok(stored[0].evidence_text.includes('TQQQ'));
  db.close();
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('a re-run does not duplicate the transcript', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');

  upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'now');
  upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'later');

  const transcripts = db.prepare('SELECT * FROM video_transcripts WHERE video_id = ?').all('vid1');
  assert.equal(transcripts.length, 1, 'a re-run must not leave a second transcript row');
  db.close();
});

test('a re-run does not duplicate the segments', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');

  const first = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'now');
  const second = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'later');

  assert.equal(first, second, 'the same video keeps the same transcript id');
  const segments = db.prepare('SELECT * FROM transcript_segments WHERE transcript_id = ?').all(first);
  assert.equal(segments.length, 3, 'the segments are replaced, not appended to');
  db.close();
});

test('a re-run replaces the signals rather than adding to them', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');

  const transcriptId = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', SEGMENTS, 'now');
  const signals = extractSignals({
    segments: SEGMENTS, lexicon: LEXICON, videoId: 'vid1', transcriptId,
  });
  insertSignals(db, 'vid1', transcriptId, signals);
  const firstCount = db.prepare('SELECT COUNT(*) AS n FROM trade_signals WHERE video_id = ?').get('vid1').n;

  insertSignals(db, 'vid1', transcriptId, signals);
  const secondCount = db.prepare('SELECT COUNT(*) AS n FROM trade_signals WHERE video_id = ?').get('vid1').n;

  assert.equal(secondCount, firstCount, 'a re-run must not double the signals');
  db.close();
});

test('a re-run of a DIFFERENT video does not touch the first one', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');
  insertVideo(db, 'vid2');

  const id1 = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p1.json', SEGMENTS, 'now');
  insertSignals(db, 'vid1', id1, extractSignals({
    segments: SEGMENTS, lexicon: LEXICON, videoId: 'vid1', transcriptId: id1,
  }));

  const id2 = upsertTranscript(db, { video_id: 'vid2' }, 'deepgram', 'p2.json', SEGMENTS, 'now');
  insertSignals(db, 'vid2', id2, extractSignals({
    segments: SEGMENTS, lexicon: LEXICON, videoId: 'vid2', transcriptId: id2,
  }));

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_signals WHERE video_id = ?').get('vid1').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_signals WHERE video_id = ?').get('vid2').n, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// The provider is recorded
// ---------------------------------------------------------------------------

test('the provider is recorded, so a reader knows which source a signal came from', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');
  insertVideo(db, 'vid2');

  upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p1.json', SEGMENTS, 'now');
  upsertTranscript(db, { video_id: 'vid2' }, 'deepgram', 'p2.json', SEGMENTS, 'now');

  const providers = db.prepare('SELECT video_id, provider FROM video_transcripts ORDER BY video_id').all();
  assert.deepEqual(providers.map((row) => row.provider), ['youtube_auto', 'deepgram']);
  db.close();
});

test('a provider outside the allowed set is refused', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');
  assert.throws(() => {
    db.prepare(
      'INSERT INTO video_transcripts (video_id, provider, transcript_path, segment_count, checksum, fetched_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
    ).run('vid1', 'whisper', 'p.json', 3, 'x', 'now');
  }, 'the CHECK constraint must refuse an unknown provider');
  db.close();
});

// ---------------------------------------------------------------------------
// The normalization the pipeline stores
// ---------------------------------------------------------------------------

test('the segments stored are the normalized ones', (t) => {
  const db = fixtureDb(t);
  insertVideo(db, 'vid1');

  // A YouTube-captions-shaped payload, normalized the way the fetcher does.
  const normalized = normalizeTranscript({
    segments: [{ start_ts: 0, end_ts: 3, text: 'hello' }],
  }, 'youtube_auto');
  const transcriptId = upsertTranscript(db, { video_id: 'vid1' }, 'youtube_auto', 'p.json', normalized, 'now');

  const segments = db.prepare('SELECT * FROM transcript_segments WHERE transcript_id = ?').all(transcriptId);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start_sec, 0);
  assert.equal(segments[0].end_sec, 3);
  assert.equal(segments[0].text, 'hello');
  db.close();
});
