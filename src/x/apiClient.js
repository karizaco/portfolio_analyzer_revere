'use strict';

/**
 * The X API v2 client (route A).
 *
 * Plain `fetch` with an app-only bearer token -- no SDK, no `xurl`
 * subprocess per request (x_unsub's mcp-client spawned `npx` once per call).
 *
 * THE RULES
 *
 * - THE TOKEN IS NEVER PRINTED. It travels in the Authorization header,
 *   never in a URL, and every error message is passed through `redact()`
 *   before it is thrown, because an error body can echo request details.
 * - A 429 IS WAITED OUT, NOT RETRIED TIGHTER. The wait is the
 *   `x-rate-limit-reset` header's time; a wait longer than the cap throws a
 *   `rate_limited` error carrying the retry time, so the caller can mark the
 *   window and stop.
 * - REQUESTS ARE PACED (default one per 1.1 s), which is the historical
 *   full-archive-search limit; measure before lowering it.
 *
 * Fields: the long-post text (`note_tweet`) is ALWAYS requested -- without
 * it the API returns a truncated `text` and nothing says so.
 */

const API_BASE = 'https://api.x.com';

const TWEET_FIELDS = [
  'created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets', 'entities',
  'attachments', 'public_metrics', 'note_tweet', 'edit_history_tweet_ids', 'lang', 'possibly_sensitive',
].join(',');
const EXPANSIONS = [
  'author_id', 'attachments.media_keys', 'referenced_tweets.id', 'referenced_tweets.id.author_id',
  'in_reply_to_user_id',
].join(',');
const MEDIA_FIELDS = ['media_key', 'type', 'url', 'preview_image_url', 'width', 'height', 'alt_text', 'variants'].join(',');
const USER_FIELDS = ['username', 'name'].join(',');
const LOOKUP_USER_FIELDS = ['created_at', 'public_metrics', 'description', 'protected', 'verified', 'username', 'name'].join(',');

class XApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'XApiError';
    this.status = details.status ?? null;
    this.code = details.code || '';
    this.endpoint = details.endpoint || '';
    this.retryAt = details.retryAt || null;
  }
}

/**
 * Remove every secret from a string.
 *
 * @param {string} text
 * @param {Array<string>} secrets
 * @returns {string}
 */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets || []) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  // Belt and braces: anything that looks like a bearer credential.
  return out.replace(/Bearer\s+[A-Za-z0-9%._~+/=-]{16,}/g, 'Bearer [redacted]');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(res, name) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === 'function') return res.headers.get(name);
  return res.headers[name] ?? null;
}

/**
 * Create a client.
 *
 * @param {object} options
 * @param {string} options.bearerToken
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.sleep]
 * @param {Function} [options.now]
 * @param {string} [options.baseUrl]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxRetries]
 * @param {number} [options.maxRateLimitWaitMs]
 * @param {Function} [options.onResponse] - ({endpoint, url, status, json, rateLimit, fetchedAt}) => void
 * @param {Function} [options.log]
 */
function createXApiClient(options) {
  const token = String(options.bearerToken || '');
  if (!token) throw new XApiError('X_BEARER_TOKEN is not set (put it in .env -- see docs/x-source-plan.md)', { code: 'no_token' });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const baseUrl = options.baseUrl || API_BASE;
  const minIntervalMs = options.minIntervalMs ?? 1100;
  const maxRetries = options.maxRetries ?? 4;
  const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 16 * 60 * 1000;
  const log = options.log || (() => {});
  let lastRequestAt = 0;

  async function request(endpoint, params = {}) {
    const url = new URL(endpoint, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const safeUrl = url.toString();

    for (let attempt = 0; ; attempt += 1) {
      const wait = lastRequestAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();

      let res;
      try {
        res = await fetchImpl(safeUrl, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'portfolio-analyzer-x/1' },
        });
      } catch (error) {
        if (attempt >= maxRetries) {
          throw new XApiError(redact(`network error on ${endpoint}: ${error.message}`, [token]), { code: 'network', endpoint });
        }
        const backoff = 1000 * 2 ** attempt;
        log(`[x-api] network error, retry in ${backoff} ms`);
        await sleep(backoff);
        continue;
      }

      const rateLimit = {
        limit: Number(header(res, 'x-rate-limit-limit')) || null,
        remaining: header(res, 'x-rate-limit-remaining') === null ? null : Number(header(res, 'x-rate-limit-remaining')),
        reset: Number(header(res, 'x-rate-limit-reset')) || null,
      };
      const text = typeof res.text === 'function' ? await res.text() : '';
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
      const fetchedAt = new Date(now()).toISOString();
      if (typeof options.onResponse === 'function') {
        options.onResponse({ endpoint, url: safeUrl, status: res.status, json, rateLimit, fetchedAt });
      }

      if (res.status === 429) {
        const resetMs = rateLimit.reset ? rateLimit.reset * 1000 : now() + 60000;
        const pause = Math.max(1000, resetMs - now()) + 1000;
        if (pause > maxRateLimitWaitMs || attempt >= maxRetries) {
          throw new XApiError(`rate limited on ${endpoint}; retry after ${new Date(resetMs).toISOString()}`,
            { status: 429, code: 'rate_limited', endpoint, retryAt: new Date(resetMs).toISOString() });
        }
        log(`[x-api] 429 on ${endpoint}; waiting ${Math.round(pause / 1000)} s for the reset`);
        await sleep(pause);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= maxRetries) {
          throw new XApiError(redact(`HTTP ${res.status} on ${endpoint}: ${text.slice(0, 300)}`, [token]), { status: res.status, code: 'server', endpoint });
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        const detail = json && (json.detail || json.title || (json.errors && json.errors[0] && json.errors[0].message));
        const code = res.status === 401 ? 'unauthorized' : (res.status === 402 ? 'payment_required' : (res.status === 403 ? 'forbidden' : 'http'));
        throw new XApiError(redact(`HTTP ${res.status} on ${endpoint}: ${detail || text.slice(0, 300)}`, [token]),
          { status: res.status, code, endpoint });
      }
      return { status: res.status, json: json || {}, rateLimit, url: safeUrl, fetchedAt };
    }
  }

  return {
    request,

    /** GET /2/users/by/username/:username */
    lookupUser(handle) {
      return request(`/2/users/by/username/${encodeURIComponent(handle)}`, { 'user.fields': LOOKUP_USER_FIELDS });
    },

    /** GET /2/tweets/search/all -- full archive, up to 500 per page. */
    searchAll({ query, startTime, endTime, nextToken, maxResults = 500, sinceId }) {
      return request('/2/tweets/search/all', {
        query,
        start_time: startTime,
        end_time: endTime,
        since_id: sinceId,
        next_token: nextToken,
        max_results: Math.max(10, Math.min(500, maxResults)),
        'tweet.fields': TWEET_FIELDS,
        expansions: EXPANSIONS,
        'media.fields': MEDIA_FIELDS,
        'user.fields': USER_FIELDS,
      });
    },

    /** GET /2/tweets/counts/all -- billed per REQUEST, not per post. */
    countsAll({ query, startTime, endTime, granularity = 'day', nextToken }) {
      return request('/2/tweets/counts/all', {
        query, start_time: startTime, end_time: endTime, granularity, next_token: nextToken,
      });
    },
  };
}

module.exports = {
  API_BASE,
  EXPANSIONS,
  MEDIA_FIELDS,
  TWEET_FIELDS,
  XApiError,
  createXApiClient,
  redact,
};
