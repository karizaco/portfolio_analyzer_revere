'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Which videos still need downloading.
//
// THE PROBLEM THIS SOLVES
// The catalog's `download_path` is a POINTER, and it goes stale: it records
// where a file was when some machine downloaded it, and nothing updates it
// when the file is later deleted. Measured on 2026-10-29: 541 QMG rows point
// into `downloads_1080p`, and only 27 of those files still resolve on disk.
// The other 514 are pointers to files that are gone.
//
// So "is this video already downloaded?" has to be answered by the
// FILESYSTEM, not by the string in the column.
//
// `tools/downloadQmg1080p.js` used to answer it with
// `download_path NOT LIKE '%downloads_1080p%'` — a string test that excluded
// every row whose pointer mentioned the target directory, including the 514
// whose file is gone. That selected 47 of 588 QMG rows and made the missing
// videos impossible to re-fetch with the tool meant to fetch them.
//
// It also broke `--only-ids`: a requested id whose row pointed into
// downloads_1080p was reported as "not in catalog", because the query it was
// filtered against no longer contained it.

// Where the catalog's paths live inside the repository.
const REPO_DATA_MARKER = 'data/video_pipeline/';

// A download smaller than this is a truncated file, not a video.
const MIN_FILE_BYTES = 1024 * 1024;

// The candidate query.
//
// The status filter keeps out rows that have already been OCR'd. The
// download_path is NOT filtered here — the filesystem check below decides,
// because a path string cannot tell a present file from a deleted one.
const CANDIDATE_SQL = `
SELECT video_id, upload_date, title, download_path FROM videos
WHERE status IN ('pending','scanning')
AND channel = 'qullamaggie'
ORDER BY upload_date DESC, video_id ASC
`;

/**
 * Resolve a catalog `download_path` to a local path.
 *
 * The column holds absolute Windows paths written on whichever machine did
 * the download, and repo-relative paths. An absolute path from another
 * machine cannot be resolved here — it simply will not exist, which is the
 * honest answer.
 *
 * @param {string|null|undefined} downloadPath
 * @param {string} [cwd] - repository root, used for relative paths
 * @returns {string|null}
 */
function resolveCatalogPath(downloadPath, cwd = process.cwd()) {
  if (!downloadPath) return null;
  const normalised = String(downloadPath).replace(/\\/g, '/');
  const marker = normalised.indexOf(REPO_DATA_MARKER);
  if (marker !== -1) return path.resolve(cwd, normalised.slice(marker));
  return path.resolve(cwd, downloadPath);
}

/**
 * Turn a local path into one that still means something on another machine.
 *
 * The inverse of `resolveCatalogPath`. A path inside the repository is stored
 * relative to the repository root, so the pointer survives being committed and
 * checked out somewhere else. A path outside it — a test's temporary directory,
 * say — has no such form and keeps its absolute one.
 *
 * This is the JavaScript twin of `portable_path()` in
 * `tools/whiteboard_worker.py`; the two must agree, because the column is
 * written from both languages.
 *
 * @param {string|null|undefined} p
 * @param {string} [cwd] - repository root
 * @returns {string|null}
 */
function toPortablePath(p, cwd = process.cwd()) {
  if (!p) return p;
  const absolute = path.resolve(cwd, p);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}

/**
 * Does this path point into the 1080p download directory?
 *
 * @param {string|null} p
 * @returns {boolean}
 */
function isHiresPath(p) {
  if (!p) return false;
  return p.replace(/\\/g, '/').includes('downloads_1080p');
}

/**
 * The 1080p copy of this video that is already on disk, or null.
 *
 * Two places can hold it: the name the downloader writes
 * (`<upload_date>_<video_id>.mp4`), and whatever the catalog points at —
 * which for the older rows is a different name under the same directory.
 *
 * A copy in `downloads_hires` is a 720p file and does NOT count: the
 * downloader exists to fetch the 1080p version.
 *
 * @param {object} row - a catalog row
 * @param {object} [options]
 * @param {string} [options.dir] - the 1080p download directory
 * @param {string} [options.cwd] - repository root, used for relative paths
 * @param {(p: string) => boolean} [options.exists] - existence check
 * @param {(p: string) => number} [options.sizeOf] - size in bytes
 * @returns {string|null} the local path of the 1080p copy
 */
function findHiresOnDisk(row, options = {}) {
  if (!row) return null;
  const dir = options.dir || path.resolve('data', 'video_pipeline', 'downloads_1080p');
  const exists = options.exists || fs.existsSync;
  const sizeOf = options.sizeOf || ((p) => fs.statSync(p).size);

  const expected = path.join(dir, `${row.upload_date ? `${row.upload_date}_` : ''}${row.video_id}.mp4`);
  if (exists(expected) && sizeOf(expected) > MIN_FILE_BYTES) return expected;

  const catalogPath = resolveCatalogPath(row.download_path, options.cwd || process.cwd());
  if (catalogPath && isHiresPath(catalogPath) && exists(catalogPath)) return catalogPath;

  return null;
}

module.exports = {
  CANDIDATE_SQL,
  MIN_FILE_BYTES,
  REPO_DATA_MARKER,
  findHiresOnDisk,
  isHiresPath,
  resolveCatalogPath,
  toPortablePath,
};
