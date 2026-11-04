'use strict';

// Fetch a transcript for every Sevcik video that does not have one yet.
//
// THE PROVIDER ORDER
//
//   1. YouTube auto-captions. Free, no key, no upload, and the video's own
//      audio never leaves the machine.
//   2. Deepgram. Needs DEEPGRAM_API_KEY and an audio upload, and costs
//      money -- but it is the only way to reach the older videos, which
//      carry no captions at all.
//
// Captions are tried FIRST even when a Deepgram key is configured, because
// they are free and instant. Deepgram is the fallback, not the default.
//
// WHAT IT WRITES
//
//   data/video_pipeline/transcripts/<video_id>.json   the transcript
//   video_transcripts                                one row per video
//   transcript_segments                               the normalized segments
//   videos.transcript_path                            the existing pointer
//
// The transcript file has the SAME shape `tools/fetchCaptions.js` writes, so
// the two tools cannot fight over the same video: whichever ran first
// leaves the file, and the other sees it and skips.
//
// The provider is recorded in `video_transcripts.provider`, because the two
// providers are not equally trustworthy and a later reader has to know
// which one a signal came from.
//
// Usage:
//   node tools/fetchSevcikTranscripts.js
//   node tools/fetchSevcikTranscripts.js --limit 6
//   node tools/fetchSevcikTranscripts.js --video-id abc123
//   node tools/fetchSevcikTranscripts.js --provider deepgram --limit 2
//   node tools/fetchSevcikTranscripts.js --no-deepgram-fallback
//   node tools/fetchSevcikTranscripts.js --json

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { normalizeTranscript, transcriptChecksum } = require('../src/transcript/transcriptNormalize');
const { extractAudio, hasDeepgramKey, transcribeAudio } = require('../src/transcript/deepgramClient');
const { SEVCIK_CHANNEL, SEVCIK_SOURCE_URL } = require('../src/sevcik/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const AUDIO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'audio_sevcik');

// yt-dlp is installed as a Python module; use 'py -3 -m yt_dlp' so the tool
// is found on every install method.
const PY = process.platform === 'win32' ? 'py' : 'python3';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || SEVCIK_CHANNEL,
  provider: readFlag(argv, '--provider') || 'auto',
  deepgramFallback: !argv.includes('--no-deepgram-fallback'),
  force: argv.includes('--force'),
  json: argv.includes('--json'),
  keepAudio: argv.includes('--keep-audio'),
};

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const rows = selectCandidates();
  console.log(`[sevcik-transcripts] candidates=${rows.length} channel=${options.channel}`
    + ` provider=${options.provider} deepgram-fallback=${options.deepgramFallback}`);

  const results = [];
  for (const row of rows) {
    const result = await processVideo(row);
    results.push(result);
    const detail = result.provider
      ? `${result.provider} (${result.segments} segments)`
      : `FAILED: ${result.error}`;
    console.log(`[sevcik-transcripts] ${row.video_id} ${row.upload_date} ${detail}`);
  }

  const summary = {
    candidates: rows.length,
    fetched: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    providers: countBy(results.filter((r) => r.provider).map((r) => r.provider)),
    results,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[sevcik-transcripts] done: fetched=${summary.fetched} skipped=${summary.skipped}`
      + ` failed=${summary.failed} providers=${JSON.stringify(summary.providers)}`);
  }
  process.exit(summary.failed ? 1 : 0);
}

/**
 * The catalog rows that need a transcript.
 *
 * A row is a candidate when it has a video URL and no transcript file on
 * disk. The FILE is the test, not the database column: a column that says
 * a transcript exists while the file is gone would silently skip the video
 * forever, and this pipeline's whole point is that every stream gets read.
 *
 * @returns {Array<{video_id: string, upload_date: string, title: string, video_url: string, channel: string}>}
 */
function selectCandidates() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const filters = ["video_url != ''", "channel = ?"];
  const params = [options.channel];

  let sql = `SELECT video_id, upload_date, title, video_url, channel FROM videos
             WHERE ${filters.join(' AND ')}
             ORDER BY upload_date DESC, video_id ASC`;
  if (options.videoId) {
    sql += ' AND video_id = ?';
    params.push(options.videoId);
  }
  const rows = db.prepare(sql).all(...params);
  db.close();

  const candidates = rows.filter((row) => {
    if (options.force) return true;
    return !fs.existsSync(transcriptPathFor(row.video_id));
  });

  return options.limit ? candidates.slice(0, options.limit) : candidates;
}

/**
 * Where a video's transcript file lives.
 *
 * @param {string} videoId
 * @returns {string}
 */
function transcriptPathFor(videoId) {
  return path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
}

/**
 * Get a transcript for one video, from whichever provider can supply it.
 *
 * @param {object} row - a catalog row
 * @returns {Promise<object>} a result record
 */
async function processVideo(row) {
  const transcriptPath = transcriptPathFor(row.video_id);

  if (fs.existsSync(transcriptPath) && !options.force) {
    return { video_id: row.video_id, ok: false, skipped: true, reason: 'transcript already on disk' };
  }

  const providers = options.provider === 'auto'
    ? ['youtube_auto', 'deepgram']
    : [options.provider];

  const errors = [];

  for (const provider of providers) {
    if (provider === 'deepgram' && !options.deepgramFallback && options.provider === 'auto') {
      errors.push('deepgram: fallback disabled');
      continue;
    }

    let outcome;
    if (provider === 'youtube_auto') {
      outcome = fetchYoutubeCaptions(row, transcriptPath);
    } else if (provider === 'deepgram') {
      outcome = await fetchDeepgramTranscript(row, transcriptPath);
    } else {
      errors.push(`${provider}: unknown provider`);
      continue;
    }

    if (!outcome.ok) {
      errors.push(`${provider}: ${outcome.error}`);
      continue;
    }

    persistTranscript(row, provider, transcriptPath, outcome.segments);
    return {
      video_id: row.video_id,
      ok: true,
      provider,
      segments: outcome.segments.length,
      transcript_path: transcriptPath,
    };
  }

  return {
    video_id: row.video_id,
    ok: false,
    error: errors.join(' | ') || 'no provider produced a transcript',
  };
}

/**
 * Fetch the video's own auto-captions.
 *
 * @param {object} row
 * @param {string} transcriptPath
 * @returns {{ok: boolean, segments?: Array, error?: string}}
 */
function fetchYoutubeCaptions(row, transcriptPath) {
  const baseOut = path.join(TRANSCRIPTS_DIR, `${row.video_id}.captions`);
  const result = spawnSync(PY, [
    '-3', '-m', 'yt_dlp',
    '--write-auto-subs',
    '--skip-download',
    '--sub-lang', 'en',
    '--convert-subs', 'vtt',
    '-o', `${baseOut}.%(ext)s`,
    row.video_url,
  ], { encoding: 'utf8' });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  const vttPath = `${baseOut}.en.vtt`;
  if (!fs.existsSync(vttPath)) {
    // yt-dlp exits 0 when it simply has no subtitles, so the file's absence
    // -- not the exit code -- is the signal.
    return { ok: false, error: 'no auto-captions' };
  }

  const vtt = fs.readFileSync(vttPath, 'utf8');
  const segments = normalizeTranscript({ segments: vttToSegments(vtt) }, 'youtube_auto');
  if (!segments.length) {
    return { ok: false, error: 'auto-captions were empty' };
  }

  return { ok: true, segments };
}

/**
 * Download the audio and transcribe it with Deepgram.
 *
 * @param {object} row
 * @param {string} transcriptPath
 * @returns {Promise<{ok: boolean, segments?: Array, error?: string}>}
 */
async function fetchDeepgramTranscript(row, transcriptPath) {
  if (!hasDeepgramKey()) {
    return { ok: false, error: 'DEEPGRAM_API_KEY is not set' };
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const audioStem = path.join(AUDIO_DIR, row.video_id);

  // Download the audio only. The full video of a one-hour stream is
  // hundreds of megabytes and none of it is needed for a transcript.
  const download = spawnSync(PY, [
    '-3', '-m', 'yt_dlp',
    '--no-playlist',
    '-f', 'bestaudio/best',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visios',
    ...(process.env.YOUTUBE_COOKIES ? ['--cookies', process.env.YOUTUBE_COOKIES] : []),
    '-o', `${audioStem}.%(ext)s`,
    row.video_url,
  ], { encoding: 'utf8' });

  if (download.error) {
    return { ok: false, error: `audio download failed: ${download.error.message}` };
  }

  const downloaded = findAudioFile(audioStem);
  if (!downloaded) {
    const stderr = String(download.stderr || '').trim().split('\n').slice(-2).join(' ');
    return { ok: false, error: `no audio downloaded${stderr ? `: ${stderr}` : ''}` };
  }

  const mp3Path = `${audioStem}.mp3`;
  const extracted = extractAudio(downloaded, mp3Path);
  if (!extracted.ok) {
    return { ok: false, error: `audio extraction failed: ${extracted.error}` };
  }

  const transcribed = await transcribeAudio(mp3Path);
  if (!transcribed.ok) {
    return { ok: false, error: transcribed.error };
  }

  const segments = normalizeTranscript(transcribed.payload, 'deepgram');
  if (!segments.length) {
    return { ok: false, error: 'Deepgram returned no utterances' };
  }

  if (!options.keepAudio) {
    safeUnlink(mp3Path);
    if (downloaded !== mp3Path) safeUnlink(downloaded);
  }

  return { ok: true, segments };
}

/**
 * The audio file yt-dlp wrote, whatever extension it chose.
 *
 * @param {string} stem
 * @returns {string|null}
 */
function findAudioFile(stem) {
  const directory = path.dirname(stem);
  const base = path.basename(stem);
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(base) && !name.endsWith('.mp3'))
    .map((name) => path.join(directory, name));
  return candidates.length ? candidates[0] : null;
}

/**
 * Write the transcript file and the database rows.
 *
 * The file has the same shape `tools/fetchCaptions.js` writes, so the two
 * tools agree on what a transcript file looks like, and the `provider` field
 * records which provider produced it.
 *
 * @param {object} row
 * @param {string} provider
 * @param {string} transcriptPath
 * @param {Array} segments
 */
function persistTranscript(row, provider, transcriptPath, segments) {
  const checksum = transcriptChecksum(segments);
  const fetchedAt = new Date().toISOString();

  fs.writeFileSync(transcriptPath, JSON.stringify({
    video_id: row.video_id,
    channel: row.channel,
    title: row.title,
    provider,
    fetched_at: fetchedAt,
    segment_count: segments.length,
    checksum,
    segments: segments.map((segment) => ({
      start_ts: segment.start_sec,
      end_ts: segment.end_sec,
      text: segment.text,
      confidence: segment.confidence,
    })),
  }, null, 2), 'utf8');

  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));

  upsertTranscript(db, row, provider, transcriptPath, segments, checksum, fetchedAt);
  db.prepare(
    'UPDATE videos SET transcript_path = ?, transcript_segment_count = ?, transcript_fetched_at = ?, updated_at = ? '
    + 'WHERE video_id = ?',
  ).run(transcriptPath, segments.length, fetchedAt, fetchedAt, row.video_id);
  db.close();
}

/**
 * Insert or update the transcript row and its segments.
 *
 * The re-run case matters: a second run over the same video must not leave
 * two transcript rows, and the segments must not be duplicated either. The
 * UNIQUE(video_id) constraint on the table makes the first half
 * impossible; the segments are deleted and rewritten, because a transcript
 * that changed has different segments.
 *
 * @param {DatabaseSync} db
 * @param {object} row
 * @param {string} provider
 * @param {string} transcriptPath
 * @param {Array} segments
 * @param {string} checksum
 * @param {string} fetchedAt
 * @returns {number} the transcript id
 */
function upsertTranscript(db, row, provider, transcriptPath, segments, checksum, fetchedAt) {
  const existing = db.prepare('SELECT id, checksum FROM video_transcripts WHERE video_id = ?')
    .get(row.video_id);

  let transcriptId;
  if (existing) {
    transcriptId = Number(existing.id);
    db.prepare(
      'UPDATE video_transcripts SET provider = ?, language = ?, transcript_path = ?, segment_count = ?, '
      + 'checksum = ?, fetched_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(provider, provider === 'deepgram' ? 'en' : '', transcriptPath, segments.length, checksum, fetchedAt, transcriptId);
    db.prepare('DELETE FROM transcript_segments WHERE transcript_id = ?').run(transcriptId);
  } else {
    const result = db.prepare(
      'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
      + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.video_id, provider, provider === 'deepgram' ? 'en' : '', transcriptPath, segments.length, checksum, fetchedAt);
    transcriptId = Number(result.lastInsertRowid);
  }

  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  segments.forEach((segment, index) => {
    insertSegment.run(
      transcriptId,
      row.video_id,
      index,
      segment.start_sec,
      segment.end_sec,
      segment.text,
      segment.confidence === null || segment.confidence === undefined ? null : segment.confidence,
    );
  });

  return transcriptId;
}

/**
 * Parse a WebVTT document into the project's own transcript shape.
 *
 * @param {string} vttText
 * @returns {Array<{start_ts:number,end_ts:number,text:string}>}
 */
function vttToSegments(vttText) {
  const { normalizeVtt } = require('../src/transcript/transcriptNormalize');
  return normalizeVtt(vttText).map((segment) => ({
    start_ts: segment.start_sec,
    end_ts: segment.end_sec,
    text: segment.text,
  }));
}

function safeUnlink(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // A leftover audio file is not worth failing a run over.
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

main().catch((error) => {
  console.error(`[sevcik-transcripts] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
