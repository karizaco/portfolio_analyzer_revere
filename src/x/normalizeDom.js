'use strict';

/**
 * Page-scraped and agent-transcribed posts -> canonical `x-post-1`
 * records, at PARTIAL fidelity.
 *
 * These are the fallbacks: the crawler scrapes the page only when it
 * captured no GraphQL for a window, and an agent transcribes the page only
 * when nothing else works. Both lose things the JSON routes keep -- the
 * user id, the id of the post a reply answers, the media keys, and text
 * behind "Show more" -- so every record from here is `fidelity: 'partial'`,
 * and a later JSON capture of the same post replaces its fields
 * (src/x/merge.js).
 *
 * TWO TRAPS FROM x_unsub, PINNED BY test/xNormalizeDom.test.js
 *
 * - A REPOST is recognised by the social-context line ("X reposted"), NOT
 *   by the presence of a retweet button: every post has that button, so
 *   testing for it calls every post a repost.
 * - A PINNED post is recognised by the social-context line ("Pinned"), NOT
 *   by the word "pinned" anywhere in the post's text.
 */

const {
  canonicalize,
  normalizeHandle,
  normalizeText,
  parseXDate,
} = require('./postRecord');

const STATUS_PATH = /\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,20})/;

/**
 * The canonical URL of a pbs.twimg.com image, and its id.
 *
 * @param {string} src
 * @returns {{url: string, id: string}|null}
 */
function canonicalMediaUrl(src) {
  const match = /https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)(?:\.(jpg|png|webp))?(?:\?([^#]*))?/.exec(String(src || ''));
  if (!match) return null;
  const params = new URLSearchParams(match[3] || '');
  const ext = match[2] || params.get('format') || 'jpg';
  return { url: `https://pbs.twimg.com/media/${match[1]}.${ext}`, id: match[1] };
}

/**
 * Is the social-context line a repost marker?
 *
 * @param {string} socialContext
 * @returns {boolean}
 */
function isRepostContext(socialContext) {
  return /\b(?:reposted|retweeted)\b/i.test(String(socialContext || ''));
}

/**
 * Is the social-context line a pin marker?
 *
 * @param {string} socialContext
 * @returns {boolean}
 */
function isPinnedContext(socialContext) {
  return /^\s*pinned\b/i.test(String(socialContext || ''));
}

/**
 * Normalize one page-scraped post.
 *
 * @param {object} raw - from src/x/browser/domExtract.js
 * @param {object} options
 * @param {Map<string, string>} options.knownUsers - handle -> user id
 * @param {string} [options.fetchedAt]
 * @returns {{record: object|null, reason: string, pinned: boolean}}
 */
function normalizeDomPost(raw, options) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const status = STATUS_PATH.exec(String(raw.status_path || ''));
  if (!status) return { record: null, reason: 'no_status_link', pinned: false };
  // A repost's article shows the ORIGINAL author's post; the repost's own
  // id is not on the page. It is out of policy anyway.
  if (isRepostContext(raw.social_context)) return { record: null, reason: 'repost', pinned: false };

  const handle = normalizeHandle(status[1]);
  const userId = options.knownUsers && options.knownUsers.get(handle);
  if (!userId) return { record: null, reason: 'user_id_unknown', pinned: false };

  const replyingTo = (raw.replying_to || []).map(normalizeHandle).filter(Boolean);
  const isReply = replyingTo.length > 0;
  const selfThread = isReply && replyingTo.every((name) => name === handle);
  const quoteStatus = raw.quote ? STATUS_PATH.exec(String(raw.quote.status_path || '')) : null;

  const media = (raw.media || []).map(canonicalMediaUrl).filter(Boolean).map((item) => ({
    media_key: `dom_${item.id}`,
    type: 'photo',
    url: item.url,
  }));

  const record = canonicalize({
    post_id: status[2],
    user_id: userId,
    handle,
    created_at: parseXDate(raw.datetime),
    kind: isReply ? 'reply' : (quoteStatus ? 'quote' : 'original'),
    // Every route strips a reply's leading @-addressees, or the three
    // routes disagree about the text of a reply by that prefix -- and the
    // merge's prefix test cannot repair a difference at the START.
    text: normalizeText(raw.text, { isReply }),
    text_source: raw.show_more ? 'dom_truncated' : 'dom',
    in_reply_to_user_id: selfThread ? userId : null,
    in_reply_to_post_id: null,
    self_thread: selfThread,
    quoted_post_id: quoteStatus ? quoteStatus[2] : null,
    referenced: quoteStatus ? [{
      type: 'quoted', post_id: quoteStatus[2], handle: quoteStatus[1], text: normalizeText(raw.quote.text || ''),
    }] : [],
    entities: {
      cashtags: (String(raw.text || '').match(/\$[A-Za-z]{1,6}(?:\.[A-Za-z])?\b/g) || []).map((tag) => tag.slice(1)),
      mentions: replyingTo,
    },
    media,
    fetched_via: 'web_dom',
    fidelity: 'partial',
    first_seen_at: fetchedAt,
  });
  // A reply to SOMEONE ELSE has no user id for its addressee on the page;
  // mark it so the policy drops it rather than validation failing on it.
  if (isReply && !selfThread) record.in_reply_to_user_id = '0';
  return { record, reason: '', pinned: isPinnedContext(raw.social_context) };
}

/**
 * The JSONL contract an agent writes when it has to transcribe the page
 * (tools/x_pipeline/agentic_prompt.md). Validated strictly: an agent that
 * guesses an id or writes a relative time ("2h") must be refused, not
 * imported.
 *
 * @param {object} raw
 * @param {object} options
 * @param {Map<string, string>} options.knownUsers
 * @param {string} [options.fetchedAt]
 * @returns {{record: object|null, reason: string}}
 */
function normalizeAgentRecord(raw, options) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  if (!raw || typeof raw !== 'object') return { record: null, reason: 'not_an_object' };
  if (typeof raw.post_id !== 'string' || !/^\d{5,20}$/.test(raw.post_id)) {
    return { record: null, reason: 'post_id must be a digit STRING copied from the post URL' };
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(raw.created_at || ''))) {
    return { record: null, reason: 'created_at must be absolute ISO-8601 from the time element' };
  }
  const handle = normalizeHandle(raw.handle);
  const userId = options.knownUsers && options.knownUsers.get(handle);
  if (!userId) return { record: null, reason: 'user_id_unknown' };
  const kind = ['original', 'reply', 'quote'].includes(raw.kind) ? raw.kind : '';
  if (!kind) return { record: null, reason: 'kind must be original | reply | quote' };
  const replyTo = normalizeHandle(raw.in_reply_to_handle);
  const selfThread = kind === 'reply' && replyTo === handle;
  const record = canonicalize({
    post_id: raw.post_id,
    user_id: userId,
    handle,
    created_at: parseXDate(raw.created_at),
    kind,
    text: normalizeText(raw.text),
    text_source: raw.text_truncated ? 'dom_truncated' : 'dom',
    in_reply_to_user_id: kind === 'reply' ? (selfThread ? userId : '0') : null,
    self_thread: selfThread,
    quoted_post_id: typeof raw.quoted_post_id === 'string' && /^\d{5,20}$/.test(raw.quoted_post_id) ? raw.quoted_post_id : null,
    entities: {
      cashtags: (String(raw.text || '').match(/\$[A-Za-z]{1,6}(?:\.[A-Za-z])?\b/g) || []).map((tag) => tag.slice(1)),
    },
    media: (raw.media_urls || []).map(canonicalMediaUrl).filter(Boolean)
      .map((item) => ({ media_key: `dom_${item.id}`, type: 'photo', url: item.url })),
    fetched_via: 'agent_jsonl',
    fidelity: 'partial',
    first_seen_at: fetchedAt,
  });
  return { record, reason: '' };
}

module.exports = {
  canonicalMediaUrl,
  isPinnedContext,
  isRepostContext,
  normalizeAgentRecord,
  normalizeDomPost,
};
