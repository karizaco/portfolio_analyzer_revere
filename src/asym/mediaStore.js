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
 * @returns {Array<object>} rows from asym_posts, oldest first
 */
function mediaWorkList(db, options = {}) {
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
        LEFT JOIN asym_media m ON m.video_id = p.video_id
       WHERE p.has_media = 1
         AND p.media_upload_id <> ''
       ORDER BY p.upload_date ASC, p.video_id ASC
    `).all();
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

  const wantedKind = options.kind || ASYM_MEDIA_KIND.VIDEO;
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
  try {
    db.exec("ALTER TABLE asym_media ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
  } catch {
    // The column is already there. That is the expected case.
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
    ON CONFLICT(video_id) DO UPDATE SET
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
  probeAudio,
  probeMedia,
  recordMedia,
  sweepStalePartials,
  takeDownloadLock,
};