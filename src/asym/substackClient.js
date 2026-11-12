'use strict';

// The Substack API client.
//
// WHY A CLIENT AND NOT `fetch` CALLS IN THE TOOLS
//
// Two things about Substack's API are worth writing down once, because both
// cost real time to discover:
//
//   1. THE PAGINATION IS A CURSOR, NOT AN OFFSET.
//      `/api/v1/archive?offset=20` returns
//      `{"errors":[{"param":"offset","msg":"Invalid value"}]}` -- HTTP 400.
//      The archive takes `cursor=<base64 of {"post_date":"..."}>`, and the
//      response carries `nextCursor`. The POSTS endpoint (`/api/v1/posts`)
//      takes the same cursor and also rejects `offset`.
//
//   2. THE TWO LIST ENDPOINTS RETURN DIFFERENT AMOUNTS OF THE POST.
//      `/api/v1/archive` returns `body_html: ""` for EVERY post -- free ones
//      included. `/api/v1/posts` returns the real `body_html` for free posts
//      and `""` for paid ones. Measured over the full corpus: walking
//      `/api/v1/posts` gives 42 posts with a body, and walking
//      `/api/v1/archive` gives 0.
//
//      So the posts endpoint is the one the pipeline uses, and the archive
//      endpoint is only useful as a cross-check.
//
// The client takes an injectable `fetch` so the tools can be tested without
// a network, and it records what it saw so a caller can tell an empty
// corpus from a failed request.

const {
  ASYM_POSTS_API,
  ASYM_POST_BY_ID_API,
  ASYM_PUBLICATION_ID,
  ASYM_VIDEO_API,
} = require('./channel');

/** How many posts a page asks for. The API accepts up to 50. */
const DEFAULT_PAGE_SIZE = 25;

/** How long to wait for a response before giving up. */
const DEFAULT_TIMEOUT_MS = 30000;

/** How many times a transient network failure is retried. */
const DEFAULT_RETRIES = 3;

/**
 * The error Substack returns for a bad query parameter.
 *
 * It answers with HTTP 400 and a JSON body naming the offending parameter,
 * so a caller can tell "you asked for something invalid" from "the server
 * is unwell". Treating it as a transient error and retrying would be wrong:
 * it would fail the same way three times.
 */
class AsymApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number} [details.status] - the HTTP status
   * @param {string} [details.url] - the URL that failed
   * @param {any} [details.body] - the parsed response body
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AsymApiError';
    this.status = details.status ?? null;
    this.url = details.url ?? '';
    this.body = details.body ?? null;
  }
}

/**
 * Sleep, for the retry backoff.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Create a client for the publication's API.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - the fetch to use (for tests)
 * @param {string} [options.baseUrl] - the publication host
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {number} [options.pageSize]
 * @param {number} [options.pauseMs] - pause between pages, to be polite
 * @param {Function} [options.onPage] - called with each page's posts
 * @param {Function} [options.log] - called with progress lines
 * @returns {object} the client
 */
function createAsymClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const pauseMs = options.pauseMs ?? 0;
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;
  const log = typeof options.log === 'function' ? options.log : () => {};

  if (typeof fetchImpl !== 'function') {
    throw new Error('createAsymClient needs a fetch implementation');
  }

  /**
   * One request, with a timeout and retries for transport failures.
   *
   * A 400 is NOT retried: Substack returns it for an invalid parameter, and
   * retrying a malformed request just repeats the mistake. A 404 is not
   * retried either -- it is an answer.
   *
   * @param {string} url
   * @returns {Promise<any>} the parsed JSON body
   */
  async function requestJson(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        const text = await response.text();
        clearTimeout(timer);

        if (!response.ok) {
          let body = text;
          try { body = JSON.parse(text); } catch { /* keep the text */ }
          throw new AsymApiError(
            `Substack request failed: ${response.status} ${response.statusText}`,
            { status: response.status, url, body },
          );
        }
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new AsymApiError('Substack returned a body that is not JSON', {
            status: response.status,
            url,
            body: text.slice(0, 400),
          });
        }
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof AsymApiError) throw error;
        lastError = error;
        if (attempt < retries) {
          log(`[asym] retry ${attempt}/${retries - 1} after ${error.message}`);
          await sleep(1000 * attempt);
        }
      }
    }
    throw new AsymApiError(`Substack request failed after ${retries} attempts: ${lastError && lastError.message}`, {
      url,
    });
  }

  /**
   * One page of the post list.
   *
   * @param {object} [pageOptions]
   * @param {string} [pageOptions.cursor] - the cursor from the previous page
   * @returns {Promise<{posts: Array<object>, nextCursor: string}>}
   */
  async function listPage(pageOptions = {}) {
    const cursor = pageOptions.cursor ? `&cursor=${encodeURIComponent(pageOptions.cursor)}` : '';
    const url = `${ASYM_POSTS_API}?limit=${pageSize}${cursor}`;
    const payload = await requestJson(url);
    const posts = Array.isArray(payload && payload.posts) ? payload.posts : [];
    const nextCursor = payload && typeof payload.nextCursor === 'string' ? payload.nextCursor : '';
    if (onPage) onPage(posts, nextCursor);
    return { posts, nextCursor };
  }

  /**
   * Every post in the publication, walked with the cursor.
   *
   * The walk ends when the API stops returning a cursor. It is NOT bounded
   * by a post count by default, because a bounded walk that stops early
   * looks exactly like a complete one -- and a partial corpus would
   * silently under-report the free posts.
   *
   * @param {object} [walkOptions]
   * @param {number} [walkOptions.maxPages] - stop after this many pages
   * @param {number} [walkOptions.maxPosts] - stop after this many posts
   * @returns {Promise<{posts: Array<object>, pages: number, complete: boolean}>}
   */
  async function listAllPosts(walkOptions = {}) {
    const maxPages = walkOptions.maxPages ?? 0;
    const maxPosts = walkOptions.maxPosts ?? 0;
    const posts = [];
    let cursor = '';
    let pages = 0;
    let complete = false;

    for (;;) {
      const page = await listPage({ cursor });
      pages += 1;
      posts.push(...page.posts);
      log(`[asym] page ${pages}: ${page.posts.length} post(s), total ${posts.length}`);

      if (!page.nextCursor) {
        complete = true;
        break;
      }
      if (maxPages && pages >= maxPages) break;
      if (maxPosts && posts.length >= maxPosts) break;
      cursor = page.nextCursor;
      if (pauseMs) await sleep(pauseMs);
    }

    return { posts, pages, complete };
  }

  /**
   * One post, by its numeric id.
   *
   * @param {number|string} postId
   * @returns {Promise<object|null>} the post, or null when it is not there
   */
  async function getPost(postId) {
    const url = `${ASYM_POST_BY_ID_API}/${postId}`;
    const payload = await requestJson(url);
    if (!payload || typeof payload !== 'object') return null;
    return payload.post || null;
  }

  /**
   * The media metadata of one embedded video.
   *
   * This is the endpoint that says how long the video is and how big it is,
   * and it also works for a PAID post's video -- so it can be used to
   * describe what the pipeline is not reading, without reading it.
   *
   * @param {string} mediaUploadId
   * @returns {Promise<object|null>}
   */
  async function getVideo(mediaUploadId) {
    const url = `${ASYM_VIDEO_API}/${encodeURIComponent(mediaUploadId)}`;
    const payload = await requestJson(url);
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  }

  /**
   * The signed MP4 URL of one embedded video.
   *
   * The endpoint redirects (307) to a Mux URL carrying a token that EXPIRES
   * (measured: `exp` was about 24 hours out), so the URL is resolved at
   * download time and never cached in the catalog.
   *
   * The `type=mp4` variant returns a progressive MP4 of the full resolution
   * (measured: 330,558,683 bytes for a 58-minute 1920x1080 video). The
   * `type=hls` variant returns an m3u8 whose renditions are 1920x1080 down
   * to 480x270.
   *
   * @param {string} mediaUploadId
   * @param {object} [resolveOptions]
   * @param {'mp4'|'hls'} [resolveOptions.type]
   * @param {string} [resolveOptions.publicationId]
   * @returns {Promise<string>} the signed URL
   */
  async function resolveVideoUrl(mediaUploadId, resolveOptions = {}) {
    const type = resolveOptions.type || 'mp4';
    const publicationId = resolveOptions.publicationId || ASYM_PUBLICATION_ID;
    const url = `${ASYM_VIDEO_API}/${encodeURIComponent(mediaUploadId)}/src`
      + `?override_publication_id=${publicationId}&type=${type}`;
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new AsymApiError(`Could not resolve the media URL: ${response.status}`, {
        status: response.status,
        url,
      });
    }
    return response.url;
  }

  return {
    getPost,
    getVideo,
    listAllPosts,
    listPage,
    resolveVideoUrl,
    requestJson,
  };
}

module.exports = {
  AsymApiError,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  createAsymClient,
};