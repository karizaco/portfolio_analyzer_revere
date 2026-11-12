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
             m.status AS media_status, m.file_path, m.file_bytes, m.error AS media_error
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
             '' AS media_status, '' AS file_path, 0 AS file_bytes, '' AS media_error
        FROM asym_posts p
       WHERE p.has_media = 1
         AND p.media_upload_id <> ''
       ORDER BY p.upload_date ASC, p.video_id ASC
    `).all();
  }

  return rows.filter((row) => {
    if (options.includeDone) return true;
    return row.media_status !== ASYM_MEDIA_STATUS.DOWNLOADED;
  });
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
      video_id, media_upload_id, file_path, file_bytes, width, height,
      duration_sec, status, error, attempts, downloaded_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      media_upload_id = excluded.media_upload_id,
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

module.exports = {
  ASYM_MEDIA_DIR,
  ASYM_MEDIA_STATUS,
  MIN_VIDEO_HEIGHT,
  MIN_VIDEO_WIDTH,
  asymMediaFileName,
  asymMediaPath,
  checkResolution,
  ensureFreeSpace,
  freeSpaceBytes,
  mediaWorkList,
  portablePath,
  probeMedia,
  recordMedia,
};