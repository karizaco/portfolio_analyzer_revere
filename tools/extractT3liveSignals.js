'use strict';

// Extract trade signals from T3Live transcripts.
//
// HOW THIS DIFFERS FROM extractSevcikSignals.js
//
// The Sevcik pipeline is Czech and uses a position-based name finder that
// drops sentence-start names (because Czech capitalises every sentence-initial
// word). T3Live is English, and "Apple is breaking out" is a valid signal —
// "Apple" at sentence start must NOT be dropped.
//
// So this tool passes `nameFinderFn: findEnglishCompanyNames` to the shared
// extraction engine. Everything else — the run model, the price extraction,
// the confidence scoring, the database schema — is identical.
//
// THE SYMBOL GATE
//
// For Sevcik, a CAPS symbol token must be in the confirmed-names table before
// it counts, because the SEC lexicon has one-letter Czech-word collisions.
// For T3Live, English traders say tickers in CAPS constantly ("NVDA", "AAPL")
// and those tokens are reliable. The confirmed-symbols gate is therefore
// NOT applied here (confirmedSymbols = null means "every symbol in the
// lexicon counts").
//
// THE PARSER VERSION
//
// `t3live-signals-1` is written onto every signal row so a re-run with a
// changed parser can be told apart from the previous one.
//
// Usage:
//   node tools/extractT3liveSignals.js
//   node tools/extractT3liveSignals.js --limit 10
//   node tools/extractT3liveSignals.js --video-id abc123
//   node tools/extractT3liveSignals.js --json
//   node tools/extractT3liveSignals.js --dry-run

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { extractSignals } = require('../src/sevcik/signalExtractor');
const { findEnglishCompanyNames, ENGLISH_SYMBOL_STOPLIST } = require('../src/t3live/englishNames');
const { T3LIVE_CHANNEL } = require('../src/t3live/channel');
const { t3liveVideoQuarantine, classifyT3liveVideo } = require('../src/t3live/contentFilter');
const { attachSegments } = require('../src/transcript/segmentStore');
const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

/**
 * The parser version written onto every signal row.
 *
 * 2 (2026-11-09): rolling caption cues collapsed, negation scoped to its
 * phrase, people and caption acronyms are not tickers, index phrases
 * ("the Qs", "the S&P") resolve to their ETF, "I like it" is weak (0.3),
 * MA added to stoplist, pieceDirection has a minimum-strength gate.
 */
const PARSER_VERSION = 't3live-signals-3';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || T3LIVE_CHANNEL,
  json: argv.includes('--json'),
  includeQuarantine: argv.includes('--include-quarantine'),
  dryRun: argv.includes('--dry-run'),
};

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  // The same lexicon as Sevcik: SEC names + seed + non-US. The T3Live hosts
  // name the same US large caps and the same European names.
  const lexicon = loadSevcikLexicon();

  const db = new DatabaseSync(DB_PATH);
  // The caption fetcher may be writing the catalog at the same time.
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  attachSegments(db);

  const registered = registerDiskTranscripts(db);
  if (registered) {
    console.log(`[t3live-signals] registered ${registered} disk transcript(s) into video_transcripts`);
  }

  const videos = selectVideos(db);
  console.log(`[t3live-signals] videos=${videos.length} channel=${options.channel}`
    + ` lexicon=${lexicon.size} parser=${PARSER_VERSION}${options.dryRun ? ' DRY-RUN' : ''}`);

  const perVideo = [];
  let totalSignals = 0;

  for (const video of videos) {
    const segments = loadSegments(video.transcript_id, video.video_id, db);
    const classification = classifyT3liveVideo(video.title);

    const signals = extractSignals({
      segments,
      lexicon,
      // confirmedSymbols stays null: the CAPS rule below is the gate.
      // YouTube auto-captions write spoken tickers in capitals (IWM, BHC)
      // and ordinary words in sentence case. Requiring capitals drops
      // "for"/"here"/"you", which are real SEC tickers and not calls.
      confirmedSymbols: null,
      requireCapsSymbols: true,
      symbolStoplist: ENGLISH_SYMBOL_STOPLIST,
      // The English name finder does not exclude sentence-start tokens.
      nameFinderFn: findEnglishCompanyNames,
      videoId: video.video_id,
      transcriptId: video.transcript_id,
    });

    if (!options.dryRun) {
      // Always replace, including the zero-signal case. A cleaner parser
      // must not leave the previous run's rows behind. One transaction per
      // video: atomic, and one short write lock instead of dozens.
      db.exec('BEGIN IMMEDIATE');
      try {
        replaceSignals(db, video.video_id, video.transcript_id, signals);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    }

    totalSignals += signals.length;
    perVideo.push({
      video_id: video.video_id,
      upload_date: video.upload_date,
      show: classification.show,
      host: classification.host,
      provider: video.provider,
      segments: segments.length,
      signals: signals.length,
      tickers: [...new Set(signals.map((signal) => signal.ticker))].sort(),
      with_entry: signals.filter((signal) => signal.entry_price !== null).length,
      with_target: signals.filter((signal) => signal.target_price_low !== null).length,
    });

    console.log(`[t3live-signals] ${video.video_id} ${video.upload_date} [${classification.show}] `
      + `${segments.length} segments -> ${signals.length} signals`
      + `${signals.length ? ` (${[...new Set(signals.map((s) => s.ticker))].join(' ')})` : ''}`);
  }

  db.close();

  const summary = {
    videos: videos.length,
    signals: totalSignals,
    parser_version: PARSER_VERSION,
    dry_run: options.dryRun,
    per_video: perVideo,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[t3live-signals] done: ${totalSignals} signal(s) from ${videos.length} video(s)`);
  }
}

/**
 * Register T3Live transcript JSON files that exist on disk but are missing
 * from video_transcripts.
 *
 * @param {DatabaseSync} db
 * @returns {number} newly registered rows
 */
function registerDiskTranscripts(db) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return 0;
  const channel = options.channel || T3LIVE_CHANNEL;
  const existing = new Set(
    db.prepare('SELECT video_id FROM video_transcripts').all().map((r) => r.video_id),
  );
  const catalog = new Map(
    db.prepare('SELECT video_id, upload_date, title FROM videos WHERE channel = ?').all(channel)
      .map((r) => [r.video_id, r]),
  );

  let registered = 0;
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => /^[\w-]{6,}\.json$/i.test(name));

  const insertTranscript = db.prepare(
    'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
    + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  for (const name of files) {
    const videoId = name.slice(0, -5);
    if (existing.has(videoId)) continue;
    if (!catalog.has(videoId)) continue;
    if (options.videoId && options.videoId !== videoId) continue;

    const filePath = path.join(TRANSCRIPTS_DIR, name);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    let segments;
    try {
      segments = normalizeTranscript(body, body.provider || 'manual');
    } catch {
      continue;
    }
    if (!segments.length) continue;

    const providerRaw = String(body.provider || '').toLowerCase();
    const provider = providerRaw === 'deepgram' || providerRaw === 'youtube_auto' || providerRaw === 'manual'
      ? providerRaw
      : (segments.some((seg) => Number.isFinite(seg.confidence)) ? 'deepgram' : 'youtube_auto');
    const language = String(body.language || body.lang || '');
    const textBlob = segments.map((seg) => seg.text || '').join('\n');
    const checksum = crypto.createHash('md5').update(textBlob).digest('hex');
    const fetchedAt = body.fetched_at || new Date().toISOString();
    const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');

    try {
      db.exec('BEGIN');
      const result = insertTranscript.run(
        videoId,
        provider,
        language,
        relPath,
        segments.length,
        checksum,
        fetchedAt,
      );
      const transcriptId = Number(result.lastInsertRowid);
      segments.forEach((segment, index) => {
        insertSegment.run(
          transcriptId,
          videoId,
          index,
          segment.start_sec,
          segment.end_sec,
          segment.text,
          segment.confidence == null ? null : segment.confidence,
        );
      });
      db.exec('COMMIT');
      existing.add(videoId);
      registered += 1;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error(`[t3live-signals] register failed ${videoId}: ${error.message}`);
    }
  }
  return registered;
}

/**
 * The videos whose transcripts have been read.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function selectVideos(db) {
  const params = [];
  let sql = `SELECT v.video_id, v.upload_date, v.title, t.id AS transcript_id, t.provider,
                    t.transcript_path, t.segment_count
             FROM video_transcripts t
             JOIN videos v ON v.video_id = t.video_id
             WHERE t.video_id IS NOT NULL`;
  if (options.channel) {
    sql += ' AND v.channel = ?';
    params.push(options.channel);
  }
  if (options.videoId) {
    sql += ' AND v.video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY v.upload_date DESC, v.video_id ASC';

  let rows = db.prepare(sql).all(...params);
  if (!options.includeQuarantine) {
    rows = rows.filter((row) => !t3liveVideoQuarantine(row).quarantined);
  }
  return options.limit ? rows.slice(0, options.limit) : rows;
}

/**
 * The transcript's segments.
 *
 * @param {number} transcriptId
 * @param {string} videoId
 * @param {DatabaseSync} db
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null}>}
 */
function loadSegments(transcriptId, videoId, db) {
  const rows = db.prepare(
    'SELECT start_sec, end_sec, text, confidence FROM transcript_segments '
    + 'WHERE transcript_id = ? ORDER BY segment_index ASC',
  ).all(transcriptId);
  if (rows.length) {
    return rows.map((row) => ({
      start_sec: Number(row.start_sec),
      end_sec: Number(row.end_sec),
      text: String(row.text || ''),
      confidence: row.confidence === null ? null : Number(row.confidence),
    }));
  }

  const filePath = path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeTranscript(body, body.provider);
  } catch {
    return [];
  }
}

/**
 * Replace the signals of one video.
 *
 * @param {DatabaseSync} db
 * @param {string} videoId
 * @param {number} transcriptId
 * @param {Array<object>} signals
 */
function replaceSignals(db, videoId, transcriptId, signals) {
  try { db.exec('ALTER TABLE trade_signals ADD COLUMN claim_kind TEXT'); } catch (_) {}

  db.prepare('DELETE FROM trade_signals WHERE video_id = ?').run(videoId);

  const insert = db.prepare(
    'INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index, '
    + 'event_time_sec, ticker, action, bias, claim_kind, confidence_label, confidence_score, entry_price, '
    + 'target_price_low, target_price_high, stop_price, horizon_text, rationale, evidence_text, '
    + 'parser_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  for (const signal of signals) {
    insert.run(
      signal.video_id,
      signal.transcript_id === null ? transcriptId : signal.transcript_id,
      signal.segment_start_index,
      signal.segment_end_index,
      signal.event_time_sec,
      signal.ticker,
      signal.action,
      signal.bias,
      signal.claim_kind || 'forward',
      signal.confidence_label,
      signal.confidence_score,
      signal.entry_price,
      signal.target_price_low,
      signal.target_price_high,
      signal.stop_price,
      signal.horizon_text,
      signal.rationale,
      signal.evidence_text,
      PARSER_VERSION,
    );
  }
}

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

try {
  main();
} catch (error) {
  console.error(`[t3live-signals] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
