'use strict';

// The T3Live channel's identity.
//
// WHY THIS IS ITS OWN MODULE
//
// The channel's LOGICAL name and its YouTube HANDLE are different strings,
// and the project has already been bitten by that once: an early version of
// `fill-dates` built `https://www.youtube.com/@revere/videos` and stamped it
// on 1,582 Revere rows, and `@revere` is a DIFFERENT, unrelated channel.
//
// So a channel URL is never built by interpolating a slug. It is looked up.
//
// T3LIVE HAS TWO LISTINGS
//
// The most important content (Actionable Swing Trade Ideas, 630 Club) is in
// the STREAMS (live) tab. The /videos tab carries additional content —
// morning shows, educational pieces, and market commentary — that overlaps
// with but is not the same as the streams listing. Both are catalogued in
// separate runs, and the catalog deduplicates on video_id automatically.
//
// Unlike the Sevcik channel (Czech), T3Live speaks ENGLISH. The transcript
// pipeline reads YouTube auto-captions in `en`. Deepgram's `nova-2` model
// with language=en is the fallback.
//
// MULTIPLE HOSTS / SHOWS
//
// T3Live features several distinct shows:
//   - "Actionable Swing Trade Ideas" (Sami Abusaad) — structured swing calls
//   - "630 Club" (Scott Redler) — morning trade ideas
//   - Miscellaneous content (Derreck, Adam, Michael, and others)
//
// The show classification lives in `src/t3live/contentFilter.js`.

/** The logical channel name, as stored in `videos.channel`. */
const T3LIVE_CHANNEL = 't3live';

/** The YouTube handle. NOT the same string as the logical name. */
const T3LIVE_HANDLE = '@t3live';

/**
 * The two listings this channel publishes content on.
 *
 * Both are catalogued; deduplication is automatic on video_id.
 */
const T3LIVE_SOURCE_URLS = {
  /** Live streams: Actionable Swing Trade Ideas, 630 Club. Highest priority. */
  streams: `https://www.youtube.com/${T3LIVE_HANDLE}/streams`,
  /** Regular uploads: morning shows, recaps, educational pieces. */
  videos: `https://www.youtube.com/${T3LIVE_HANDLE}/videos`,
};

/** Primary catalog source (the streams listing). */
const T3LIVE_SOURCE_URL = T3LIVE_SOURCE_URLS.streams;

/**
 * Does this source URL name the T3Live channel?
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isT3liveSourceUrl(sourceUrl) {
  const lowered = String(sourceUrl || '').toLowerCase();
  return lowered.includes('@t3live') || lowered.includes('/t3live/') || lowered.includes('/t3live');
}

/**
 * The logical channel name for a source URL, or '' when it is not T3Live.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isT3liveSourceUrl(sourceUrl) ? T3LIVE_CHANNEL : '';
}

module.exports = {
  T3LIVE_CHANNEL,
  T3LIVE_HANDLE,
  T3LIVE_SOURCE_URL,
  T3LIVE_SOURCE_URLS,
  channelFromSourceUrl,
  isT3liveSourceUrl,
};
