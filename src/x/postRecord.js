'use strict';

/**
 * The canonical X post record, `x-post-1`.
 *
 * WHY ONE RECORD
 *
 * Two routes fetch posts -- the paid API and the browser -- and they speak
 * different JSON. Each route has its own normalizer, and every normalizer
 * emits THIS shape. The importer, the archive and every reader downstream
 * see only this shape, so the two routes are interchangeable by
 * construction, and `test/xRouteEquivalence.test.js` pins that the same
 * post captured both ways normalizes to the same record.
 *
 * THE RULES THAT ARE EASY TO GET WRONG
 *
 * 1. AN ID IS A STRING. An X id is a 64-bit snowflake, larger than 2^53.
 *    `Number("1858123456789012345")` silently returns a DIFFERENT id.
 *    Every id here is a decimal string, compared with BigInt.
 * 2. THE ID CARRIES ITS OWN TIMESTAMP. A snowflake is
 *    `(milliseconds since 2010-11-04T01:42:54.657Z) << 22`, so `created_at`
 *    can be checked against the id. A disagreement is a parse error, not a
 *    data point. Ids from before snowflakes (before November 2010) are
 *    small sequential numbers and carry no time; they are not checked.
 * 3. THE TEXT IS NORMALISED THE SAME WAY ON EVERY ROUTE. Both routes
 *    HTML-escape `&`, `<`, `>`; both append t.co links for media and for a
 *    quoted post; both start a reply with the @-handles it replies to. Those
 *    are presentation, not content, and the two routes disagree about them
 *    at the edges -- so they are removed here, once.
 * 4. VOLATILE NUMBERS ARE NOT CONTENT. Likes and views change every minute.
 *    The archive keeps the FIRST observation only (`metrics_first_seen`),
 *    so re-crawling an unchanged month rewrites nothing.
 */

const SCHEMA = 'x-post-1';

const KINDS = ['original', 'reply', 'quote', 'repost'];

/** Route priority on merge: a higher-fidelity route wins a field. */
const ROUTE_RANK = {
  api_v2: 3,
  web_graphql: 2,
  agent_jsonl: 1,
  web_dom: 0,
};

const FIDELITIES = ['full', 'partial'];

const TWITTER_EPOCH_MS = 1288834974657n;

/** Pre-snowflake ids topped out near 3e10; a snowflake is far above 1e11. */
const MIN_SNOWFLAKE = 100000000000n;

/** created_at is truncated to the second; the id has milliseconds. */
const CREATED_AT_TOLERANCE_MS = 2000;

const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;

/**
 * Is this a well-formed X id (a decimal string)?
 *
 * @param {*} value
 * @returns {boolean}
 */
function isPostId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

/**
 * The time a snowflake id encodes, or null for a pre-snowflake id.
 *
 * @param {string} id
 * @returns {number|null} epoch milliseconds
 */
function snowflakeTime(id) {
  if (!isPostId(id)) return null;
  const big = BigInt(id);
  if (big < MIN_SNOWFLAKE) return null;
  return Number((big >> 22n) + TWITTER_EPOCH_MS);
}

/**
 * Compare two ids numerically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareIds(a, b) {
  if (!/^\d+$/.test(String(a)) || !/^\d+$/.test(String(b))) return String(a).localeCompare(String(b));
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * A handle, as stored: lowercase, no at-sign.
 *
 * @param {string} handle
 * @returns {string}
 */
function normalizeHandle(handle) {
  return String(handle || '').trim().replace(/^@+/, '').toLowerCase();
}

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse an X date into ISO UTC with milliseconds.
 *
 * Accepts ISO-8601 (the API, the DOM's `time[datetime]`) and the legacy
 * form the web app still uses: "Wed Oct 10 20:19:24 +0000 2018".
 *
 * @param {string} value
 * @returns {string} ISO string, or '' when it cannot be parsed
 */
function parseXDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const legacy = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(raw);
  if (legacy) {
    const [, mon, day, hh, mm, ss, sign, oh, om, year] = legacy;
    if (!(mon in MONTHS)) return '';
    let ms = Date.UTC(Number(year), MONTHS[mon], Number(day), Number(hh), Number(mm), Number(ss));
    const offset = (Number(oh) * 60 + Number(om)) * 60000;
    ms += sign === '+' ? -offset : offset;
    return new Date(ms).toISOString();
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

/**
 * Undo the HTML escaping both routes apply to post text.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The post text, normalised the same way on every route (rule 3).
 *
 * @param {string} text
 * @param {{isReply?: boolean}} [options]
 * @returns {string}
 */
function normalizeText(text, options = {}) {
  let out = decodeEntities(text).replace(/\r\n?/g, '\n');
  // Trailing t.co links are the media and the quoted post, which the record
  // carries as structure. A t.co link in the MIDDLE of the text is the
  // author's own link and stays. The link's own alphabet includes `-` and
  // `_`, so a pattern that allows only letters and digits leaves the link
  // in the text -- and then the routes disagree about the same post.
  out = out.replace(/(?:\s*https:\/\/t\.co\/[A-Za-z0-9_-]+)+\s*$/u, '');
  if (options.isReply) {
    // The leading @-handles of a reply are the reply's addressees, added by
    // the client. They are in entities.mentions and in_reply_to_user_id.
    out = out.replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+\s*/u, '');
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Unique values in order of first appearance.
 *
 * @param {Array<string>} values
 * @returns {Array<string>}
 */
function uniqueInOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Is a URL a post permalink or a media link? Those are structure (the
 * quoted post, the attached media), not a link the author shared.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isStructuralUrl(url) {
  return /^https?:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(String(url || ''))
    || /^https?:\/\/pic\.(?:x|twitter)\.com\//i.test(String(url || ''));
}

/**
 * The kind of a post, from its references.
 *
 * @param {{reposted?: string|null, inReplyTo?: string|null, quoted?: string|null}} refs
 * @returns {string}
 */
function postKind(refs) {
  if (refs.reposted) return 'repost';
  if (refs.inReplyTo) return 'reply';
  if (refs.quoted) return 'quote';
  return 'original';
}

const REF_ORDER = { retweeted: 0, replied_to: 1, quoted: 2 };

const FIELD_ORDER = [
  'schema', 'post_id', 'user_id', 'handle', 'created_at', 'kind', 'text', 'text_source', 'lang',
  'conversation_id', 'in_reply_to_post_id', 'in_reply_to_user_id', 'self_thread', 'quoted_post_id',
  'reposted_post_id', 'referenced', 'entities', 'media', 'edit', 'metrics_first_seen', 'fetched_via',
  'fidelity', 'first_seen_at',
];

/**
 * The engagement numbers, in a fixed shape.
 *
 * The archive's lines are supposed to be byte-identical for an unchanged
 * post, so the metrics object is CANONICALISED here: the same keys, in
 * the same order, whatever route produced it. Without this the same corpus
 * imported GraphQL-first and API-first would serialise to two different
 * byte sequences, and `git diff` would show a change that is not one.
 *
 * @param {object|null} metrics
 * @returns {object|null}
 */
function canonicalMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  return {
    likes: metrics.likes ?? null,
    reposts: metrics.reposts ?? null,
    replies: metrics.replies ?? null,
    quotes: metrics.quotes ?? null,
    views: metrics.views ?? null,
    bookmarks: metrics.bookmarks ?? null,
    observed_at: metrics.observed_at || '',
  };
}

/**
 * Build a record with every field present, in the canonical key order.
 *
 * The archive writes records with `JSON.stringify`, which keeps insertion
 * order -- so a fixed order is what makes an unchanged post serialize to an
 * unchanged line.
 *
 * @param {object} input
 * @returns {object}
 */
function canonicalize(input) {
  const entities = input.entities || {};
  const media = Array.isArray(input.media) ? input.media : [];
  const edit = input.edit || {};
  const historyIds = Array.isArray(edit.history_ids) && edit.history_ids.length
    ? edit.history_ids.map(String)
    : [String(input.post_id)];
  const record = {
    schema: SCHEMA,
    post_id: String(input.post_id || ''),
    user_id: String(input.user_id || ''),
    handle: normalizeHandle(input.handle),
    created_at: input.created_at || '',
    kind: input.kind || 'original',
    text: String(input.text || ''),
    text_source: input.text_source || 'text',
    lang: input.lang || '',
    conversation_id: input.conversation_id ? String(input.conversation_id) : String(input.post_id || ''),
    in_reply_to_post_id: input.in_reply_to_post_id ? String(input.in_reply_to_post_id) : null,
    in_reply_to_user_id: input.in_reply_to_user_id ? String(input.in_reply_to_user_id) : null,
    self_thread: Boolean(input.self_thread),
    quoted_post_id: input.quoted_post_id ? String(input.quoted_post_id) : null,
    reposted_post_id: input.reposted_post_id ? String(input.reposted_post_id) : null,
    referenced: (Array.isArray(input.referenced) ? input.referenced : [])
      .filter((ref) => ref && ref.post_id)
      .map((ref) => ({
        type: ref.type || '',
        post_id: String(ref.post_id),
        handle: normalizeHandle(ref.handle),
        created_at: ref.created_at || '',
        text: String(ref.text || ''),
      }))
      // A fixed order, so the same references serialize the same way
      // whichever route (or merge) produced them.
      .sort((a, b) => (REF_ORDER[a.type] ?? 9) - (REF_ORDER[b.type] ?? 9) || compareIds(a.post_id, b.post_id)),
    entities: {
      // The two routes spell a cashtag differently: the API gives `NVDA`,
      // the web GraphQL gives `$NVDA` (and `#nasa` for a hashtag). The
      // marker is stripped HERE, once, so both routes normalise to the same
      // value -- otherwise a GraphQL post's cashtag matches no ticker, and
      // the archive's content depends on which route saw the post first.
      cashtags: uniqueInOrder((entities.cashtags || []).map((tag) => String(tag).replace(/^\$/, '').toUpperCase())),
      hashtags: uniqueInOrder((entities.hashtags || []).map((tag) => String(tag).replace(/^#/, ''))),
      mentions: uniqueInOrder((entities.mentions || []).map((name) => normalizeHandle(name))),
      urls: uniqueInOrder((entities.urls || []).map(String).filter((url) => !isStructuralUrl(url))),
    },
    media: media.map((item) => ({
      media_key: String(item.media_key || ''),
      type: item.type || 'photo',
      url: item.url || '',
      preview_url: item.preview_url || '',
      width: Number.isFinite(item.width) ? item.width : null,
      height: Number.isFinite(item.height) ? item.height : null,
      alt_text: item.alt_text || '',
    })),
    edit: {
      history_ids: historyIds,
      is_earliest: historyIds[0] === String(input.post_id),
    },
    metrics_first_seen: canonicalMetrics(input.metrics_first_seen),
    fetched_via: input.fetched_via || 'web_dom',
    fidelity: input.fidelity || 'partial',
    first_seen_at: input.first_seen_at || '',
  };
  const ordered = {};
  for (const key of FIELD_ORDER) ordered[key] = record[key];
  return ordered;
}

/**
 * Validate a canonical record.
 *
 * @param {object} record
 * @returns {{ok: boolean, errors: string[]}}
 */
function validatePostRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['not an object'] };
  if (record.schema !== SCHEMA) errors.push(`schema is ${record.schema}, expected ${SCHEMA}`);
  if (!isPostId(record.post_id)) errors.push(`post_id is not an id string: ${JSON.stringify(record.post_id)}`);
  if (!/^\d{1,20}$/.test(String(record.user_id || ''))) errors.push('user_id is missing or not numeric');
  if (!HANDLE_PATTERN.test(String(record.handle || ''))) errors.push(`handle is not a handle: ${JSON.stringify(record.handle)}`);
  if (!KINDS.includes(record.kind)) errors.push(`kind is ${record.kind}`);
  if (typeof record.text !== 'string') errors.push('text is not a string');
  if (!(record.fetched_via in ROUTE_RANK)) errors.push(`fetched_via is ${record.fetched_via}`);
  if (!FIDELITIES.includes(record.fidelity)) errors.push(`fidelity is ${record.fidelity}`);

  const createdMs = Date.parse(record.created_at || '');
  if (Number.isNaN(createdMs)) {
    errors.push('created_at is not a date');
  } else if (isPostId(record.post_id)) {
    const idMs = snowflakeTime(record.post_id);
    if (idMs !== null && Math.abs(idMs - createdMs) > CREATED_AT_TOLERANCE_MS) {
      errors.push(`created_at ${record.created_at} disagrees with the id's own time ${new Date(idMs).toISOString()}`);
    }
  }

  for (const key of ['in_reply_to_post_id', 'quoted_post_id', 'reposted_post_id']) {
    if (record[key] !== null && record[key] !== undefined && !isPostId(record[key])) {
      errors.push(`${key} is not an id string`);
    }
  }
  if (record.kind === 'reply' && !record.in_reply_to_user_id && !record.in_reply_to_post_id) {
    errors.push('a reply names neither the post nor the user it replies to');
  }
  if (record.kind === 'repost' && !record.reposted_post_id) errors.push('a repost without reposted_post_id');
  for (const item of record.media || []) {
    if (!item.media_key) errors.push('a media item without media_key');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Does the account's reply policy keep this post?
 *
 * 'self' (the user's decision, 2026-11-20): own posts, own quotes, and own
 * thread replies -- never a reply to somebody else, never a repost of
 * somebody else's post.
 *
 * A self-reply whose THREAD began as a reply to somebody else is still
 * kept here; whether its root is the author's own is decided downstream,
 * where the root can be looked up (`threadRootIsOwn`).
 *
 * @param {object} record
 * @param {'self'|'none'} policy
 * @returns {{keep: boolean, reason: string}}
 */
function keepByPolicy(record, policy = 'self') {
  if (record.kind === 'repost') return { keep: false, reason: 'repost' };
  if (record.kind === 'reply') {
    if (policy === 'none') return { keep: false, reason: 'reply' };
    if (!record.self_thread) return { keep: false, reason: 'reply_to_other' };
  }
  return { keep: true, reason: '' };
}

module.exports = {
  CREATED_AT_TOLERANCE_MS,
  FIELD_ORDER,
  KINDS,
  ROUTE_RANK,
  SCHEMA,
  canonicalMetrics,
  canonicalize,
  compareIds,
  decodeEntities,
  isPostId,
  isStructuralUrl,
  keepByPolicy,
  normalizeHandle,
  normalizeText,
  parseXDate,
  postKind,
  snowflakeTime,
  uniqueInOrder,
  validatePostRecord,
};
