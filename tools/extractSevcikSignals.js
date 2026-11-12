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
const { attachSegments, runExtraction } = require('../src/transcript/extractRunner');

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
  // Another tool (the caption fetcher) may be writing the catalog at the
  // same time; wait for its lock instead of failing the run.
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  // `transcript_segments` is not in the catalog -- it is a cache in its own
  // untracked file, and attaching it is what makes the unqualified SQL below
  // resolve to that file. See src/transcript/segmentStore.js.
  attachSegments(db);

  const perVideo = [];

  const result = runExtraction(db, {
    channel: options.channel,
    videoId: options.videoId,
    limit: options.limit,
    quarantine: sevcikVideoQuarantine,
    includeQuarantine: options.includeQuarantine,
    dryRun: options.dryRun,
    parserVersion: PARSER_VERSION,
    label: 'sevcik-signals',
    extract: (segments, video) => extractSignals({
      segments,
      lexicon,
      confirmedSymbols,
      videoId: video.video_id,
      transcriptId: video.transcript_id,
    }),
    onVideo: (video, signals, segments) => {
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
    },
  });

  db.close();

  const summary = {
    videos: result.videos,
    signals: result.signals,
    parser_version: PARSER_VERSION,
    dry_run: options.dryRun,
    per_video: perVideo,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[sevcik-signals] done: ${result.signals} signal(s) from ${result.videos} video(s)`);
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
