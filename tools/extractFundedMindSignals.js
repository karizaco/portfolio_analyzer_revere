'use strict';

// Extract trade signals from FundedMind transcripts.
//
// FundedMind is multi-host CZ/SK prop desks. Do NOT run the Sevcik equity
// extractor here: instruments are often gold/FX/crypto/indices, and Czech
// function words collide with short SEC tickers.
//
// Usage:
//   node tools/extractFundedMindSignals.js --limit 5
//   node tools/extractFundedMindSignals.js --video-id DGj_jwNtVkg
//   node tools/extractFundedMindSignals.js --limit 5 --dry-run --json
//   node tools/extractFundedMindSignals.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');
const { FUNDEDMIND_CHANNEL } = require('../src/fundedmind/channel');
const {
  fundedmindVideoQuarantine,
  hostFromTitle,
  sessionKind,
} = require('../src/fundedmind/contentFilter');
const { extractSignals, PARSER_VERSION } = require('../src/fundedmind/signalExtractor');
const { attachSegments, runExtraction } = require('../src/transcript/extractRunner');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || FUNDEDMIND_CHANNEL,
  json: argv.includes('--json'),
  includeQuarantine: argv.includes('--include-quarantine'),
  dryRun: argv.includes('--dry-run'),
};

function readFlag(list, name) {
  const i = list.indexOf(name);
  if (i === -1) return '';
  return list[i + 1] || '';
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  db.exec('PRAGMA busy_timeout = 30000');
  try {
    db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  } catch (_) {
    // schema may already be applied
  }
  attachSegments(db);

  const perVideo = [];

  const result = runExtraction(db, {
    channel: options.channel,
    videoId: options.videoId || undefined,
    limit: options.limit || undefined,
    quarantine: fundedmindVideoQuarantine,
    includeQuarantine: options.includeQuarantine,
    dryRun: options.dryRun,
    parserVersion: PARSER_VERSION,
    label: 'fundedmind-signals',
    extract: (segments, video) => extractSignals(segments, {
      video_id: video.video_id,
      transcript_id: video.transcript_id,
      title: video.title || '',
      upload_date: video.upload_date || '',
    }),
    onVideo: (video, signals, segments) => {
      const host = hostFromTitle(video.title || '');
      const kind = sessionKind(video.title || '');
      const tickers = [...new Set(signals.map((s) => s.ticker))].sort();
      perVideo.push({
        video_id: video.video_id,
        upload_date: video.upload_date,
        host,
        kind,
        provider: video.provider,
        segments: segments.length,
        signals: signals.length,
        tickers,
        sample_evidence: signals.slice(0, 3).map((s) => ({
          ticker: s.ticker,
          action: s.action,
          evidence: String(s.evidence_text || '').slice(0, 120),
        })),
      });
      console.error(
        `[fundedmind-signals] ${video.video_id} ${video.upload_date || ''} [${kind}|${host}] `
        + `${segments.length} segments -> ${signals.length} signals`
        + (tickers.length ? ` (${tickers.join(' ')})` : ''),
      );
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
    console.error(`[fundedmind-signals] done: ${result.signals} signal(s) from ${result.videos} video(s)`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[fundedmind-signals] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
