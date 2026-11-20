'use strict';

// The FundedMind channel's identity.
//
// WHY THIS IS ITS OWN MODULE
//
// The channel's LOGICAL name and its YouTube HANDLE are different strings,
// and the project has been bitten by building a URL from the slug: an early
// `fill-dates` built `https://www.youtube.com/@revere/videos`, and `@revere`
// is a DIFFERENT channel. A channel URL is looked up, never interpolated.
//
// WHAT THE CHANNEL IS (measured 2026-11-18, read-only listings)
//
// A Czech/Slovak prop-trading education community (fundedmind.cz). The
// high-value corpus is the STREAMS tab: 465 entries, 461 was_live, ~457
// hours, median ~55 minutes. Titles are multi-host live desks:
//
//   "Live Trading | Oliver Pátek 13.11. 2026"
//   "Sunday Focus | Petr Můčka 15.11. 2026"
//   "Gold Trading | Sunita Hakimi 10.11. 2026"
//   "Macro Monday | Daniel Valchář 9.11. 2026"
//
// The /videos tab is mostly short education, psychology, prop-firm guides
// and FM Interview podcasts -- catalogued second, quarantined from forward
// signal scoring by default. Speech is Czech, so captions prefer cs-orig
// and Deepgram uses language=cs (same stack as davidsevcik).
//
// This is a TRANSCRIPT source. It is not in OCR_CHANNELS. Whether a live
// session shows a stable on-screen book is a separate frame census; until
// that is measured the useful record is what the host SAID.

/** The logical channel name, as stored in `videos.channel`. */
const FUNDEDMIND_CHANNEL = 'fundedmind';

/** The YouTube handle. NOT the same string as the logical name. */
const FUNDEDMIND_HANDLE = '@FundedMind';

/** The listings this channel publishes on. */
const FUNDEDMIND_SOURCE_URLS = {
  /** Past live streams: the primary corpus. */
  streams: `https://www.youtube.com/${FUNDEDMIND_HANDLE}/streams`,
  /** Regular uploads: education, interviews, shorter explainers. */
  videos: `https://www.youtube.com/${FUNDEDMIND_HANDLE}/videos`,
};

/** Primary catalog source (the streams listing). */
const FUNDEDMIND_SOURCE_URL = FUNDEDMIND_SOURCE_URLS.streams;

/**
 * Does this source URL name the FundedMind channel?
 *
 * A playlist URL carries no handle, so it is NOT recognised here -- a
 * playlist has to be catalogued with an explicit `--channel fundedmind`.
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isFundedmindSourceUrl(sourceUrl) {
  return String(sourceUrl || '').toLowerCase().includes('@fundedmind');
}

/**
 * The logical channel name for a source URL, or '' when it is not this channel.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isFundedmindSourceUrl(sourceUrl) ? FUNDEDMIND_CHANNEL : '';
}

module.exports = {
  FUNDEDMIND_CHANNEL,
  FUNDEDMIND_HANDLE,
  FUNDEDMIND_SOURCE_URL,
  FUNDEDMIND_SOURCE_URLS,
  channelFromSourceUrl,
  isFundedmindSourceUrl,
};
