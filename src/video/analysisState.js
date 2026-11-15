'use strict';

// Whether a video's ORIGINAL FILE is still needed.
//
// WHY THIS IS NOT `videos.status`
//
// `status='done'` already means two different things, and both downloaders
// EXCLUDE it from their work. Writing `done` to mean "the original may be
// deleted" would hide a video whose file was then deleted from every
// downloader -- the exact trap `tools/reconcileCatalogStatus.js` exists
// to repair. So the deletion question has its own column.
//
// THE VOCABULARY
//
//   ''           not assessed, or assessed and the file is still needed.
//                This is the default, and it is the safe one: an empty
//                flag never means "delete".
//   scanned      a probe log with status "done" names THIS video. The
//                reading exists. It is not verified against the pixels,
//                so the file stays -- a re-scan or a ground-truth
//                correction may need it.
//   disposable   that done log names this video AND the date is pinned
//                in the ground-truth fixture manifest. The published
//                reading does not need the original file.
//
// A DATE BEING PINNED DOES NOT MAKE EVERY VIDEO ON THAT DATE
// DISPOSABLE. 20220606 is three uploads. Only the file a done scan
// actually read is disposable; its siblings stay.
//
// "disposable" is not "this file can never be useful again". A future
// OCR engine would need the original. It means the published, pixel-
// verified reading can be reproduced without it.

const ANALYSIS_STATE = Object.freeze({
  UNSET: '',
  SCANNED: 'scanned',
  DISPOSABLE: 'disposable',
});

const ANALYSIS_STATE_VALUES = Object.freeze(['', 'scanned', 'disposable']);

/**
 * The flag for one video.
 *
 * @param {{ scannedDone: boolean, datePinned: boolean }} input
 * @returns {''|'scanned'|'disposable'}
 */
function decideAnalysisState({ scannedDone, datePinned }) {
  if (scannedDone && datePinned) return ANALYSIS_STATE.DISPOSABLE;
  if (scannedDone) return ANALYSIS_STATE.SCANNED;
  return ANALYSIS_STATE.UNSET;
}

/**
 * The catalog date a scan key names.
 *
 * A scan key can carry a suffix (`20220606b` -- a second upload on the
 * same day). The ground truth and the catalog are keyed on `YYYYMMDD`,
 * so the pin is checked against the first eight digits and nothing else.
 *
 * @param {string} value
 * @returns {string}
 */
function catalogDateOf(value) {
  const match = /^(20\d{6})/.exec(String(value || ''));
  return match ? match[1] : '';
}

/**
 * The video id a media filename names.
 *
 * A downloader writes `<upload_date>_<video_id>.mp4`. Some ids start
 * with `_` themselves, and a September 2026 run prepended another, so
 * the date prefix is what is stripped and the rest is the id. A bare
 * `<video_id>.mp4` (the older scheme) is the id itself.
 *
 * @param {string} filePath
 * @returns {string}
 */
function videoIdFromMediaPath(filePath) {
  const base = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  const stem = base.replace(/\.(mp4|part)$/i, '').replace(/-1080p$/, '');
  const dated = /^(\d{8})_(.+)$/.exec(stem);
  return dated ? dated[2] : stem;
}

module.exports = {
  ANALYSIS_STATE,
  ANALYSIS_STATE_VALUES,
  catalogDateOf,
  decideAnalysisState,
  videoIdFromMediaPath,
};
