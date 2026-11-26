'use strict';

/**
 * Extract the video id from a media filename.
 *
 * The downloader writes `<upload_date>_<video_id>.mp4`, where upload_date is
 * an 8-digit YYYYMMDD. A row whose upload_date is empty is written as plain
 * `<video_id>.mp4` (517 of the 716 files on disk are in that shape).
 *
 * The date prefix must therefore be matched EXACTLY as 8 digits. Matching
 * `\d+_` instead truncates any video id that itself begins with digits —
 * "438_cyYQ888" becomes "cyYQ888", "0_inu2Isf4k" becomes "inu2Isf4k" — and
 * the video then looks absent from disk. That is how two real 1080p videos
 * were reported as "still lost" when they were sitting on disk the whole time.
 */

/** The 8-digit upload_date prefix the downloader adds. */
const DATE_PREFIX = /^\d{8}_/;

/**
 * @param {string} fileName a media file's basename, e.g. "20260612_xC63a7idsGQ.mp4"
 * @returns {string} the bare video id, e.g. "xC63a7idsGQ"
 */
function mediaVideoId(fileName) {
  return String(fileName).replace(DATE_PREFIX, '').replace(/\.mp4$/i, '');
}

module.exports = { mediaVideoId, DATE_PREFIX };
