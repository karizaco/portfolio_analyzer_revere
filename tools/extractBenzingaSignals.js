'use strict';

// The Benzinga signal extractor.
//
// HOW IT DIFFERS FROM extractT3liveSignals.js
//
// It runs the SAME shared engine (src/sevcik/signalExtractor.js) with the
// same English settings T3Live uses, and then applies three Benzinga
// corrections on the result. The corrections are a POST-PASS, not a change
// to the shared engine, so Sevcik's and T3Live's numbers cannot move --
// which is the project's rule for a change to the shared vocabulary.
//
// THE THREE CORRECTIONS
//
//   1. ATTRIBUTION. A news channel reports other people's opinions. "Wedbush's
//      Dan Ives remains very bullish on Tesla" is not Benzinga's call, and
//      the shared extractor published it as a bullish TSLA at confidence 0.83
//      (measured 2026-11-11). Such a claim is TAGGED `reported` rather
//      than dropped, and the outcome analysis leaves it out.
//
//   2. OPTIONS DIRECTION. "I'm going to sell some puts" is a BULLISH
//      position, and the shared extractor reads the "sell" and calls it
//      bearish -- which is backwards. The Drift is an options show, so this
//      is its normal vocabulary.
//
//   3. SECTION. A show's recap of what already happened is not a
//      prediction, and a sponsor's segment is not a call at all. The
//      section is read off the transcript around the claim.
//
// THE PARSER VERSION
//
// `benzinga-signals-1` is written onto every signal row, so a re-run with a
// changed parser can be told apart from the previous one.
//
// Usage:
//   node tools/extractBenzingaSignals.js
//   node tools/extractBenzingaSignals.js --limit 10
//   node tools/extractBenzingaSignals.js --video-id abc123
//   node tools/extractBenzingaSignals.js --json
//   node tools/extractBenzingaSignals.js --dry-run

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { extractSignals } = require('../src/sevcik/signalExtractor');
const { findEnglishCompanyNames, ENGLISH_SYMBOL_STOPLIST } = require('../src/t3live/englishNames');
const { BENZINGA_CHANNEL } = require('../src/benzinga/channel');
const { benzingaVideoQuarantine, classifyBenzingaVideo } = require('../src/benzinga/contentFilter');
const { reportedClaim, isBrokerMention } = require('../src/benzinga/attribution');
const { optionsDirection, isOptionsText } = require('../src/benzinga/options');
const { benzingaSymbolStoplist } = require('../src/benzinga/symbols');
const { sectionAt } = require('../src/benzinga/sections');
const { attachSegments, runExtraction } = require('../src/transcript/extractRunner');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

/**
 * The parser version written onto every signal row.
 *
 * 1 (2026-11-12): the shared English engine, plus the attribution tag, the
 * options direction, and the section tag.
 */
const PARSER_VERSION = 'benzinga-signals-2';

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
  includeQuarantine: argv.includes('--include-quarantine'),
  dryRun: argv.includes('--dry-run'),
};

/**
 * Apply the Benzinga corrections to one video's signals.
 *
 * @param {Array<object>} signals - the shared engine's output
 * @param {Array<object>} segments - the transcript's segments
 * @returns {Array<object>}
 */
function applyBenzingaRules(signals, segments) {
  return signals.map((signal) => {
    const text = signal.evidence_text || '';
    const out = { ...signal };

    // -- the section the claim was made in ------------------------------
    const section = sectionAt(segments, signal.segment_start_index);
    out.section = section;

    // -- the options direction ------------------------------------------
    const optionsCall = optionsDirection(text);
    if (optionsCall && optionsCall.direction !== 'neutral' && out.bias !== 'mixed') {
      // The options construction IS the position, so it wins over the verb
      // the shared extractor read. A "sell" of a put is a bullish position.
      out.bias = optionsCall.direction;
      out.action = optionsCall.kind;
      out.options_kind = optionsCall.kind;
    } else if (optionsCall) {
      out.options_kind = optionsCall.kind;
    }

    // A strike price is not an entry price. "at the 80 strike" is where
    // the option is written.
    if (isOptionsText(text)) {
      out.entry_price = null;
      out.stop_price = null;
      out.target_price_low = null;
      out.target_price_high = null;
    }

    // -- whose opinion is it ---------------------------------------------
    const reported = reportedClaim(text);
    if (reported.reported) {
      out.claim_kind = 'reported';
      out.reported_cue = reported.cue;
      // A reported opinion is not a prediction, so it carries no direction
      // to score. The claim stays, and its evidence stays, so a reader can
      // see what was said and who said it.
      out.bias = 'neutral';
      out.action = out.action === '' ? 'watch' : out.action;
      out.confidence_score = null;
    }

    // A BROKER's own name is never a call on the broker.
    if (isBrokerMention(text, out.ticker)) {
      out.claim_kind = 'reported';
      out.bias = 'neutral';
      out.action = out.action === '' ? 'watch' : out.action;
      out.confidence_score = null;
      out.broker_mention = true;
    }

    // -- a recap is history ---------------------------------------------
    if (section === 'recap' && out.claim_kind === 'forward') {
      out.claim_kind = 'retrospective';
    }
    // A sponsor's segment is not a call.
    if (section === 'sponsor') {
      out.claim_kind = 'sponsor';
      out.bias = 'neutral';
      out.confidence_score = null;
    }

    out.parser_version = PARSER_VERSION;
    return out;
  });
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const lexicon = loadSevcikLexicon();
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  attachSegments(db);

  const perVideo = [];

  const result = runExtraction(db, {
    channel: options.channel,
    videoId: options.videoId,
    limit: options.limit,
    quarantine: benzingaVideoQuarantine,
    includeQuarantine: options.includeQuarantine,
    dryRun: options.dryRun,
    parserVersion: PARSER_VERSION,
    label: 'benzinga-signals',
    extract: (segments, video) => {
      const signals = extractSignals({
        segments,
        parserVersion: PARSER_VERSION,
        lexicon,
        // The CAPS rule is the gate, exactly as for T3Live: YouTube's
        // auto-captions write a spoken ticker in capitals and an ordinary
        // word in sentence case.
        confirmedSymbols: null,
        requireCapsSymbols: true,
        // Benzinga's own stoplist on top of T3Live's: the indicators the
        // hosts say out loud ("20 DMA", "RSI", "the VIX") and the index
        // futures ("ES", "NQ"), which are market positions and not
        // holdings. The pilot published both as tickers.
        symbolStoplist: benzingaSymbolStoplist(ENGLISH_SYMBOL_STOPLIST),
        nameFinderFn: findEnglishCompanyNames,
        videoId: video.video_id,
        transcriptId: video.transcript_id,
      });
      return applyBenzingaRules(signals, segments);
    },
    onVideo: (video, signals, segments) => {
      const classification = classifyBenzingaVideo({
        title: video.title,
        duration_sec: video.duration_sec,
        live_status: video.live_status,
        listing_kind: video.listing_kind,
      });
      const kinds = {};
      for (const signal of signals) kinds[signal.claim_kind] = (kinds[signal.claim_kind] || 0) + 1;
      perVideo.push({
        video_id: video.video_id,
        upload_date: video.upload_date,
        show: classification.show,
        partner: classification.partner,
        segments: segments.length,
        signals: signals.length,
        by_claim_kind: kinds,
        tickers: [...new Set(signals.map((signal) => signal.ticker))].sort(),
      });
      console.log(`[benzinga-signals] ${video.video_id} ${video.upload_date} [${classification.show}] `
        + `${segments.length} segments -> ${signals.length} signals `
        + `${JSON.stringify(kinds)}`
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
    console.log(`[benzinga-signals] done: ${result.signals} signal(s) from ${result.videos} video(s)`);
  }
}

module.exports = { PARSER_VERSION, applyBenzingaRules };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[benzinga-signals] failed: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  }
}
