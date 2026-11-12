'use strict';

// The MEDIA layer of the AsymTrading source.
//
// WHY THIS IS A MODULE AND NOT PART OF THE DOWNLOAD TOOL
//
// The download, the transcription and the reporting all need to agree on
// three things that are easy to get subtly wrong:
//
//   1. WHERE a post's media lives on disk, and what the file is called.
//      A name that is computed twice, in two places, drifts.
//   2. WHAT counts as a usable video. The project's rule is 720p or
//      better, and it is checked with ffprobe rather than assumed from
//      the file's size -- a 10-minute FullHD video can be under 1 GB and
//      a 2-hour 720p video can be 2 GB.
//   3. HOW MUCH disk has to be free before a download starts. A disk that
//      fills mid-download fails in a way that looks like a network error.
//
// WHERE THE MEDIA COMES FROM
//
// Substack serves the embedded video from its own Mux account. The
// `/api/v1/video/upload/<id>` endpoint describes it (duration, dimensions,
// the primary file's size) and the same endpoint with `/src` redirects to
// a signed Mux URL.
//
// THE SIGNED URL EXPIRES, AND THAT IS WHY IT IS NOT STORED
//
// The redirect carries a token whose `exp` was measured at about 24 hours.
// A URL stored in the catalog would be a promise that expires, and a
// re-run weeks later would fail against a token that is dead. So the
// catalog stores the PERMANENT identifier -- the media-upload id -- and the
// URL is resolved fresh at download time.
//
// THE DOWNLOAD DIRECTORY
//
// `data/video_pipeline/downloads_asym/` is its own directory rather than
// one of the three historical download directories, because those are
// described by RESOLUTION and are known to hold mixed content (see
// CLAUDE.md). A new directory with a new name holds exactly one source's
// media and nothing else.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveFfprobeBin } = require('../video/ffmpegBin');

const ROOT = path.resolve(__dirname, '..', '..');

/** Where the AsymTrading media is downloaded to. */
const ASYM_MEDIA_DIR = path.join(ROOT, 'data', 'video_pipeline', 'downloads_asym');

/**
 * Where the AUDIO lives.
 *
 * The audio is what the transcription actually reads, and it is small: a
 * 16 kHz mono MP3 of the whole free corpus is about 360 MB, against
 * 8.51 GB of video. So the audio-only path keeps the corpus on disk
 * comfortably.
 */
const ASYM_AUDIO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'audio_asym');

/**
 * What kind of file a media row holds.
 *
 * @readonly
 * @enum {string}
 */
const ASYM_MEDIA_KIND = {
  /** The 1920x1080 MP4, which the frames are read from. */
  VIDEO: 'video',
  /** A 16 kHz mono MP3, which is what Deepgram is sent. */
  AUDIO: 'audio',
};

/**
 * The minimum height a downloaded video must have.
 *
 * 720p. The project's rule for every media file the pipeline reads, and
 * the reason a resolution gate exists at all: the OCR and the frame
 * readers both assume a readable chart, and a 480p video is not one.
 */
const MIN_VIDEO_HEIGHT = 720;

/**
 * The minimum width a downloaded video must have.
 *
 * 1280, which is 720p's width. The gate is stated as BOTH dimensions
 * because a 720x720 video passes a height-only check and is useless.
 */
const MIN_VIDEO_WIDTH = 1280;

/**
 * The canonical DDL of the media table.
 *
 * It is duplicated in data/db/schema.sql, and a test asserts that the two
 * agree -- a migration that rebuilds the table from a DIFFERENT shape than
 * the schema file would silently change the column order.
 *
 * @type {string}
 */
const ASYM_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS asym_media (
    video_id TEXT NOT NULL REFERENCES asym_posts(video_id),
    media_upload_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'video',
    file_path TEXT NOT NULL DEFAULT '',
    file_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration_sec REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    segment_count INTEGER NOT NULL DEFAULT 0,
    transcribed_at TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    downloaded_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, kind)
);`;

/**
 * The media state values.
 *
 * @readonly
 * @enum {string}
 */
const ASYM_MEDIA_STATUS = {
  PENDING: 'pending',
  DOWNLOADED: 'downloaded',
  ERROR: 'error',
  MISSING: 'missing',
};

/**
 * The file name of one post's media.
 *
 * The date comes first so a directory listing sorts the way the report
 * does, and the post id -- not the slug -- follows, because every post in
 * this publication is titled "Market Pulse" and the slug suffix repeats.
 *
 * @param {object} post - a row from asym_posts
 * @returns {string} e.g. `20261028_asym_222466781.mp4`
 */
function asymMediaFileName(post) {
  const row = post || {};
  const date = String(row.upload_date || '').trim() || 'undated';
  const id = String(row.post_id || row.video_id || '').trim().replace(/^asym_/, '') || 'unknown';
  return `${date}_asym_${id}.mp4`;
}

/**
 * The absolute path of one post's media.
 *
 * @param {object} post - a row from asym_posts
 * @returns {string}
 */
function asymMediaPath(post) {
  return path.join(ASYM_MEDIA_DIR, asymMediaFileName(post));
}

/**
 * The absolute path of one post's AUDIO.
 *
 * @param {object} post - a row from asym_posts
 * @returns {string}
 */
function asymAudioPath(post) {
  const row = post || {};
  const id = String(row.post_id || row.video_id || '').trim().replace(/^asym_/, '') || 'unknown';
  return path.join(ASYM_AUDIO_DIR, `${id}.mp3`);
}

/**
 * The repository-relative path, which is what the catalog stores.
 *
 * An absolute path would be meaningless on another machine, and the
 * project's rule for the catalog is a path that survives a checkout
 * elsewhere.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
function portablePath(absolutePath) {
  return path.relative(ROOT, absolutePath).replace(/\\/g, '/');
}

/**
 * Read a video's dimensions and duration with ffprobe.
 *
 * ffprobe is OPTIONAL in the project -- `resolveFfprobeBin` returns null
 * when it cannot find the binary -- so this returns null rather than
 * throwing. The caller decides whether an unverifiable video is
 * acceptable; the download tool treats it as a failure, because a video
 * the pipeline cannot measure is a video the pipeline cannot trust.
 *
 * @param {string} filePath
 * @returns {{width: number, height: number, duration: number}|null}
 */
function probeMedia(filePath) {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return null;
  if (!fs.existsSync(filePath)) return null;

  const result = spawnSync(
    ffprobe,
    [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return null;

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === 'video');
  if (!video) return null;

  const format = payload.format || {};
  const duration = Number(video.duration ?? format.duration ?? 0) || 0;

  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    duration: duration,
  };
}

/**
 * Read an audio file's duration and shape with ffprobe.
 *
 * @param {string} filePath
 * @returns {{duration: number, channels: number, sample_rate: number, bit_rate: number}|null}
 */
function probeAudio(filePath) {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return null;
  if (!fs.existsSync(filePath)) return null;

  const result = spawnSync(
    ffprobe,
    ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return null;

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const audio = streams.find((stream) => stream && stream.codec_type === 'audio');
  if (!audio) return null;

  const format = payload.format || {};
  return {
    duration: Number(audio.duration ?? format.duration ?? 0) || 0,
    channels: Number(audio.channels) || 0,
    sample_rate: Number(audio.sample_rate) || 0,
    bit_rate: Number(audio.bit_rate ?? format.bit_rate ?? 0) || 0,
  };
}

/**
 * Is this video whole AND usable?
 *
 * TWO CHECKS, AND THE SECOND ONE IS THE ONE THAT MATTERS
 *
 * The resolution check answers "can this be read?". It does NOT
 * answer "is this all of it?" -- and a TRUNCATED video passes the
 * resolution check, because the header is intact and the resolution is
 * right. A truncated download of a 46-minute video yields a file that
 * ffprobe happily describes as 1920x1080.
 *
 * That is not a hypothetical: the size the Mux metadata reports
 * (`primary_file_size`) is the size of the ORIGINAL UPLOADED asset,
 * not of the rendition that is served. The 1080p rendition is Mux's own
 * re-encode, and it is smaller. So the byte count cannot be compared
 * with the metadata -- but the DURATION can, and it is the same number
 * for both, because they are the same recording.
 *
 * @param {object} probe - the result of probeMedia
 * @param {number} [expectedDurationSec] - the duration the source reports
 * @returns {{ok: boolean, reason: string}}
 */
function checkVideo(probe, expectedDurationSec) {
  const resolution = checkResolution(probe);
  if (!resolution.ok) return resolution;
  const expected = Number(expectedDurationSec) || 0;
  if (expected > 0 && probe.duration) {
    // Two per cent, the same tolerance the audio gate uses.
    const ratio = probe.duration / expected;
    if (ratio < 0.98 || ratio > 1.02) {
      return { ok: false, reason: `duration_mismatch:${probe.duration.toFixed(1)}s_vs_${expected.toFixed(1)}s` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * Is this audio usable?
 *
 * The video's gate is a RESOLUTION check, because a video too small to
 * read cannot be read. The audio's gate is a LENGTH check, because the
 * failure mode is different: a truncated download still has an audio
 * stream, and it still decodes, and Deepgram would transcribe it without
 * complaining. So the only thing that catches a truncated file is
 * comparing its length with the length the source says it should have.
 *
 * @param {object} probe - the result of probeAudio
 * @param {number} [expectedDurationSec] - the duration the source reports
 * @returns {{ok: boolean, reason: string}}
 */
function checkAudio(probe, expectedDurationSec) {
  if (!probe) return { ok: false, reason: 'unmeasurable' };
  if (!probe.duration) return { ok: false, reason: 'no_duration' };
  if (!probe.channels) return { ok: false, reason: 'no_audio_stream' };
  const expected = Number(expectedDurationSec) || 0;
  if (expected > 0) {
    // Two per cent. A file that is more than 2% short is truncated, and
    // a transcript of a truncated file looks like a short video rather
    // than like a failure.
    const ratio = probe.duration / expected;
    if (ratio < 0.98 || ratio > 1.02) {
      return { ok: false, reason: `duration_mismatch:${probe.duration.toFixed(1)}s_vs_${expected.toFixed(1)}s` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * Is this video usable by the pipeline?
 *
 * @param {{width: number, height: number}} probe
 * @returns {{ok: boolean, reason: string}}
 */
function checkResolution(probe) {
  if (!probe) return { ok: false, reason: 'unmeasurable' };
  if (!probe.width || !probe.height) return { ok: false, reason: 'no_video_stream' };
  if (probe.height < MIN_VIDEO_HEIGHT || probe.width < MIN_VIDEO_WIDTH) {
    return { ok: false, reason: `too_small:${probe.width}x${probe.height}` };
  }
  return { ok: true, reason: '' };
}

/**
 * The free space on the volume that holds a directory.
 *
 * @param {string} dir
 * @returns {number} bytes, or 0 when it cannot be determined
 */
function freeSpaceBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}

/**
 * Is there room for a download of this size?
 *
 * The margin is deliberate: the pipeline also writes the extracted audio,
 * the transcript JSON and the frame captures, and a disk that is full
 * during the download fails in a way that reads as a network error.
 *
 * @param {string} dir
 * @param {number} neededBytes
 * @param {number} [marginFactor] - the multiplier on the needed size
 * @returns {{ok: boolean, free: number, needed: number, reason: string}}
 */
function ensureFreeSpace(dir, neededBytes, marginFactor = 1.25) {
  const free = freeSpaceBytes(dir);
  if (!free) {
    // Cannot measure. Not a reason to refuse: the download's own failure
    // is a clear enough signal.
    return { ok: true, free: 0, needed: Math.ceil(neededBytes * marginFactor), reason: 'free_space_unknown' };
  }
  const needed = Math.ceil(neededBytes * marginFactor);
  if (free < needed) {
    return { ok: false, free, needed, reason: `insufficient_space:free=${free},needed=${needed}` };
  }
  return { ok: true, free, needed, reason: '' };
}

/**
 * The posts whose media the pipeline still needs.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {boolean} [options.includeDone] - include posts already downloaded
 * @param {string} [options.kind] - which media kind to look for (default video)
 * @returns {Array<object>} rows from asym_posts, oldest first
 */
function mediaWorkList(db, options = {}) {
  const wantedKind = options.kind || ASYM_MEDIA_KIND.VIDEO;

  // The join is against a table that may not exist yet -- a fresh clone
  // has not run the schema that creates it, and a dry run opens the
  // catalog read-only precisely so it cannot create it. So the joined
  // query is tried first and the plain one is the fallback, which reports
  // every post with media as not-yet-downloaded.
  let rows;
  try {
    rows = db.prepare(`
      SELECT p.video_id, p.post_id, p.slug, p.title, p.upload_date, p.series,
             p.has_media, p.media_upload_id, p.media_duration,
             m.status AS media_status, m.kind AS media_kind,
             m.file_path, m.file_bytes, m.error AS media_error
        FROM asym_posts p
        LEFT JOIN asym_media m
               ON m.video_id = p.video_id AND m.kind = ?
       WHERE p.has_media = 1
         AND p.media_upload_id <> ''
       ORDER BY p.upload_date ASC, p.video_id ASC
    `).all(wantedKind);
  } catch {
    rows = db.prepare(`
      SELECT p.video_id, p.post_id, p.slug, p.title, p.upload_date, p.series,
             p.has_media, p.media_upload_id, p.media_duration,
             '' AS media_status, '' AS media_kind, '' AS file_path, 0 AS file_bytes, '' AS media_error
        FROM asym_posts p
       WHERE p.has_media = 1
         AND p.media_upload_id <> ''
       ORDER BY p.upload_date ASC, p.video_id ASC
    `).all();
  }

  return rows.filter((row) => {
    // A row of the wrong KIND is not a row that satisfies the request.
    // The audio path wants an MP3 and the video path wants an MP4, and
    // one does not stand in for the other.
    if (row.media_kind && row.media_kind !== wantedKind) return true;
    if (options.includeDone) return true;
    return row.media_status !== ASYM_MEDIA_STATUS.DOWNLOADED;
  });
}

/**
 * Make sure the media table has the columns this code writes.
 *
 * WHY THIS IS NEEDED
 *
 * `CREATE TABLE IF NOT EXISTS` does not ADD a column to a table that
 * already exists, and the media table was created by an earlier run of
 * the downloader -- before the `kind` column existed. So a catalog
 * written by that run has the table without the column, and every
 * INSERT that names it fails.
 *
 * This is the project's own idiom for the same problem -- the
 * extractors do `ALTER TABLE trade_signals ADD COLUMN claim_kind`
 * inside a try/catch -- and it is the right one here: the ALTER is
 * idempotent (it fails, harmlessly, when the column is already there)
 * and it needs no version bookkeeping for a table this young.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureAsymMediaSchema(db) {
  // The posts table carries the column that holds EVERY media id, and it
  // needs the same treatment.
  ensureAsymPostsMediaColumn(db);
  // The table may not exist yet -- a fresh clone has not run the schema
  // that creates it, and schema.sql will.
  let columns = [];
  try { columns = db.prepare('PRAGMA table_info(asym_media)').all(); } catch { columns = []; }
  if (!columns.length) return;

  // The key used to be video_id alone. It is now (video_id, kind), so a
  // post can hold BOTH its video and its audio. A table with the old key
  // has to be REBUILT -- SQLite cannot change a primary key in place.
  const kindColumn = columns.find((column) => column.name === 'kind');
  if (kindColumn && Number(kindColumn.pk) > 0) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(ASYM_MEDIA_DDL.replace('CREATE TABLE IF NOT EXISTS asym_media', 'CREATE TABLE asym_media_new'));
    // A row whose kind is missing or unknown becomes a video row, which is
    // what it was before the key changed.
    // The copy is built from the columns the table REALLY HAS. A table
    // written by an older schema may be missing `kind`, or any of the
    // columns added later, and naming a column that is not there is a
    // SQL error -- so a missing column becomes its default instead.
    const has = (name) => columns.some((column) => column.name === name);
    const pick = (name, fallback) => (has(name) ? name : fallback);
    const kindExpression = has('kind')
      ? "CASE WHEN kind IN ('video', 'audio') THEN kind ELSE 'video' END"
      : "'video'";
    const column = (name, fallback) => pick(name, fallback);
    db.exec(`INSERT OR REPLACE INTO asym_media_new (video_id, media_upload_id, kind, file_path, file_bytes,
      width, height, duration_sec, status, error, transcript_path, segment_count,
      transcribed_at, attempts, downloaded_at, updated_at)
      SELECT video_id, media_upload_id,
      ${kindExpression},
      ${column('file_path', "''")}, ${column('file_bytes', '0')},
      ${column('width', '0')}, ${column('height', '0')},
      ${column('duration_sec', '0')}, ${column('status', "'pending'")},
      ${column('error', "''")}, ${column('transcript_path', "''")},
      ${column('segment_count', '0')}, ${column('transcribed_at', "''")},
      ${column('attempts', '0')}, ${column('downloaded_at', "''")},
      ${column('updated_at', "datetime('now')")}
      FROM asym_media`);
    db.exec('DROP TABLE asym_media');
    db.exec('ALTER TABLE asym_media_new RENAME TO asym_media');
    db.exec('CREATE INDEX IF NOT EXISTS idx_asym_media_status ON asym_media(status)');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Record the state of one post's media.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row
 * @returns {void}
 */
function recordMedia(db, row) {
  const record = row || {};
  db.prepare(`
    INSERT INTO asym_media (
      video_id, media_upload_id, kind, file_path, file_bytes, width, height,
      duration_sec, status, error, attempts, downloaded_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id, kind) DO UPDATE SET
      media_upload_id = excluded.media_upload_id,
      kind = excluded.kind,
      file_path = excluded.file_path,
      file_bytes = excluded.file_bytes,
      width = excluded.width,
      height = excluded.height,
      duration_sec = excluded.duration_sec,
      status = excluded.status,
      error = excluded.error,
      attempts = excluded.attempts,
      downloaded_at = CASE
        WHEN excluded.downloaded_at <> '' THEN excluded.downloaded_at
        ELSE asym_media.downloaded_at
      END,
      updated_at = datetime('now')
  `).run(
    record.video_id,
    record.media_upload_id || '',
    record.kind || ASYM_MEDIA_KIND.VIDEO,
    record.file_path || '',
    Number(record.file_bytes) || 0,
    Number(record.width) || 0,
    Number(record.height) || 0,
    Number(record.duration_sec) || 0,
    record.status || ASYM_MEDIA_STATUS.PENDING,
    record.error || '',
    Number(record.attempts) || 0,
    record.downloaded_at || '',
  );
}

/**
 * Make sure the posts table carries the column that holds EVERY media id.
 *
 * `CREATE TABLE IF NOT EXISTS` does not add a column to a table that already
 * exists, so a catalog written before this column existed does not have it,
 * and every INSERT that names it fails. The ALTER is idempotent -- it fails,
 * harmlessly, when the column is already there -- which is the project's own
 * idiom for this.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureAsymPostsMediaColumn(db) {
  try {
    db.exec("ALTER TABLE asym_posts ADD COLUMN media_upload_ids TEXT NOT NULL DEFAULT ''");
  } catch {
    // The column is already there, or the table does not exist yet.
  }
}

/**
 * Record the media that is ALREADY on disk.
 *
 * WHY THIS IS NEEDED
 *
 * The media table used to be keyed by `video_id` alone, so a post could hold
 * only ONE row: recording the audio erased the video row, and recording the
 * video erased the audio row. The key is now (video_id, kind), so both can
 * exist -- but the rows that were overwritten while the old key was in place
 * are gone from the catalog, even though the FILES are still on disk.
 *
 * This reads the disk and writes back the rows the catalog is missing, so a
 * file that was downloaded is not downloaded again. It is safe to run at any
 * time: a file that fails its gate is reported, not recorded.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - report what would be recorded, write nothing
 * @returns {{checked: number, video: number, audio: number, rejected: Array<object>}}
 */
function reconcileLocalMedia(db, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const posts = db.prepare(
    "SELECT video_id, post_id, upload_date, media_upload_id, media_duration FROM asym_posts WHERE has_media = 1"
  ).all();

  const summary = { checked: posts.length, video: 0, audio: 0, rejected: [] };
  const existing = db.prepare('SELECT status FROM asym_media WHERE video_id = ? AND kind = ?');
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  for (const post of posts) {
    // -- the video -------------------------------------------------------
    const videoPath = asymMediaPath(post);
    if (fs.existsSync(videoPath)) {
      const row = existing.get(post.video_id, ASYM_MEDIA_KIND.VIDEO);
      if (!row || row.status !== ASYM_MEDIA_STATUS.DOWNLOADED) {
        const probe = probeMedia(videoPath);
        const check = checkVideo(probe, post.media_duration);
        if (check.ok) {
          if (!dryRun) recordMedia(db, {
            video_id: post.video_id,
            media_upload_id: post.media_upload_id || '',
            kind: ASYM_MEDIA_KIND.VIDEO,
            file_path: portablePath(videoPath),
            file_bytes: fs.statSync(videoPath).size,
            width: probe.width,
            height: probe.height,
            duration_sec: probe.duration,
            status: ASYM_MEDIA_STATUS.DOWNLOADED,
            attempts: 1,
            downloaded_at: stamp,
          });
          summary.video += 1;
        } else {
          summary.rejected.push({
            video_id: post.video_id,
            kind: ASYM_MEDIA_KIND.VIDEO,
            path: portablePath(videoPath),
            reason: check.reason,
          });
        }
      }
    }

    // -- the audio -------------------------------------------------------
    const audioPath = asymAudioPath(post);
    if (fs.existsSync(audioPath)) {
      const row = existing.get(post.video_id, ASYM_MEDIA_KIND.AUDIO);
      if (!row || row.status !== ASYM_MEDIA_STATUS.DOWNLOADED) {
        const probe = probeAudio(audioPath);
        const check = checkAudio(probe, post.media_duration);
        if (check.ok) {
          if (!dryRun) recordMedia(db, {
            video_id: post.video_id,
            media_upload_id: post.media_upload_id || '',
            kind: ASYM_MEDIA_KIND.AUDIO,
            file_path: portablePath(audioPath),
            file_bytes: fs.statSync(audioPath).size,
            duration_sec: probe.duration,
            status: ASYM_MEDIA_STATUS.DOWNLOADED,
            attempts: 1,
            downloaded_at: stamp,
          });
          summary.audio += 1;
        } else {
          summary.rejected.push({
            video_id: post.video_id,
            kind: ASYM_MEDIA_KIND.AUDIO,
            path: portablePath(audioPath),
            reason: check.reason,
          });
        }
      }
    }
  }

  return summary;
}

/**
 * Remove the leftovers of an interrupted run.
 *
 * A carrier file (the temporary video the audio path downloads) is never
 * resumable, so a leftover one is pure waste -- and a 55 MB one is
 * enough to look like the run is still going.
 *
 * @param {string} [dir] - the media directory
 * @returns {number} the files removed
 */
function sweepStalePartials(dir) {
  const target = dir || ASYM_MEDIA_DIR;
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.carrier.mp4')) continue;
    try {
      fs.unlinkSync(path.join(target, name));
      removed += 1;
    } catch { /* ignore */ }
  }
  return removed;
}

/**
 * Take the download lock, or refuse to run.
 *
 * TWO DOWNLOADERS AT ONCE IS A REAL FAILURE, and it was measured: a second
 * run started while a 271 MB download was in flight died with "fetch
 * failed: terminated", and the first one left a half-written carrier
 * behind.
 *
 * So the second one is refused, loudly, rather than allowed to compete.
 * A lock whose owner is dead is taken over, because the process that made
 * it may have been killed.
 *
 * @param {string} [dir] - the media directory
 * @returns {{release: () => void, path: string}}
 */
function takeDownloadLock(dir) {
  const target = dir || ASYM_MEDIA_DIR;
  const lockPath = path.join(target, '.download.lock');
  fs.mkdirSync(target, { recursive: true });

  const tryTake = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (!tryTake()) {
    let owner = 0;
    try {
      owner = Number(fs.readFileSync(lockPath, 'utf8').trim()) || 0;
    } catch { /* ignore */ }
    let alive = false;
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch { /* the owner is gone */ }
    }
    if (alive) {
      throw new Error(
        `Another download is already running (pid ${owner}). `
        + 'Wait for it to finish, or delete '
        + lockPath
        + ' if you are sure it is dead.',
      );
    }
    // The owner is dead: take the lock over.
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    if (!tryTake()) {
      throw new Error(`Could not take the download lock at ${lockPath}`);
    }
  }

  return {
    path: lockPath,
    release: () => {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  ASYM_AUDIO_DIR,
  ASYM_MEDIA_DDL,
  ASYM_MEDIA_DIR,
  ASYM_MEDIA_KIND,
  ASYM_MEDIA_STATUS,
  MIN_VIDEO_HEIGHT,
  MIN_VIDEO_WIDTH,
  asymAudioPath,
  asymMediaFileName,
  asymMediaPath,
  checkAudio,
  checkResolution,
  checkVideo,
  ensureAsymMediaSchema,
  ensureFreeSpace,
  freeSpaceBytes,
  mediaWorkList,
  portablePath,
  ensureAsymPostsMediaColumn,
  probeAudio,
  probeMedia,
  reconcileLocalMedia,
  recordMedia,
  sweepStalePartials,
  takeDownloadLock,
};