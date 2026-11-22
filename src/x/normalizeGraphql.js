'use strict';

/**
 * X web app GraphQL responses -> canonical `x-post-1` records.
 *
 * The browser route does not read the page. As the user scrolls, the web
 * app fetches its timelines as JSON from `/i/api/graphql/<id>/<Operation>`
 * (UserTweets, UserTweetsAndReplies, SearchTimeline, TweetDetail), and that
 * JSON carries the same fields the API returns: the full text, the exact
 * timestamp, the ids, the media. The crawler captures those responses and
 * this file normalizes them.
 *
 * THE SHAPE IS NOT DOCUMENTED, so the walk is deliberately tolerant:
 *
 * - Posts are found by looking for `tweet_results.result` ANYWHERE in the
 *   response, not by a fixed path. Timelines, search, conversation modules
 *   and thread details all nest it differently, and X moves it around.
 * - The walk does NOT descend into a post it has collected, so a QUOTED
 *   post (`quoted_status_result`) and a REPOSTED post
 *   (`legacy.retweeted_status_result`) are never emitted as posts of their
 *   own -- they become the outer post's `referenced` entries.
 * - `TweetWithVisibilityResults` wraps a post in `.tweet`; a
 *   `TweetTombstone` / `TweetUnavailable` is a post that cannot be shown
 *   (deleted, withheld, protected) and is reported, not emitted.
 * - The screen name moved from `user.legacy.screen_name` to
 *   `user.core.screen_name` in 2025; both are read.
 * - A long post's full text is `note_tweet.note_tweet_results.result.text`
 *   and its cashtags are in that result's `entity_set`.
 *
 * The response shapes in test/fixtures/x/ are synthetic, modelled on the
 * known structure. Phase 0's real captures are what confirm them.
 */

const {
  canonicalize,
  normalizeText,
  parseXDate,
  postKind,
} = require('./postRecord');

const UNAVAILABLE = new Set(['TweetTombstone', 'TweetUnavailable']);

/**
 * Unwrap a tweet result.
 *
 * @param {object} result
 * @returns {{tweet: object|null, unavailable: string}}
 */
function unwrap(result) {
  if (!result || typeof result !== 'object') return { tweet: null, unavailable: 'empty' };
  if (UNAVAILABLE.has(result.__typename)) {
    const text = result.tombstone && result.tombstone.text && result.tombstone.text.text;
    return { tweet: null, unavailable: String(text || result.__typename) };
  }
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return { tweet: result.tweet, unavailable: '' };
  if (result.rest_id && result.legacy) return { tweet: result, unavailable: '' };
  return { tweet: null, unavailable: 'unrecognised' };
}

function userOf(tweet) {
  const user = tweet && tweet.core && tweet.core.user_results && tweet.core.user_results.result;
  if (!user) return { id: '', handle: '' };
  const handle = (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || '';
  return { id: String(user.rest_id || ''), handle };
}

function noteOf(tweet) {
  return tweet && tweet.note_tweet && tweet.note_tweet.note_tweet_results
    && tweet.note_tweet.note_tweet_results.result
    ? tweet.note_tweet.note_tweet_results.result
    : null;
}

function textOf(tweet) {
  const note = noteOf(tweet);
  if (note && typeof note.text === 'string' && note.text) return { text: note.text, source: 'note_tweet' };
  return { text: String((tweet.legacy && tweet.legacy.full_text) || ''), source: 'text' };
}

function editIdsOf(tweet) {
  const control = tweet.edit_control || {};
  if (Array.isArray(control.edit_tweet_ids)) return control.edit_tweet_ids.map(String);
  if (control.edit_control_initial && Array.isArray(control.edit_control_initial.edit_tweet_ids)) {
    return control.edit_control_initial.edit_tweet_ids.map(String);
  }
  return [];
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Collect every top-level tweet result in a response.
 *
 * @param {*} node
 * @param {Array<object>} out
 */
function collectTweetResults(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTweetResults(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'tweet_results' || key === 'tweetResult') && value && typeof value === 'object' && 'result' in value) {
      out.push(value.result);
      continue; // never descend into a collected post (its quote is a reference)
    }
    collectTweetResults(value, out);
  }
}

/**
 * Normalize one tweet object (already unwrapped).
 *
 * @param {object} tweet
 * @param {string} fetchedAt
 * @returns {object} canonical record
 */
function normalizeTweet(tweet, fetchedAt) {
  const legacy = tweet.legacy || {};
  const author = userOf(tweet);
  const repostedResult = legacy.retweeted_status_result && legacy.retweeted_status_result.result;
  const reposted = repostedResult ? unwrap(repostedResult).tweet : null;
  const quotedResult = tweet.quoted_status_result && tweet.quoted_status_result.result;
  const quoted = quotedResult ? unwrap(quotedResult).tweet : null;

  const repostedId = reposted ? String(reposted.rest_id) : null;
  const inReplyTo = legacy.in_reply_to_status_id_str ? String(legacy.in_reply_to_status_id_str) : null;
  const quotedId = quoted
    ? String(quoted.rest_id)
    : (legacy.is_quote_status && legacy.quoted_status_id_str ? String(legacy.quoted_status_id_str) : null);
  const kind = postKind({ reposted: repostedId, inReplyTo, quoted: quotedId });
  const inReplyToUser = legacy.in_reply_to_user_id_str ? String(legacy.in_reply_to_user_id_str) : null;

  const referenced = [];
  if (reposted) {
    const ref = userOf(reposted);
    referenced.push({
      type: 'retweeted',
      post_id: String(reposted.rest_id),
      handle: ref.handle,
      created_at: parseXDate(reposted.legacy && reposted.legacy.created_at),
      text: normalizeText(textOf(reposted).text, { isReply: Boolean(reposted.legacy && reposted.legacy.in_reply_to_status_id_str) }),
    });
  }
  if (inReplyTo) {
    referenced.push({ type: 'replied_to', post_id: inReplyTo, handle: legacy.in_reply_to_screen_name || '', created_at: '', text: '' });
  }
  if (quotedId) {
    const ref = quoted ? userOf(quoted) : { handle: '' };
    referenced.push({
      type: 'quoted',
      post_id: quotedId,
      handle: ref.handle,
      created_at: quoted ? parseXDate(quoted.legacy && quoted.legacy.created_at) : '',
      text: quoted ? normalizeText(textOf(quoted).text, { isReply: Boolean(quoted.legacy && quoted.legacy.in_reply_to_status_id_str) }) : '',
    });
  }

  const note = noteOf(tweet);
  const entitySource = note && note.entity_set ? note.entity_set : (legacy.entities || {});
  const { text, source } = textOf(tweet);
  const media = ((legacy.extended_entities && legacy.extended_entities.media) || []).map((item, index) => ({
    // A media item without a key still has to be identifiable: a missing
    // key made the WHOLE post invalid, and the post was lost.
    media_key: String(item.media_key || `media_${index}_${tweet.rest_id}`),
    type: item.type || 'photo',
    url: item.type === 'photo' ? (item.media_url_https || '') : '',
    preview_url: item.type === 'photo' ? '' : (item.media_url_https || ''),
    width: item.original_info ? toInt(item.original_info.width) : null,
    height: item.original_info ? toInt(item.original_info.height) : null,
    alt_text: item.ext_alt_text || '',
  }));

  return canonicalize({
    post_id: String(tweet.rest_id),
    user_id: author.id || String(legacy.user_id_str || ''),
    handle: author.handle,
    created_at: parseXDate(legacy.created_at),
    kind,
    text: normalizeText(kind === 'repost' && referenced[0] ? referenced[0].text : text, { isReply: kind === 'reply' }),
    text_source: source,
    lang: legacy.lang || '',
    conversation_id: legacy.conversation_id_str ? String(legacy.conversation_id_str) : String(tweet.rest_id),
    in_reply_to_post_id: inReplyTo,
    in_reply_to_user_id: inReplyToUser,
    self_thread: kind === 'reply' && inReplyToUser !== null && inReplyToUser === (author.id || String(legacy.user_id_str || '')),
    quoted_post_id: quotedId,
    reposted_post_id: repostedId,
    referenced,
    entities: {
      cashtags: (entitySource.symbols || []).map((item) => item && item.text).filter(Boolean),
      hashtags: (entitySource.hashtags || []).map((item) => item && item.text).filter(Boolean),
      mentions: (entitySource.user_mentions || []).map((item) => item && item.screen_name).filter(Boolean),
      urls: (entitySource.urls || []).map((item) => item && (item.expanded_url || item.url)).filter(Boolean),
    },
    media,
    edit: { history_ids: editIdsOf(tweet) },
    metrics_first_seen: {
      likes: toInt(legacy.favorite_count),
      reposts: toInt(legacy.retweet_count),
      replies: toInt(legacy.reply_count),
      quotes: toInt(legacy.quote_count),
      views: toInt(tweet.views && tweet.views.count),
      bookmarks: toInt(legacy.bookmark_count),
      observed_at: fetchedAt,
    },
    fetched_via: 'web_graphql',
    fidelity: 'full',
    first_seen_at: fetchedAt,
  });
}

/**
 * A screen name, wherever it lives.
 *
 * It moved from `user.legacy.screen_name` to `user.core.screen_name` in
 * 2025, so both are read.
 *
 * @param {*} user
 * @returns {string}
 */
function screenNameOf(user) {
  if (!user || typeof user !== 'object') return '';
  return (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || '';
}

/**
 * The user ids a GraphQL response carries.
 *
 * The page-scrape route needs the account's NUMERIC user id, and the page
 * carries only the handle -- so the id has to come from the web app's own
 * user lookup (`UserByScreenName`). Without it a DOM record cannot be
 * validated, and the whole page-scrape route is refused.
 *
 * The response is not a documented shape, so the walk is tolerant: a USER
 * is an object with a `rest_id` and a screen name. A POST is not -- it has
 * a `rest_id` too, and its author is under `core.user_results` -- so a
 * post is never mistaken for the account it belongs to.
 *
 * @param {*} body
 * @returns {Map<string, string>} handle -> user id
 */
function findUserIds(body) {
  const out = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const id = node.rest_id ? String(node.rest_id) : '';
    const handle = screenNameOf(node);
    if (id && handle && !(node.core && node.core.user_results)) out.set(handle.toLowerCase(), id);
    for (const value of Object.values(node)) walk(value);
  };
  walk(body);
  return out;
}

/**
 * Normalize one captured GraphQL response body.
 *
 * @param {object} body
 * @param {object} [options]
 * @param {string} [options.fetchedAt]
 * @returns {{records: object[], unavailable: Array<{reason: string}>, cursors: {bottom: string, top: string}}}
 */
function normalizeGraphqlResponse(body, options = {}) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const results = [];
  collectTweetResults(body, results);
  const records = [];
  const unavailable = [];
  const seen = new Set();
  for (const result of results) {
    const { tweet, unavailable: reason } = unwrap(result);
    if (!tweet) {
      unavailable.push({ reason });
      continue;
    }
    if (seen.has(String(tweet.rest_id))) continue;
    seen.add(String(tweet.rest_id));
    records.push(normalizeTweet(tweet, fetchedAt));
  }
  return { records, unavailable, cursors: findCursors(body) };
}

/**
 * Did X say the timeline has NO MORE results below?
 *
 * The web app's last page of a search carries
 * `{"type": "TimelineTerminateTimeline", "direction": "Bottom"}` and no
 * posts (measured on a live SearchTimeline capture, 2026-11-21). It is
 * X's own end-of-results statement, and on a date-bounded search -- where
 * the results never reach past the window's start -- it is the ONLY
 * natural end there is.
 *
 * @param {*} body
 * @returns {boolean}
 */
function timelineTerminated(body) {
  let terminated = false;
  const walk = (node) => {
    if (terminated || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'TimelineTerminateTimeline' && node.direction === 'Bottom') {
      terminated = true;
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(body);
  return terminated;
}

/**
 * The timeline's paging cursors, when present (a `cursor-bottom` entry
 * means there is more to scroll).
 *
 * @param {*} body
 * @returns {{bottom: string, top: string}}
 */
function findCursors(body) {
  const cursors = { bottom: '', top: '' };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.cursorType && node.value) {
      if (node.cursorType === 'Bottom') cursors.bottom = String(node.value);
      if (node.cursorType === 'Top') cursors.top = String(node.value);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(body);
  return cursors;
}

module.exports = {
  collectTweetResults, findCursors, findUserIds, normalizeGraphqlResponse, normalizeTweet, timelineTerminated, unwrap,
};
