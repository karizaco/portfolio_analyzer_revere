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

test('the capture matches GraphQL by operation name, whatever the rotating query id', () => {
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc123XYZ/SearchTimeline?variables=%7B%7D'), 'SearchTimeline');
  assert.equal(timelineOperation('https://x.com/i/api/graphql/zzz999/UserTweets?variables=1'), 'UserTweets');
  assert.equal(timelineOperation('https://x.com/i/api/graphql/abc/HomeTimeline?x=1'), null, 'not an operation we read');
  assert.equal(timelineOperation('https://x.com/home'), null);
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
