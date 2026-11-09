'use strict';

// Read the transcripts and write the SETUPS.
//
// WHAT IT DOES
//
// For every video that has a transcript, this runs the setup segmenter over
// the transcript's segments and writes what it found into
// `sevcik_setups`.
//
// A SETUP is not a signal. The speaker does not disclose positions; he
// describes setups and ideas. A signal is a trade-shaped sentence; a setup
// is the THING he is talking about, which may be talked about for ten
// minutes, revisited, and end up worked, failed, or invalidated.
//
// So this is the table that answers the questions a viewer of the stream
// actually asks:
//
//   how many setups did he describe in this video?
//   which tickers were they on?
//   which ones were still running at the end?
//   which ones worked, and which were killed?
//
// and, per setup, how CERTAIN he was -- the scale in `src/sevcik/certainty.js`.
//
// The evidence text is stored with every setup, so a claim can always be
// checked against the words it came from.
//
// RE-RUNS
//
// A re-run replaces the setups of the videos it processed, and only those.
// It does not delete the setups of videos it did not reach -- so a partial
// run never loses work.
//
// The `parser_version` column records which segmenter produced a row, so a
// setup from an older parser can be told apart from a current one.
//
// Usage:
//   node tools/extractSevcikSetups.js
//   node tools/extractSevcikSetups.js --limit 3
//   node tools/extractSevcikSetups.js --video-id abc123
//   node tools/extractSevcikSetups.js --json
//   node tools/extractSevcikSetups.js --dry-run

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { findSetups } = require('../src/sevcik/setupSegmenter');
const { SEVCIK_CHANNEL } = require('../src/sevcik/channel');
const { sevcikVideoQuarantine } = require('../src/sevcik/contentFilter');
const { attachSegments } = require('../src/transcript/segmentStore');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

/**
 * The version of the segmenter. It is written onto every setup row, so a
 * re-run with a changed segmenter can be told apart from the previous one.
 */
// 4 (2026-11-09): rolling YouTube caption cues are collapsed first, so a
// setup's mentions and evidence no longer count every line twice.
const PARSER_VERSION = 'sevcik-setups-4';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || SEVCIK_CHANNEL,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  includeQuarantine: argv.includes('--include-quarantine'),
};

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const lexicon = loadSevcikLexicon();
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  // `transcript_segments` is not in the catalog -- it is a cache in its own
  // untracked file, and attaching it is what makes the unqualified SQL below
  // resolve to that file. See src/transcript/segmentStore.js.
  attachSegments(db);

  const videos = selectVideos(db);
  console.log(`[sevcik-setups] videos=${videos.length} channel=${options.channel}`
    + ` lexicon=${lexicon.size} parser=${PARSER_VERSION}${options.dryRun ? ' DRY-RUN' : ''}`);

  const perVideo = [];
  let totalSetups = 0;

  for (const video of videos) {
    const segments = loadSegments(video.transcript_id, video.video_id, db);
    const setups = findSetups({
      segments,
      lexicon,
      videoId: video.video_id,
    });

    if (!options.dryRun && setups.length) {
      replaceSetups(db, video.video_id, video.transcript_id, setups, segments);
    }

    totalSetups += setups.length;
    const states = {};
    for (const setup of setups) states[setup.state] = (states[setup.state] || 0) + 1;

    perVideo.push({
      video_id: video.video_id,
      upload_date: video.upload_date,
      provider: video.provider,
      segments: segments.length,
      setups: setups.length,
      tickers: setups.map((setup) => setup.ticker),
      states,
    });

    console.log(`[sevcik-setups] ${video.video_id} ${video.upload_date} `
      + `${segments.length} segments -> ${setups.length} setup(s)`
      + `${setups.length ? ` (${setups.map((setup) => setup.ticker).join(' ')})` : ''}`);
  }

  db.close();

  const summary = {
    videos: videos.length,
    setups: totalSetups,
    parser_version: PARSER_VERSION,
    dry_run: options.dryRun,
    per_video: perVideo,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[sevcik-setups] done: ${totalSetups} setup(s) from ${videos.length} video(s)`);
  }
}

/**
 * The videos whose transcripts have been read.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
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
 * transcript FILE when they are not.
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
 * Replace the setups of one video.
 *
 * The setups of the video are deleted and the new ones inserted, so a
 * re-run with a changed segmenter does not leave the old rows behind next
 * to the new ones. Only THIS video's setups are touched.
 *
 * @param {DatabaseSync} db
 * @param {string} videoId
 * @param {number} transcriptId
 * @param {Array<object>} setups
 * @param {Array<object>} segments
 */

function ensureSevcikSetupsSchema(db) {
  try { db.exec('ALTER TABLE sevcik_setups ADD COLUMN claim_kind TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE sevcik_setups ADD COLUMN bias TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE sevcik_setups ADD COLUMN is_prediction INTEGER'); } catch (_) {}
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sevcik_setups'").get();
  const sql = String((master && master.sql) || '');
  if (!/UNIQUE\s*\(\s*video_id\s*,\s*ticker\s*\)/i.test(sql)) return;

  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE sevcik_setups_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      transcript_id INTEGER,
      ticker TEXT NOT NULL,
      spoken_name TEXT,
      state TEXT,
      states TEXT,
      mentions INTEGER,
      segment_start_index INTEGER,
      segment_end_index INTEGER,
      event_time_sec REAL,
      certainty_level TEXT,
      certainty_confidence REAL,
      certainty_marker TEXT,
      probability REAL,
      direction_uncertain INTEGER,
      still_running INTEGER,
      invalidated INTEGER,
      worked INTEGER,
      failed INTEGER,
      claim_kind TEXT,
      evidence_text TEXT,
      parser_version TEXT
    )`);
    db.exec(`INSERT INTO sevcik_setups_v2 (
      video_id, transcript_id, ticker, spoken_name, state, states, mentions,
      segment_start_index, segment_end_index, event_time_sec, certainty_level,
      certainty_confidence, certainty_marker, probability, direction_uncertain,
      still_running, invalidated, worked, failed, claim_kind, evidence_text, parser_version
    ) SELECT
      video_id, transcript_id, ticker, spoken_name, state, states, mentions,
      segment_start_index, segment_end_index, event_time_sec, certainty_level,
      certainty_confidence, certainty_marker, probability, direction_uncertain,
      still_running, invalidated, worked, failed, claim_kind, evidence_text, parser_version
    FROM sevcik_setups`);
    db.exec('DROP TABLE sevcik_setups');
    db.exec('ALTER TABLE sevcik_setups_v2 RENAME TO sevcik_setups');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sevcik_setups_video ON sevcik_setups(video_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sevcik_setups_ticker ON sevcik_setups(ticker)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function replaceSetups(db, videoId, transcriptId, setups, segments) {
  ensureSevcikSetupsSchema(db);

  db.prepare('DELETE FROM sevcik_setups WHERE video_id = ?').run(videoId);

  const insert = db.prepare(
    'INSERT INTO sevcik_setups (video_id, transcript_id, ticker, spoken_name, state, states, '
    + 'mentions, segment_start_index, segment_end_index, event_time_sec, certainty_level, '
    + 'certainty_confidence, certainty_marker, probability, direction_uncertain, still_running, '
    + 'invalidated, worked, failed, claim_kind, bias, is_prediction, evidence_text, parser_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  for (const setup of setups) {
    insert.run(
      videoId,
      transcriptId,
      setup.ticker,
      setup.spoken_name || '',
      setup.state,
      JSON.stringify(Array.isArray(setup.states) ? setup.states : []),
      setup.mentions,
      setup.first_index,
      setup.last_index,
      Number(segments[setup.first_index] ? segments[setup.first_index].start_sec : 0) || 0,
      setup.certainty_level,
      setup.certainty_confidence,
      setup.certainty_marker || '',
      setup.probability === undefined ? null : setup.probability,
      setup.direction_uncertain ? 1 : 0,
      setup.still_running ? 1 : 0,
      setup.invalidated ? 1 : 0,
      setup.worked ? 1 : 0,
      setup.failed ? 1 : 0,
      setup.claim_kind || '',
      setup.bias || '',
      setup.is_prediction ? 1 : 0,
      (setup.evidence || []).join('\n'),
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
  console.error(`[sevcik-setups] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
