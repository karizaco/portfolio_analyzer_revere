'use strict';

/**
 * When is a window's scroll DONE? A pure state machine, so it can be tested
 * without a browser.
 *
 * A window is finished when ONE of these is true:
 *
 *   passed_start    the oldest captured own post is older than the window's
 *                   start -- the timeline has scrolled past the window, so
 *                   everything inside it has been on screen
 *   end_of_results  X's own `TimelineTerminateTimeline` (direction Bottom)
 *                   arrived: X says there is nothing more below. On a
 *                   date-bounded search the results never reach past the
 *                   window's start, so this is the natural end there
 *                   (measured on the first live window, 2026-11-21: one
 *                   post, then a page with only cursors and the terminate)
 *   exhausted       N scrolls in a row brought no new post
 *   scroll_cap      the hard cap on scrolls was hit
 *
 * ONLY `passed_start` and `end_of_results` are NATURAL ENDS -- each is a
 * positive statement that the window was covered. The other two are STOPS, and a
 * window that stopped is `partial`, never `complete`: a scroll that
 * brought nothing new is as likely to be a lazy-loading hiccup as the end
 * of the timeline, and completeness belongs to the window -- so a stall
 * recorded as coverage means the paid route will never come back for it.
 * That is the same failure as the catalog's `listing_complete`: absence
 * from an incomplete listing proves nothing.
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
     * @param {object} [signals]
     * @param {boolean} [signals.terminated] - X sent TimelineTerminateTimeline (Bottom) since the last scroll
     * @param {boolean} [signals.atBottom] - the viewport is at the end of what is loaded; a scroll that
     *   brought nothing counts as QUIET only there (undefined = unknown, counted as quiet)
     * @returns {{done: boolean, reason: string, reachedEnd: boolean, fresh: number}}
     */
    observe(records, signals = {}) {
      scrolls += 1;
      let fresh = 0;
      for (const record of records || []) {
        if (seen.has(record.post_id)) continue;
        seen.add(record.post_id);
        fresh += 1;
        if (!oldest || record.created_at < oldest) oldest = record.created_at;
      }
      // A turn that is still crossing posts already loaded is not quiet: it
      // could not have brought anything new.
      if (fresh) quiet = 0;
      else if (signals.atBottom !== false) quiet += 1;
      if (oldest && Date.parse(oldest) < startMs) return { done: true, reason: 'passed_start', reachedEnd: true, fresh };
      if (signals.terminated) return { done: true, reason: 'end_of_results', reachedEnd: true, fresh };
      if (quiet >= noNewLimit) return { done: true, reason: 'exhausted', reachedEnd: false, fresh };
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
