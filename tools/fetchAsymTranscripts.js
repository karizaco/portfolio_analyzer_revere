'use strict';

// Transcribe the video of a free AsymTrading post with Deepgram.
//
// WHY DEEPGRAM IS NOT OPTIONAL HERE
//
// Every other transcript source in this project can fall back on YouTube's
// own auto-captions. This one cannot: the video is served from Substack's
// Mux CDN, not from YouTube, and Mux's assets carry
// `CLOSED-CAPTIONS=NONE` -- there are no captions to fetch. So there is
// exactly one path to a transcript, and it costs money.
//
// THE LANGUAGE IS `en`, AND IT IS A HARD FILTER
//
// The shared client defaults to `cs` because the Sevcik channel is Czech.
// The language selects the ACOUSTIC MODEL, so pointing the Czech model at
// English audio produces no transcript rather than a bad one. The
// default is overridden per call, which is exactly what the client's
// `overrides.language` parameter exists for.
//
// THE COST
//
// Deepgram nova-2 is roughly $0.0043 per minute of audio. The 24 free
// posts carry 16.8 hours of audio, so a full run is on the order of
// $4.30. The audio is uploaded to Deepgram, which is a deliberate
// consequence of using a hosted transcription service.
//
// THE AUDIO-ONLY PATH
//
// The downloader has a mode that keeps only the audio -- a 16 kHz mono MP3
// of the whole free corpus is about 360 MB, against 8.51 GB of video --
// and the source's audio is then ALREADY in the shape Deepgram wants. So
// when the media row says the file is an MP3, it is sent as it is, with no
// extraction step at all. When it says MP4, the audio is extracted first,
// and the extraction is temporary.
//
// WHAT IT WRITES
//
//   data/video_pipeline/transcripts/asym_<post_id>.json   the transcript
//   video_transcripts                                    the catalog row
//   transcript_segments                                  the segment rows
//   asym_media.transcript_path / segment_count           the join columns
//
// The transcript JSON is written in the SAME shape as every other
// transcript in the project, so the extractors' disk-registration path
// works on it unchanged.
//
// Usage:
//   node tools/fetchAsymTranscripts.js
//   node tools/fetchAsymTranscripts.js --limit 1
//   node tools/fetchAsymTranscripts.js --video-id asym_222466781
//   node tools/fetchAsymTranscripts.js --dry-run
//   node tools/fetchAsymTranscripts.js --json

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadEnv } = require('../src/transcript/loadEnv');
const {
  extractAudio,
  hasDeepgramKey,
  transcribeAudio,
} = require('../src/transcript/deepgramClient');
const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');
const { attachSegments } = require('../src/transcript/segmentStore');
const { ASYM_MEDIA_STATUS, ensureAsymMediaSchema } = require('../src/asym/mediaStore');

// The credentials live in .env, which is gitignored. An environment
// variable that is already set wins over the file.
loadEnv();

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const AUDIO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'audio_asym');

/**
 * The language of the source.
 *
 * AsymTrading's Market Pulse is English. It is passed per call rather
 * than set in the environment, because the environment default is `cs`
 * for the Czech channel and this process must not inherit it.
 */
const ASYM_LANGUAGE = 'en';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  keepAudio: argv.includes('--keep-audio'),
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

/**
 * Open the catalog with the segments database attached.
 *
 * @returns {DatabaseSync}
 */
function openCatalog() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  attachSegments(db);
  return db;
}

/**
 * The posts whose media is on disk and ready to transcribe.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function workList(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT p.video_id, p.post_id, p.slug, p.title, p.upload_date, p.series,
             m.kind AS media_kind, m.file_path, m.file_bytes, m.duration_sec,
             m.status AS media_status,
             m.transcript_path AS already_transcribed,
             (SELECT COUNT(*) FROM video_transcripts t WHERE t.video_id = p.video_id) AS transcript_rows
        FROM asym_posts p
        JOIN asym_media m ON m.video_id = p.video_id
       WHERE m.status = ?
       ORDER BY p.upload_date ASC, p.video_id ASC
    `).all(ASYM_MEDIA_STATUS.DOWNLOADED);
  } catch {
    return [];
  }

  return rows.filter((row) => {
    if (options.videoId && row.video_id !== options.videoId) return false;
    // A post that already has a transcript row is done, unless the caller
    // insists. The transcript is not cheap, so the default is to skip.
    if (!options.force && Number(row.transcript_rows) > 0) return false;
    return true;
  });
}

/**
 * Write the transcript JSON.
 *
 * The shape is the project's: `{provider, language, fetched_at, segments}`.
 * The extractors' disk-registration reads exactly this, so a transcript
 * written here is picked up by the same code path as a YouTube one.
 *
 * @param {object} post
 * @param {Array<object>} segments
 * @returns {string} the path written
 */
function writeTranscriptJson(post, segments) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPTS_DIR, `${post.video_id}.json`);
  const body = {
    video_id: post.video_id,
    provider: 'deepgram',
    language: ASYM_LANGUAGE,
    fetched_at: new Date().toISOString(),
    segments,
  };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), 'utf8');
  return filePath;
}

/**
 * Record the transcript in the catalog and in the segment store.
 *
 * @param {DatabaseSync} db
 * @param {object} post
 * @param {Array<object>} segments
 * @param {string} filePath
 * @returns {number} the transcript id
 */
function registerTranscript(db, post, segments, filePath) {
  const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const textBlob = segments.map((segment) => segment.text || '').join('\n');
  const checksum = crypto.createHash('md5').update(textBlob).digest('hex');
  const fetchedAt = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, checksum, fetched_at)
      VALUES (?, 'deepgram', ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        provider = excluded.provider,
        language = excluded.language,
        transcript_path = excluded.transcript_path,
        segment_count = excluded.segment_count,
        checksum = excluded.checksum,
        fetched_at = excluded.fetched_at,
        updated_at = datetime('now')
    `).run(post.video_id, ASYM_LANGUAGE, relPath, segments.length, checksum, fetchedAt);

    const transcriptId = Number(
      db.prepare('SELECT id FROM video_transcripts WHERE video_id = ?').get(post.video_id).id,
    );

    // A re-run replaces the segments rather than adding to them: the
    // transcript id is the same, and the old rows would otherwise
    // duplicate every sentence.
    db.prepare('DELETE FROM transcript_segments WHERE transcript_id = ?').run(transcriptId);

    const insertSegment = db.prepare(
      'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    segments.forEach((segment, index) => {
      insertSegment.run(
        transcriptId,
        post.video_id,
        index,
        Number(segment.start_sec) || 0,
        Number(segment.end_sec) || 0,
        String(segment.text || ''),
        segment.confidence == null ? null : Number(segment.confidence),
      );
    });

    db.prepare(`
      UPDATE asym_media
         SET transcript_path = ?, segment_count = ?, transcribed_at = ?, updated_at = datetime('now')
       WHERE video_id = ?
    `).run(relPath, segments.length, fetchedAt, post.video_id);

    db.exec('COMMIT');
    return transcriptId;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  if (!options.dryRun && !hasDeepgramKey()) {
    console.error('DEEPGRAM_API_KEY is not set. Add it to .env (see .env.example).');
    process.exit(1);
  }

  const db = openCatalog();
  ensureAsymMediaSchema(db);
  let work = workList(db);
  if (options.limit) work = work.slice(0, options.limit);

  const summary = {
    command: ['fetchAsymTranscripts.js', ...argv],
    candidates: work.length,
    transcribed: 0,
    skipped: 0,
    failed: 0,
    segments: 0,
    rows: [],
  };

  if (!work.length) {
    console.log('[asym-transcripts] nothing to do: no downloaded media without a transcript.');
    db.close();
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const post of work) {
    const label = `${post.upload_date} ${post.video_id}`;
    const videoPath = path.join(ROOT, post.file_path || '');

    if (!fs.existsSync(videoPath)) {
      summary.failed += 1;
      console.error(`[asym-transcripts] ${label} media not found: ${post.file_path}`);
      continue;
    }

    if (options.dryRun) {
      summary.rows.push({
        video_id: post.video_id,
        upload_date: post.upload_date,
        media: post.file_path,
        duration_sec: post.duration_sec,
        action: 'would-transcribe',
      });
      console.log(`[asym-transcripts] ${label} would transcribe ${post.file_path}`
        + ` (${Math.round(Number(post.duration_sec) || 0)}s)`);
      continue;
    }

    // An audio-only download IS the Deepgram input already, so there is
    // nothing to extract. A video download has to be extracted first.
    const isAudio = String(post.media_kind || '') === 'audio';
    const audioPath = isAudio ? videoPath : path.join(AUDIO_DIR, `${post.video_id}.mp3`);
    try {
      let audio = { ok: true, path: audioPath };
      if (!isAudio) {
        audio = extractAudio(videoPath, audioPath);
        if (!audio.ok) {
          summary.failed += 1;
          console.error(`[asym-transcripts] ${label} audio extraction failed: ${audio.error}`);
          continue;
        }
      }

      const result = await transcribeAudio(audio.path, { language: ASYM_LANGUAGE });
      if (!result.ok) {
        summary.failed += 1;
        console.error(`[asym-transcripts] ${label} transcription failed: ${result.error}`);
        continue;
      }

      const segments = normalizeTranscript(result.payload, 'deepgram');
      if (!segments.length) {
        summary.failed += 1;
        console.error(`[asym-transcripts] ${label} transcription produced no segments`);
        continue;
      }

      const filePath = writeTranscriptJson(post, segments);
      registerTranscript(db, post, segments, filePath);

      // Only the EXTRACTED audio is temporary. An audio-only download is
      // the artifact, and deleting it would mean re-downloading to
      // re-transcribe.
      if (!isAudio && !options.keepAudio) {
        try { fs.unlinkSync(audio.path); } catch { /* ignore */ }
      }

      summary.transcribed += 1;
      summary.segments += segments.length;
      summary.rows.push({
        video_id: post.video_id,
        upload_date: post.upload_date,
        transcript: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        segments: segments.length,
        action: 'transcribed',
      });
      console.log(`[asym-transcripts] ${label} transcribed: ${segments.length} segment(s)`);
    } catch (error) {
      summary.failed += 1;
      console.error(`[asym-transcripts] ${label} failed: ${error && error.message ? error.message : error}`);
    }
  }

  db.close();

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`[asym-transcripts] transcribed=${summary.transcribed} failed=${summary.failed}`
    + ` segments=${summary.segments}`);
  if (options.dryRun) console.log('[asym-transcripts] dry run: nothing was transcribed.');
}

main().catch((error) => {
  console.error(`[asym-transcripts] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});