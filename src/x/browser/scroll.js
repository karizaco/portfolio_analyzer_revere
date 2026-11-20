'use strict';

/**
 * When is a window's scroll DONE? A pure state machine, so it can be tested
 * without a browser.
 *
 * A window is finished when ONE of these is true:
 *
 *   passed_start  the oldest captured own post is older than the window's
 *                 start -- the timeline has scrolled past the window, so
 *                 everything inside it has been on screen
 *   exhausted     N scrolls in a row brought no new post: the results ran out
 *   scroll_cap    the hard cap on scrolls was hit (NOT a natural end: the
 *                 window is then partial)
 *
 * Borrowed from x_unsub's "N scrolls with no new items" loop, with the
 * window boundary added.
 */

const DEFAULT_NO_NEW_LIMIT = 6;
const DEFAULT_MAX_SCROLLS = 400;

/**
 * @param {object} options
 * @param {string} options.windowStart - ISO date
 * @param {number} [options.noNewLimit]
 * @param {number} [options.maxScrolls]
 */
function createScrollTracker(options) {
  const startMs = Date.parse(`${options.windowStart}T00:00:00Z`);
  const noNewLimit = options.noNewLimit || DEFAULT_NO_NEW_LIMIT;
  const maxScrolls = options.maxScrolls || DEFAULT_MAX_SCROLLS;
  const seen = new Set();
  let scrolls = 0;
  let quiet = 0;
  let oldest = '';

  return {
    get seen() { return seen.size; },
    get scrolls() { return scrolls; },
    get oldest() { return oldest; },

    /**
     * Report what one scroll brought.
     *
     * @param {Array<{post_id: string, created_at: string}>} records - own posts captured since the last scroll
     * @returns {{done: boolean, reason: string, reachedEnd: boolean, fresh: number}}
     */
    observe(records) {
      scrolls += 1;
      let fresh = 0;
      for (const record of records || []) {
        if (seen.has(record.post_id)) continue;
        seen.add(record.post_id);
        fresh += 1;
        if (!oldest || record.created_at < oldest) oldest = record.created_at;
      }
      quiet = fresh ? 0 : quiet + 1;
      if (oldest && Date.parse(oldest) < startMs) return { done: true, reason: 'passed_start', reachedEnd: true, fresh };
      if (quiet >= noNewLimit) return { done: true, reason: 'exhausted', reachedEnd: true, fresh };
      if (scrolls >= maxScrolls) return { done: true, reason: 'scroll_cap', reachedEnd: false, fresh };
      return { done: false, reason: '', reachedEnd: false, fresh };
    },
  };
}

/**
 * A human-paced pause, uniformly jittered.
 *
 * @param {number} minMs
 * @param {number} maxMs
 * @param {Function} [random]
 * @returns {number}
 */
function jitter(minMs, maxMs, random = Math.random) {
  return Math.round(minMs + (maxMs - minMs) * random());
}

module.exports = { DEFAULT_MAX_SCROLLS, DEFAULT_NO_NEW_LIMIT, createScrollTracker, jitter };
