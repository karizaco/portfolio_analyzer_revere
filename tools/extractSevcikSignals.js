'use strict';

// Read the transcripts and write the trade signals.
//
// WHAT IT DOES
//
// For every video that has a transcript, this runs the deterministic signal
// extractor over the transcript's segments and writes what it found into
// `trade_signals`.
//
// The evidence text is stored with every signal, so a claim can always be
// checked against the words it came from. That is the point of the whole
// table: a signal without its evidence is not checkable, and a portfolio
// report of unchecked claims is worth nothing.
//
// RE-RUNS
//
// A re-run replaces the signals of the videos it processed, and only those.
// It does not delete the signals of videos it did not reach -- so a partial
// run never loses work.
//
// The `parser_version` column records which extractor produced a row, so a
// signal from an older parser can be told apart from a current one.
//
// Usage:
//   node tools/extractSevcikSignals.js
//   node tools/extractSevcikSignals.js --limit 3
//   node tools/extractSevcikSignals.js --video-id abc123
//   node tools/extractSevcikSignals.js --json
//   node tools/extractSevcikSignals.js --dry-run

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { loadConfirmedNames } = require('../src/sevcik/companyNames');
const { extractSignals, PARSER_VERSION } = require('../src/sevcik/signalExtractor');
const { SEVCIK_CHANNEL } = require('../src/sevcik/channel');
const { sevcikVideoQuarantine } = require('../src/sevcik/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || SEVCIK_CHANNEL,
  json: argv.includes('--json'),
  includeQuarantine: argv.includes('--include-quarantine'),
  dryRun: argv.includes('--dry-run'),
};

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  // The Sevcik allow list, NOT the shared seed.
  //
  // The seed is the allow list for the OCR channels and it is built
  // around two boards this source has nothing to do with. This speaker
  // names large caps the seed does not carry -- and with the seed, the
  // extractor found NOTHING in the whole corpus, because the names he
  // says ("Tesla", "Apple", "Amazon") are not in it.
  const lexicon = loadSevcikLexicon();

  // The tickers that may be read as a SPOKEN SYMBOL.
  //
  // The Sevcik lexicon has 10,485 tickers, and the SEC's list carries
  // one- and two-letter registrants that ordinary Czech speech is full
  // of: M, E, A, V, SE, EL, P, TAK. So a symbol token has to be one that
  // was CONFIRMED as a symbol before it counts.
  const confirmedSymbols = new Set(Object.values(loadConfirmedNames()));
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));

  const registered = registerDiskTranscripts(db);
  if (registered) {
    console.log(`[sevcik-signals] registered ${registered} disk transcript(s) into video_transcripts`);
  }
  const videos = selectVideos(db);
  console.log(`[sevcik-signals] videos=${videos.length} channel=${options.channel}`
    + ` lexicon=${lexicon.size} parser=${PARSER_VERSION}${options.dryRun ? ' DRY-RUN' : ''}`);

  const perVideo = [];
  let totalSignals = 0;

  for (const video of videos) {
    const segments = loadSegments(video.transcript_id, video.video_id, db);
    const signals = extractSignals({
      segments,
      lexicon,
      confirmedSymbols,
      videoId: video.video_id,
      transcriptId: video.transcript_id,
    });

    if (!options.dryRun && signals.length) {
      replaceSignals(db, video.video_id, video.transcript_id, signals);
    }

    totalSignals += signals.length;
    perVideo.push({
      video_id: video.video_id,
      upload_date: video.upload_date,
      provider: video.provider,
      segments: segments.length,
      signals: signals.length,
      tickers: [...new Set(signals.map((signal) => signal.ticker))].sort(),
      with_entry: signals.filter((signal) => signal.entry_price !== null).length,
      with_target: signals.filter((signal) => signal.target_price_low !== null).length,
    });

    console.log(`[sevcik-signals] ${video.video_id} ${video.upload_date} `
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
    console.log(`[sevcik-signals] done: ${totalSignals} signal(s) from ${videos.length} video(s)`);
  }
}

/**
 * The videos whose transcripts have been read.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
/**
 * Register Sevcik transcript JSON files that exist on disk but are missing
 * from video_transcripts. Without this, extract only sees the subset that
 * fetch already wrote to SQLite, and hundreds of on-disk transcripts stay idle.
 *
 * @param {DatabaseSync} db
 * @returns {number} newly registered rows
 */
function registerDiskTranscripts(db) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return 0;
  const channel = options.channel || SEVCIK_CHANNEL;
  const existing = new Set(
    db.prepare('SELECT video_id FROM video_transcripts').all().map((r) => r.video_id),
  );
  const catalog = new Map(
    db.prepare('SELECT video_id, upload_date, title FROM videos WHERE channel = ?').all(channel)
      .map((r) => [r.video_id, r]),
  );

  let registered = 0;
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => /^[\w-]{6,}\.json$/i.test(name));
  const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');
  const crypto = require('node:crypto');

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

    const filePath = require('node:path').join(TRANSCRIPTS_DIR, name);
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
    const relPath = require('node:path').relative(ROOT, filePath).replace(/\\/g, '/');

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
      console.error(`[sevcik-signals] register failed ${videoId}: ${error.message}`);
    }
  }
  return registered;
}


function selectVideos(db) {
  const filters = ['t.video_id IS NOT NULL'];
  const params = [];
  let sql = `SELECT v.video_id, v.upload_date, v.title, t.id AS transcript_id, t.provider,
                    t.transcript_path, t.segment_count
             FROM video_transcripts t
             JOIN videos v ON v.video_id = t.video_id
             WHERE ${filters.join(' AND ')}`;
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
    rows = rows.filter((row) => !sevcikVideoQuarantine(row).quarantined);
  }
  return options.limit ? rows.slice(0, options.limit) : rows;
}

/**
 * The transcript's segments.
 *
 * The segments come from the DATABASE when they are there, and from the
 * transcript FILE when they are not. The file is the fallback because a
 * transcript can exist on disk before its segments have been written -- and
 * a transcript that is on disk but unreadable would silently produce no
 * signals.
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
    const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');
    return normalizeTranscript(body, body.provider);
  } catch {
    return [];
  }
}

/**
 * Replace the signals of one video.
 *
 * The signals of the video are deleted and the new ones inserted, so a
 * re-run with a changed parser does not leave the old rows behind next to
 * the new ones. Only THIS video's signals are touched -- the signals of
 * other videos are none of this run's business.
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
      signal.parser_version,
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
  console.error(`[sevcik-signals] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
