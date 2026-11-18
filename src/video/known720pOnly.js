'use strict';

// The qullamaggie videos that have NO 1080p upload on YouTube.
//
// WHY THEY NEED THEIR OWN LIST
//
// On these ids, yt-dlp's "Requested format is not available" is REAL -- the
// channel never published a 1080p copy. On any OTHER video that error means
// YouTube is throttling us, and the fix is to wait, not to download 720p.
//
// The list is STATIC and HAND-MAINTAINED. It is never grown from a run's
// errors alone: "Requested format is not available" on a new id is a
// throttling signal, not evidence that the video has no 1080p.
//
// The original 39 were known before this file existed. Fifteen more were
// added on 2026-11-18, and only after a --list-formats check (visios client,
// after a network change, so it was not the throttled reading) showed no
// video format above 720p on each of them. The user approved extending the
// list. A later id is not added without that same check and that approval.
//
// The 1080p pass skips them, and a separate 720p pass (--height 720) fetches
// them at format 136 into the 720p library.

const KNOWN_720P_ONLY_IDS = Object.freeze([
  '0Ew3DImAZlw', '1QtMVbPrKUw', '1X0J9XbF7I4', '3328puCDrks', '3w5BmkbsJpo',
  '4UWLcS4-lbI', '6XgAT5LW9Ks', '8uyENUhiW1c', 'AAs9-ZO33eA', 'A_0Sj3Hi9Jw',
  'Ab6bXsSfweo', 'Ax5a_ouJMKU', 'B1TCCDizExQ', 'BqGwSzbGS10', 'D4pnSkaFVb8',
  'FN20YOH_XRM', 'FcXJZ3Y98YU', 'MFew0xR3iv0', 'MSVE_HaH0qo', 'NDCSRLjr1-g',
  'Nlc2r-uz6Gg', 'O333thFuU40', 'PvL5_kwE0fI', 'R7nACKgTydc', 'SZ0QELUoCJ4',
  'SrIGW4fvzFE', 'UG1vfP9hCH0', 'UmAdr1cM3RY', 'V5ETDZgbnOs', 'gqzntxo4DdI',
  'jtyYLDlgdbE', 'l2olCkDuHGo', 'n8SWEpUNylE', 'o3IoaGLCxz4', 'oRX7YeTLdRg',
  'pomzmadhQV0', 'sUU3mXKLgok', 'ttKgeB-cZbY', 'u84s3-ehrw4',
  // Verified 2026-11-18 by --list-formats: highest video format is 720p.
  'Z1ywOzX05uA', 'Zp2aN0ZYcz4', '_3LVGLEAlKQ', '_esqrDEJJdg', 'a4Al3E-Voxg',
  'arUI0OLD0u8', 'cEryzoN5WNw', 'cKfK0F3ENvM', 'diApIcC5i-s', 'e49j7sjdMFE',
  'ebiE01a6XiM', 'vLuChJ0B6mU', 'Wb_R-YqKoR0', 'y090kik4xFA', 'yGdp9C0n6DM',
]);

const KNOWN_720P_ONLY_SET = new Set(KNOWN_720P_ONLY_IDS.map((id) => id.toLowerCase()));

/**
 * Is this video one of the known 720p-only uploads?
 *
 * Case-insensitive, because catalog ids and checkpoint ids have not always
 * agreed on case, and a case mismatch here would send a 720p-only video
 * through the 1080p pass again.
 *
 * @param {string|null|undefined} videoId
 * @returns {boolean}
 */
function isKnown720pOnly(videoId) {
  if (!videoId) return false;
  return KNOWN_720P_ONLY_SET.has(String(videoId).trim().toLowerCase());
}

/**
 * How many videos the list covers. A test pins the count, so that adding or
 * dropping an id is a deliberate act rather than an accident.
 *
 * @returns {number}
 */
function known720pOnlyCount() {
  return KNOWN_720P_ONLY_IDS.length;
}

module.exports = {
  KNOWN_720P_ONLY_IDS,
  KNOWN_720P_ONLY_SET,
  isKnown720pOnly,
  known720pOnlyCount,
};
