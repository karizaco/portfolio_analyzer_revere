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
