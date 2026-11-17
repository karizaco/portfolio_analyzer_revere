'use strict';

/**
 * Transcribe the Komar corpus with Deepgram.
 *
 * WHAT THIS STAGE DOES
 *
 * The Komar corpus is 116 screen recordings -- 65.9 hours of spoken
 * commentary, and the corpus's PRIMARY TEXT. The documents carry the
 * cards, the theme leaders and the trade log; the videos carry the
 * reasoning, the setups and the positions.
 *
 * There are no YouTube captions (these are local files), so Deepgram
 * is the only route. The audio is extracted, uploaded, transcribed, and
 * DELETED -- it is a byproduct, and the transcript is the corpus.
 *
 * THE LANGUAGE IS A MODEL CHOICE, NOT A HINT
 *
 * `src/transcript/deepgramClient.js` documents the measurement: pointed
 * at the wrong acoustic model, Deepgram emits a handful of isolated
 * words instead of a transcript (measured: 15 segments of isolated
 * words on Czech audio with `language=en`, against 881 segments of
 * full sentences with `language=cs`). The module's default is `cs`
 * (Sevcik is Czech) and the repo's `.env` sets no language, so this
 * tool passes `language: 'en'` PER CALL and RECORDS the language the
 * request actually used -- the Sevcik tool had a bug where every row
 * claimed `en` whatever the request did.
 *
 * WHAT IT COSTS
 *
 * nova-2 at the standard rate is $0.0077 a minute, so the whole
 * corpus is about $30 for 3,954 minutes. `--dry-run` prints the plan
 * and the estimate before a cent is spent, and `--limit` bounds the
 * spend.
 *
 * Usage:
 *   node tools/fetchKomarTranscripts.js --dry-run
 *   node tools/fetchKomarTranscripts.js --limit 3
 *   node tools/fetchKomarTranscripts.js --only-ids komar_vid_weekend_226_stocks
 *   node tools/fetchKomarTranscripts.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { loadEnv } = require('../src/transcript/loadEnv');
const {
  DEFAULT_MODEL,
  extractAudio,
  hasDeepgramKey,
  transcribeAudio,
} = require('../src/transcript/deepgramClient');
const { normalizeTranscript, transcriptChecksum } = require('../src/transcript/transcriptNormalize');
const { komarSourceDir } = require('../src/komar/channel');
const { ensureKomarSchema } = require('../src/komar/schema');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
// The transcripts are TRACKED (they are the corpus's primary text), and
// the audio is not: it is a byproduct and it is deleted after every
// request. Both directories can be pointed elsewhere, which is how a
// test runs the tool without touching the tracked corpus.
const TRANSCRIPTS_DIR = process.env.KOMAR_TRANSCRIPTS_DIR
  ? path.resolve(process.env.KOMAR_TRANSCRIPTS_DIR)
  : path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const AUDIO_DIR = process.env.KOMAR_AUDIO_DIR
  ? path.resolve(process.env.KOMAR_AUDIO_DIR)
  : path.join(ROOT, 'data', 'komar_work', 'audio');

/** nova-2 at the standard rate, per minute of audio. */
const COST_PER_MINUTE = 0.0077;

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  keepAudio: argv.includes('--keep-audio'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  onlyIds: String(readFlag(argv, '--only-ids') || '').split(',').map((id) => id.trim()).filter(Boolean),
  sourceDir: komarSourceDir({ sourceDir: readFlag(argv, '--source-dir') }),
};

/**
 * Open the catalog with the derived file attached.
 *
 * The catalog connection is only a carrier: the Komar rows live in the
 * DERIVED file, which is what this source writes.
 *
 * @returns {object}
 */
function openDatabase() {
  const db = new DatabaseSync(CATALOG_DB_PATH);
  attachDerived(db);
  ensureKomarSchema(db);
  return db;
}

/**
 * The videos to transcribe, shortest first.
 *
 * The order is by DURATION, so a bounded run buys the most transcripts
 * per dollar and the cheapest ones are the ones that fail first.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listVideos(db) {
  let sql = `
    SELECT video_id, kind, title, duration_sec, media_path, folder
    FROM komar_videos
  `;
  const params = [];
  if (options.onlyIds.length) {
    sql += ` WHERE video_id IN (${options.onlyIds.map(() => '?').join(', ')})`;
    params.push(...options.onlyIds);
  }
  sql += ' ORDER BY duration_sec ASC, video_id ASC';
  return db.prepare(sql).all(...params);
}

/**
 * Where a video's media is on disk.
 *
 * @param {object} video
 * @returns {string}
 */
function mediaPathOf(video) {
  const relative = String(video.media_path || '');
  if (!relative) return '';
  if (path.isAbsolute(relative)) return relative;
  return path.join(options.sourceDir, relative);
}

/**
 * Where a video's transcript lives.
 *
 * @param {string} videoId
 * @returns {string}
 */
function transcriptPathOf(videoId) {
  return path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
}

/**
 * Record one transcript.
 *
 * @param {object} db
 * @param {object} video
 * @param {object} record
 */
function writeTranscriptRow(db, video, record) {
  db.prepare(`
    INSERT INTO komar_transcripts (
      video_id, provider, language, model, transcript_path, segment_count,
      duration_sec, quality_score, checksum, fetched_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      provider = excluded.provider,
      language = excluded.language,
      model = excluded.model,
      transcript_path = excluded.transcript_path,
      segment_count = excluded.segment_count,
      duration_sec = excluded.duration_sec,
      quality_score = excluded.quality_score,
      checksum = excluded.checksum,
      fetched_at = excluded.fetched_at,
      updated_at = datetime('now')
  `).run(
    video.video_id,
    record.provider,
    record.language,
    record.model,
    record.transcript_path,
    record.segment_count,
    record.duration_sec,
    record.quality_score === undefined ? null : record.quality_score,
    record.checksum,
    record.fetched_at
  );
}

/**
 * Re-register a transcript that is on disk but has no row.
 *
 * The JSON file is the RECORD -- it is tracked, and the extractors
 * rebuild everything else from it -- and the row is its index. So a file
 * with no row is not missing work: it is a row that was never written,
 * and writing it costs nothing and no Deepgram call.
 *
 * @param {object} db
 * @param {object} video
 * @returns {boolean} whether the row was written
 */
function registerExistingTranscript(db, video) {
  const transcriptPath = transcriptPathOf(video.video_id);
  if (!fs.existsSync(transcriptPath)) return false;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  } catch {
    return false;
  }
  writeTranscriptRow(db, video, {
    checksum: record.checksum || '',
    duration_sec: Number(record.duration_sec || video.duration_sec || 0),
    fetched_at: record.fetched_at || '',
    language: record.language || '',
    model: record.model || DEFAULT_MODEL,
    provider: record.provider || 'deepgram',
    quality_score: Number.isFinite(Number(record.quality_score))
      ? Number(record.quality_score)
      : null,
    segment_count: Number(record.segment_count || (record.segments || []).length),
    transcript_path: path.relative(ROOT, transcriptPath).split(path.sep).join('/'),
  });
  return true;
}

/**
 * Transcribe one video.
 *
 * @param {object} db
 * @param {object} video
 * @returns {Promise<object>} the outcome
 */
async function transcribeVideo(db, video) {
  const mediaPath = mediaPathOf(video);
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    return { ok: false, video_id: video.video_id, error: 'media not found', path: mediaPath };
  }

  const audioPath = path.join(AUDIO_DIR, `${video.video_id}.mp3`);
  const extracted = extractAudio(mediaPath, audioPath);
  if (!extracted.ok) {
    return { ok: false, video_id: video.video_id, error: extracted.error };
  }

  try {
    const result = await transcribeAudio(audioPath, { language: 'en' });
    if (!result.ok) {
      return { ok: false, video_id: video.video_id, error: result.error };
    }
    const segments = normalizeTranscript(result.payload, 'deepgram');
    if (!segments.length) {
      // A transcript with no segments is a FAILURE, not a result: the
      // wrong acoustic model produces exactly this, and the corpus is
      // English while the module's default language is Czech.
      return {
        ok: false,
        video_id: video.video_id,
        error: `no segments (the request used language=${result.language})`,
      };
    }

    const transcriptPath = transcriptPathOf(video.video_id);
    const relativePath = path.relative(ROOT, transcriptPath).split(path.sep).join('/');
    const confidences = segments
      .map((segment) => Number(segment.confidence))
      .filter((value) => Number.isFinite(value));
    const record = {
      channel: 'komar',
      checksum: transcriptChecksum(segments),
      duration_sec: Number(video.duration_sec || 0),
      fetched_at: new Date().toISOString(),
      language: result.language || 'en',
      model: DEFAULT_MODEL,
      provider: 'deepgram',
      quality_score: confidences.length
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null,
      segment_count: segments.length,
      segments,
      title: video.title || '',
      transcript_path: relativePath,
      video_id: video.video_id,
    };
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    writeTranscriptRow(db, video, record);

    return {
      ok: true,
      video_id: video.video_id,
      segments: segments.length,
      language: record.language,
      minutes: (Number(video.duration_sec || 0) / 60),
    };
  } finally {
    if (!options.keepAudio) {
      try { fs.unlinkSync(audioPath); } catch { /* best effort */ }
    }
  }
}

async function main() {
  loadEnv();
  const db = openDatabase();
  const videos = listVideos(db);
  const pending = [];
  let skipped = 0;
  let pendingMinutes = 0;
  const hasRow = (videoId) => Boolean(
    db.prepare('SELECT 1 FROM komar_transcripts WHERE video_id = ?').get(videoId)
  );

  for (const video of videos) {
    if (hasRow(video.video_id)) {
      skipped += 1;
      continue;
    }
    // The record is on disk and only the index is missing: write the
    // row, and pay nothing.
    if (fs.existsSync(transcriptPathOf(video.video_id))
      && registerExistingTranscript(db, video)) {
      skipped += 1;
      continue;
    }
    pending.push(video);
    pendingMinutes += Number(video.duration_sec || 0) / 60;
  }
  const selected = options.limit > 0 ? pending.slice(0, options.limit) : pending;
  const selectedMinutes = selected.reduce((sum, video) => sum + Number(video.duration_sec || 0) / 60, 0);

  const plan = {
    corpus_videos: videos.length,
    already_transcribed: skipped,
    pending: pending.length,
    pending_minutes: Math.round(pendingMinutes),
    pending_cost_usd: Number((pendingMinutes * COST_PER_MINUTE).toFixed(2)),
    selected: selected.length,
    selected_minutes: Math.round(selectedMinutes),
    selected_cost_usd: Number((selectedMinutes * COST_PER_MINUTE).toFixed(2)),
  };

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    db.close();
    return;
  }

  if (!hasDeepgramKey()) {
    console.error('DEEPGRAM_API_KEY is not set');
    db.close();
    process.exit(1);
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const summary = { ...plan, transcribed: 0, failed: 0, minutes: 0, cost_usd: 0, failures: [] };
  const started = Date.now();

  try {
    for (const video of selected) {
      const outcome = await transcribeVideo(db, video);
      if (outcome.ok) {
        summary.transcribed += 1;
        summary.minutes += outcome.minutes;
        summary.cost_usd = Number((summary.minutes * COST_PER_MINUTE).toFixed(2));
        console.log(
          `[${summary.transcribed}/${selected.length}] ${video.video_id}: ${outcome.segments} segments`
          + ` (${Math.round(outcome.minutes)} min, language=${outcome.language})`
        );
      } else {
        summary.failed += 1;
        summary.failures.push({ video_id: video.video_id, error: outcome.error });
        console.log(`[${summary.failed} failed] ${video.video_id}: ${outcome.error}`);
        // A rate limit or a transport failure is not the video's fault,
        // and hammering the endpoint makes it worse. Stop and let the
        // operator decide.
        if (/429|rate limit|fetch failed|ECONN|ETIMEDOUT/i.test(String(outcome.error))) {
          console.log('stopping: the endpoint is refusing requests');
          break;
        }
      }
    }
  } finally {
    db.close();
  }

  summary.elapsed_sec = Math.round((Date.now() - started) / 1000);
  console.log(options.json ? JSON.stringify(summary, null, 2) : (
    `transcribed ${summary.transcribed}/${selected.length} `
    + `(${Math.round(summary.minutes)} min, ~$${summary.cost_usd}), ${summary.failed} failed, `
    + `${summary.elapsed_sec}s`
  ));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  COST_PER_MINUTE,
  listVideos,
  mediaPathOf,
  registerExistingTranscript,
  transcriptPathOf,
  writeTranscriptRow,
};
