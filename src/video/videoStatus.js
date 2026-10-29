'use strict';

// The catalog's `status` column: what each value means, and who reads it.
//
// WHY THIS EXISTS
//
// `videos.status` is one column with six writers, and the two of them that
// matter most disagree about what `done` means:
//
//   tools/runAllOcr.js            'done' = "the OCR pass finished"
//   tools/whiteboard_worker.py    'done' = "the scan wrote an artifact"
//                                  (and it fills output_path with it)
//
// So `status='done'` cannot answer "has this video been processed?" on its
// own, and it certainly cannot answer "is this video downloaded?".
//
// THE STATE MACHINE, as it actually behaves
//
//   pending      the catalog row exists; the media has not been fetched
//   downloading  a download has been claimed and has not finished
//   scanning     THE MEDIA IS ON DISK. Nothing has been scanned yet.
//   review       the scan found something that needs a human
//   done         an OCR pass finished -- or a scan wrote an artifact
//   no_match     the scan found nothing
//   error        the pass failed, INCLUDING "the media file is missing"
//
// The order matters. `scanning` is the state the DOWNLOADERS leave a video in
// once the file is on disk, and it is also the queue both OCR paths read. So
// the OCR paths and the downloaders are not independent: a downloader that
// finds a file on disk does not touch the row's status, and an OCR pass that
// has already run leaves the row in `done`.
//
// THE TRAP
//
// Both downloaders select their work with a status filter that EXCLUDES
// `done`, because a `done` row is supposed to be finished. But `done` says
// nothing about whether the media is still there. A row that was OCR'd and
// whose file was later deleted is therefore invisible to every downloader:
// neither re-fetched, nor reported as missing.
//
// Measured on 2026-10-29: 21 rows were in exactly that state -- all Revere,
// all pointing into the `data/video_pipeline/downloads/` directory that the
// 2026-10-21 cleanup removed.
//
// `tools/reconcileCatalogStatus.js` is the repair: it resolves every pointer
// against the filesystem, and resets the claims that are false.
//
// Note the asymmetry that makes this survivable for the whiteboard worker and
// not for the OCR runner: `tools/whiteboard_worker.py` marks a row `error`
// when its media file is missing (see `command_scan`), and `error` IS a
// download candidate -- so the worker heals itself on the next pass.
// `tools/runAllOcr.js` flips `scanning` to `done` without looking at the
// filesystem, so nothing ever notices a file that vanished afterwards.

const STATUS = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  SCANNING: 'scanning',
  REVIEW: 'review',
  DONE: 'done',
  NO_MATCH: 'no_match',
  ERROR: 'error',
});

/** Every status the schema's CHECK constraint allows. */
const STATUS_VALUES = Object.freeze([
  STATUS.PENDING,
  STATUS.DOWNLOADING,
  STATUS.SCANNING,
  STATUS.REVIEW,
  STATUS.DONE,
  STATUS.NO_MATCH,
  STATUS.ERROR,
]);

/**
 * What each status means, and which tool writes it.
 *
 * Kept as data so that a reader -- and a test -- can check the code against
 * one description instead of against six comments that drift apart. Each
 * writer is a repository-relative path, optionally followed by the function
 * inside it, so a test can check that the file still exists.
 */
const STATUS_MEANING = Object.freeze({
  pending: {
    meaning: 'The catalog row exists; the media has not been fetched.',
    writtenBy: ['tools/whiteboard_worker.py upsert_catalog_rows'],
  },
  downloading: {
    meaning: 'A download has been claimed and has not finished.',
    writtenBy: ['tools/whiteboard_worker.py command_download'],
  },
  scanning: {
    meaning: 'THE MEDIA IS ON DISK. Nothing has been scanned yet.',
    writtenBy: [
      'tools/downloadHiresBatch.js finalizeRow',
      'tools/downloadQmg1080p.js finalizeRow',
      'tools/whiteboard_worker.py command_download',
    ],
  },
  review: {
    meaning: 'The scan found something that needs a human; the artifact is in path_review.',
    writtenBy: ['tools/whiteboard_worker.py command_scan'],
  },
  done: {
    meaning: 'An OCR pass finished -- or a scan wrote an artifact (which also fills output_path). '
      + 'It says NOTHING about whether the media is still on disk.',
    writtenBy: ['tools/runAllOcr.js', 'tools/whiteboard_worker.py command_scan'],
  },
  no_match: {
    meaning: 'The scan found nothing.',
    writtenBy: ['tools/whiteboard_worker.py command_scan'],
  },
  error: {
    meaning: 'The pass failed -- including "the media file is missing". '
      + 'Because error IS a download candidate, this is how a missing file heals itself.',
    writtenBy: [
      'tools/whiteboard_worker.py command_download',
      'tools/whiteboard_worker.py command_scan',
    ],
  },
});

/**
 * The work list of the 720p batch downloader.
 *
 * `error` is in it so a failed download is retried.
 */
const DOWNLOAD_CANDIDATE_STATUSES = Object.freeze([
  STATUS.PENDING,
  STATUS.SCANNING,
  STATUS.ERROR,
]);

/**
 * The work list of the 1080p batch downloader.
 *
 * It leaves `error` out on purpose: it wants the videos that have never been
 * fetched at 1080p, not a re-run of the 720p batcher's failures.
 */
const HIRES_CANDIDATE_STATUSES = Object.freeze([
  STATUS.PENDING,
  STATUS.SCANNING,
]);

/**
 * The statuses a video can only reach AFTER its media was fetched.
 *
 * A row in one of these with an empty `download_path` is a catalog defect:
 * nothing in the pipeline can move a row into `scanning` or `done` without
 * having downloaded it first. The status does not promise the file is still
 * there -- `done` records that a pass finished, which is not a statement
 * about the file -- but it does promise it was there when the row got there.
 */
const REQUIRES_MEDIA_STATUSES = Object.freeze([
  STATUS.SCANNING,
  STATUS.DONE,
]);

/**
 * Render a status list as the body of a SQL `IN (...)` clause.
 *
 * @param {readonly string[]} statuses
 * @returns {string} e.g. `'pending','scanning','error'`
 */
function sqlStatusList(statuses) {
  return statuses.map((s) => `'${s}'`).join(',');
}

/**
 * What a status means.
 *
 * @param {string} status
 * @returns {{meaning: string, writtenBy: string[]}|null}
 */
function statusMeaning(status) {
  return STATUS_MEANING[status] || null;
}

/**
 * Does this status say the media has been fetched?
 *
 * @param {string} status
 * @returns {boolean}
 */
function requiresMedia(status) {
  return REQUIRES_MEDIA_STATUSES.includes(status);
}

module.exports = {
  DOWNLOAD_CANDIDATE_STATUSES,
  HIRES_CANDIDATE_STATUSES,
  REQUIRES_MEDIA_STATUSES,
  STATUS,
  STATUS_MEANING,
  STATUS_VALUES,
  requiresMedia,
  sqlStatusList,
  statusMeaning,
};
