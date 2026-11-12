'use strict';

// The Benzinga channel's identity.
//
// WHY THIS IS ITS OWN MODULE
//
// The channel's LOGICAL name and its YouTube HANDLE are different strings,
// and the project has been bitten by that before: an early `fill-dates`
// built `https://www.youtube.com/@revere/videos`, and `@revere` is a
// DIFFERENT, unrelated channel. A channel URL is never built by
// interpolating a slug. It is looked up.
//
// BENZINGA IS A TRANSCRIPT SOURCE -- AND MOSTLY NOT A TRADE-CALL CHANNEL
//
// It is the third transcript source after Sevcik (Czech) and T3Live
// (English). It speaks English, so it reuses T3Live's extractor settings.
// But most of what it publishes is not commentary by its hosts: measured on
// the newest 150 streams (2026-11-11), 76 were company EARNINGS-CALL
// rebroadcasts and 3 were Fed press conferences, and the /videos tab is
// mostly 3-minute futures updates, interviews and product tutorials. So
// the content filter is an ALLOW-LIST of shows (src/benzinga/contentFilter.js),
// not T3Live's permissive deny-list. See docs/benzinga-source-plan.md.
//
// TWO LISTINGS, PLUS PLAYLISTS
//
// The daily PreMarket Playbook and the weekly The Drift are live streams,
// so the /streams tab carries the shows this source was added for. The
// /videos tab carries the prerecorded clips. Benzinga also keeps per-show
// playlists, which are imported as listing memberships.

/** The logical channel name, as stored in `videos.channel`. */
const BENZINGA_CHANNEL = 'benzinga';

/** The YouTube handle. NOT the same string as the logical name. */
const BENZINGA_HANDLE = '@Benzinga';

/** The listings this channel publishes on. */
const BENZINGA_SOURCE_URLS = {
  /** Live streams: PreMarket Playbook, The Drift, earnings calls. */
  streams: `https://www.youtube.com/${BENZINGA_HANDLE}/streams`,
  /** Prerecorded uploads: market updates, explainers, clips. */
  videos: `https://www.youtube.com/${BENZINGA_HANDLE}/videos`,
  /** Shorts: not read (too short to carry a call). */
  shorts: `https://www.youtube.com/${BENZINGA_HANDLE}/shorts`,
  /** The channel's playlist index. */
  playlists: `https://www.youtube.com/${BENZINGA_HANDLE}/playlists`,
};

/** Primary catalog source (the streams listing). */
const BENZINGA_SOURCE_URL = BENZINGA_SOURCE_URLS.streams;

/**
 * Does this source URL name the Benzinga channel?
 *
 * A playlist URL carries no handle, so it is NOT recognised here -- a
 * playlist has to be catalogued with an explicit `--channel benzinga`.
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isBenzingaSourceUrl(sourceUrl) {
  return String(sourceUrl || '').toLowerCase().includes('@benzinga');
}

/**
 * The logical channel name for a source URL, or '' when it is not Benzinga.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isBenzingaSourceUrl(sourceUrl) ? BENZINGA_CHANNEL : '';
}

module.exports = {
  BENZINGA_CHANNEL,
  BENZINGA_HANDLE,
  BENZINGA_SOURCE_URL,
  BENZINGA_SOURCE_URLS,
  channelFromSourceUrl,
  isBenzingaSourceUrl,
};
