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
const { attachSegments, runExtraction } = require('../src/transcript/extractRunner');
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

  const perVideo = [];

  const result = runExtraction(db, {
    channel: options.channel,
    videoId: options.videoId,
    limit: options.limit,
    quarantine: t3liveVideoQuarantine,
    includeQuarantine: options.includeQuarantine,
    dryRun: options.dryRun,
    parserVersion: PARSER_VERSION,
    label: 't3live-signals',
    extract: (segments, video) => extractSignals({
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
    }),
    onVideo: (video, signals, segments) => {
      const classification = classifyT3liveVideo(video.title);
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
    console.log(`[t3live-signals] done: ${totalSignals} signal(s) from ${videos.length} video(s)`);
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
