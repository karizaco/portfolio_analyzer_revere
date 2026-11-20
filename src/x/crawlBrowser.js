'use strict';

/**
 * Route B1: the scripted browser crawler.
 *
 * It drives a HEADED browser with a persistent profile the user logged into
 * by hand (`browser-login`), opens the X search page for one date window at
 * a time (`from:<handle> since:… until:…`, Latest tab), scrolls at human
 * pace, and CAPTURES the GraphQL timeline responses the web app fetches --
 * the same structured posts the API returns. The page itself is read only
 * as a fallback.
 *
 * WHAT KEEPS THE USER'S ACCOUNT SAFE (docs/x-source-plan.md §3.5)
 *
 * - headed, never headless; one crawl per session (src/x/lock.js);
 * - jittered pauses between scrolls and a cool-down between windows;
 * - a hard STOP on a login wall, a challenge, a 429, an error page or a
 *   locked account (src/x/browser/signals.js), with the window left
 *   resumable and the reason recorded -- never a tighter retry;
 * - a per-session window cap.
 *
 * Every captured response is saved raw before it is normalized, and posts
 * are imported as they arrive, so an interrupted crawl keeps what it saw.
 */

const { planWindows, browserSearchUrl, uncoveredRanges, windowVerdict, BROWSER_QUERY_KIND } = require('./windows');
const { createScrollTracker, jitter } = require('./browser/scroll');
const { detectStopSignal, isEmptyResult } = require('./browser/signals');
const { defaultProfileDir, isInsideRepo, stripQuery, timelineOperation } = require('./browser/capture');
const { extractVisibleArticles, readPageState } = require('./browser/domExtract');
const { normalizeEnvelope, saveRaw } = require('./rawStore');
const { importRecords, filteredTotal } = require('./importer');
const { acquireLock } = require('./lock');
const registry = require('./registry');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch the persistent, headed browser.
 *
 * @param {object} options
 * @param {string} [options.profileDir]
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
  let lastError = null;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel,
        viewport: { width: 1280, height: 950 },
      });
      log(`[x-browser] launched ${channel || 'bundled chromium'} with profile ${profileDir}`);
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

  // A re-plan is reduced to the part no window covers yet, exactly as the
  // API route does it: a window that exists is covering its own range,
  // and a window that is COMPLETE is never crawled again.
  const existing = registry.windowRanges(catalogDb, account.account_id, BROWSER_QUERY_KIND, 'browser');
  const effective = [];
  for (const window of planWindows({ since, until, unit: options.unit || 'month' })) {
    for (const part of uncoveredRanges(existing, window.start, window.end)) {
      effective.push({ start: part.start, end: part.end });
    }
  }
  registry.ensureWindows(catalogDb, account.account_id, 'browser', BROWSER_QUERY_KIND, effective);
  const pending = registry.pendingWindows(catalogDb, account.account_id, 'browser', BROWSER_QUERY_KIND)
    .filter((window) => window.window_start >= since && window.window_end <= until)
    .filter((window) => !(options.windowId && window.id !== Number(options.windowId)));
  registry.updateRun(catalogDb, runId, { windows_planned: pending.length });

  const report = {
    route: 'browser', handle: account.handle, status: 'ok', stop_reason: '', message: '', retry_at: null,
    windows: [], posts_seen: 0, posts_new: 0, posts_filtered: 0, posts_other_user: 0, run_id: runId,
  };
  if (!pending.length) {
    report.message = 'no pending browser windows in this range';
    return report;
  }

  const lock = acquireLock({ label: `browser @${account.handle}` });
  const context = await launchBrowser({ profileDir: options.profileDir, log });
  const queue = [];
  let lastStatus = null;
  let rateLimitReset = null;
  try {
    const page = context.pages()[0] || await context.newPage();
    page.on('response', async (res) => {
      const operation = timelineOperation(res.url());
      if (!operation) return;
      const status = res.status();
      lastStatus = status;
      if (status === 429) {
        rateLimitReset = res.headers()['x-rate-limit-reset'] || null;
        return;
      }
      if (status !== 200) return;
      try {
        const body = await res.json();
        queue.push({
          route: 'web_graphql', operation, url: stripQuery(res.url()), status, fetched_at: new Date().toISOString(), body,
        });
      } catch (_) { /* a body that is not JSON carries no posts */ }
    });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    let signal = detectStopSignal({ ...(await pageState(page)), graphqlStatus: lastStatus, rateLimitReset });
    if (signal.stop || !(await isLoggedIn(page))) {
      const reason = signal.stop ? signal : detectStopSignal({ url: 'https://x.com/i/flow/login' });
      Object.assign(report, { status: 'blocked', stop_reason: reason.reason, message: reason.message });
      return report;
    }

    let captureIndex = 0;
    for (const window of pending.slice(0, maxWindows)) {
      registry.updateWindow(catalogDb, window.id, { status: 'running', last_run_id: runId, stop_reason: '' });
      const tracker = createScrollTracker({ windowStart: window.window_start, maxScrolls: options.maxScrolls });
      let capturedHere = 0;
      let usedDom = false;
      let windowStop = null;
      let progress = { done: false, reason: '', reachedEnd: false };
      queue.length = 0;
      lastStatus = null;
      log(`[x-browser] @${account.handle} ${window.window_start}..${window.window_end}`);
      await page.goto(browserSearchUrl(account.handle, { start: window.window_start, end: window.window_end }),
        { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(jitter(3000, 5000));

      for (;;) {
        const batch = queue.splice(0, queue.length);
        const records = [];
        for (const envelope of batch) {
          captureIndex += 1;
          saveRaw(rawDir, `${window.window_start}_${String(captureIndex).padStart(5, '0')}_${envelope.operation}`, envelope);
          records.push(...normalizeEnvelope(envelope).records);
          capturedHere += 1;
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
          captureIndex += 1;
          saveRaw(rawDir, `${window.window_start}_${String(captureIndex).padStart(5, '0')}_dom`, envelope);
          const known = new Map(account.user_id ? [[account.handle, account.user_id]] : []);
          records.push(...normalizeEnvelope(envelope, { knownUsers: known }).records);
        }

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
        progress = tracker.observe(own);

        signal = detectStopSignal({ ...state, graphqlStatus: lastStatus, rateLimitReset });
        if (signal.stop && signal.reason === 'challenge' && waitOnChallengeMs > 0) {
          log(`[x-browser] ${signal.message} Waiting up to ${Math.round(waitOnChallengeMs / 60000)} min.`);
          const deadline = Date.now() + waitOnChallengeMs;
          while (signal.stop && Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(5000);
            // eslint-disable-next-line no-await-in-loop
            state = await pageState(page);
            signal = detectStopSignal({ ...state, graphqlStatus: null, rateLimitReset: null });
          }
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

        await page.mouse.wheel(0, jitter(1200, 1800));
        await sleep(jitter(pause[0], pause[1]));
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
        id: window.id, start: window.window_start, end: window.window_end, status: verdict,
        posts: tracker.seen, scrolls: tracker.scrolls, end_reason: windowStop ? windowStop.reason : progress.reason,
        fidelity: usedDom ? 'partial' : 'full',
      });
      log(`[x-browser]   -> ${verdict}: ${tracker.seen} own posts in ${tracker.scrolls} scrolls (${progress.reason || windowStop.reason})`);

      if (windowStop) {
        Object.assign(report, {
          status: windowStop.reason === 'account_locked' ? 'failed' : 'blocked',
          stop_reason: windowStop.reason,
          message: windowStop.message,
          retry_at: windowStop.retryAt || null,
        });
        break;
      }
      await sleep(jitter(cooldown[0], cooldown[1]));
    }
    if (report.status === 'ok' && pending.length > maxWindows) {
      report.message = `${pending.length - maxWindows} window(s) left for the next session (cap ${maxWindows} per session)`;
    }
    return report;
  } finally {
    await context.close().catch(() => {});
    lock.release();
  }
}

module.exports = { browserLogin, crawlBrowserWindows, launchBrowser };
