'use strict';

// Route B (the browser): the stop signals, the scroll state machine, the
// capture filter, the profile location, the lock, and the page-scrape /
// agent normalizers. No browser is launched here; test/manual/ does that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectStopSignal, isEmptyResult } = require('../src/x/browser/signals');
const { createScrollTracker, jitter } = require('../src/x/browser/scroll');
const { defaultProfileDir, isInsideRepo, timelineOperation } = require('../src/x/browser/capture');
const { acquireLock } = require('../src/x/lock');
const { findUserIds, timelineTerminated } = require('../src/x/normalizeGraphql');
const { expectedForDensity, splitDenseWindows } = require('../src/x/windows');
const { normalizeAgentRecord, normalizeDomPost, isRepostContext, isPinnedContext } = require('../src/x/normalizeDom');
const { USER, idAt } = require('./fixtures/x/scenario');

const KNOWN = new Map([['testtrader', USER.id]]);

test('every stop signal stops the crawl with its own reason', () => {
  const cases = [
    [{ bodyText: 'Your account has been locked.' }, 'account_locked'],
    [{ url: 'https://x.com/i/flow/login?redirect_after_login=%2Fhome' }, 'login_required'],
    // The real redirect a logged-out search got on 2026-11-20 (live smoke test).
    [{ url: 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fsearch%3Fsrc%3Dtyped_query' }, 'login_required'],
    [{ hasChallengeFrame: true }, 'challenge'],
    [{ title: 'Just a moment...' }, 'challenge'],
    [{ graphqlStatus: 429, rateLimitReset: '1795000000' }, 'rate_limited'],
    [{ bodyText: 'Rate limit exceeded' }, 'rate_limited'],
    [{ bodyText: 'Something went wrong. Try reloading.' }, 'x_error_page'],
  ];
  for (const [state, reason] of cases) {
    const verdict = detectStopSignal(state);
    assert.equal(verdict.stop, true, JSON.stringify(state));
    assert.equal(verdict.reason, reason, JSON.stringify(state));
  }
  assert.equal(detectStopSignal({ graphqlStatus: 429, rateLimitReset: '1795000000' }).retryAt,
    new Date(1795000000 * 1000).toISOString(), 'the retry time is the reset header, not a guess');
  assert.equal(detectStopSignal({ url: 'https://x.com/search?q=from%3Ax', bodyText: 'Latest posts', graphqlStatus: 200 }).stop, false);
  assert.equal(isEmptyResult('No results for "from:x since:2020-01-01"'), true);
});

test('a window is done when it scrolled past its start, or ran dry -- a scroll cap is not an end', () => {
  const tracker = createScrollTracker({ windowStart: '2026-11-01', noNewLimit: 2, maxScrolls: 50 });
  assert.equal(tracker.observe([{ post_id: idAt('2026-11-10T10:00:00Z'), created_at: '2026-11-10T10:00:00.000Z' }]).done, false);
  const past = tracker.observe([{ post_id: idAt('2026-10-31T10:00:00Z'), created_at: '2026-10-31T10:00:00.000Z' }]);
  assert.deepEqual([past.done, past.reason, past.reachedEnd], [true, 'passed_start', true]);

  const dry = createScrollTracker({ windowStart: '2026-11-01', noNewLimit: 2 });
  dry.observe([{ post_id: '1', created_at: '2026-11-10T00:00:00Z' }]);
  dry.observe([{ post_id: '1', created_at: '2026-11-10T00:00:00Z' }]);
  assert.equal(dry.observe([]).reason, 'exhausted');

  const capped = createScrollTracker({ windowStart: '2026-11-01', noNewLimit: 99, maxScrolls: 2 });
  capped.observe([{ post_id: '1', created_at: '2026-11-10T00:00:00Z' }]);
  const cap = capped.observe([{ post_id: '2', created_at: '2026-11-09T00:00:00Z' }]);
  assert.deepEqual([cap.reason, cap.reachedEnd], ['scroll_cap', false]);
  assert.equal(jitter(1000, 2000, () => 0.5), 1500);
});

test('a stalled window is partial, not complete: a scroll that brought nothing is not the end', () => {
  // A scroll that brought nothing new is as likely to be a lazy-loading
  // hiccup as the end of the timeline, and completeness belongs to the
  // window -- so a stall recorded as coverage means the paid route will
  // never come back for it.
  const dry = createScrollTracker({ windowStart: '2026-11-01', noNewLimit: 2 });
  dry.observe([{ post_id: '1', created_at: '2026-11-10T00:00:00Z' }]);
  dry.observe([{ post_id: '1', created_at: '2026-11-10T00:00:00Z' }]);
  const stalled = dry.observe([]);
  assert.deepEqual([stalled.done, stalled.reason, stalled.reachedEnd], [true, 'exhausted', false],
    'a stall is a STOP, not a natural end');
});

test('a scroll still crossing loaded posts is not quiet: tall posts must not end the window early', () => {
  // @StockSavvyShay, 2026-11-21: one page of 20 tall posts, 7 wheel turns,
  // and the window was declared "exhausted" before the page's end -- where
  // the next page would have been requested -- was ever reached.
  const tracker = createScrollTracker({ windowStart: '2026-11-14', noNewLimit: 3 });
  tracker.observe([{ post_id: '1', created_at: '2026-11-20T00:00:00Z' }], { atBottom: false });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(tracker.observe([], { atBottom: false }).done, false, 'crossing loaded posts is not a stall');
  }
  tracker.observe([], { atBottom: true });
  tracker.observe([], { atBottom: true });
  assert.equal(tracker.observe([], { atBottom: true }).reason, 'exhausted', 'at the bottom, nothing new three times: a stall');
});

test('X\'s own end-of-results instruction is a search window\'s natural end', () => {
  // The first live window (2026-11-21): one post, then a page with only
  // the cursors and this instruction. A date-bounded search never reaches
  // past the window's start, so without it no search window could ever be
  // complete -- every one would stall into "exhausted".
  const lastPage = {
    data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
      { type: 'TimelineReplaceEntry', entry_id_to_replace: 'cursor-top-1', entry: { entryId: 'cursor-top-1', content: { cursorType: 'Top', value: 'T' } } },
      { type: 'TimelineReplaceEntry', entry_id_to_replace: 'cursor-bottom-0', entry: { entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: 'B' } } },
      { type: 'TimelineTerminateTimeline', direction: 'Bottom' },
    ] } } } },
  };
  assert.equal(timelineTerminated(lastPage), true);
  assert.equal(timelineTerminated({ data: { instructions: [{ type: 'TimelineTerminateTimeline', direction: 'Top' }] } }), false,
    'the TOP end says nothing about older results');
  assert.equal(timelineTerminated({ data: { instructions: [{ type: 'TimelineAddEntries', entries: [] }] } }), false);

  const tracker = createScrollTracker({ windowStart: '2026-11-01', noNewLimit: 6 });
  tracker.observe([{ post_id: idAt('2026-11-21T02:53:53Z'), created_at: '2026-11-21T02:53:53.000Z' }]);
  const end = tracker.observe([], { terminated: true });
  assert.deepEqual([end.done, end.reason, end.reachedEnd], [true, 'end_of_results', true]);
});

test('the capture matches GraphQL by operation name, whatever the rotating query id', () => {
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc123XYZ/SearchTimeline?variables=%7B%7D'), 'SearchTimeline');
  assert.equal(timelineOperation('https://x.com/i/api/graphql/zzz999/UserTweets?variables=1'), 'UserTweets');
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc/HomeTimeline?x=1'), null, 'not an operation we read');
  assert.equal(timelineOperation('https://x.com/home'), null);
  // The USER lookup carries the numeric id the page-scrape route needs,
  // and it is in the filter for that reason.
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc/UserByScreenName?variables=1'), 'UserByScreenName');
  // A media grid is not a timeline: it can carry a tweet from a moment
  // the window does not cover.
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc/UserMedia?variables=1'), null,
    'UserMedia is a media grid, not a timeline');
});

test('a dense window is split into weeks, from the density of the windows already crawled', () => {
  // A long scroll is where the challenges and the rate limits bite, so a
  // window expected to hold more than about 400 posts is cut up. The
  // browser route has no count endpoint, so the density comes from the
  // windows the account has already crawled.
  const plan = [{ start: '2026-01-01', end: '2026-02-01' }];
  assert.deepEqual(splitDenseWindows(plan, { postsPerDay: 1 }), plan, 'a sparse account is not split');
  assert.deepEqual(splitDenseWindows(plan, { postsPerDay: 0 }), plan, 'with no estimate, nothing is split');
  const split = splitDenseWindows(plan, { postsPerDay: 30, threshold: 400, unit: 'week' });
  assert.ok(split.length > 1, 'a dense window is split');
  // The plan is newest first, like every window plan here.
  const asc = [...split].sort((a, b) => (a.start < b.start ? -1 : 1));
  assert.equal(asc[0].start, '2026-01-01');
  assert.equal(asc[asc.length - 1].end, '2026-02-01', 'the split covers the same ground');
  for (let i = 1; i < asc.length; i += 1) {
    assert.equal(asc[i].start, asc[i - 1].end, 'the pieces are contiguous');
  }
  assert.equal(expectedForDensity({ start: '2026-01-01', end: '2026-02-01' }, 30), 930);
});

test('the web app\'s user lookup carries the numeric id the page scrape needs', () => {
  // A DOM record needs the user id, and the page carries only the handle
  // -- so without this response the whole page-scrape route is refused.
  const body = { data: { user_result: { result: { rest_id: '123456789', legacy: { screen_name: 'TestTrader' } } } } };
  const ids = findUserIds(body);
  assert.equal(ids.get('testtrader'), '123456789');
  const modern = { data: { user_result: { result: { rest_id: '987654321', core: { screen_name: 'OtherGuy' } } } } };
  assert.equal(findUserIds(modern).get('otherguy'), '987654321');
});

test('the browser profile (it holds the X session) lives outside the repository by default', () => {
  const dir = defaultProfileDir({ LOCALAPPDATA: os.tmpdir() });
  assert.equal(isInsideRepo(dir), false);
  assert.equal(isInsideRepo(defaultProfileDir({})), false);
  assert.equal(isInsideRepo(path.join(__dirname, '..', 'data', 'profile')), true);
});

test('only one crawl per X session: a live holder refuses a second, a dead one is taken over', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'x-lock-')), '.browser.lock');
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(child.stdout);
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid, started_at: 'earlier' }));
  const lock = acquireLock({ file, label: 'test' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'a stale lock is taken over');
  lock.release();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, started_at: 'now' }));
  assert.throws(() => acquireLock({ file }), /another X crawl is running/);
});

test('page scrape: a repost is the social-context line, NOT the retweet button every post carries', () => {
  // x_unsub's getPostType tested [data-testid="retweet"], which is the
  // action button on EVERY post. The marker is the social-context text.
  assert.equal(isRepostContext('TestTrader reposted'), true);
  assert.equal(isRepostContext(''), false);
  const { record, reason } = normalizeDomPost({
    status_path: `/OtherGuy/status/${idAt('2026-11-19T11:00:00Z')}`, datetime: '2026-11-19T11:00:00.000Z',
    text: 'not mine', social_context: 'TestTrader reposted',
  }, { knownUsers: KNOWN });
  assert.equal(record, null);
  assert.equal(reason, 'repost');
});

test('page scrape: "pinned" in the text is not a pin; the social-context line is', () => {
  assert.equal(isPinnedContext('Pinned'), true);
  const { record, pinned } = normalizeDomPost({
    status_path: `/TestTrader/status/${idAt('2026-11-18T14:00:00Z')}`, datetime: '2026-11-18T14:00:00.000Z',
    text: 'I pinned my watchlist below', social_context: '',
  }, { knownUsers: KNOWN });
  assert.equal(pinned, false);
  assert.equal(record.fidelity, 'partial');
  assert.equal(record.kind, 'original');
});

test('page scrape: a reply to somebody else is marked so the policy drops it; a self reply is kept', () => {
  const other = normalizeDomPost({
    status_path: `/TestTrader/status/${idAt('2026-11-18T20:00:00Z')}`, datetime: '2026-11-18T20:00:00.000Z',
    text: 'agree', replying_to: ['OtherGuy'],
  }, { knownUsers: KNOWN }).record;
  assert.equal(other.kind, 'reply');
  assert.equal(other.self_thread, false);
  const self = normalizeDomPost({
    status_path: `/TestTrader/status/${idAt('2026-11-18T21:00:00Z')}`, datetime: '2026-11-18T21:00:00.000Z',
    text: 'triggered', replying_to: ['TestTrader'],
  }, { knownUsers: KNOWN }).record;
  assert.equal(self.self_thread, true);
});

test('the agent JSONL contract refuses guessed ids and relative times', () => {
  const ok = normalizeAgentRecord({
    post_id: idAt('2026-11-18T14:32:08Z'), handle: 'TestTrader', created_at: '2026-11-18T14:32:08.000Z',
    kind: 'original', text: 'Long $NVDA', media_urls: ['https://pbs.twimg.com/media/ZZZ?format=png&name=small'],
  }, { knownUsers: KNOWN });
  assert.equal(ok.record.fetched_via, 'agent_jsonl');
  assert.equal(ok.record.media[0].url, 'https://pbs.twimg.com/media/ZZZ.png');
  assert.match(normalizeAgentRecord({ post_id: 1858123, handle: 'TestTrader', created_at: '2026-11-18T14:32:08Z', kind: 'original' },
    { knownUsers: KNOWN }).reason, /digit STRING/);
  assert.match(normalizeAgentRecord({ post_id: '1858123456789', handle: 'TestTrader', created_at: '2h', kind: 'original' },
    { knownUsers: KNOWN }).reason, /absolute ISO-8601/);
  assert.equal(normalizeAgentRecord({ post_id: '1858123456789', handle: 'Stranger', created_at: '2026-11-18T14:32:08Z', kind: 'original' },
    { knownUsers: KNOWN }).reason, 'user_id_unknown');
});

// ---------------------------------------------------------------------------
// The session, carried over from a browser where the user is logged in
// (src/x/browser/cookies.js). X refused the crawler's own login on
// 2026-11-21 ("We've temporarily limited your login").
// ---------------------------------------------------------------------------

const {
  cookiesFromEditorExport, describeProblem, ensureSessionCookies, readCookieExport, sessionCookiesFromEnv,
} = require('../src/x/browser/cookies');
const { launchOptions } = require('../src/x/crawlBrowser');

const FAKE_AUTH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FAKE_CT0 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

test('the .env session becomes the two X cookies, and a pasted "name=" or quotes are cleaned off', () => {
  const { cookies, missing, malformed } = sessionCookiesFromEnv(
    { X_AUTH_TOKEN: `auth_token=${FAKE_AUTH}`, X_CT0: `"${FAKE_CT0}"` }, { nowS: 1_800_000_000 },
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(malformed, []);
  const auth = cookies.find((c) => c.name === 'auth_token');
  const ct0 = cookies.find((c) => c.name === 'ct0');
  assert.equal(auth.value, FAKE_AUTH);
  assert.equal(ct0.value, FAKE_CT0);
  assert.equal(auth.domain, '.x.com');
  assert.equal(auth.httpOnly, true, 'auth_token is HttpOnly, as X sets it');
  assert.equal(ct0.httpOnly, false, 'ct0 is read by the web app itself');
  assert.ok(auth.secure && ct0.secure);
  assert.ok(auth.expires > 1_800_000_000, 'a persistent profile only keeps a cookie that expires');
});

test('a missing or garbled session cookie is NAMED, and its value never appears in the message', () => {
  const missing = sessionCookiesFromEnv({ X_AUTH_TOKEN: FAKE_AUTH, X_CT0: '' });
  assert.deepEqual(missing.missing, ['ct0']);
  assert.match(describeProblem(missing), /ct0 \(X_CT0 in \.env\)/);

  const garbled = `${FAKE_AUTH}; ct0=${FAKE_CT0}`;
  const bad = sessionCookiesFromEnv({ X_AUTH_TOKEN: garbled, X_CT0: FAKE_CT0 });
  assert.deepEqual(bad.malformed, ['auth_token'], 'a whole cookie header is not a cookie value');
  const message = describeProblem(bad);
  assert.match(message, /X_AUTH_TOKEN/);
  assert.equal(message.includes(FAKE_AUTH), false, 'no value in the message');
  assert.equal(message.includes(FAKE_CT0), false, 'no value in the message');
});

test('a Cookie-Editor export keeps only the X cookies, in Playwright\'s shape', () => {
  const { cookies, missing } = cookiesFromEditorExport([
    { domain: '.x.com', name: 'auth_token', value: FAKE_AUTH, path: '/', httpOnly: true, secure: true, sameSite: 'no_restriction', expirationDate: 1_900_000_000.5 },
    { domain: '.x.com', name: 'ct0', value: FAKE_CT0, path: '/', httpOnly: false, secure: true, sameSite: 'lax', expirationDate: 1_900_000_000 },
    { domain: 'x.com', hostOnly: true, name: 'lang', value: 'en', path: '/', session: true, sameSite: 'unspecified' },
    { domain: '.twitter.com', name: 'guest_id', value: 'v1%3A123', path: '/', sameSite: 'no_restriction', secure: false },
    { domain: '.google.com', name: 'NID', value: 'should-not-travel', path: '/' },
  ]);
  assert.deepEqual(missing, []);
  assert.deepEqual(cookies.map((c) => c.name).sort(), ['auth_token', 'ct0', 'guest_id', 'lang']);
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
  assert.equal(byName.auth_token.sameSite, 'None');
  assert.equal(byName.auth_token.expires, 1_900_000_000);
  assert.equal(byName.ct0.sameSite, 'Lax');
  assert.equal(byName.lang.domain, 'x.com', 'a host-only cookie keeps its exact host');
  assert.equal(byName.lang.expires, -1, 'a session cookie stays a session cookie');
  assert.equal(byName.guest_id.secure, true, 'Chromium refuses SameSite=None without Secure');
  assert.deepEqual(cookiesFromEditorExport([{ domain: '.x.com', name: 'ct0', value: FAKE_CT0 }]).missing, ['auth_token']);
});

test('a cookie export inside the repository is refused: it holds the X session', () => {
  const inside = path.join(__dirname, '..', 'data', 'x_pipeline', 'cookies.json');
  assert.throws(() => readCookieExport(inside), /inside the repository/);
});

test('the session cookies are added only when the profile lacks them or holds a different session', async () => {
  const { cookies } = sessionCookiesFromEnv({ X_AUTH_TOKEN: FAKE_AUTH, X_CT0: FAKE_CT0 });
  function fakeContext(present) {
    const added = [];
    return {
      added,
      cookies: async () => present,
      addCookies: async (list) => { added.push(...list); },
    };
  }
  const empty = fakeContext([]);
  assert.equal((await ensureSessionCookies(empty, cookies)).injected, true);
  assert.equal(empty.added.length, 2);

  const same = fakeContext([{ name: 'auth_token', value: FAKE_AUTH }, { name: 'ct0', value: FAKE_CT0 }]);
  assert.equal((await ensureSessionCookies(same, cookies)).injected, false);
  assert.equal(same.added.length, 0);

  const stale = fakeContext([{ name: 'auth_token', value: 'f'.repeat(40) }, { name: 'ct0', value: FAKE_CT0 }]);
  assert.equal((await ensureSessionCookies(stale, cookies)).injected, true, 'the .env session wins over a stale profile');
});

test('the crawler browser is headed and does not announce itself as automated', () => {
  const options = launchOptions('msedge');
  assert.equal(options.headless, false);
  assert.equal(options.channel, 'msedge');
  assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'));
  assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'));
});

// ---------------------------------------------------------------------------
// Headless, two tabs, and X's own allowance (2026-11-22)

const { headlessUserAgent, crawlBrowserWindows } = require('../src/x/crawlBrowser');
const { MAX_CONCURRENCY, clampConcurrency, createRateGate } = require('../src/x/browser/pacing');
const { readPageState, extractVisibleArticles } = require('../src/x/browser/domExtract');
const registry = require('../src/x/registry');
const { openIndex } = require('../src/x/indexStore');

test('a headless crawl carries the browser\'s own user agent with "HeadlessChrome" corrected, and a desktop screen', () => {
  const measured = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'HeadlessChrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0';
  const ua = headlessUserAgent(measured);
  assert.equal(ua, measured.replace('HeadlessChrome/', 'Chrome/'));
  assert.doesNotMatch(ua, /Headless/);
  assert.equal(headlessUserAgent(ua), ua, 'a headed user agent is left alone');

  const options = launchOptions('msedge', { headless: true, userAgent: ua });
  assert.equal(options.headless, true);
  assert.equal(options.userAgent, ua);
  assert.deepEqual(options.screen, { width: 1920, height: 1080 });
  assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'));
  const headed = launchOptions('msedge');
  assert.equal(headed.userAgent, undefined, 'a headed browser sends its own user agent');
  assert.equal(headed.screen, undefined);
});

test('at most two tabs crawl at once, whatever is asked (the user\'s cap)', () => {
  assert.equal(MAX_CONCURRENCY, 2);
  assert.equal(clampConcurrency(undefined), 1);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency('x'), 1);
  assert.equal(clampConcurrency(1), 1);
  assert.equal(clampConcurrency(2), 2);
  assert.equal(clampConcurrency(5), 2);
});

test('the rate gate holds at the reserve until X\'s reset, and only then', () => {
  const now = 1_800_000_000_000;
  const resetS = now / 1000 + 600;
  const gate = createRateGate({ reserve: 3, maxWaitMs: 16 * 60 * 1000, marginMs: 1000 });
  assert.equal(gate.waitMs(now), 0, 'nothing known yet: no hold');
  assert.equal(gate.observe({}), false, 'a response without the headers is not an allowance');

  gate.observe({ 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '10', 'x-rate-limit-reset': String(resetS) });
  assert.equal(gate.waitMs(now), 0, 'allowance left: no hold');
  gate.observe({ 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '3', 'x-rate-limit-reset': String(resetS) });
  assert.equal(gate.waitMs(now), 600_000 + 1000, 'at the reserve: hold until the reset');
  // Two tabs: a response that arrives late with MORE left does not undo the hold.
  gate.observe({ 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '7', 'x-rate-limit-reset': String(resetS) });
  assert.ok(gate.waitMs(now) > 0);
  assert.equal(gate.waitMs(resetS * 1000), 0, 'once the reset has passed, the next response says what is left');
  // A later reset is a new window.
  gate.observe({ 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '49', 'x-rate-limit-reset': String(resetS + 900) });
  assert.equal(gate.waitMs(now), 0);
  const snap = gate.snapshot();
  assert.equal(snap.limit, 50);
  assert.equal(snap.lowest_remaining, 3);
  assert.equal(snap.responses_with_allowance, 4);
});

test('the rate gate announces a hold once per reset, so two tabs log it once', () => {
  const gate = createRateGate({ reserve: 3 });
  gate.observe({ 'x-rate-limit-remaining': '1', 'x-rate-limit-reset': '1800000600' });
  assert.equal(gate.announce(), true);
  assert.equal(gate.announce(), false);
  gate.observe({ 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1800001500' });
  assert.equal(gate.announce(), true);
});

const REAL_TIMELINE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'x', 'real_search_timeline_chickengenius_2026-10.json'), 'utf8',
));
const CHICKEN_ID = '1027041315110842368';
const TERMINATE = {
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
    { type: 'TimelineTerminateTimeline', direction: 'Bottom' },
  ] } } } },
};

/**
 * A fake browser: every search page answers with the real capture, and
 * every scroll with X's end-of-results. `lockedTab` makes one tab's page
 * read as a locked account; `headers` is the allowance every answer carries.
 */
function fakeBrowser({ lockedTab = -1, headers = {} } = {}) {
  const pages = [];
  const visits = [];
  function makePage(index) {
    const listeners = [];
    let url = 'about:blank';
    const emit = (json) => {
      const res = {
        url: () => 'https://x.com/i/api/graphql/q1d/SearchTimeline?variables=%7B%7D',
        status: () => 200,
        headers: () => headers,
        json: async () => json,
      };
      for (const fn of listeners) fn(res);
    };
    return {
      on(event, fn) { if (event === 'response') listeners.push(fn); },
      async goto(target) {
        url = target;
        if (/\/search\?/.test(target)) {
          visits.push({ tab: index, url: target });
          emit(REAL_TIMELINE);
        }
      },
      url: () => url,
      async evaluate(fn) {
        if (fn === readPageState) {
          const locked = index === lockedTab && /\/search\?/.test(url);
          return {
            url, title: 'X', hasChallengeFrame: false, articles: 5, atBottom: true,
            bodyText: locked ? 'Your account has been locked.' : 'posts',
          };
        }
        if (fn === extractVisibleArticles) return [];
        return true; // the logged-in check
      },
      mouse: { async wheel() { emit(TERMINATE); } },
    };
  }
  pages.push(makePage(0));
  const context = {
    pages: () => pages.slice(),
    async newPage() { const page = makePage(pages.length); pages.push(page); return page; },
    async cookies() { return []; },
    async addCookies() {},
    async close() {},
  };
  return { context, pages, visits };
}

async function crawlWithFake(fake, options = {}) {
  const { prepare, ...extra } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-tabs-'));
  const catalogDb = registry.openCatalog({ path: path.join(dir, 'state.sqlite') });
  const indexDb = openIndex({ path: path.join(dir, 'x_index.sqlite') });
  try {
    const account = registry.addAccount(catalogDb, { handle: 'chickengenius', userId: CHICKEN_ID });
    if (prepare) prepare(catalogDb, account);
    const runId = registry.startRun(catalogDb, { accountId: account.account_id, route: 'browser', runTag: 'tabs' });
    const lockFile = path.join(dir, '.browser.lock');
    const report = await crawlBrowserWindows({
      catalogDb, indexDb, account, runId,
      rawDir: path.join(dir, 'raw'), archiveRoot: path.join(dir, 'archive'),
      since: '2026-10-01', until: '2026-11-01', unit: 'week', maxWindows: 10,
      launch: async () => fake.context, sleep: () => new Promise((resolve) => setImmediate(resolve)),
      lockFile, log: () => {}, ...extra,
    });
    const windows = catalogDb.prepare(
      "SELECT window_start, query_kind, status, stop_reason FROM x_crawl_windows WHERE route = 'browser' ORDER BY window_start, query_kind",
    ).all();
    const archived = indexDb.prepare('SELECT COUNT(*) AS n FROM x_posts').get().n;
    return { report, windows, archived, lockLeft: fs.existsSync(lockFile) };
  } finally {
    catalogDb.close();
    indexDb.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('two tabs share the windows: every window is crawled once, by one of the tabs, and completes', async () => {
  const fake = fakeBrowser();
  const { report, windows, archived, lockLeft } = await crawlWithFake(fake, { concurrency: 2 });
  assert.equal(report.status, 'ok', report.message);
  assert.equal(report.concurrency, 2);
  assert.ok(windows.length >= 4, 'October in weeks');
  assert.ok(windows.every((w) => w.status === 'complete'), JSON.stringify(windows));
  const urls = fake.visits.map((v) => v.url);
  assert.equal(new Set(urls).size, urls.length, 'no window was crawled twice');
  assert.equal(urls.length, windows.length);
  assert.deepEqual([...new Set(fake.visits.map((v) => v.tab))].sort(), [0, 1], 'both tabs crawled');
  const single = await crawlWithFake(fakeBrowser(), {});
  assert.ok(single.archived > 0);
  assert.equal(archived, single.archived, 'the same posts seen by two tabs are archived once');
  assert.deepEqual(report.windows.map((w) => w.start), [...report.windows.map((w) => w.start)].sort());
  assert.equal(lockLeft, false, 'the lock is released');
});

test('a crawl asked for five tabs opens two; one asked for nothing opens one', async () => {
  const many = await crawlWithFake(fakeBrowser(), { concurrency: 5 });
  assert.equal(many.report.concurrency, 2);
  const fake = fakeBrowser();
  const one = await crawlWithFake(fake, {});
  assert.equal(one.report.concurrency, 1);
  assert.deepEqual([...new Set(fake.visits.map((v) => v.tab))], [0]);
});

test('a stop on one tab ends the session for both, and no window is left running or recorded as covered', async () => {
  const { report, windows } = await crawlWithFake(fakeBrowser({ lockedTab: 1 }), { concurrency: 2 });
  assert.equal(report.status, 'failed');
  assert.equal(report.stop_reason, 'account_locked');
  assert.ok(!windows.some((w) => w.status === 'running'), JSON.stringify(windows));
  const locked = windows.filter((w) => w.stop_reason === 'account_locked');
  assert.equal(locked.length, 1);
  assert.notEqual(locked[0].status, 'complete');
  assert.ok(windows.some((w) => w.status === 'pending'), 'the windows nobody reached stay pending');
});

test('an allowance spent past the gate\'s patience stops the crawl with the reset as its retry time', async () => {
  const resetS = Math.floor(Date.now() / 1000) + 3600;
  const headers = { 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(resetS) };
  const fake = fakeBrowser({ headers });
  const { report, windows } = await crawlWithFake(fake, { concurrency: 1, maxRateWaitMs: 60_000 });
  assert.equal(report.stop_reason, 'rate_limited');
  assert.equal(report.retry_at, new Date(resetS * 1000).toISOString());
  // The first window may finish on the answer that spent the allowance; the
  // next one is never opened, so it costs X nothing and stays pending.
  assert.equal(fake.visits.length, 1, 'no search page was opened after the allowance ran out');
  assert.ok(!windows.some((w) => w.status === 'running'), JSON.stringify(windows));
  assert.equal(windows.filter((w) => w.status === 'pending').length, windows.length - 1);
  assert.equal(report.allowance.lowest_remaining, 0);
});

const { browserSearchUrl, BROWSER_SPLIT_KINDS } = require('../src/x/windows');

const searchQuery = (url) => new URL(url).searchParams.get('q');

test("the split queries ask only for what is kept: originals without replies, and the account's replies to itself", () => {
  const range = { start: '2026-10-01', end: '2026-11-01' };
  assert.equal(searchQuery(browserSearchUrl('ChickenGenius', range)), 'from:chickengenius since:2026-09-30 until:2026-11-02');
  assert.equal(searchQuery(browserSearchUrl('ChickenGenius', range, 'originals')),
    'from:chickengenius -filter:replies since:2026-09-30 until:2026-11-02');
  assert.equal(searchQuery(browserSearchUrl('ChickenGenius', range, 'self_replies')),
    'from:chickengenius filter:replies to:chickengenius since:2026-09-30 until:2026-11-02',
    'to: takes the HANDLE -- to:<numeric id> matches nothing');
  assert.deepEqual(BROWSER_SPLIT_KINDS, ['originals', 'self_replies']);
  assert.throws(() => browserSearchUrl('x', range, 'everything'), /unknown browser query kind/);
});

test('switching to the split queries retires unfinished all_own windows and never refetches a complete one', async () => {
  const fake = fakeBrowser();
  const { report, windows } = await crawlWithFake(fake, {
    queryMode: 'split',
    prepare(catalogDb, account) {
      registry.ensureWindows(catalogDb, account.account_id, 'browser', 'all_own', [
        { start: '2026-10-01', end: '2026-10-08' }, { start: '2026-10-08', end: '2026-10-15' },
      ]);
      const [done] = registry.pendingWindows(catalogDb, account.account_id, 'browser', 'all_own')
        .filter((w) => w.window_start === '2026-10-01');
      registry.updateWindow(catalogDb, done.id, { status: 'complete' });
    },
  });
  assert.equal(report.status, 'ok', report.message);
  const allOwn = windows.filter((w) => w.query_kind === 'all_own');
  assert.deepEqual(allOwn.map((w) => [w.window_start, w.status]), [['2026-10-01', 'complete']],
    'the unfinished all_own window is gone; the complete one is the record of its range');
  const queries = fake.visits.map((v) => searchQuery(v.url));
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => /-filter:replies|filter:replies to:chickengenius/.test(q)), queries.join(' | '));
  assert.ok(!queries.some((q) => q.includes('since:2026-09-30')), 'the range a complete all_own window covers is not fetched again');
  for (const kind of BROWSER_SPLIT_KINDS) {
    const ofKind = windows.filter((w) => w.query_kind === kind);
    assert.ok(ofKind.length >= 3, `${kind} windows were planned`);
    assert.ok(ofKind.every((w) => w.status === 'complete'), JSON.stringify(ofKind));
  }
  assert.ok(report.windows.every((w) => BROWSER_SPLIT_KINDS.includes(w.kind)));
});
