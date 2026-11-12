'use strict';

// The AsymTrading publication's identity.
//
// WHY THIS IS ITS OWN MODULE
//
// Every other source in this project is a YouTube channel, and every one of
// them has a module that names it: `src/t3live/channel.js`,
// `src/sevcik/channel.js`. The pattern exists because the LOGICAL name and
// the address you fetch from are different strings, and building an address
// by interpolating a name is how the project once stamped 1,582 rows with
// `https://www.youtube.com/@revere/videos` -- a DIFFERENT, unrelated channel.
//
// AsymTrading is a Substack publication, so the hazard is different but the
// rule is the same: the publication has a canonical host
// (`asymtrading.substack.com`), a numeric publication id that its own API
// requires (`1534424`), and a logical name the catalog stores
// (`asymtrading`). None of the three is derivable from the others.
//
// THE ID SCHEME, AND WHY IT IS NOT THE SLUG
//
// Every post in this publication is titled "Market Pulse". The SLUG is
// `market-pulse-<something>` and the `<something>` is a short random suffix
// (`2d2`, `b5e`, `fa6`) that Substack generates and that REPEATS across
// series: the archive contains `market-pulse-open-access` and
// `market-pulse-open-access-bf1`, and `6-steps-to-profitable-swing-trading`
// appears with six different suffixes.
//
// A slug is therefore not an identifier -- it is a display name. The
// identifier is Substack's numeric post id, which is unique, permanent, and
// what the API itself keys every media upload by.
//
// So a catalog row's `video_id` is `asym_<post_id>`: the post id, namespaced
// so it can never collide with a YouTube video id (which is 11 characters of
// base64 and always contains at least one digit-and-letter mix, but the
// namespace makes the collision impossible rather than unlikely).
//
// WHY THE `videos` TABLE AT ALL
//
// `videos` is named for YouTube, but it is really the catalog of "a piece of
// media this pipeline may fetch", and it already carries three non-YouTube
// channels: `davidsevcik` (498 rows), `t3live` (7,349 rows) and, after this
// change, `asymtrading`. Both of those are transcript sources whose media
// comes from the same YouTube downloader; AsymTrading's media comes from
// Substack's Mux CDN, which is why its download is a separate tool.
//
// The `status` column is the thing to be careful about. Its CHECK constraint
// allows only the seven values in `src/video/videoStatus.js`, and those
// values describe an OCR pipeline's lifecycle. A Substack post has a
// DIFFERENT lifecycle (catalogued -> body fetched -> media downloaded ->
// transcribed), so AsymTrading reuses the values that mean what it needs and
// leaves the rest alone. See `src/asym/status.js`.

/** The logical channel name, as stored in `videos.channel`. */
const ASYM_CHANNEL = 'asymtrading';

/** The publication's canonical host. */
const ASYM_PUBLICATION_URL = 'https://asymtrading.substack.com';

/**
 * Substack's numeric publication id.
 *
 * It appears in every post's `publication_id` field, and the media-upload
 * endpoint needs it as `override_publication_id`. It is a property of the
 * PUBLICATION, not of the post, so it is one constant here rather than
 * something each post carries.
 */
const ASYM_PUBLICATION_ID = 1534424;

/** The RSS feed. The most recent ~20 posts, and no pagination beyond that. */
const ASYM_FEED_URL = `${ASYM_PUBLICATION_URL}/feed`;

/** The archive listing, which is the full corpus. */
const ASYM_ARCHIVE_URL = `${ASYM_PUBLICATION_URL}/archive`;

/**
 * The archive API endpoint.
 *
 * It is UNDOCUMENTED, and its pagination contract is unusual: it takes a
 * `cursor` (a base64-encoded `{"post_date":"..."}`) and REJECTS `offset`
 * outright with `{"errors":[{"param":"offset","msg":"Invalid value"}]}`.
 * That is measured, not assumed -- see `src/asym/substackClient.js`.
 */
const ASYM_ARCHIVE_API = `${ASYM_PUBLICATION_URL}/api/v1/archive`;

/**
 * The post-list API endpoint.
 *
 * Unlike the archive endpoint, this one returns `body_html` for FREE posts
 * (the archive endpoint returns it empty for every post). That is what makes
 * the text path possible without scraping HTML pages.
 */
const ASYM_POSTS_API = `${ASYM_PUBLICATION_URL}/api/v1/posts`;

/**
 * The single-post endpoint, which returns `body_html` for one post by id.
 */
const ASYM_POST_BY_ID_API = `${ASYM_PUBLICATION_URL}/api/v1/posts/by-id`;

/**
 * The media-upload endpoint, which describes one embedded video.
 */
const ASYM_VIDEO_API = `${ASYM_PUBLICATION_URL}/api/v1/video/upload`;

/**
 * The prefix that namespaces a Substack post id inside `videos.video_id`.
 */
const ASYM_ID_PREFIX = 'asym_';

/**
 * The catalog id for a Substack post.
 *
 * @param {number|string} postId - Substack's numeric post id
 * @returns {string} e.g. `asym_222466781`
 */
function asymVideoId(postId) {
  const numeric = String(postId == null ? '' : postId).trim();
  if (!/^\d+$/.test(numeric)) {
    throw new Error(`A Substack post id must be numeric, got "${postId}"`);
  }
  return `${ASYM_ID_PREFIX}${numeric}`;
}

/**
 * The Substack post id inside a catalog id, or null when the id is not ours.
 *
 * @param {string} videoId
 * @returns {string|null} e.g. `222466781`
 */
function asymPostId(videoId) {
  const raw = String(videoId == null ? '' : videoId).trim();
  if (!raw.startsWith(ASYM_ID_PREFIX)) return null;
  const rest = raw.slice(ASYM_ID_PREFIX.length);
  return /^\d+$/.test(rest) ? rest : null;
}

/**
 * Does this source URL name the AsymTrading publication?
 *
 * @param {string} sourceUrl
 * @returns {boolean}
 */
function isAsymSourceUrl(sourceUrl) {
  const lowered = String(sourceUrl || '').toLowerCase();
  return lowered.includes('asymtrading.substack.com');
}

/**
 * The logical channel name for a source URL, or '' when it is not AsymTrading.
 *
 * @param {string} sourceUrl
 * @returns {string}
 */
function channelFromSourceUrl(sourceUrl) {
  return isAsymSourceUrl(sourceUrl) ? ASYM_CHANNEL : '';
}

/**
 * The canonical URL of a post.
 *
 * @param {string} slug
 * @returns {string}
 */
function asymPostUrl(slug) {
  return `${ASYM_PUBLICATION_URL}/p/${slug}`;
}

module.exports = {
  ASYM_ARCHIVE_API,
  ASYM_ARCHIVE_URL,
  ASYM_CHANNEL,
  ASYM_FEED_URL,
  ASYM_ID_PREFIX,
  ASYM_POSTS_API,
  ASYM_POST_BY_ID_API,
  ASYM_PUBLICATION_ID,
  ASYM_PUBLICATION_URL,
  ASYM_VIDEO_API,
  asymPostId,
  asymPostUrl,
  asymVideoId,
  channelFromSourceUrl,
  isAsymSourceUrl,
};