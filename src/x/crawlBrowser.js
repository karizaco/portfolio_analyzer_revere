'use strict';

/**
 * Route B1: the scripted browser crawler.
 *
 * It drives a browser with a persistent profile that holds the user's own
 * X session (`browser-import-cookies`), opens the X search page for one date
 * window at a time (`from:<handle> since:… until:…`, Latest tab), scrolls at
 * human pace, and CAPTURES the GraphQL timeline responses the web app
 * fetches -- the same structured posts the API returns. The page itself is
 * read only as a fallback.
 *
 * HEADLESS, BY THE USER'S CHOICE (2026-11-22): the crawl runs with no window
 * on the user's screen. A headless Edge announces itself as `HeadlessChrome`
 * in its user agent and in nothing else that was measured -- the client
 * hints (`Chromium 158 | Not.A/Brand 24 | Microsoft Edge 158`), the
 * `sec-ch-ua` header and `navigator.webdriver` (false) are those of a
 * headed one -- so the user agent is set to the browser's OWN string with
 * that one word corrected. `browser-login` stays headed: a person types there.
 *
 * WHAT KEEPS THE USER'S ACCOUNT SAFE (docs/x-source-plan.md §3.5)
 *
 * - one crawl per session (src/x/lock.js), and at most TWO tabs in it
 *   (src/x/browser/pacing.js, the user's cap);
 * - jittered pauses between scrolls and a cool-down between windows;
 * - X's own allowance read from every search response, and the scrolling
 *   held at the reserve until it resets -- slowing down before a 429;
 * - a hard STOP on a login wall, a challenge, a 429, an error page or a
 *   locked account (src/x/browser/signals.js), with the window left
 *   resumable and the reason recorded -- never a tighter retry;
 * - a per-session window cap.
 *
 * Every captured response is saved raw before it is normalized, and posts
 * are imported as they arrive, so an interrupted crawl keeps what it saw.
 */

const { DENSE_WINDOW_POSTS, planWindows, browserSearchUrl, splitDenseWindows, uncoveredRanges, windowVerdict, BROWSER_QUERY_KIND, BROWSER_SPLIT_KINDS } = require('./windows');
const { createScrollTracker, jitter } = require('./browser/scroll');
const { detectStopSignal, isEmptyResult } = require('./browser/signals');
const { defaultProfileDir, isInsideRepo, stripQuery, timelineOperation } = require('./browser/capture');
const { extractVisibleArticles, readPageState } = require('./browser/domExtract');
const { normalizeEnvelope, saveRaw } = require('./rawStore');
const { findUserIds, timelineTerminated } = require('./normalizeGraphql');
const { importRecords, filteredTotal } = require('./importer');
const { acquireLock } = require('./lock');
const { ensureSessionCookies } = require('./browser/cookies');
const { clampConcurrency, createRateGate } = require('./browser/pacing');
const registry = require('./registry');

const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A navigation or input that threw: no connection, a timeout, or a computer
 * that slept with the page open. Retryable, and never a natural end.
 *
 * @param {Error} error
 * @returns {{reason: string, message: string, retryAt: null}}
 */
function networkStop(error) {
  const detail = String((error && error.message) || error || '').split('\n')[0].slice(0, 160);
  return {
    reason: 'network_error',
    message: `a page could not load (${detail}); the connection dropped or the computer slept. Resume once it is back.`,
    retryAt: null,
  };
}

/**
 * The launch options of the persistent, headed browser.
 *
 * Playwright starts Chromium with `--enable-automation`, which sets
 * `navigator.webdriver` and shows the "controlled by automated software"
 * bar -- and X answered the first live login from such a browser with
 * "We've temporarily limited your login" (2026-11-21). The crawler is a
 * person-paced reader of public posts, and nothing here is meant to look
 * like anything else; the flag only made X treat a normal session as a bot.
 *
 * A headless launch also carries the corrected user agent (see the header)
 * and a desktop-sized screen, because a headless screen is the viewport's
 * size and no desktop monitor is 1280x950.
 *
 * @param {string|undefined} channel - 'msedge', 'chrome' or undefined (bundled)
 * @param {object} [extra]
 * @param {boolean} [extra.headless]
 * @param {string} [extra.userAgent]
 * @returns {object}
 */
function launchOptions(channel, extra = {}) {
  const options = {
    headless: Boolean(extra.headless),
    channel,
    viewport: { width: 1280, height: 950 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [...LAUNCH_ARGS],
  };
  if (extra.headless) {
    options.screen = { width: 1920, height: 1080 };
    if (extra.userAgent) options.userAgent = extra.userAgent;
  }
  return options;
}

/**
 * The user agent a headed copy of the same browser sends: the headless one
 * with `HeadlessChrome/` read as `Chrome/`, everything else untouched.
 *
 * @param {string} userAgent
 * @returns {string}
 */
function headlessUserAgent(userAgent) {
  return String(userAgent || '').replace(/HeadlessChrome\//g, 'Chrome/');
}

/**
 * Ask the browser itself what it is, in a throwaway headless instance that
 * touches no profile, so the version in the corrected user agent is the
 * installed one and never a constant that goes stale.
 */
async function probeUserAgent(chromium, channel) {
  const browser = await chromium.launch({
    headless: true, channel, ignoreDefaultArgs: ['--enable-automation'], args: [...LAUNCH_ARGS],
  });
  try {
    const page = await browser.newPage();
    return headlessUserAgent(await page.evaluate(() => navigator.userAgent));
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Launch the persistent browser: headed by default, headless on request.
 *
 * @param {object} options
 * @param {string} [options.profileDir]
 * @param {boolean} [options.headless]
 * @param {Function} [options.log]
 */
async function launchBrowser(options = {}) {
  // eslint-disable-next-line global-require
  const { chromium } = require('playwright');
  const profileDir = options.profileDir || defaultProfileDir();
  if (isInsideRepo(profileDir)) {
    throw new Error(`the browser profile ${profileDir} is inside the repository; it holds your X session cookies. `
      + 'Set X_BROWSER_PROFILE_DIR to a folder outside the repository.');
  }
  const log = options.log || (() => {});
  const headless = Boolean(options.headless);
  let lastError = null;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const userAgent = headless ? await probeUserAgent(chromium, channel) : undefined;
      // eslint-disable-next-line no-await-in-loop
      const context = await chromium.launchPersistentContext(profileDir, launchOptions(channel, { headless, userAgent }));
      log(`[x-browser] launched ${channel || 'bundled chromium'}${headless ? ' (headless, no window)' : ''} with profile ${profileDir}`);
      return context;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not launch a browser: ${lastError && lastError.message}`);
}

async function pageState(page) {
  try {
    return await page.evaluate(readPageState);
  } catch (_) {
    return { url: page.url(), title: '', bodyText: '', hasChallengeFrame: false, articles: 0 };
  }
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => Boolean(document.querySelector(
      '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]',
    )));
  } catch (_) {
    return false;
  }
}

/**
 * Open the browser and wait for the user to log in by hand.
 *
 * The crawler never types a password: the session lives in the profile.
 */
async function browserLogin(options = {}) {
  const log = options.log || console.log;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const context = await launchBrowser({ ...options, log });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('[x-browser] Log into X in the opened window. This waits up to '
      + `${Math.round(timeoutMs / 60000)} minutes and closes by itself once you are in.`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await isLoggedIn(page)) {
        log('[x-browser] logged in; the session is saved in the profile.');
        return { loggedIn: true };
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000);
    }
    return { loggedIn: false };
  } finally {
    await context.close();
  }
}

/**
 * Carry an existing X session into the crawler's profile, and check it.
 *
 * The user is logged in to X in their own browser; the session cookies
 * (from .env or a Cookie-Editor export, see src/x/browser/cookies.js) are
 * added to the persistent profile, and the home page tells whether X
 * accepts them. No password is ever typed, and no value is ever logged.
 *
 * @param {object} options
 * @param {object[]} options.cookies
 * @param {string} [options.profileDir]
 * @param {Function} [options.log]
 * @returns {Promise<{loggedIn: boolean, injected: boolean, stop_reason: string, message: string}>}
 */
async function importSession(options) {
  const log = options.log || console.log;
  const context = await launchBrowser({ profileDir: options.profileDir, log, headless: options.headless });
  try {
    const result = await ensureSessionCookies(context, options.cookies);
    log(`[x-browser] ${result.reason}`);
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let loggedIn = false;
    for (let i = 0; i < 10 && !loggedIn; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(2000);
      // eslint-disable-next-line no-await-in-loop
      loggedIn = await isLoggedIn(page);
    }
    const signal = loggedIn ? { stop: false, reason: '', message: '' } : detectStopSignal(await pageState(page));
    return {
      loggedIn,
      injected: result.injected,
      stop_reason: loggedIn ? '' : (signal.reason || 'login_required'),
      message: loggedIn ? 'X accepts the session' : (signal.message || 'X did not accept the session cookies'),
    };
  } finally {
    await context.close();
  }
}

/**
 * Crawl an account's pending browser windows.
 *
 * @param {object} options
 * @returns {Promise<object>} the stop report
 */
async function crawlBrowserWindows(options) {
  const {
    catalogDb, indexDb, runId, rawDir, archiveRoot,
  } = options;
  const log = options.log || console.log;
  let account = registry.getAccount(catalogDb, options.account.account_id);
  const until = options.until || new Date().toISOString().slice(0, 10);
  const since = options.since || account.backfill_since || '2010-01-01';
  const maxWindows = options.maxWindows || 6;
  const pause = options.pauseMs || [1500, 3500];
  const cooldown = options.cooldownMs || [20000, 45000];
  const waitOnChallengeMs = options.waitOnChallengeMs ?? 5 * 60 * 1000;
  const stagger = options.staggerMs || [10000, 25000];
  // A test drives the loop with a fake browser and an instant clock.
  const nap = options.sleep || sleep;

  // A re-plan is reduced to the part no window covers yet, exactly as the
  // API route does it: a window that exists is covering its own range,
  // and a window that is COMPLETE is never crawled again.
  //
  // And a DENSE window is split first, because a long scroll is where the
  // challenges and the rate limits bite. The density comes from the
  // windows this account has already crawled -- the browser route has no
  // count endpoint, so that is the only estimate there is.
  //
  // THE QUERY: `all_own` (one search, the default) or `split` (the
  // originals and the self-replies as two searches, without the replies to
  // other people that `all_own` fetches only for the importer to drop).
  // Switching an account to `split` retires its UNFINISHED `all_own`
  // windows; a COMPLETE `all_own` window still covers its range for both
  // split kinds, so nothing done is fetched again.
  const split = options.queryMode === 'split';
  const kinds = split ? BROWSER_SPLIT_KINDS : [BROWSER_QUERY_KIND];
  if (split) {
    const dropped = registry.dropUnfinishedWindows(catalogDb, account.account_id, 'browser', BROWSER_QUERY_KIND);
    if (dropped) log(`[x-browser] @${account.handle}: ${dropped} unfinished all_own window(s) replaced by the split queries`);
  }
  const doneByAllOwn = split
    ? registry.windowRanges(catalogDb, account.account_id, BROWSER_QUERY_KIND, 'browser', { completeOnly: true })
    : [];
  let pending = [];
  for (const kind of kinds) {
    const existing = [...registry.windowRanges(catalogDb, account.account_id, kind, 'browser'), ...doneByAllOwn]
      .sort((a, b) => a.start.localeCompare(b.start));
    const density = registry.windowDensity(catalogDb, account.account_id, 'browser', kind);
    const planned = splitDenseWindows(planWindows({ since, until, unit: options.unit || 'month' }), {
      postsPerDay: density, threshold: DENSE_WINDOW_POSTS, unit: 'week',
    });
    if (density > 0) {
      log(`[x-browser] @${account.handle} ${kind}: ${density.toFixed(1)} posts a day observed; `
        + `a window over ${DENSE_WINDOW_POSTS} posts is split into weeks`);
    }
    const effective = [];
    for (const window of planned) {
      for (const part of uncoveredRanges(existing, window.start, window.end)) {
        effective.push({ start: part.start, end: part.end });
      }
    }
    registry.ensureWindows(catalogDb, account.account_id, 'browser', kind, effective);
    pending.push(...registry.pendingWindows(catalogDb, account.account_id, 'browser', kind));
  }
  pending = pending
    .filter((window) => window.window_start >= since && window.window_end <= until)
    .filter((window) => !(options.windowId && window.id !== Number(options.windowId)))
    // Newest first, and a range's two split queries next to each other.
    .sort((a, b) => b.window_start.localeCompare(a.window_start) || a.query_kind.localeCompare(b.query_kind));
  registry.updateRun(catalogDb, runId, { windows_planned: pending.length });

  const report = {
    route: 'browser', handle: account.handle, status: 'ok', stop_reason: '', message: '', retry_at: null,
    windows: [], posts_seen: 0, posts_new: 0, posts_filtered: 0, posts_other_user: 0, run_id: runId,
  };
  if (!pending.length) {
    report.message = 'no pending browser windows in this range';
    return report;
  }

  const concurrency = clampConcurrency(options.concurrency);
  const lock = acquireLock({ file: options.lockFile, label: `browser @${account.handle}${concurrency > 1 ? ` (${concurrency} tabs)` : ''}` });
  const context = options.launch
    ? await options.launch()
    : await launchBrowser({ profileDir: options.profileDir, log, headless: options.headless });
  // X's search allowance belongs to the ACCOUNT, so the tabs share one gate.
  const rateGate = createRateGate({ reserve: options.rateReserve, maxWaitMs: options.maxRateWaitMs });
  // What the tabs share: the first stop (it ends the session for both), a
  // hold while one tab waits out a challenge, and the raw-capture counter.
  const shared = { stop: null, hold: false, captureIndex: 0 };
  try {
    // The session the user pasted into .env wins over whatever the profile
    // held: it is the explicit answer, and a stale profile cookie would
    // otherwise read as "login required".
    if (options.sessionCookies && options.sessionCookies.length) {
      const injected = await ensureSessionCookies(context, options.sessionCookies);
      if (injected.injected) log(`[x-browser] ${injected.reason}`);
    }
    const first = context.pages()[0] || await context.newPage();
    const firstTap = attachCapture(first, rateGate);

    try {
      await first.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      const stop = networkStop(error);
      Object.assign(report, { status: 'blocked', stop_reason: stop.reason, message: stop.message });
      return report;
    }
    await nap(3000);
    const signal = detectStopSignal({ ...(await pageState(first)), graphqlStatus: firstTap.lastStatus, rateLimitReset: firstTap.rateLimitReset });
    if (signal.stop || !(await isLoggedIn(first))) {
      const reason = signal.stop ? signal : detectStopSignal({ url: 'https://x.com/i/flow/login' });
      Object.assign(report, { status: 'blocked', stop_reason: reason.reason, message: reason.message });
      return report;
    }

    // The handle -> user id map. The account's own id is known once the
    // account has been looked up; the web app's own user lookup fills it
    // in when it has not -- and without a user id the page-scrape route
    // cannot produce a record at all.
    const knownUsers = new Map(account.user_id ? [[account.handle, account.user_id]] : []);

    /**
     * Hold until X's search allowance allows another request. Returns a
     * stop when the wait is longer than the gate will sit out.
     */
    async function respectAllowance() {
      const wait = rateGate.waitMs(Date.now());
      if (!wait) return null;
      const allowance = rateGate.snapshot();
      if (wait > rateGate.maxWaitMs) {
        return {
          reason: 'rate_limited',
          message: `X's search allowance is spent until ${allowance.reset_at}; resume after it, not sooner.`,
          retryAt: allowance.reset_at,
        };
      }
      if (rateGate.announce()) {
        log(`[x-browser] X's search allowance is down to ${allowance.remaining} of ${allowance.limit}; `
          + `holding ${Math.round(wait / 1000)} s until it resets (${allowance.reset_at})`);
      }
      await nap(wait + jitter(2000, 8000));
      return null;
    }

    /** One window, on one tab, from the search page to its verdict. */
    async function crawlWindow(page, tap, window) {
      const before = await respectAllowance();
      if (before) {
        // Stopped before the window started: it stays pending, untouched.
        if (!shared.stop) shared.stop = before;
        return;
      }
      registry.updateWindow(catalogDb, window.id, { status: 'running', last_run_id: runId, stop_reason: '' });
      const tracker = createScrollTracker({ windowStart: window.window_start, maxScrolls: options.maxScrolls });
      let capturedHere = 0;
      let usedDom = false;
      let windowStop = null;
      let progress = { done: false, reason: '', reachedEnd: false };
      tap.queue.length = 0;
      tap.lastStatus = null;
      const kind = window.query_kind || BROWSER_QUERY_KIND;
      log(`[x-browser] @${account.handle} ${window.window_start}..${window.window_end}${kind === BROWSER_QUERY_KIND ? '' : ` (${kind})`}`);
      // A page that cannot load (no connection; a computer waking from sleep
      // with its sockets gone) is a STOP: the window is left `blocked`, which
      // is resumable, and a later session crawls it again.
      try {
        await page.goto(browserSearchUrl(account.handle, { start: window.window_start, end: window.window_end }, kind),
          { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (error) {
        windowStop = networkStop(error);
      }
      await nap(jitter(3000, 5000));

      while (!windowStop) {
        const batch = tap.queue.splice(0, tap.queue.length);
        const records = [];
        let terminated = false;
        for (const envelope of batch) {
          shared.captureIndex += 1;
          saveRaw(rawDir, `${window.window_start}_${String(shared.captureIndex).padStart(5, '0')}_${envelope.operation}`, envelope);
          if (envelope.operation === 'UserByScreenName') {
            // The user lookup carries the numeric id the DOM route needs.
            for (const [handle, id] of findUserIds(envelope.body)) knownUsers.set(handle, id);
            continue;
          }
          // X's own "nothing more below": the search window's natural end.
          if (envelope.operation === 'SearchTimeline' && timelineTerminated(envelope.body)) terminated = true;
          records.push(...normalizeEnvelope(envelope).records);
          capturedHere += 1;
        }
        // The web app's own user lookup can resolve the account's identity
        // where nothing else could -- so it is PINNED, and a disagreement
        // with what the catalog already knows is refused rather than
        // silently merged.
        const resolved = knownUsers.get(String(account.handle).toLowerCase());
        if (resolved && resolved !== account.user_id) {
          try {
            registry.resolveUserId(catalogDb, account.account_id, resolved, account.handle);
            account = registry.getAccount(catalogDb, account.account_id);
          } catch (error) {
            log(`[x-browser] ${error.message}`);
          }
        }
        let state = await pageState(page);
        if (!capturedHere && tracker.scrolls >= 3 && state.articles > 0 && !usedDom) {
          // No GraphQL for this window: fall back to reading the page.
          usedDom = true;
          log('[x-browser] no timeline data captured; reading the page instead (partial fidelity)');
        }
        if (usedDom) {
          const articles = await page.evaluate(extractVisibleArticles).catch(() => []);
          const envelope = { route: 'web_dom', operation: 'dom', url: page.url(), status: 200, fetched_at: new Date().toISOString(), body: articles };
          shared.captureIndex += 1;
          saveRaw(rawDir, `${window.window_start}_${String(shared.captureIndex).padStart(5, '0')}_dom`, envelope);
          records.push(...normalizeEnvelope(envelope, { knownUsers }).records);
        }

        // The import is synchronous, so two tabs can never interleave inside
        // one batch: each lands whole in the archive and the index.
        const imported = records.length
          ? importRecords({ catalogDb, indexDb, account, records, archiveRoot })
          : null;
        account = registry.getAccount(catalogDb, account.account_id);
        if (imported) {
          report.posts_seen += imported.seen;
          report.posts_new += imported.new;
          report.posts_filtered += filteredTotal(imported.filtered);
          // Posts of another user id are dropped by the policy, and a batch
          // of them is what a stale handle looks like. Reported, so a crawl
          // that dropped everything does not look like one that found none.
          report.posts_other_user += imported.otherUser;
          registry.addToRun(catalogDb, runId, {
            posts_seen: imported.seen, posts_new: imported.new, posts_updated: imported.updated,
            posts_filtered: filteredTotal(imported.filtered), posts_other_user: imported.otherUser,
          });
          if (imported.otherUser) {
            log(`[x-browser] ${imported.otherUser} post(s) belong to another user id and were not imported`);
          }
          if (imported.identityError) log(`[x-browser] ${imported.identityError}`);
        }
        const own = records.filter((record) => record.user_id === account.user_id);
        progress = tracker.observe(own, { terminated, atBottom: state.atBottom });

        let signal = detectStopSignal({ ...state, graphqlStatus: tap.lastStatus, rateLimitReset: tap.rateLimitReset });
        if (signal.stop && signal.reason === 'challenge' && waitOnChallengeMs > 0) {
          // The other tab waits too: a challenge is the session's, not the page's.
          shared.hold = true;
          log(`[x-browser] ${signal.message} Waiting up to ${Math.round(waitOnChallengeMs / 60000)} min.`);
          const deadline = Date.now() + waitOnChallengeMs;
          while (signal.stop && Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop
            await nap(5000);
            // eslint-disable-next-line no-await-in-loop
            state = await pageState(page);
            signal = detectStopSignal({ ...state, graphqlStatus: null, rateLimitReset: null });
          }
          shared.hold = false;
        }
        if (signal.stop) {
          windowStop = signal;
          break;
        }
        if (isEmptyResult(state.bodyText) && !own.length && tracker.scrolls >= 2) {
          // A blank page is a STOP, not a natural end: X may simply have
          // failed to render, and a window recorded as covered because of
          // it would never be crawled again.
          progress = { done: true, reason: 'empty', reachedEnd: false };
        }
        if (progress.done) break;
        if (tracker.scrolls >= 3 && !capturedHere && !state.articles && !isEmptyResult(state.bodyText)) {
          windowStop = { reason: 'no_graphql', message: 'nothing on the page and nothing captured', retryAt: null };
          break;
        }

        // The other tab hit a challenge: wait with it. It stopped the
        // session: this window is left resumable, never recorded as covered.
        while (shared.hold && !shared.stop) {
          // eslint-disable-next-line no-await-in-loop
          await nap(2000);
        }
        if (shared.stop) {
          windowStop = { reason: 'sibling_stop', message: 'the other tab stopped the session', retryAt: null };
          break;
        }
        const held = await respectAllowance();
        if (held) {
          windowStop = held;
          break;
        }

        try {
          await page.mouse.wheel(0, jitter(1200, 1800));
        } catch (error) {
          windowStop = networkStop(error);
          break;
        }
        await nap(jitter(pause[0], pause[1]));
      }

      const verdict = windowVerdict({
        route: 'browser', reachedEnd: progress.reachedEnd, stopReason: windowStop ? windowStop.reason : '',
        seen: tracker.seen, expected: null,
      });
      registry.updateWindow(catalogDb, window.id, {
        status: verdict,
        posts_seen: tracker.seen,
        oldest_seen: tracker.oldest || '',
        stop_reason: windowStop ? windowStop.reason : (progress.reason === 'scroll_cap' ? 'scroll_cap' : (usedDom ? 'dom_fallback' : '')),
      });
      if (verdict === 'complete') registry.addToRun(catalogDb, runId, { windows_complete: 1 });
      report.windows.push({
        id: window.id, start: window.window_start, end: window.window_end, kind, status: verdict,
        posts: tracker.seen, scrolls: tracker.scrolls, end_reason: windowStop ? windowStop.reason : progress.reason,
        fidelity: usedDom ? 'partial' : 'full',
      });
      log(`[x-browser]   -> ${window.window_start}..${window.window_end} ${verdict}: ${tracker.seen} own posts `
        + `in ${tracker.scrolls} scrolls (${progress.reason || windowStop.reason})`);
      // The first real stop ends the session for every tab.
      if (windowStop && windowStop.reason !== 'sibling_stop' && !shared.stop) shared.stop = windowStop;
    }

    const todo = pending.slice(0, maxWindows);
    let next = 0;
    const take = () => (shared.stop || next >= todo.length ? null : todo[next++]);
    async function lane(page, tap, slot) {
      // The second tab starts a little later, as a person opening it would.
      if (slot > 0) await nap(jitter(stagger[0], stagger[1]));
      for (let window = take(); window; window = take()) {
        // eslint-disable-next-line no-await-in-loop
        await crawlWindow(page, tap, window);
        if (shared.stop) return;
        // eslint-disable-next-line no-await-in-loop
        if (next < todo.length) await nap(jitter(cooldown[0], cooldown[1]));
      }
    }
    const lanes = [lane(first, firstTap, 0)];
    if (concurrency > 1 && todo.length > 1) {
      const second = await context.newPage();
      lanes.push(lane(second, attachCapture(second, rateGate), 1));
    }
    await Promise.all(lanes);

    report.windows.sort((a, b) => a.start.localeCompare(b.start));
    report.concurrency = lanes.length;
    report.allowance = rateGate.snapshot();
    if (shared.stop) {
      Object.assign(report, {
        status: shared.stop.reason === 'account_locked' ? 'failed' : 'blocked',
        stop_reason: shared.stop.reason,
        message: shared.stop.message,
        retry_at: shared.stop.retryAt || null,
      });
    } else if (pending.length > maxWindows) {
      report.message = `${pending.length - maxWindows} window(s) left for the next session (cap ${maxWindows} per session)`;
    }
    return report;
  } finally {
    await context.close().catch(() => {});
    lock.release();
  }
}

/**
 * Listen to one tab's GraphQL timeline responses: queue the bodies, note
 * the last status, and feed every search response's allowance to the gate.
 *
 * @param {object} page
 * @param {object} rateGate
 * @returns {{queue: object[], lastStatus: number|null, rateLimitReset: string|null}}
 */
function attachCapture(page, rateGate) {
  const tap = { queue: [], lastStatus: null, rateLimitReset: null };
  page.on('response', async (res) => {
    const operation = timelineOperation(res.url());
    if (!operation) return;
    const status = res.status();
    tap.lastStatus = status;
    const headers = res.headers();
    if (operation === 'SearchTimeline') rateGate.observe(headers);
    if (status === 429) {
      tap.rateLimitReset = headers['x-rate-limit-reset'] || null;
      return;
    }
    if (status !== 200) return;
    try {
      const body = await res.json();
      tap.queue.push({
        route: 'web_graphql', operation, url: stripQuery(res.url()), status, fetched_at: new Date().toISOString(), body,
      });
    } catch (_) { /* a body that is not JSON carries no posts */ }
  });
  return tap;
}

module.exports = {
  attachCapture, browserLogin, crawlBrowserWindows, headlessUserAgent, importSession, launchBrowser, launchOptions,
};
