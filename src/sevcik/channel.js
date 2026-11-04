'use strict';

// The Sevcik channel's identity.
//
// WHY THIS IS ITS OWN MODULE
//
// The channel's LOGICAL name and its YouTube HANDLE are different strings,
// and the project has already been bitten by that once: an early version of
// `fill-dates` built `https://www.youtube.com/@revere/videos` and stamped it
// on 1,582 Revere rows, and `@revere` is a DIFFERENT, unrelated channel that
// returns a completely disjoint set of video ids.
//
// So a channel URL is never built by interpolating a slug. It is looked up.
//
// The handle here is `@davidsevcik-sved4697`, and the STREAMS tab is the
// listing this source wants: the channel's daily prediction videos are
// livestreams, and a `/videos` listing does not necessarily carry them the
// same way. The streams listing is therefore the source URL, and it is
// stored as the channel's `source_url` -- which is what the catalog row
// records.
//
// The two listings are both usable and they are NOT the same set: a stream
// that is later made into a regular video can appear in both, and a
// members-only stream appears in neither. The catalog records what it
// fetched, and `catalog_runs.not_listed_count` reports the difference.

/** The logical channel name, as stored in `videos.channel`. */
const SEVCIK_CHANNEL = 'davidsevcik';

/** The YouTube handle. NOT the same string as the logical name. */
const SEVCIK_HANDLE = '@davidsevcik-sved4697';

/** The channel's streams listing -- the listing this source reads. */
const SEVCIK_SOURCE_URL = `https://www.youtube.com/${SEVCIK_HANDLE}/streams`;

/** The channel's regular videos listing, for comparison. */
const SEVCIK_VIDEOS_URL = `https://www.youtube.com/${SEVCIK_HANDLE}/videos`;

/**
 * Does this source URL name the Sevcik channel?
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isSevcikSourceUrl(sourceUrl) {
  const lowered = String(sourceUrl || '').toLowerCase();
  return lowered.includes('@davidsevcik-sved4697') || lowered.includes('/davidsevcik-sved4697');
}

/**
 * The logical channel name for a source URL, or '' when it is not ours.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isSevcikSourceUrl(sourceUrl) ? SEVCIK_CHANNEL : '';
}

module.exports = {
  SEVCIK_CHANNEL,
  SEVCIK_HANDLE,
  SEVCIK_SOURCE_URL,
  SEVCIK_VIDEOS_URL,
  channelFromSourceUrl,
  isSevcikSourceUrl,
};
