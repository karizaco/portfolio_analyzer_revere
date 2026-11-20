'use strict';

/**
 * X API v2 response -> canonical `x-post-1` records.
 *
 * One call handles one response PAGE: `{ data, includes, errors, meta }`.
 * The page's `includes` carries the authors, the referenced posts and the
 * media, keyed by id; a post refers to them and this file joins them.
 *
 * THE TRAPS
 *
 * - `text` is TRUNCATED for a long post. The full text is `note_tweet.text`,
 *   and only when `note_tweet` was in `tweet.fields`. It always is in
 *   src/x/apiClient.js, and a long post without it is still normalized but
 *   flagged `text_source: 'text_truncated'`.
 * - A REPOST's own `text` is "RT @user: ..." cut at 140 characters. The
 *   original's text is in `includes.tweets`.
 * - A deleted or protected post is not missing from the page: it is an
 *   entry in `errors[]`. Those are returned so the caller can record them.
 * - `edit_history_tweet_ids` is in ascending order: the FIRST id is the
 *   original version.
 */

const {
  canonicalize,
  normalizeText,
  parseXDate,
  postKind,
} = require('./postRecord');

/**
 * @param {object} tweet
 * @param {Map<string, object>} tweetsById
 * @returns {{text: string, source: string}}
 */
function fullText(tweet) {
  if (tweet.note_tweet && typeof tweet.note_tweet.text === 'string' && tweet.note_tweet.text) {
    return { text: tweet.note_tweet.text, source: 'note_tweet' };
  }
  return { text: String(tweet.text || ''), source: 'text' };
}

function entityList(entities, key, field) {
  if (!entities || !Array.isArray(entities[key])) return [];
  return entities[key].map((item) => item && item[field]).filter(Boolean);
}

/**
 * Normalize one API v2 response page.
 *
 * @param {object} page - the parsed response body
 * @param {object} [options]
 * @param {string} [options.fetchedAt] - when the page was fetched, ISO
 * @returns {{records: object[], errors: object[]}}
 */
function normalizeApiV2Page(page, options = {}) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const includes = (page && page.includes) || {};
  const users = new Map((includes.users || []).map((user) => [String(user.id), user]));
  const tweetsById = new Map((includes.tweets || []).map((tweet) => [String(tweet.id), tweet]));
  const mediaByKey = new Map((includes.media || []).map((item) => [String(item.media_key), item]));
  const data = Array.isArray(page && page.data) ? page.data : (page && page.data ? [page.data] : []);

  const records = [];
  const errors = (page && Array.isArray(page.errors) ? page.errors : []).map((error) => ({
    post_id: String(error.resource_id || error.value || ''),
    title: String(error.title || ''),
    detail: String(error.detail || ''),
    type: String(error.type || ''),
  }));

  for (const tweet of data) {
    const authorId = String(tweet.author_id || '');
    const author = users.get(authorId);
    const refs = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
    const refOf = (type) => {
      const ref = refs.find((item) => item.type === type);
      return ref ? String(ref.id) : null;
    };
    const reposted = refOf('retweeted');
    const inReplyTo = refOf('replied_to');
    const quoted = refOf('quoted');
    const kind = postKind({ reposted, inReplyTo, quoted });
    const inReplyToUser = tweet.in_reply_to_user_id ? String(tweet.in_reply_to_user_id) : null;

    const { text, source } = fullText(tweet);
    const truncated = source === 'text' && /…$/.test(String(tweet.text || '')) && kind !== 'repost';

    const referenced = refs.map((ref) => {
      const target = tweetsById.get(String(ref.id));
      const targetAuthor = target ? users.get(String(target.author_id || '')) : null;
      const targetText = target ? fullText(target).text : '';
      return {
        type: ref.type,
        post_id: String(ref.id),
        handle: targetAuthor ? targetAuthor.username : '',
        created_at: target ? parseXDate(target.created_at) : '',
        text: target ? normalizeText(targetText, { isReply: Boolean(target.in_reply_to_user_id) }) : '',
      };
    });

    // The cashtags of a long post are in the note's own entity set.
    const entitySource = tweet.note_tweet && tweet.note_tweet.entities ? tweet.note_tweet.entities : tweet.entities;
    const urlEntities = entitySource && Array.isArray(entitySource.urls) ? entitySource.urls : [];

    const mediaKeys = tweet.attachments && Array.isArray(tweet.attachments.media_keys)
      ? tweet.attachments.media_keys
      : [];
    const media = mediaKeys.map((key) => {
      const item = mediaByKey.get(String(key)) || { media_key: key };
      return {
        media_key: String(item.media_key || key),
        type: item.type || 'photo',
        url: item.url || '',
        preview_url: item.preview_image_url || '',
        width: Number.isFinite(item.width) ? item.width : null,
        height: Number.isFinite(item.height) ? item.height : null,
        alt_text: item.alt_text || '',
      };
    });

    const metrics = tweet.public_metrics || null;
    records.push(canonicalize({
      post_id: String(tweet.id),
      user_id: authorId,
      handle: author ? author.username : '',
      created_at: parseXDate(tweet.created_at),
      kind,
      text: normalizeText(kind === 'repost' ? (referenced.find((ref) => ref.type === 'retweeted') || {}).text || text : text,
        { isReply: kind === 'reply' }),
      text_source: truncated ? 'text_truncated' : source,
      lang: tweet.lang || '',
      conversation_id: tweet.conversation_id ? String(tweet.conversation_id) : String(tweet.id),
      in_reply_to_post_id: inReplyTo,
      in_reply_to_user_id: inReplyToUser,
      self_thread: kind === 'reply' && inReplyToUser !== null && inReplyToUser === authorId,
      quoted_post_id: quoted,
      reposted_post_id: reposted,
      referenced,
      entities: {
        cashtags: entityList(entitySource, 'cashtags', 'tag'),
        hashtags: entityList(entitySource, 'hashtags', 'tag'),
        mentions: entityList(entitySource, 'mentions', 'username'),
        urls: urlEntities.filter((url) => !url.media_key).map((url) => url.unwound_url || url.expanded_url || url.url),
      },
      media,
      edit: { history_ids: Array.isArray(tweet.edit_history_tweet_ids) ? tweet.edit_history_tweet_ids : [] },
      metrics_first_seen: metrics ? {
        likes: metrics.like_count ?? null,
        reposts: metrics.retweet_count ?? null,
        replies: metrics.reply_count ?? null,
        quotes: metrics.quote_count ?? null,
        views: metrics.impression_count ?? null,
        bookmarks: metrics.bookmark_count ?? null,
        observed_at: fetchedAt,
      } : null,
      fetched_via: 'api_v2',
      fidelity: truncated ? 'partial' : 'full',
      first_seen_at: fetchedAt,
    }));
  }

  return { records, errors };
}

module.exports = { normalizeApiV2Page };
