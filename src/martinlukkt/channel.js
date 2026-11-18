'use strict';

// The martinlukkt channel's identity.
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
// A discretionary long/short swing trader. 113 past live streams on
// /streams (all was_live, 12 Nov 2025 to 4 Nov 2026, 213 hours) plus 2
// uploads on /videos, and no Shorts tab. English. Most streams have
// YouTube auto-captions; a sample of 12 found one without. The useful
// record is what he SAID he did ("I bought the breakout", "I'm going to
// short this one"), not a chart overlay -- whether a position list is on
// screen was not settled by the listing and is a separate frame census.
//
// The session date is in the TITLE ("Flipped long | 4 Nov 2026"), not in
// the flat listing, which returns no upload_date. See contentFilter.js.

/** The logical channel name, as stored in `videos.channel`. */
const MARTINLUKKT_CHANNEL = 'martinlukkt';

/** The YouTube handle. The same string as the logical name, looked up anyway. */
const MARTINLUKKT_HANDLE = '@martinlukkt';

/** The listings this channel publishes on. */
const MARTINLUKKT_SOURCE_URLS = {
  /** Past live streams: the corpus. */
  streams: `https://www.youtube.com/${MARTINLUKKT_HANDLE}/streams`,
  /** Two long uploads that are streams under another tab. */
  videos: `https://www.youtube.com/${MARTINLUKKT_HANDLE}/videos`,
};

/** Primary catalog source (the streams listing). */
const MARTINLUKKT_SOURCE_URL = MARTINLUKKT_SOURCE_URLS.streams;

/**
 * Does this source URL name the martinlukkt channel?
 *
 * A playlist URL carries no handle, so it is NOT recognised here -- a
 * playlist has to be catalogued with an explicit `--channel martinlukkt`.
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isMartinlukktSourceUrl(sourceUrl) {
  return String(sourceUrl || '').toLowerCase().includes('@martinlukkt');
}

/**
 * The logical channel name for a source URL, or '' when it is not this channel.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isMartinlukktSourceUrl(sourceUrl) ? MARTINLUKKT_CHANNEL : '';
}

module.exports = {
  MARTINLUKKT_CHANNEL,
  MARTINLUKKT_HANDLE,
  MARTINLUKKT_SOURCE_URL,
  MARTINLUKKT_SOURCE_URLS,
  channelFromSourceUrl,
  isMartinlukktSourceUrl,
};
