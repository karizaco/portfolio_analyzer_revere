'use strict';

// Extract trade signals from AsymTrading transcripts.
//
// HOW THIS FITS THE FAMILY
//
// Every source that has speech goes through the SAME extraction engine,
// `src/sevcik/signalExtractor.js`, and differs only in the options it
// passes:
//
//   Sevcik     Czech speech, so company names are found by a POSITION rule
//              (a capitalised word is only a name when it is not the
//              first word of its sentence) and a CAPS symbol has to be in
//              the confirmed-names table.
//   T3Live     English speech, so names are found by the ENGLISH finder
//              (capitalised, not a trading word, in the name table) and a
//              CAPS symbol counts on its own.
//   AsymTrading  English speech, exactly like T3Live.
//
// The reason AsymTrading is treated like T3Live and not like Sevcik is the
// language of the source, and nothing else: the author speaks English, so
// "Apple is breaking out" is a valid name occurrence even when "Apple"
// starts the sentence.
//
// WHY THE SIGNALS GO INTO THE SHARED trade_signals TABLE
//
// The table is keyed on (video_id, transcript_id) and neither of those is
// a YouTube id. `asym_<post_id>` is as good a key as any, and the
// `video_transcripts` row it points at is a real one.
//
// And the other sources' aggregators are NOT contaminated by this: both
// `tools/aggregateSevcikSignals.js` and `tools/aggregateT3liveSignals.js`
// filter with `WHERE v.channel = '...'` over a LEFT JOIN on `videos`. An
// AsymTrading signal has no `videos` row, so `v.channel` is NULL and the
// row is excluded. That is measured, not assumed -- see
// `test/asymPipeline.test.js`.
//
// THE PARSER VERSION
//
// `asym-signals-1` is written onto every signal row, so a re-run with a
// changed parser can be told apart from the previous one.
//
// Usage:
//   node tools/extractAsymSignals.js
//   node tools/extractAsymSignals.js --limit 5
//   node tools/extractAsymSignals.js --video-id asym_222466781
//   node tools/extractAsymSignals.js --json
//   node tools/extractAsymSignals.js --dry-run

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { extractSignals } = require('../src/sevcik/signalExtractor');
const { findEnglishCompanyNames, ENGLISH_SYMBOL_STOPLIST } = require('../src/t3live/englishNames');
const { attachSegments } = require('../src/transcript/segmentStore');
const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

/**
 * The parser version written onto every signal row.
 *
 * 1 (2026-11-12): the first version. It reuses the shared extraction
 * engine with the English name finder and the English CAPS-symbol rule,
 * exactly as the T3Live extractor does.
 */
const PARSER_VERSION = 'asym-signals-1';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  json: argv.includes('--json'),
  includeQuarantine: argv.includes('--include-quarantine'),
  dryRun: argv.includes('--dry-run'),
};

/**
 * Read a flag's value.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string|null}
 */
function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || '';
}

function main() {
  const lexicon = loadSevcikLexicon();

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  attachSegments(db);

  const registered = registerDiskTranscripts(db);
  if (registered) {
    console.log(`[asym-signals] registered ${registered} disk transcript(s) into video_transcripts`);
  }

  const posts = selectPosts(db);
  console.log(`[asym-signals] posts=${posts.length} lexicon=${lexicon.size}`
    + ` parser=${PARSER_VERSION}${options.dryRun ? ' DRY-RUN' : ''}`);

  const perPost = [];
  let totalSignals = 0;

  for (const post of posts) {
    const segments = loadSegments(post.transcript_id, post.video_id, db);

    const signals = extractSignals({
      segments,
      lexicon,
      // The CAPS rule is the gate. The English name finder and the CAPS
      // symbol path are the same ones T3Live uses, because the language
      // is the same.
      confirmedSymbols: null,
      requireCapsSymbols: true,
      symbolStoplist: ENGLISH_SYMBOL_STOPLIST,
      nameFinderFn: findEnglishCompanyNames,
      videoId: post.video_id,
      transcriptId: post.transcript_id,
    });

    if (!options.dryRun) {
      // Always replace, including the zero-signal case: a cleaner parser
      // must not leave the previous run's rows behind. One transaction per
      // post, so a failure leaves the previous state intact.
      db.exec('BEGIN IMMEDIATE');
      try {
        replaceSignals(db, post.video_id, post.transcript_id, signals);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    }

    totalSignals += signals.length;
    perPost.push({
      video_id: post.video_id,
      upload_date: post.upload_date,
      series: post.series,
      provider: post.provider,
      segments: segments.length,
      signals: signals.length,
      tickers: [...new Set(signals.map((signal) => signal.ticker))].sort(),
      with_entry: signals.filter((signal) => signal.entry_price !== null).length,
      with_target: signals.filter((signal) => signal.target_price_low !== null).length,
    });

    console.log(`[asym-signals] ${post.video_id} ${post.upload_date} ${segments.length} segments`
      + ` -> ${signals.length} signals`
      + `${signals.length ? ` (${[...new Set(signals.map((s) => s.ticker))].join(' ')})` : ''}`);
  }

  db.close();

  const summary = {
    posts: posts.length,
    signals: totalSignals,
    parser_version: PARSER_VERSION,
    dry_run: options.dryRun,
    per_post: perPost,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[asym-signals] done: ${totalSignals} signal(s) from ${posts.length} post(s)`);
  }
}

/**
 * Register transcript JSON files that exist on disk but are missing from
 * video_transcripts.
 *
 * @param {DatabaseSync} db
 * @returns {number} newly registered rows
 */
function registerDiskTranscripts(db) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return 0;
  const existing = new Set(
    db.prepare('SELECT video_id FROM video_transcripts').all().map((row) => row.video_id),
  );
  const catalog = new Map(
    db.prepare('SELECT video_id, upload_date, series FROM asym_posts').all()
      .map((row) => [row.video_id, row]),
  );

  let registered = 0;
  const files = fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => /^asym_\d+\.json$/i.test(name));

  const insertTranscript = db.prepare(
    'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
    + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(video_id) DO UPDATE SET provider = excluded.provider, language = excluded.language, '
    + 'transcript_path = excluded.transcript_path, segment_count = excluded.segment_count, '
    + 'checksum = excluded.checksum, fetched_at = excluded.fetched_at, updated_at = datetime(\'now\')',
  );
  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transcript_id, segment_index) DO UPDATE SET '
    + 'start_sec = excluded.start_sec, end_sec = excluded.end_sec, text = excluded.text, '
    + 'confidence = excluded.confidence',
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
      segments = normalizeTranscript(body, body.provider || 'deepgram');
    } catch {
      continue;
    }
    if (!segments.length) continue;

    const providerRaw = String(body.provider || '').toLowerCase();
    const provider = ['deepgram', 'youtube_auto', 'manual'].includes(providerRaw) ? providerRaw : 'deepgram';
    const language = String(body.language || body.lang || '');
    const textBlob = segments.map((segment) => segment.text || '').join('\n');
    const checksum = crypto.createHash('md5').update(textBlob).digest('hex');
    const fetchedAt = body.fetched_at || new Date().toISOString();
    const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');

    try {
      db.exec('BEGIN');
      insertTranscript.run(videoId, provider, language, relPath, segments.length, checksum, fetchedAt);
      const transcriptId = Number(
        db.prepare('SELECT id FROM video_transcripts WHERE video_id = ?').get(videoId).id,
      );
      segments.forEach((segment, index) => {
        insertSegment.run(
          transcriptId,
          videoId,
          index,
          Number(segment.start_sec) || 0,
          Number(segment.end_sec) || 0,
          String(segment.text || ''),
          segment.confidence == null ? null : Number(segment.confidence),
        );
      });
      db.exec('COMMIT');
      existing.add(videoId);
      registered += 1;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      console.error(`[asym-signals] register failed ${videoId}: ${error.message}`);
    }
  }
  return registered;
}

/**
 * The AsymTrading posts whose transcripts have been read.
 *
 * The catalog is `asym_posts`, NOT `videos` -- a Substack post is not a
 * YouTube video and the project deliberately keeps them apart. So this
 * joins the transcript table to `asym_posts` on the catalog id.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function selectPosts(db) {
  const params = [];
  let sql = `SELECT p.video_id, p.upload_date, p.series, p.quarantined, p.quarantine_reason,
                    t.id AS transcript_id, t.provider, t.transcript_path, t.segment_count
               FROM video_transcripts t
               JOIN asym_posts p ON p.video_id = t.video_id
              WHERE t.video_id IS NOT NULL`;
  if (options.videoId) {
    sql += ' AND p.video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY p.upload_date DESC, p.video_id ASC';

  let rows = db.prepare(sql).all(...params);
  if (!options.includeQuarantine) {
    rows = rows.filter((row) => !Number(row.quarantined));
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
    return normalizeTranscript(body, body.provider || 'deepgram');
  } catch {
    return [];
  }
}

/**
 * Replace the signals of one post.
 *
 * @param {DatabaseSync} db
 * @param {string} videoId
 * @param {number} transcriptId
 * @param {Array<object>} signals
 */
function replaceSignals(db, videoId, transcriptId, signals) {
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

try {
  main();
} catch (error) {
  console.error(`[asym-signals] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}