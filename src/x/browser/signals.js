'use strict';

/**
 * When must the browser crawler STOP?
 *
 * The browser route uses the user's own logged-in X session, so a mistake
 * here is paid by that account (rate limits, a challenge, a lock). The rule
 * is simple and pinned by test/xBrowserRoute.test.js: on any of these the
 * crawler stops, records why, and never retries tighter.
 *
 * Adapted from x_unsub's detectCloudflareChallenge / detectBanSignals, plus
 * the GraphQL response status, which x_unsub could not see.
 */

const STOP_REASONS = {
  account_locked: { retryable: false, message: 'X says the account is locked or suspended. STOP everything and resolve it in the browser.' },
  login_required: { retryable: true, message: 'Not logged in. Run `node tools/runXPipeline.js browser-login` and log in by hand.' },
  challenge: { retryable: true, message: 'X is showing a challenge. Solve it in the open browser window, then resume.' },
  rate_limited: { retryable: true, message: 'X rate-limited the session. Wait for the reset before resuming; do not retry sooner.' },
  x_error_page: { retryable: true, message: 'X showed "Something went wrong". Pause, then resume.' },
  no_graphql: { retryable: true, message: 'No timeline data was captured. X may have changed its web app; diagnose with the agentic prompt.' },
};

/**
 * Classify the page state.
 *
 * @param {object} state
 * @param {string} [state.url]
 * @param {string} [state.title]
 * @param {string} [state.bodyText]
 * @param {boolean} [state.hasChallengeFrame]
 * @param {number|null} [state.graphqlStatus] - the last timeline response status
 * @param {string|null} [state.rateLimitReset] - epoch seconds, from x-rate-limit-reset
 * @returns {{stop: boolean, reason: string, retryable: boolean, message: string, retryAt: string|null}}
 */
function detectStopSignal(state) {
  const url = String(state.url || '');
  const title = String(state.title || '').toLowerCase();
  const body = String(state.bodyText || '').toLowerCase();
  const verdict = (reason, retryAt = null) => ({
    stop: true, reason, retryable: STOP_REASONS[reason].retryable, message: STOP_REASONS[reason].message, retryAt,
  });

  if (/your account (?:has been|is) (?:locked|suspended)|account suspended/.test(body)) return verdict('account_locked');
  // The login wall has more than one address. Measured 2026-11-20: a
  // logged-out search now redirects to /i/jf/onboarding/web?redirect_after_login=...
  // -- not to /login -- so the test is "any login/onboarding/signup page, or
  // any page carrying redirect_after_login".
  if (/(?:x|twitter)\.com\/(?:login|signup|i\/flow\/(?:login|signup)|i\/jf\/onboarding)|[?&]redirect_after_login=/.test(url)) {
    return verdict('login_required');
  }
  if (state.hasChallengeFrame || title.includes('just a moment') || /checking your browser|verify you are human|prove you're human/.test(body)) {
    return verdict('challenge');
  }
  if (state.graphqlStatus === 429 || /rate limit exceeded|too many requests/.test(body)) {
    const reset = Number(state.rateLimitReset);
    return verdict('rate_limited', Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null);
  }
  if (/something went wrong\.?\s*try reloading/.test(body)) return verdict('x_error_page');
  return { stop: false, reason: '', retryable: true, message: '', retryAt: null };
}

/**
 * Does the search page say there is nothing in this window at all?
 *
 * @param {string} bodyText
 * @returns {boolean}
 */
function isEmptyResult(bodyText) {
  return /no results for/i.test(String(bodyText || ''));
}

module.exports = { STOP_REASONS, detectStopSignal, isEmptyResult };
