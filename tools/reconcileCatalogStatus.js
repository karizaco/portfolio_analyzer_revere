#!/usr/bin/env node
'use strict';

// Reconcile the catalog's `status` column against the filesystem.
//
// WHY THIS EXISTS
//
// `videos.status` cannot answer "is this video downloaded?". It is written by
// six tools, and `done` in particular means two different things:
//
//   tools/runAllOcr.js           'done' = "the OCR pass finished"
//                                            (writes a probe log, not output_path)
//   tools/whiteboard_worker.py   'done' = "the scan wrote an artifact"
//                                            (also sets output_path,
//                                            selected_timestamp, selected_score)
//
// The downloaders, meanwhile, leave a row in `scanning` once its media is on
// disk -- they never write `done`. So `done` says a pass finished, and says
// nothing at all about the file.
//
// Worse, both downloaders select their work with a status filter that
// EXCLUDES 'done', because a `done` row is supposed to be finished. A row
// that says 'done' but whose media has since been deleted is therefore
// invisible to every downloader: it is neither re-fetched nor reported as
// missing. Measured on 2026-10-29: **21 rows** were in that state -- all
// Revere, all pointing into the `downloads/` directory the 2026-10-21 cleanup
// removed.
//
// This tool reports what the catalog claims against what is on disk, and with
// `--execute` it resets the claims that are false. The reset is the whole
// point: it makes the stale rows visible to the downloaders again.
//
// A pointer is not evidence that a file is missing, and not evidence that one
// is present -- so every pointer is resolved against the filesystem, and the
// media is also looked for under the name the downloader itself writes
// (`<upload_date>_<video_id>.mp4`). A file can be on disk with no pointer
// naming it.
//
// The meanings of the status values are written down once, in
// src/video/videoStatus.js.
//
// Usage:
//   node tools/reconcileCatalogStatus.js              # report only
//   node tools/reconcileCatalogStatus.js --execute     # also reset false claims
//   node tools/reconcileCatalogStatus.js --json

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { resolveCatalogPath } = require('../src/video/downloadCandidates');
const { STATUS } = require('../src/video/videoStatus');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

// The directories a download writes into, relative to `data/video_pipeline/`.
// The first is the historical 720p directory; the second is where the hires
// batch lands; the third is the 1080p directory. A file can be in any of them.
const DOWNLOAD_DIRS = ['downloads', 'downloads_hires', 'downloads_1080p'];

// Where those directories live, relative to the repository root.
const MEDIA_ROOT = path.join('data', 'video_pipeline');

// A download smaller than this is a truncated file, not a video.
const MIN_FILE_BYTES = 1024 * 1024;

/**
 * The status values that mean "this video still needs its media fetched".
 *
 * `error` is deliberately not here: it is used for a lot of things, and only
 * one of them is a missing file. The reconciliation cannot tell which, so it
 * leaves those rows for a human -- the report calls them "review / no_match
 * / error".
 */
const ACTIVE_STATUSES = new Set([STATUS.PENDING, STATUS.SCANNING]);

/**
 * The name a downloader writes a video under.
 *
 * @param {object} row - a catalog row
 * @returns {string}
 */
function downloaderFileName(row) {
  const stamp = row.upload_date && row.upload_date !== 'NA' ? `${row.upload_date}_` : '';
  return `${stamp}${row.video_id}.mp4`;
}

/**
 * Does this path point at a real video file?
 *
 * A file smaller than a megabyte is a truncated download, not a video, so it
 * does not count as present.
 *
 * @param {string} p
 * @param {(p: string) => boolean} [exists]
 * @param {(p: string) => number} [sizeOf]
 * @returns {boolean}
 */
function isRealFile(p, exists = fs.existsSync, sizeOf = (f) => fs.statSync(f).size) {
  if (!p || !exists(p)) return false;
  try {
    return sizeOf(p) > MIN_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Where a row's media could be.
 *
 * Two answers, and both are checked: the pointer the catalog holds, and the
 * name the downloader itself writes. The second is what finds a file that is
 * on disk with no pointer naming it.
 *
 * @param {object} row
 * @param {object} [options]
 * @param {string} [options.cwd] - repository root
 * @param {string[]} [options.dirs] - the download directories, relative to the root
 * @param {(p: string) => boolean} [options.exists]
 * @param {(p: string) => number} [options.sizeOf]
 * @returns {{pointer: string|null, pointerPresent: boolean, own: string|null, ownPresent: boolean, mediaPresent: boolean}}
 */
function locateMedia(row, options = {}) {
  const cwd = options.cwd || ROOT;
  const dirs = options.dirs || DOWNLOAD_DIRS;
  const exists = options.exists || fs.existsSync;
  const sizeOf = options.sizeOf || ((p) => fs.statSync(p).size);

  const pointer = resolveCatalogPath(row.download_path, cwd) || null;
  const pointerPresent = isRealFile(pointer, exists, sizeOf);

  let own = null;
  for (const dir of dirs) {
    const candidate = path.resolve(cwd, MEDIA_ROOT, dir, downloaderFileName(row));
    if (isRealFile(candidate, exists, sizeOf)) { own = candidate; break; }
  }
  const ownPresent = own !== null;

  return {
    pointer,
    pointerPresent,
    own,
    ownPresent,
    mediaPresent: pointerPresent || ownPresent,
  };
}

/**
 * The video ids a file name could mean.
 *
 * Three spellings turn up in this tree, and a file has to be matched against
 * all of them:
 *
 *   `<date>_<id>.mp4`  the downloader's own name
 *   `<id>.mp4`         the older scheme, with no date
 *   `<date>_<id>-1080p.mp4`  a resolution suffix a later run appended
 *
 * And the id itself may carry a leading underscore -- some Qullamaggie ids
 * start with one, and a September 2026 download run prepended another. So
 * `_-3qtA_s7g9c.mp4` is the video `-3qtA_s7g9c`, while `__2urSPdZVec.mp4` is
 * the video `_2urSPdZVec`. Without both forms most such files look like they
 * belong to nothing.
 *
 * @param {string} fileName
 * @returns {string[]}
 */
function idForms(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const forms = [];
  const dated = /^(\d{8})_(.+)$/.exec(stem);
  if (dated) {
    // `<date>_<id>.mp4` -- the date is the downloader's, not part of the id.
    forms.push(dated[2]);
  } else {
    // `<id>.mp4` -- the older scheme, with no date.
    forms.push(stem);
    if (stem.startsWith('_')) forms.push(stem.slice(1));
  }
  return [...new Set(forms)].map((id) => id.replace(/-1080p$/, ''));
}

/**
 * The files on disk that no catalog pointer names.
 *
 * The other direction of the same reconciliation: a video can be downloaded
 * and still have no pointer saying so. Measured on 2026-10-29: 36 files, 22 of
 * them 1080p copies of Qullamaggie videos whose pointer names the 720p copy
 * instead, and 11 whose pointer names a 1080p file that was never fetched.
 *
 * @param {object[]} rows - catalog rows
 * @param {object} [options]
 * @param {string} [options.cwd] - repository root
 * @param {string[]} [options.dirs] - download directory names
 * @param {(p: string) => boolean} [options.exists]
 * @param {(p: string) => string[]} [options.listDir]
 * @returns {object[]}
 */
function unclaimedFiles(rows, options = {}) {
  const cwd = options.cwd || ROOT;
  const dirs = options.dirs || DOWNLOAD_DIRS;
  const exists = options.exists || fs.existsSync;
  const listDir = options.listDir || ((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []));

  const claimed = new Set();
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.video_id, row);
    const pointer = resolveCatalogPath(row.download_path, cwd);
    if (pointer) claimed.add(path.resolve(pointer).toLowerCase());
  }

  const out = [];
  for (const dir of dirs) {
    const full = path.resolve(cwd, MEDIA_ROOT, dir);
    for (const name of listDir(full)) {
      if (!name.toLowerCase().endsWith('.mp4')) continue;
      const abs = path.resolve(full, name);
      if (claimed.has(abs.toLowerCase())) continue;
      const forms = idForms(name);
      const row = forms.map((id) => byId.get(id)).find(Boolean) || null;
      out.push({
        directory: dir,
        file: name,
        path: abs,
        video_id: row ? row.video_id : null,
        inCatalog: Boolean(row),
        triedIds: forms,
        rowStatus: row ? row.status : null,
        rowPointer: row ? row.download_path : null,
      });
    }
  }
  return out;
}

/**
 * Classify a row against the filesystem.
 *
 * @param {object} row
 * @param {object} [options] - see locateMedia
 * @returns {object}
 */
function classifyRow(row, options = {}) {
  const media = locateMedia(row, options);
  const status = String(row.status || '');

  let classification;
  if (status === 'done') {
    // The claim is "finished". It holds only if the media is really there.
    classification = media.mediaPresent ? 'done-present' : 'done-missing';
  } else if (ACTIVE_STATUSES.has(status)) {
    classification = media.mediaPresent ? 'active-present' : 'active-missing';
  } else {
    classification = 'other';
  }

  return {
    video_id: row.video_id,
    channel: row.channel || '',
    upload_date: row.upload_date || '',
    status,
    download_path: row.download_path || '',
    classification,
    mediaPresent: media.mediaPresent,
    pointerPresent: media.pointerPresent,
    ownPresent: media.ownPresent,
    stale: classification === 'done-missing',
  };
}

/**
 * Classify a whole catalog.
 *
 * @param {object[]} rows
 * @param {object} [options]
 * @returns {{rows: object[], counts: Record<string, number>, stale: object[], pointerRows: number, pointerResolved: number, unpointedMedia: number}}
 */
function reconcile(rows, options = {}) {
  const classified = rows.map((row) => classifyRow(row, options));
  const counts = {};
  for (const row of classified) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  const withPointer = classified.filter((r) => r.download_path);
  return {
    rows: classified,
    counts,
    stale: classified.filter((r) => r.stale),
    pointerRows: withPointer.length,
    pointerResolved: withPointer.filter((r) => r.pointerPresent).length,
    unpointedMedia: classified.filter((r) => r.ownPresent && !r.pointerPresent).length,
    unclaimed: options.listDir ? unclaimedFiles(rows, options) : null,
  };
}

/**
 * The rows whose 'done' claim is false.
 *
 * These are the rows a downloader cannot see: its candidate query excludes
 * 'done', so a row that says 'done' and has no media is neither re-fetched nor
 * reported. Resetting it to 'pending' puts it back in reach.
 *
 * @param {object[]} rows - catalog rows
 * @param {object} [options] - see locateMedia
 * @returns {object[]}
 */
function planReset(rows, options = {}) {
  return reconcile(rows, options).stale;
}

/**
 * Reset the false claims.
 *
 * The pointer is left alone: it is the correct name for the file, and the
 * downloader rewrites it when it fetches the video again.
 *
 * @param {object} db - an open DatabaseSync
 * @param {object[]} stale
 * @param {string} [now] - the timestamp to stamp the rows with
 * @returns {number} how many rows were reset
 */
function resetStaleClaims(db, stale, now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')) {
  const update = db.prepare(
    "UPDATE videos SET status = 'pending', error = '', updated_at = ? WHERE video_id = ? AND status = 'done'");
  let changed = 0;
  for (const row of stale) {
    changed += update.run(now, row.video_id).changes;
  }
  return changed;
}

function printReport(report, dbPath, mode) {
  console.log('Catalog status reconciliation (' + mode + ')');
  console.log('  database: ' + path.relative(ROOT, dbPath));
  console.log('  rows:     ' + report.rows.length);
  console.log('');

  console.log('  status against the filesystem');
  const order = ['done-present', 'done-missing', 'active-present', 'active-missing', 'other'];
  for (const key of order) {
    const n = report.counts[key] || 0;
    if (!n) continue;
    const label = {
      'done-present': "done, media present   -- the claim holds",
      'done-missing': "done, media MISSING   -- the claim is FALSE",
      'active-present': 'pending/scanning, media present',
      'active-missing': 'pending/scanning, media missing',
      other: 'review / no_match / error',
    }[key];
    console.log('    ' + String(n).padStart(5) + '  ' + label);
  }
  console.log('');

  console.log('  pointers');
  console.log('    ' + String(report.pointerRows).padStart(5) + '  rows carry a download_path');
  console.log('    ' + String(report.pointerResolved).padStart(5) + '  of those resolve to a file that is there');
  console.log('    ' + String(report.pointerRows - report.pointerResolved).padStart(5) + '  point at a file that is gone');
  console.log('');

  if (report.unclaimed) {
    const notInCatalog = report.unclaimed.filter((f) => !f.inCatalog);
    console.log('  files on disk');
    console.log('    ' + String(report.unclaimed.length).padStart(5) + '  files that no pointer names');
    console.log('    ' + String(notInCatalog.length).padStart(5) + '  of those are for a video the catalog does not have');
    for (const file of notInCatalog.slice(0, 20)) {
      console.log('        ' + file.directory + '/' + file.file
        + '   (tried as: ' + file.triedIds.join(', ') + ')');
    }
    console.log('');
  }

  if (report.stale.length) {
    console.log('  ' + report.stale.length + ' row(s) claim "done" but have no media. '
      + 'The downloaders exclude "done", so these are invisible to them:');
    for (const row of report.stale.slice(0, 30)) {
      console.log('    ' + row.video_id.padEnd(14) + (row.channel || '').padEnd(14)
        + (row.upload_date || '').padEnd(10) + row.download_path);
    }
    if (report.stale.length > 30) console.log('    ... and ' + (report.stale.length - 30) + ' more');
  } else {
    console.log('  No row claims "done" without having the media.');
  }
}

function main(argv = process.argv.slice(2)) {
  const execute = argv.includes('--execute');
  const asJson = argv.includes('--json');
  const dbIndex = argv.indexOf('--db');
  const dbPath = dbIndex >= 0 && argv[dbIndex + 1]
    ? path.resolve(argv[dbIndex + 1])
    : DB_PATH;

  if (!fs.existsSync(dbPath)) {
    console.error('No catalog at ' + dbPath);
    return 1;
  }

  const db = new DatabaseSync(dbPath, { readOnly: !execute });
  const rows = db.prepare(
    'SELECT video_id, channel, upload_date, status, download_path FROM videos').all();
  const report = reconcile(rows, { listDir: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []) });

  if (!asJson) printReport(report, dbPath, execute ? 'execute' : 'report only');

  if (execute && report.stale.length) {
    const changed = resetStaleClaims(db, report.stale);
    if (!asJson) {
      console.log('');
      console.log('  Reset ' + changed + ' row(s) to status=pending. They are back in the downloaders\' reach.');
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      database: path.relative(ROOT, dbPath),
      rows: report.rows.length,
      counts: report.counts,
      pointerRows: report.pointerRows,
      pointerResolved: report.pointerResolved,
      unpointedMedia: report.unpointedMedia,
      unclaimed: (report.unclaimed || []).map((f) => ({
        directory: f.directory, file: f.file, video_id: f.video_id, inCatalog: f.inCatalog,
      })),
      stale: report.stale.map((r) => ({
        video_id: r.video_id, channel: r.channel, upload_date: r.upload_date, download_path: r.download_path,
      })),
      executed: execute,
    }, null, 2));
  }

  db.close();
  return 0;
}

module.exports = {
  ACTIVE_STATUSES,
  DOWNLOAD_DIRS,
  MEDIA_ROOT,
  MIN_FILE_BYTES,
  classifyRow,
  downloaderFileName,
  idForms,
  isRealFile,
  locateMedia,
  planReset,
  reconcile,
  resetStaleClaims,
  unclaimedFiles,
};

if (require.main === module) process.exit(main());
