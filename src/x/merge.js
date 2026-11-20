'use strict';

/**
 * Merge two canonical records of the SAME post.
 *
 * The same post can arrive by more than one route: the API, a GraphQL
 * capture, a page scrape, an agent's transcription. The merged record takes
 * each field from the most faithful route that has it, and NEVER
 * downgrades:
 *
 *   api_v2 > web_graphql > agent_jsonl > web_dom
 *
 * - The content fields come from the higher-ranked route. A lower-ranked
 *   route only fills what the record is missing.
 * - TEXT: a longer text wins over a shorter one it extends -- a truncated
 *   "Show more" text never replaces the full one, whichever route it came
 *   from.
 * - `first_seen_at` is the EARLIEST sighting, and `metrics_first_seen` is
 *   kept from the first record that had it. Both are what the survivorship
 *   and engagement analyses need, and neither may move once written.
 * - `referenced` is the union by (type, post_id), keeping the entry that
 *   carries text.
 */

const { ROUTE_RANK, canonicalize } = require('./postRecord');

const CONTENT_FIELDS = [
  'user_id', 'handle', 'created_at', 'kind', 'lang', 'conversation_id', 'in_reply_to_post_id',
  'in_reply_to_user_id', 'self_thread', 'quoted_post_id', 'reposted_post_id', 'entities', 'media', 'edit',
];

function rank(record) {
  return ROUTE_RANK[record.fetched_via] ?? -1;
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    return Object.values(value).every((inner) => isEmpty(inner));
  }
  return false;
}

/**
 * Strip a truncation marker so "abc…" is recognised as a prefix of "abcdef".
 *
 * @param {string} text
 * @returns {string}
 */
function stem(text) {
  return String(text || '').replace(/(?:…|\.\.\.)\s*$/u, '').trim();
}

/**
 * Choose the text: the higher route's, unless the lower route's text is a
 * strict extension of it.
 *
 * A TRUNCATED text never beats an untruncated one, whichever route it
 * came from: the API cuts a long post at 280 characters and the page
 * scrape cuts it at "Show more", so the two routes truncate at different
 * points and the prefix test alone would let the shorter one win.
 *
 * @param {object} high
 * @param {object} low
 * @returns {{text: string, text_source: string}}
 */
function chooseText(high, low) {
  const hi = String(high.text || '');
  const lo = String(low.text || '');
  const hiTruncated = isTruncated(high.text_source);
  const loTruncated = isTruncated(low.text_source);
  if (!hi) return { text: lo, text_source: low.text_source };
  if (loTruncated && !hiTruncated) return { text: hi, text_source: high.text_source };
  if (!loTruncated && hiTruncated) return { text: lo, text_source: low.text_source };
  if (lo.length > hi.length && lo.startsWith(stem(hi))) return { text: lo, text_source: low.text_source };
  return { text: hi, text_source: high.text_source };
}

/**
 * Is this text source a TRUNCATED reading?
 *
 * @param {string} textSource
 * @returns {boolean}
 */
function isTruncated(textSource) {
  return /truncated/i.test(String(textSource || ''));
}

/**
 * The union of two entity sets, member by member.
 *
 * The entity lists are SETS -- a cashtag is present or it is not -- so
 * the lower route's extra cashtags are lost if the higher route's list
 * merely happens to be non-empty. The higher route's ORDER comes first,
 * so the merge does not depend on which route was seen first.
 *
 * @param {object} high
 * @param {object} low
 * @returns {object}
 */
function mergeEntities(high, low) {
  const out = {};
  for (const key of ['cashtags', 'hashtags', 'mentions', 'urls']) {
    const values = [...(high[key] || []), ...(low[key] || [])];
    out[key] = [...new Set(values)];
  }
  return out;
}

/**
 * The union of two edit histories.
 *
 * The history is the list of versions of a post, oldest first, so the
 * union keeps that order and `is_earliest` is recomputed from it: a
 * higher route that saw only the LATEST version must not hide the fact
 * that the post was edited.
 *
 * @param {object} high
 * @param {object} low
 * @param {string} postId
 * @returns {object}
 */
function mergeEdit(high, low, postId) {
  const ids = [...new Set([
    ...((low.edit && low.edit.history_ids) || []).map(String),
    ...((high.edit && high.edit.history_ids) || []).map(String),
  ])];
  const history = ids.length ? ids : [String(postId)];
  return { history_ids: history, is_earliest: history[0] === String(postId) };
}

/**
 * Merge `incoming` into `existing`.
 *
 * @param {object|null} existing
 * @param {object} incoming
 * @returns {{record: object, changed: boolean}}
 */
function mergeRecords(existing, incoming) {
  if (!existing) return { record: canonicalize(incoming), changed: true };
  if (existing.post_id !== incoming.post_id) {
    throw new Error(`cannot merge different posts ${existing.post_id} and ${incoming.post_id}`);
  }
  const incomingWins = rank(incoming) > rank(existing);
  const high = incomingWins ? incoming : existing;
  const low = incomingWins ? existing : incoming;

  const merged = { ...high };
  for (const field of CONTENT_FIELDS) {
    if (isEmpty(merged[field]) && !isEmpty(low[field])) merged[field] = low[field];
  }
  // The entity lists and the edit history are SETS and a LIST: they are
  // UNIONED, not replaced by whichever route happened to be richer.
  merged.entities = mergeEntities(high.entities || {}, low.entities || {});
  merged.edit = mergeEdit(high, low, incoming.post_id);
  // A real media key from a JSON route replaces a page-scraped placeholder.
  if (Array.isArray(merged.media) && merged.media.some((item) => String(item.media_key).startsWith('dom_'))
    && Array.isArray(low.media) && low.media.length && !low.media.some((item) => String(item.media_key).startsWith('dom_'))) {
    merged.media = low.media;
  }
  Object.assign(merged, chooseText(high, low));

  const firstSeen = [existing.first_seen_at, incoming.first_seen_at].filter(Boolean).sort()[0] || '';
  merged.first_seen_at = firstSeen;
  merged.metrics_first_seen = existing.metrics_first_seen || incoming.metrics_first_seen || null;
  merged.fidelity = existing.fidelity === 'full' || incoming.fidelity === 'full'
    ? (isTruncated(chooseText(high, low).text_source) ? 'partial' : 'full')
    : 'partial';

  const refs = new Map();
  for (const ref of [...(low.referenced || []), ...(high.referenced || [])]) {
    const key = `${ref.type}:${ref.post_id}`;
    const prior = refs.get(key);
    if (!prior || (!prior.text && ref.text) || (ref.text && ref.text.length > prior.text.length)) refs.set(key, ref);
  }
  merged.referenced = [...refs.values()];

  const record = canonicalize(merged);
  const changed = JSON.stringify(record) !== JSON.stringify(canonicalize(existing));
  return { record, changed };
}

module.exports = { isTruncated, mergeEdit, mergeEntities, mergeRecords, stem };
