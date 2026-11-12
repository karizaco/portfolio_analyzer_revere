'use strict';

// The shared runner behind every transcript source's signal extractor.
//
// WHY IT EXISTS
//
// `tools/extractSevcikSignals.js` and `tools/extractT3liveSignals.js` were
// COPIES of each other, and the copies drifted in a way that cost data:
//
//   * the Sevcik copy replaced a video's rows only when the new run found
//     signals. A video whose signals went to zero kept its OLD rows, from an
//     OLD parser version. Measured on the shipped catalog: 8 rows from
//     parser versions 3 and 4 survived on 4 videos -- one quarantined video
//     that is never revisited, and three that now yield zero signals. Those
//     rows were still aggregated and scored.
//
//   * the Sevcik copy never revisits a quarantined video, so its rows are
//     never cleared either.
//
// One runner, used by every source, fixes both: a video's rows are ALWAYS
// replaced, including with zero rows.
//
// WHAT IT DOES, IN ORDER
//
//   1. register the transcript files that exist on disk but not in the
//      database (`video_transcripts` + `transcript_segments`)
//   2. select the videos to read (channel, optional id, quarantine filter)
//   3. read the segments (the database first, the file as the fallback)
//   4. run the caller's extractor over them
//   5. replace that video's rows, in ONE transaction
//
// The caller supplies the source-specific parts: the lexicon, the name
// finder, the symbol rules, the quarantine, and the parser version.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { attachSegments } = require('./segmentStore');
const { normalizeTranscript } = require('./transcriptNormalize');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

/**
 * Register transcript files that are on disk but missing from the database.
 *
 * The file is the record, not the column: a transcript can be fetched
 * before its row is written, and an extractor that reads only the database
 * would silently skip it.
 *
 * @param {DatabaseSync} db
 * @param {{channel: string, videoId?: string}} options
 * @returns {number} the number of newly registered transcripts
 */
function registerDiskTranscripts(db, options = {}) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return 0;
  const channel = options.channel || '';
  const existing = new Set(
    db.prepare('SELECT video_id FROM video_transcripts').all().map((r) => r.video_id),
  );
  const catalog = new Map(
    db.prepare('SELECT video_id FROM videos WHERE channel = ?').all(channel)
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
        videoId, provider, language, relPath, segments.length, checksum, fetchedAt,
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
      console.error(`[extract-runner] register failed ${videoId}: ${error.message}`);
    }
  }
  return registered;
}

/**
 * The videos whose transcripts have been read.
 *
 * @param {DatabaseSync} db
 * @param {{channel?: string, videoId?: string, limit?: number,
 *          quarantine?: Function, includeQuarantine?: boolean}} options
 * @returns {Array<object>}
 */
function selectVideos(db, options = {}) {
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
  if (options.quarantine && !options.includeQuarantine) {
    rows = rows.filter((row) => !options.quarantine(row).quarantined);
  }
  return options.limit ? rows.slice(0, options.limit) : rows;
}

/**
 * The transcript's segments: the DATABASE when they are there, the FILE when
 * they are not. A transcript can be on disk before its segments have been
 * written, and one that is on disk but unreadable would silently produce no
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
    return normalizeTranscript(body, body.provider);
  } catch {
    return [];
  }
}

/**
 * Replace the signals of one video.
 *
 * The rows are deleted and the new ones inserted, so a re-run with a changed
 * parser does not leave the old rows behind next to the new ones. Only THIS
 * video's rows are touched.
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

/**
 * Attach the segments database, unless it is already attached.
 *
 * The tools attach it themselves before calling the runner, and ATTACHing
 * the same alias twice is an error ("database seg is already in use"). So
 * the runner checks first.
 *
 * @param {DatabaseSync} db
 * @param {string} [segmentsPath] - overrides the default file (tests)
 */
function ensureSegmentsAttached(db, segmentsPath) {
  const attached = db.prepare('PRAGMA database_list').all()
    .some((row) => String(row.name) === 'seg');
  if (attached) return;
  attachSegments(db, segmentsPath ? { segmentsPath } : {});
}

/**
 * Run the extractor over every selected video.
 *
 * @param {object} options
 * @param {DatabaseSync} db
 * @param {string} options.channel
 * @param {string} [options.videoId]
 * @param {number} [options.limit]
 * @param {Function} [options.quarantine]
 * @param {boolean} [options.includeQuarantine]
 * @param {boolean} [options.dryRun]
 * @param {string} [options.segmentsPath] - overrides the segments file (tests)
 * @param {Function} options.extract - (segments, video) => Array<object>
 * @param {Function} [options.replace] - (db, videoId, transcriptId, rows) => void
 *   writes the rows; defaults to replaceSignals (trade_signals)
 * @param {Function} [options.onVideo] - (video, signals, segments) => void
 * @param {string} [options.label] - the prefix on the runner's own log lines
 * @returns {{videos: number, signals: number, perVideo: Array<object>}}
 */
function runExtraction(db, options) {
  const label = options.label || 'extract';
  ensureSegmentsAttached(db, options.segmentsPath);
  const registered = registerDiskTranscripts(db, options);
  if (registered) {
    console.log(`[${label}] registered ${registered} disk transcript(s) into video_transcripts`);
  }

  const videos = selectVideos(db, options);
  console.log(`[${label}] videos=${videos.length} channel=${options.channel}`
    + `${options.dryRun ? ' DRY-RUN' : ''}`);

  const perVideo = [];
  let totalSignals = 0;

  for (const video of videos) {
    const segments = loadSegments(video.transcript_id, video.video_id, db);
    const signals = options.extract(segments, video);

    if (!options.dryRun) {
      // One transaction per video: atomic, and one short write lock instead
      // of dozens. The rows are replaced even when there are none, so a
      // video whose calls disappeared does not keep its old rows.
      //
      // `replace` is overridable: the market-readings extractor writes its
      // own table, and it must not touch the signals table.
      const replace = typeof options.replace === 'function' ? options.replace : replaceSignals;
      db.exec('BEGIN IMMEDIATE');
      try {
        replace(db, video.video_id, video.transcript_id, signals);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    }

    totalSignals += signals.length;
    perVideo.push({ video, segments: segments.length, signals });
    if (typeof options.onVideo === 'function') options.onVideo(video, signals, segments);
  }

  return { videos: videos.length, signals: totalSignals, perVideo };
}

module.exports = {
  DB_PATH,
  ROOT,
  TRANSCRIPTS_DIR,
  attachSegments,
  ensureSegmentsAttached,
  loadSegments,
  registerDiskTranscripts,
  replaceSignals,
  runExtraction,
  selectVideos,
};
