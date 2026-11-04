'use strict';

// The Sevcik pipeline, end to end, on a transcript that looks like a real one.
//
// WHY THIS TEST EXISTS
//
// Every other Sevcik test checks one stage in isolation. This one runs
// the WHOLE chain -- transcript -> segments -> signals -> CSV -> dashboard
// -- over a transcript written to look like what YouTube's machine
// translation of a Czech trading stream actually produces.
//
// The reason it is worth having is that the individual stages can each
// be right and the CHAIN still wrong. Four defects were found exactly
// this way, and none of them was visible from any single stage:
//
//   * the price role was assigned by DECLARATION order, so the STOP price
//     225 was labelled a TARGET and the stop was lost
//   * a window spanning two tickers put the TSLA entry and the NVDA
//     target on the same row, and the TSLA row carried NVDA's price
//   * AAPL was published as `action=short, bias=bearish` when the text
//     said "I am watching it" -- the direction bled across names
//   * one call produced three rows, so the aggregate said TSLA was
//     called three times
//
// A test that only checks "the extractor produced N signals" would have
// passed on all four.
//
// THE TRANSCRIPT
//
// It is SYNTHETIC, and it is written in the shape the machine translation
// produces: the TICKERS and the NUMBERS survive, and the trading
// vocabulary is English. It is not a transcript of a real video, and it
// does not prove the extractor reads real Czech stream commentary --
// that requires a real transcript, which the caption endpoint currently
// refuses to deliver (see CLAUDE.md).
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
const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');
const { buildSevcikReportHtml } = require('../src/report/sevcikReport');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = path.join(ROOT, 'data', 'db', 'schema.sql');

// A small, explicit lexicon. The extractor is lexicon-constrained, and a
// test that used the real seed lexicon would move whenever the seed does.
const LEXICON = new Set(['TSLA', 'NVDA', 'AAPL', 'TQQQ', 'SPY']);

// The synthetic stream. Three names: one with a complete call (entry,
// target, stop), one bearish call with its own levels, and one name that
// is only being watched.
const SEGMENTS = [
  { start_ts: 0, end_ts: 4, text: "Let's talk about Tesla today, ticker TSLA." },
  { start_ts: 4, end_ts: 9, text: 'I am very bullish on TSLA, high conviction.' },
  { start_ts: 9, end_ts: 14, text: 'I am going to buy TSLA at 240, my target is 280.' },
  { start_ts: 14, end_ts: 19, text: 'The stop loss is 225 if it breaks down.' },
  { start_ts: 19, end_ts: 24, text: 'Over the next few days, this is a swing trade.' },
  { start_ts: 24, end_ts: 30, text: 'Now for Nvidia, NVDA. I am bearish on it here.' },
  { start_ts: 30, end_ts: 35, text: 'I think NVDA is going to lower, so I am shorting it.' },
  { start_ts: 35, end_ts: 40, text: 'The target is 120 and my stop is 140.' },
  { start_ts: 40, end_ts: 45, text: 'Apple, AAPL, I am watching it for now.' },
  { start_ts: 45, end_ts: 52, text: 'That is all for today, see you tomorrow.' },
];

/**
 * Run the chain over the synthetic transcript.
 *
 * @returns {{signals: Array<object>, db: object, dir: string}}
 */
function runChain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sevcik-e2e-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO videos (video_id, source_url, video_url, title, upload_date, channel, status, created_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'syntheticSevcik01',
    'https://www.youtube.com/@davidsevcik-sved4697/streams',
    'https://www.youtube.com/watch?v=syntheticSevcik01',
    'Synthetic Sevcik stream',
    '20261104',
    'davidsevcik',
    'pending',
    now,
    now,
  );

  const segments = normalizeTranscript({ segments: SEGMENTS }, 'youtube_auto');

  const transcriptId = Number(db.prepare(
    'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
    + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('syntheticSevcik01', 'youtube_auto', 'en', 'transcript.json', segments.length, 'checksum', now).lastInsertRowid);

  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  segments.forEach((segment, index) => {
    insertSegment.run(transcriptId, 'syntheticSevcik01', index, segment.start_sec, segment.end_sec, segment.text, null);
  });

  const signals = extractSignals({
    segments,
    lexicon: LEXICON,
    videoId: 'syntheticSevcik01',
    transcriptId,
  });

  const insertSignal = db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, event_time_sec, '
    + 'ticker, action, bias, confidence_label, confidence_score, entry_price, target_price_low, target_price_high, '
    + 'stop_price, horizon_text, rationale, evidence_text, parser_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const signal of signals) {
    insertSignal.run(
      signal.video_id, signal.transcript_id, signal.segment_start_index, signal.segment_end_index,
      signal.event_time_sec, signal.ticker, signal.action, signal.bias, signal.confidence_label,
      signal.confidence_score, signal.entry_price, signal.target_price_low, signal.target_price_high,
      signal.stop_price, signal.horizon_text, signal.rationale, signal.evidence_text, signal.parser_version,
    );
  }

  return { signals, db, dir };
}

// ---------------------------------------------------------------------------
// The chain produces the right CALLS
// ---------------------------------------------------------------------------

test('the chain produces one signal per call, with its own levels', () => {
  const { signals, db, dir } = runChain();
  try {
    assert.equal(signals.length, 2, 'two calls: TSLA and NVDA');

    const tsla = signals.find((signal) => signal.ticker === 'TSLA');
    const nvda = signals.find((signal) => signal.ticker === 'NVDA');
    assert.ok(tsla, 'TSLA is a signal');
    assert.ok(nvda, 'NVDA is a signal');

    // The TSLA call: entry, target and stop, each its own price.
    assert.equal(tsla.action, 'buy');
    assert.equal(tsla.bias, 'bullish');
    assert.equal(tsla.entry_price, 240);
    assert.equal(tsla.target_price_low, 280);
    assert.equal(tsla.stop_price, 225);

    // The NVDA call: a target and a stop, and NO entry -- NVDA never had
    // one, and the TSLA entry must not have leaked across.
    assert.equal(nvda.action, 'short');
    assert.equal(nvda.bias, 'bearish');
    assert.equal(nvda.entry_price, null, 'NVDA has no entry price of its own');
    assert.equal(nvda.target_price_low, 120);
    assert.equal(nvda.stop_price, 140);

    // A name that is only being WATCHED is not a call.
    assert.equal(signals.find((signal) => signal.ticker === 'AAPL'), undefined,
      'AAPL was only being watched');

    // The horizon is the explicit one, not the "today" in the first line.
    assert.equal(tsla.horizon_text, 'swing');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a price does not cross from one name to the next', () => {
  const { signals, db, dir } = runChain();
  try {
    for (const signal of signals) {
      if (signal.ticker === 'NVDA') {
        assert.notEqual(signal.entry_price, 240, 'NVDA did not inherit the TSLA entry');
        assert.notEqual(signal.stop_price, 225, 'NVDA did not inherit the TSLA stop');
      }
      if (signal.ticker === 'TSLA') {
        assert.notEqual(signal.target_price_low, 120, 'TSLA did not inherit the NVDA target');
        assert.notEqual(signal.stop_price, 140, 'TSLA did not inherit the NVDA stop');
      }
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one call is published once', () => {
  const { signals, db, dir } = runChain();
  try {
    const tickers = signals.map((signal) => signal.ticker);
    assert.equal(new Set(tickers).size, tickers.length, 'no ticker is published twice');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every signal in the database carries its evidence', () => {
  const { db, dir } = runChain();
  try {
    const rows = db.prepare(
      'SELECT ticker, evidence_text, confidence_score FROM trade_signals ORDER BY segment_start_index',
    ).all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.evidence_text && row.evidence_text.length > 20,
        `${row.ticker} carries the text it was read from`);
      assert.ok(row.evidence_text.includes(row.ticker), `${row.ticker} is named in its own evidence`);
      assert.ok(row.confidence_score > 0 && row.confidence_score <= 1,
        'the confidence score is in range');
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The dashboard renders what the chain found
// ---------------------------------------------------------------------------

test('the dashboard renders every signal and its evidence', () => {
  const { db, dir } = runChain();
  try {
    const rows = db.prepare(
      'SELECT s.video_id AS video_id, v.upload_date AS upload_date, s.event_time_sec AS event_time_sec, '
      + 's.ticker AS ticker, s.action AS action, s.bias AS bias, s.confidence_label AS confidence_label, '
      + 's.confidence_score AS confidence_score, s.entry_price AS entry_price, '
      + 's.target_price_low AS target_price_low, s.target_price_high AS target_price_high, '
      + 's.stop_price AS stop_price, s.horizon_text AS horizon_text, s.rationale AS rationale, '
      + 's.evidence_text AS evidence_text '
      + 'FROM trade_signals s JOIN videos v ON v.video_id = s.video_id '
      + 'ORDER BY s.segment_start_index',
    ).all();

    const html = buildSevcikReportHtml({
      generated_at: '2026-11-04T00:00:00Z',
      signal_count: rows.length,
      video_count: 1,
      unique_tickers: new Set(rows.map((row) => row.ticker)).size,
      signals: rows,
      daily: [],
      ticker_summary: [],
    });

    assert.ok(html.includes('TSLA'), 'the dashboard names the ticker');
    assert.ok(html.includes('NVDA'));
    assert.equal((html.match(/<tr class="sig"/g) || []).length, rows.length,
      'the dashboard has one row per signal');
    assert.ok(!html.includes('AAPL'), 'the watched-only name is not published');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
