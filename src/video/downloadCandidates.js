'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getDownloadDir,
  media1080SearchDirs,
  resolveMediaPath,
  uniqueResolvedDirs,
} = require('./mediaRoots');

const {
  DOWNLOAD_CANDIDATE_STATUSES,
  HIRES_CANDIDATE_STATUSES,
  sqlOcrChannelCondition,
  sqlStatusList,
} = require('./videoStatus');

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
//
// The status list comes from src/video/videoStatus.js, which is where the
// meaning of each status is written down. Note what the filter leaves out:
// `done`. A `done` row has been OCR'd, and the OCR pass is why this tool
// has nothing to do with it — but `done` says nothing about whether the
// media is still on disk, so a `done` row whose file was deleted is
// invisible here. That is what tools/reconcileCatalogStatus.js repairs.
const CANDIDATE_SQL = `
SELECT video_id, upload_date, title, download_path, status FROM videos
WHERE status IN (${sqlStatusList(HIRES_CANDIDATE_STATUSES)})
AND channel = 'qullamaggie'
ORDER BY upload_date DESC, video_id ASC
`;

/**
 * Resolve a catalog `download_path` to a local path.
 *
 * The column holds absolute Windows paths written on whichever machine did
 * the download, and repo-relative paths. An absolute path from another
 * machine cannot be resolved here — it simply will not exist, which is the
 * honest answer. Absolute paths on another local drive (D:\\...) are kept as-is
 * so a split library still resolves.
 *
 * @param {string|null|undefined} downloadPath
 * @param {string} [cwd] - repository root, used for relative paths
 * @returns {string|null}
 */
function resolveCatalogPath(downloadPath, cwd = process.cwd()) {
  if (!downloadPath) return null;
  // Absolute other-drive paths (D:\\...) and repo-relative data/... paths.
  return resolveMediaPath(downloadPath, { cwd });
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
 * Does this path point into the classic 1080p download directory name?
 *
 * Used by inventory/reporting. findHiresOnDisk no longer requires this
 * substring — a file on D:\\ or in media_roots extra_dirs still counts.
 *
 * @param {string|null} p
 * @returns {boolean}
 */
function isHiresPath(p) {
  if (!p) return false;
  return p.replace(/\\/g, '/').includes('downloads_1080p');
}

/**
 * True when a catalog pointer is the 720p library (must not skip 1080 download).
 * @param {string|null} p
 * @returns {boolean}
 */
function is720HiresLibraryPath(p) {
  if (!p) return false;
  return p.replace(/\\/g, '/').toLowerCase().includes('downloads_hires');
}

/**
 * Directories to scan for an existing 1080-class file.
 * options.dir is searched first (tests + callers that pin one folder).
 * Then media1080SearchDirs() (primary 1080p + extra_dirs), unless options.dirs
 * is provided.
 *
 * @param {object} options
 * @returns {string[]}
 */
function hiresSearchDirs(options = {}) {
  const primary = [];
  if (options.dir) primary.push(options.dir);
  const rest = options.dirs
    ? options.dirs
    : (typeof options.media1080SearchDirs === 'function'
      ? options.media1080SearchDirs()
      : media1080SearchDirs());
  return uniqueResolvedDirs([...primary, ...rest]);
}

/**
 * The 1080p (or extra-root equivalent) copy of this video on disk, or null.
 *
 * Places checked:
 *   1. `<dir>/<upload_date>_<video_id>.mp4` across 1080 search dirs (primary
 *      downloads_1080p + extra_dirs from media roots)
 *   2. Catalog `download_path` when the file exists and is NOT under
 *      downloads_hires (720p must not count as "already have 1080")
 *
 * A copy only in `downloads_hires` does NOT count: the 1080 downloader exists
 * to fetch the higher-resolution version.
 *
 * @param {object} row - a catalog row
 * @param {object} [options]
 * @param {string} [options.dir] - preferred first search directory
 * @param {string[]} [options.dirs] - override full search list
 * @param {string} [options.cwd] - repository root, used for relative paths
 * @param {(p: string) => boolean} [options.exists] - existence check
 * @param {(p: string) => number} [options.sizeOf] - size in bytes
 * @returns {string|null} the local path of the 1080-class copy
 */
function findHiresOnDisk(row, options = {}) {
  if (!row) return null;
  const exists = options.exists || fs.existsSync;
  const sizeOf = options.sizeOf || ((p) => fs.statSync(p).size);

  const expectedName = `${row.upload_date ? `${row.upload_date}_` : ''}${row.video_id}.mp4`;
  for (const dir of hiresSearchDirs(options)) {
    const expected = path.join(dir, expectedName);
    if (exists(expected) && sizeOf(expected) > MIN_FILE_BYTES) return expected;
  }

  const catalogPath = resolveCatalogPath(row.download_path, options.cwd || process.cwd());
  if (
    catalogPath
    && !is720HiresLibraryPath(catalogPath)
    && exists(catalogPath)
    && sizeOf(catalogPath) > MIN_FILE_BYTES
  ) {
    return catalogPath;
  }

  return null;
}

/**
 * The candidate query for the 720p batch downloader.
 *
 * It differs from the 1080p one in three ways: it is not restricted to
 * Qullamaggie, it retries `error` rows, and it can be narrowed to an
 * explicit list of ids.
 *
 * The status filter comes from src/video/videoStatus.js, like the 1080p
 * query's -- so the two downloaders cannot drift apart on what a status
 * means.
 *
 * @param {object} [options]
 * @param {string} [options.pathCondition] - an extra SQL condition on the pointer
 * @returns {string}
 */
function buildDownloadCandidateSql(options = {}) {
  const pathCondition = options.pathCondition || 'download_path IS NOT NULL';
  return `
SELECT video_id, upload_date, title, download_path, status FROM videos
WHERE status IN (${sqlStatusList(DOWNLOAD_CANDIDATE_STATUSES)}) AND ${pathCondition}
AND ${sqlOcrChannelCondition()}
AND upload_date IS NOT NULL AND upload_date != 'NA'
ORDER BY upload_date DESC, video_id ASC
`;
}

/**
 * Decide what still needs downloading, given the checkpoint.
 *
 * WHY THIS EXISTS
 *
 * The 1080p downloader used to ask the CHECKPOINT first:
 *
 *     if (checkpoint.done.some(...)) { skippedCheckpoint += 1; continue; }
 *     const onDisk = findHiresOnDisk(row, { dir: dlDir });
 *
 * That ordering is the bug. `checkpoint.done` records "a download run
 * finished this id" -- it says nothing about whether the file is still on
 * disk. Measured on 2026-11-17: of 457 ids in the QMG 1080p checkpoint, 181
 * had NO file anywhere on disk (D:, downloads_1080p, downloads_hires,
 * downloads, or the Recycle Bin). All 181 came from the 2026-11-06 run.
 * Because the checkpoint was consulted first, those 181 were skipped forever:
 * never re-fetched, never reported as missing, and the catalog said
 * `status='scanning'` with a `download_path` pointing into a directory that
 * no longer held the file.
 *
 * The fix is the ORDER: the FILESYSTEM answers "is it already downloaded?",
 * and the checkpoint only answers "did we already try?".
 *
 * THE ORDER, AND WHY
 *
 *   1. excluded        -- a known 720p-only video; the 1080p pass cannot
 *                          satisfy it and must not keep re-trying it.
 *   2. on disk        -- the work is DONE, whatever the checkpoint says.
 *   3. errored        -- a recent attempt failed; do not retry silently.
 *   4. blocked        -- a previous run decided this one must not proceed.
 *   5. otherwise      -- download it. This includes the STRANDED ids: the
 *                          checkpoint says done, the filesystem says gone.
 *
 * Step 2 before step 3 matters too: a video whose file is on disk is
 * satisfied even if an earlier attempt errored, so a good file is never
 * re-fetched because of a stale error entry.
 *
 * @param {object[]} rows - catalog rows (the candidate query's output)
 * @param {object} [checkpoint] - { done, errored, blocked }
 * @param {object} [options]
 * @param {string} [options.dir] - preferred first search directory
 * @param {string[]} [options.dirs] - override the full search list
 * @param {string} [options.cwd] - repository root for relative paths
 * @param {boolean} [options.retryErrored] - retry the errored bucket
 * @param {string[]} [options.excludeIds] - ids this pass must not download
 * @param {(p: string) => boolean} [options.exists]
 * @param {(p: string) => number} [options.sizeOf]
 * @returns {{
 *   todo: object[],
 *   satisfied: {row: object, path: string, alreadyInCheckpoint: boolean}[],
 *   stranded: object[],
 *   skippedErrored: number,
 *   skippedBlocked: number,
 *   skippedExcluded: number,
 * }}
 */
function selectDownloadCandidates(rows, checkpoint = {}, options = {}) {
  const {
    dir,
    dirs,
    cwd,
    exists,
    sizeOf,
    retryErrored = false,
    excludeIds = [],
    findOnDisk = findHiresOnDisk,
  } = options;

  const doneIds = new Set(
    (Array.isArray(checkpoint.done) ? checkpoint.done : [])
      .map((e) => (typeof e === 'string' ? e : e && e.id))
      .filter(Boolean)
      .map((id) => String(id))
  );
  const errored = (checkpoint.errored && typeof checkpoint.errored === 'object') ? checkpoint.errored : {};
  const blocked = new Set(
    (Array.isArray(checkpoint.blocked) ? checkpoint.blocked : []).map((id) => String(id))
  );
  const excluded = new Set(
    (Array.isArray(excludeIds) ? excludeIds : []).map((id) => String(id).trim().toLowerCase())
  );

  const todo = [];
  const satisfied = [];
  const stranded = [];
  let skippedErrored = 0;
  let skippedBlocked = 0;
  let skippedExcluded = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const videoId = row && row.video_id;
    if (!videoId) continue;
    const id = String(videoId);

    if (excluded.has(id.trim().toLowerCase())) { skippedExcluded += 1; continue; }

    const onDisk = findOnDisk(row, { dir, dirs, cwd, exists, sizeOf });
    if (onDisk) {
      satisfied.push({ row, path: onDisk, alreadyInCheckpoint: doneIds.has(id) });
      continue;
    }

    // The file is NOT on disk. A checkpoint entry claiming success is stale.
    if (doneIds.has(id)) stranded.push(row);

    if (!retryErrored && errored[id]) { skippedErrored += 1; continue; }
    if (blocked.has(id)) { skippedBlocked += 1; continue; }

    todo.push(row);
  }

  return {
    todo,
    satisfied,
    stranded,
    skippedErrored,
    skippedBlocked,
    skippedExcluded,
  };
}

module.exports = {
  CANDIDATE_SQL,
  DOWNLOAD_CANDIDATE_STATUSES,
  HIRES_CANDIDATE_STATUSES,
  MIN_FILE_BYTES,
  REPO_DATA_MARKER,
  buildDownloadCandidateSql,
  findHiresOnDisk,
  isHiresPath,
  is720HiresLibraryPath,
  resolveCatalogPath,
  selectDownloadCandidates,
  toPortablePath,
};
