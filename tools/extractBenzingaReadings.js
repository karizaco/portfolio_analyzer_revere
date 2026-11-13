'use strict';

// Write the market, sector and macro-event readings a show makes.
//
// WHAT IT DOES
//
// For every Benzinga video with a transcript, it runs
// src/benzinga/marketReadings.js over the segments and writes what it
// found into `market_readings`.
//
// The rows carry the EXACT sentence they were read from, for the same
// reason every claim in this pipeline does: a reading you cannot point at
// is a reading you cannot check.
//
// RE-RUNS
//
// A re-run replaces the readings of the videos it processed, and only
// those -- the same rule the signal extractor follows.
//
// Usage:
//   node tools/extractBenzingaReadings.js
//   node tools/extractBenzingaReadings.js --limit 5
//   node tools/extractBenzingaReadings.js --video-id abc123
//   node tools/extractBenzingaReadings.js --json

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { extractReadings } = require('../src/benzinga/marketReadings');
const { sectionAt } = require('../src/benzinga/sections');
const { BENZINGA_CHANNEL } = require('../src/benzinga/channel');
const { attachSegments, runExtraction } = require('../src/transcript/extractRunner');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

/** The parser version written onto every reading row. */
const PARSER_VERSION = 'benzinga-readings-1';

/**
 * THE STANCE RULES, by name. Measured against a hand-labelled sample of
 * 40 readings on 2026-11-13 (29 correct, 11 wrong):
 *
 *   shipped               40 readings survive, 29 right = 72.5 % precision
 *   same-clause           33 survive, 26 right = 78.8 %
 *   after-only            21 survive, 19 right = 90.5 %
 *   same-clause+after     20 survive, 19 right = 95.0 %
 *
 * The choice is not "which rule is best" but how many readings to keep
 * against how clean they are. `same-clause` drops 3 correct readings to
 * remove 4 wrong ones; `after-only` drops 10 correct to remove 9.
 */
const STANCE_RULES = {
  shipped: {},
  'same-clause': { sameClause: true },
  'after-only': { afterOnly: true },
  'same-clause+after': { sameClause: true, afterOnly: true },
};

const argv = process.argv.slice(2);

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || BENZINGA_CHANNEL,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  stanceRule: readFlag(argv, '--stance-rule') || 'shipped',
};


// The stance rule, resolved once the options exist.
const stanceOptions = STANCE_RULES[options.stanceRule] || STANCE_RULES.shipped;
/**
 * Replace the readings of one video.
 *
 * @param {DatabaseSync} db
 * @param {string} videoId
 * @param {number} transcriptId
 * @param {Array<object>} readings
 */
function replaceReadings(db, videoId, transcriptId, readings) {
  db.prepare('DELETE FROM market_readings WHERE video_id = ?').run(videoId);
  const insert = db.prepare(
    'INSERT INTO market_readings (video_id, transcript_id, scope, subject, proxy_ticker, stance, '
    + 'claim_kind, section, horizon_text, event_date, event_time_sec, evidence_text, parser_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const reading of readings) {
    insert.run(
      videoId,
      reading.transcript_id === null ? transcriptId : reading.transcript_id,
      reading.scope,
      reading.subject,
      reading.proxy_ticker,
      reading.stance,
      reading.claim_kind,
      reading.section,
      reading.horizon_text,
      reading.event_date,
      reading.event_time_sec,
      reading.evidence_text,
      reading.parser_version,
    );
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  attachSegments(db);

  const perVideo = [];

  // The readings are extracted from EVERY transcript, including the ones
  // whose show is quarantined for SIGNALS: an earnings call still says
  // something about the market and the sector. The market_update shows
  // are the reason the pipeline fetches them at all.
  const result = runExtraction(db, {
    channel: options.channel,
    videoId: options.videoId,
    limit: options.limit,
    dryRun: options.dryRun,
    label: 'benzinga-readings',
    // The readings have their OWN table. The default writer would wipe
    // the video's trade_signals rows, which are a different artifact.
    replace: replaceReadings,
    extract: (segments, video) => extractReadings(segments, {
      videoId: video.video_id,
      transcriptId: video.transcript_id,
      // The section is read for the segment a reading is in: a show
      // moves from the recap to the preview, and a reading in the recap
      // is history while one in the preview is a prediction.
      sectionAt: (index) => sectionAt(segments, index),
      parserVersion: PARSER_VERSION,
      // THE STANCE RULE, so it can be measured rather than argued.
      // `--stance-rule shipped` is the behaviour that shipped.
      stanceOptions: stanceOptions,
    }),
    onVideo: (video, signals, segments) => {
      perVideo.push({
        video_id: video.video_id,
        upload_date: video.upload_date,
        segments: segments.length,
        readings: signals.length,
      });
      console.log(`[benzinga-readings] ${video.video_id} ${video.upload_date} `
        + `${segments.length} segments -> ${signals.length} reading(s)`);
    },
  });

  db.close();

  const summary = {
    videos: result.videos,
    readings: result.signals,
    parser_version: PARSER_VERSION,
    dry_run: options.dryRun,
    per_video: perVideo,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[benzinga-readings] done: ${result.signals} reading(s) from ${result.videos} video(s)`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[benzinga-readings] failed: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  }
}
