'use strict';

// The Komar transcript fetcher's write path.
//
// These tests pin the write contract:
// - a transcript's ROW records the language the request actually used
//   (the language selects the ACOUSTIC MODEL, so a hard-coded one in
//   the row hid a whole corpus's worth of wrong readings once)
// - the JSON file is the RECORD and the row is its index, so a file
//   with no row is re-registered rather than transcribed again
// - the plan is priced before a cent is spent
//
// The Deepgram call itself is NOT exercised here: it costs money. The
// end-to-end path is measured by the tool's own run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-transcripts-'));
process.env.KOMAR_TRANSCRIPTS_DIR = path.join(SCRATCH, 'transcripts');

const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');
const { ensureKomarSchema } = require('../src/komar/schema');
const {
  COST_PER_MINUTE,
  listVideos,
  registerExistingTranscript,
  transcriptPathOf,
  writeTranscriptRow,
} = require('../tools/fetchKomarTranscripts');

function isolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-transcripts-db-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  const derivedPath = path.join(dir, 'derived.sqlite');
  ensureDerivedSchema(derivedPath);
  db.prepare('ATTACH DATABASE ? AS derived').run(derivedPath);
  ensureKomarSchema(db, { derivedPath });
  return {
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    db,
  };
}

function addVideo(db, video) {
  db.prepare(`
    INSERT INTO derived.komar_videos (
      video_id, kind, series, title, part, part_index, report_number,
      session_date, session_date_source, has_video, width, height, duration_sec,
      audio_codec, audio_channels, size_bytes, media_path, folder,
      catalog_version, created_at, updated_at
    ) VALUES (?, ?, '', ?, '', 0, '', '', '', 1, 1920, 1080, ?, 'aac', 1, 0, ?, '', 'v1', datetime('now'), datetime('now'))
  `).run(
    video.video_id, video.kind || 'weekend', video.title || '',
    video.duration_sec || 0, video.media_path || ''
  );
}

test('the videos are listed shortest first, so a bounded run buys the most', () => {
  const ctx = isolatedDb();
  try {
    addVideo(ctx.db, { video_id: 'komar_vid_long', duration_sec: 3600 });
    addVideo(ctx.db, { video_id: 'komar_vid_short', duration_sec: 600 });
    const videos = listVideos(ctx.db);
    assert.equal(videos.length, 2);
    assert.equal(videos[0].video_id, 'komar_vid_short');
    assert.equal(videos[1].video_id, 'komar_vid_long');
  } finally {
    ctx.cleanup();
  }
});

test('a row records the language the request used, and the checksum', () => {
  const ctx = isolatedDb();
  try {
    const video = { video_id: 'komar_vid_weekend_226_stocks', duration_sec: 1820 };
    writeTranscriptRow(ctx.db, video, {
      checksum: 'abc123',
      duration_sec: 1820,
      fetched_at: '2026-11-17T10:00:00.000Z',
      language: 'en',
      model: 'nova-2',
      provider: 'deepgram',
      quality_score: 0.93,
      segment_count: 412,
      transcript_path: 'data/video_pipeline/transcripts/komar_vid_weekend_226_stocks.json',
    });
    const row = ctx.db.prepare('SELECT * FROM komar_transcripts WHERE video_id = ?').get(video.video_id);
    assert.equal(row.language, 'en');
    assert.equal(row.model, 'nova-2');
    assert.equal(row.provider, 'deepgram');
    assert.equal(row.segment_count, 412);
    assert.equal(row.checksum, 'abc123');
    assert.equal(row.quality_score, 0.93);
    assert.equal(row.duration_sec, 1820);

    // A re-fetch replaces the row rather than adding one.
    writeTranscriptRow(ctx.db, video, {
      checksum: 'def456',
      duration_sec: 1820,
      fetched_at: '2026-11-17T11:00:00.000Z',
      language: 'en',
      model: 'nova-2',
      provider: 'deepgram',
      quality_score: 0.91,
      segment_count: 415,
      transcript_path: 'data/video_pipeline/transcripts/komar_vid_weekend_226_stocks.json',
    });
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM komar_transcripts').get().c, 1);
    assert.equal(
      ctx.db.prepare('SELECT checksum FROM komar_transcripts').get().checksum,
      'def456'
    );
  } finally {
    ctx.cleanup();
  }
});

test('a transcript on disk with no row is re-registered, not transcribed again', () => {
  const ctx = isolatedDb();
  try {
    const video = { video_id: 'komar_vid_weekend_226_overview', duration_sec: 727 };
    const transcriptPath = transcriptPathOf(video.video_id);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify({
      checksum: 'deadbeef',
      duration_sec: 727,
      fetched_at: '2026-11-17T10:00:00.000Z',
      language: 'en',
      model: 'nova-2',
      provider: 'deepgram',
      segment_count: 88,
      segments: [{ start_sec: 0, end_sec: 1, text: 'hello' }],
      video_id: video.video_id,
    }), 'utf8');

    const registered = registerExistingTranscript(ctx.db, video);
    assert.ok(registered, 'the row was written from the file');
    const row = ctx.db.prepare('SELECT * FROM komar_transcripts WHERE video_id = ?').get(video.video_id);
    assert.equal(row.language, 'en');
    assert.equal(row.segment_count, 88);
    assert.equal(row.checksum, 'deadbeef');
    assert.ok(row.transcript_path.endsWith('komar_vid_weekend_226_overview.json'));

    // A second call is a no-op rather than an error.
    assert.ok(registerExistingTranscript(ctx.db, video));
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM komar_transcripts').get().c, 1);
  } finally {
    ctx.cleanup();
  }
});

test('the price of the corpus is what the plan says it is', () => {
  // The plan budgets the whole corpus at about $30: 3,954 minutes at
  // nova-2's standard rate. The rate is a CONSTANT in the tool, so a
  // change to it is a change to the budget and has to be a decision.
  assert.equal(COST_PER_MINUTE, 0.0077);
  const corpusMinutes = 3952;
  assert.ok(
    Math.abs(corpusMinutes * COST_PER_MINUTE - 30.43) < 0.05,
    'the corpus is about $30'
  );
});

test.after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
