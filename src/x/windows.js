'use strict';

/**
 * Date windows: the unit of crawl work on BOTH routes.
 *
 * WHY WINDOWS
 *
 * Neither route can walk an account's whole history in one go. The API's
 * user timeline stops at the 3,200 newest posts, so a backfill uses
 * full-archive search with a date range; the web profile stops scrolling
 * early, so the browser uses the search page with since:/until:. Cutting
 * the history into windows makes every crawl RESUMABLE (a window remembers
 * its pagination token and its state) and AUDITABLE (a window is complete or
 * it is not), and it lets one route finish a window the other could not.
 *
 * Window ends are EXCLUSIVE ISO dates: [2025-01-01, 2025-02-01).
 */

const { normalizeHandle } = require('./postRecord');

/**
 * The API queries, one per kind of own post the policy keeps.
 *
 * Splitting them is the cost lever: `from:h` alone would also return (and
 * bill) every reply to somebody else, which the policy then throws away.
 */
const API_QUERY_KINDS = {
  originals: (handle) => `from:${handle} -is:retweet -is:reply`,
  self_replies: (handle) => `from:${handle} is:reply to:${handle}`,
};

/** The browser uses one search per window; the importer applies the policy. */
const BROWSER_QUERY_KIND = 'all_own';

function toDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`not a date: ${value}`);
  return text;
}

function addUnit(isoDate, unit) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1, 0, 1);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1, 1);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (unit === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else throw new Error(`unknown unit ${unit}`);
  return d.toISOString().slice(0, 10);
}

function alignStart(isoDate, unit) {
  if (unit === 'year') return `${isoDate.slice(0, 4)}-01-01`;
  if (unit === 'month') return `${isoDate.slice(0, 7)}-01`;
  return isoDate;
}

/**
 * Split [since, until) into calendar-aligned windows, newest first.
 *
 * @param {object} options
 * @param {string} options.since - ISO date (inclusive)
 * @param {string} options.until - ISO date (exclusive)
 * @param {'year'|'month'|'week'|'day'} [options.unit]
 * @returns {Array<{start: string, end: string}>}
 */
function planWindows(options) {
  const since = toDate(options.since);
  const until = toDate(options.until);
  const unit = options.unit || 'month';
  if (since >= until) return [];
  const out = [];
  let cursor = alignStart(since, unit);
  while (cursor < until) {
    const next = addUnit(cursor, unit);
    out.push({ start: cursor < since ? since : cursor, end: next > until ? until : next });
    cursor = next;
  }
  return out.reverse();
}

/**
 * Split one window into smaller ones (a dense month becomes weeks).
 *
 * @param {{start: string, end: string}} window
 * @param {'week'|'day'} unit
 * @returns {Array<{start: string, end: string}>}
 */
function splitWindow(window, unit = 'week') {
  return planWindows({ since: window.start, until: window.end, unit });
}

/**
 * The browser search URL for a window. The window is widened by one day on
 * each side, because X does not document the timezone of since:/until:;
 * duplicates are removed by post id.
 *
 * @param {string} handle
 * @param {{start: string, end: string}} window
 * @returns {string}
 */
function browserSearchUrl(handle, window) {
  const h = normalizeHandle(handle);
  const since = shift(window.start, -1);
  const until = shift(window.end, 1);
  const query = `from:${h} since:${since} until:${until}`;
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
}

function shift(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The parts of [start, end) that no existing window already covers.
 *
 * WHY THIS EXISTS
 *
 * A window is the unit of work and a COMPLETE window is never crawled
 * again. So a re-plan must be REDUCED to the part that is not covered
 * yet -- otherwise extending the end of a backfill by one day creates a
 * NEW window for the whole period, and the crawler re-reads (and
 * re-bills) every post in it. The API costs $0.005 a post, so "re-plan
 * tomorrow" is not a free operation.
 *
 * The covered ranges are the ranges of the windows that already exist for
 * the account and the query kind -- complete ones AND the ones still in
 * progress, because a window being resumed is covering its own range.
 *
 * @param {Array<{start: string, end: string}>} existing
 * @param {string} start
 * @param {string} end
 * @returns {Array<{start: string, end: string}>}
 */
function uncoveredRanges(existing, start, end) {
  if (!(start < end)) return [];
  const ranges = (existing || [])
    .filter((range) => range && range.start < range.end)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));
  const out = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    if (range.start > cursor) out.push({ start: cursor, end: range.start < end ? range.start : end });
    if (range.end > cursor) cursor = range.end;
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((range) => range.start < range.end);
}

/**
 * Is a window complete? (The rule both routes share.)
 *
 * THREE THINGS MUST HOLD
 *
 * 1. The route reached the window's NATURAL END -- the API ran out of
 *    pages, the browser scrolled past the window's start.
 * 2. NO STOP SIGNAL was raised. ANY stop reason means the window is not
 *    complete: only a list of five known reasons used to be treated as
 *    stops, so a reason outside that list (`no_graphql`, `selector_drift`,
 *    `x_error_page`) could still yield a "complete" window -- and a
 *    window that is complete is never crawled again.
 * 3. The seen count AGREES with the expected count, when one is known.
 *    The agreement is TWO-SIDED: a shortfall means posts were missed, and
 *    a surplus means the count and the crawl disagree about the window.
 *    Both are a reason to look again.
 *
 * @param {object} input
 * @param {'api'|'browser'|'agent'} input.route
 * @param {boolean} input.reachedEnd - API: no next page; browser: scrolled past the window start
 * @param {string} [input.stopReason] - any stop signal means NOT complete
 * @param {number} input.seen
 * @param {number|null} [input.expected] - from the counts endpoint, when known
 * @param {number} [input.tolerance] - allowed disagreement, as a fraction
 * @returns {'complete'|'partial'|'blocked'}
 */
function windowVerdict(input) {
  if (input.stopReason) {
    // A stop that still reached the end is 'partial'; one that did not is
    // 'blocked', so a caller can tell "we stopped early" from "we stopped
    // at the boundary".
    return input.reachedEnd ? 'partial' : 'blocked';
  }
  if (!input.reachedEnd) return 'partial';
  if (Number.isFinite(input.expected) && input.expected > 0) {
    const tolerance = Number.isFinite(input.tolerance) ? input.tolerance : 0.02;
    const drift = Math.abs(input.seen - input.expected);
    if (drift > input.expected * tolerance) return 'partial';
  }
  return 'complete';
}

module.exports = {
  API_QUERY_KINDS,
  BROWSER_QUERY_KIND,
  addUnit,
  browserSearchUrl,
  planWindows,
  shift,
  splitWindow,
  uncoveredRanges,
  windowVerdict,
};
