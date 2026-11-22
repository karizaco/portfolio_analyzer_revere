'use strict';

/**
 * How fast the browser crawl may go: the number of pages it scrolls at once,
 * and X's own search allowance. Pure, so it can be tested without a browser.
 *
 * CONCURRENCY
 *
 * At most TWO pages crawl at once -- the user's cap (2026-11-22). They are two
 * TABS of ONE browser on ONE session: that is what a person with two search
 * tabs open looks like, and it keeps the one-crawl-per-session lock
 * (src/x/lock.js) meaningful. A second browser on the same profile is not
 * possible anyway (Chromium locks its user-data directory).
 *
 * THE RATE GATE
 *
 * X's web app answers every GraphQL call with its allowance for that
 * endpoint and that account:
 *
 *   x-rate-limit-limit      the requests allowed in the window
 *   x-rate-limit-remaining  what is left of them
 *   x-rate-limit-reset      when the window resets (epoch seconds)
 *
 * The allowance belongs to the ACCOUNT, so two tabs spend one budget. The
 * gate reads it from every SearchTimeline response and, when what is left is
 * down to the reserve, holds the scrolling until the reset -- so a crawl that
 * goes faster slows down BEFORE X has to answer 429, instead of being stopped
 * by it. A wait longer than `maxWaitMs` is not waited out: the crawl stops
 * with `rate_limited` and the reset as its retry time.
 *
 * MEASURED (2026-11-22, one headless tab, @BoujeeFinances October): the
 * search allowance is 50 pages per 15 minutes, and ONE tab fetches 39 pages
 * in 4 minutes -- about three times faster than the allowance refills. So the
 * allowance, not the scrolling, is what bounds a crawl, and a second tab adds
 * nothing but a faster drain. The reserve of 10 keeps a fifth of the
 * allowance for the user's own searching on the same account.
 */

const MAX_CONCURRENCY = 2;
const DEFAULT_RATE_RESERVE = 10;
const DEFAULT_MAX_RATE_WAIT_MS = 16 * 60 * 1000;

/**
 * The number of pages to crawl with: 1 unless asked, never more than the cap.
 *
 * @param {*} value
 * @returns {number}
 */
function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

function headerInt(headers, name) {
  if (!headers) return null;
  const raw = headers[name];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} [options]
 * @param {number} [options.reserve] - requests kept back; the gate holds at or below this
 * @param {number} [options.maxWaitMs] - a longer wait stops the crawl instead
 * @param {number} [options.marginMs] - added after the reset, so the new window has opened
 */
function createRateGate(options = {}) {
  const reserve = Number.isFinite(options.reserve) ? options.reserve : DEFAULT_RATE_RESERVE;
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : DEFAULT_MAX_RATE_WAIT_MS;
  const marginMs = Number.isFinite(options.marginMs) ? options.marginMs : 3000;
  let state = { limit: null, remaining: null, reset: null };
  let lowest = null;
  let observed = 0;
  let announcedReset = null;

  return {
    reserve,
    maxWaitMs,

    /**
     * Record one response's allowance. Responses can arrive out of order,
     * so within one reset window the LOWEST remaining wins, and a later
     * reset starts a new window.
     *
     * @param {object} headers - lower-case response headers
     * @returns {boolean} whether the response carried an allowance
     */
    observe(headers) {
      const remaining = headerInt(headers, 'x-rate-limit-remaining');
      const reset = headerInt(headers, 'x-rate-limit-reset');
      if (remaining === null || reset === null) return false;
      const limit = headerInt(headers, 'x-rate-limit-limit');
      observed += 1;
      lowest = lowest === null ? remaining : Math.min(lowest, remaining);
      if (state.reset === null || reset > state.reset) state = { limit, remaining, reset };
      else if (reset === state.reset) state = { ...state, remaining: Math.min(state.remaining, remaining) };
      return true;
    },

    /**
     * How long to hold before the next request: 0 when there is allowance
     * left, or once the reset has passed (the next response says what the
     * new window holds).
     *
     * @param {number} nowMs
     * @returns {number}
     */
    waitMs(nowMs) {
      if (state.reset === null || state.remaining === null) return 0;
      const resetMs = state.reset * 1000;
      if (nowMs >= resetMs) return 0;
      if (state.remaining > reserve) return 0;
      return resetMs - nowMs + marginMs;
    },

    /**
     * True the first time a hold is reported for the current reset, so two
     * pages waiting on one allowance log it once.
     *
     * @returns {boolean}
     */
    announce() {
      if (announcedReset === state.reset) return false;
      announcedReset = state.reset;
      return true;
    },

    snapshot() {
      return {
        limit: state.limit,
        remaining: state.remaining,
        reset_at: state.reset === null ? null : new Date(state.reset * 1000).toISOString(),
        lowest_remaining: lowest,
        responses_with_allowance: observed,
      };
    },
  };
}

module.exports = {
  DEFAULT_MAX_RATE_WAIT_MS, DEFAULT_RATE_RESERVE, MAX_CONCURRENCY, clampConcurrency, createRateGate,
};
