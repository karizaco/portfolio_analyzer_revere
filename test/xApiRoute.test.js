'use strict';

// Route A (the paid API): the client, the budget guard, the window planner
// and the resumable window crawler. No network: a fake fetch and a fake clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { createXApiClient, redact } = require('../src/x/apiClient');
const { createBudget } = require('../src/x/apiBudget');
const { planWindows, windowVerdict, browserSearchUrl, API_QUERY_KINDS } = require('../src/x/windows');
const { crawlWindows, estimate, incrementalSince } = require('../src/x/crawlApi');
const { openIndex } = require('../src/x/indexStore');
const registry = require('../src/x/registry');
const { USER, apiPage } = require('./fixtures/x/scenario');

const PRICING = { post_read: 0.005, user_read: 0.01, counts_all_request: 0.01, counts_recent_request: 0.005 };
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAsecretTOKENvalue1234567890';

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function fakeClock() {
  let t = Date.parse('2026-11-20T10:00:00Z');
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('the token is sent in a header, never in the URL, and never appears in an error', async () => {
  const seen = [];
  const clock = fakeClock();
  const client = createXApiClient({
    bearerToken: TOKEN, now: clock.now, sleep: clock.sleep,
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return response(403, { title: `Forbidden for Bearer ${TOKEN}`, detail: `token ${TOKEN} lacks access` });
    },
  });
  await assert.rejects(client.lookupUser('TestTrader'), (error) => {
    assert.equal(error.code, 'forbidden');
    assert.ok(!error.message.includes(TOKEN), 'the token must not leak into the message');
    return true;
  });
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.ok(!seen[0].url.includes(TOKEN));
  assert.equal(redact(`x Bearer ${TOKEN} y`, []), 'x Bearer [redacted] y');
});

test('a 429 is waited out until the reset time, then the request succeeds', async () => {
  const clock = fakeClock();
  let calls = 0;
  const resetAt = Math.floor(clock.now() / 1000) + 120;
  const client = createXApiClient({
    bearerToken: TOKEN, now: clock.now, sleep: clock.sleep, minIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response(429, { title: 'Too Many Requests' }, { 'x-rate-limit-reset': String(resetAt) });
      return response(200, { data: { id: USER.id, username: USER.username } });
    },
  });
  const result = await client.lookupUser('TestTrader');
  assert.equal(result.json.data.id, USER.id);
  assert.ok(clock.sleeps.some((ms) => ms >= 120000), 'it waited for the reset, not a guess');
});

test('a 429 whose reset is too far away stops the crawl with the retry time', async () => {
  const clock = fakeClock();
  const client = createXApiClient({
    bearerToken: TOKEN, now: clock.now, sleep: clock.sleep, minIntervalMs: 0, maxRateLimitWaitMs: 60000,
    fetchImpl: async () => response(429, {}, { 'x-rate-limit-reset': String(Math.floor(clock.now() / 1000) + 3600) }),
  });
  await assert.rejects(client.searchAll({ query: 'from:x' }), (error) => error.code === 'rate_limited' && Boolean(error.retryAt));
});

test('the budget shrinks the page and stops BEFORE a request that could cross it', () => {
  const budget = createBudget({ budgetUsd: 1, pricing: PRICING });
  assert.equal(budget.searchPageSize(), 200, '$1 buys 200 posts');
  budget.charge('post_read', 195);
  assert.equal(budget.searchPageSize(), 0, '5 posts left is below the minimum page of 10: stop');
  assert.equal(budget.canAfford('counts_all_request'), true);
  const capped = createBudget({ budgetUsd: 100, maxPosts: 120, pricing: PRICING });
  assert.equal(capped.searchPageSize(), 120);
});

test('windows are calendar-aligned, newest first, and never cross the bounds', () => {
  assert.deepEqual(planWindows({ since: '2024-03-15', until: '2026-02-10', unit: 'year' }), [
    { start: '2026-01-01', end: '2026-02-10' },
    { start: '2025-01-01', end: '2026-01-01' },
    { start: '2024-03-15', end: '2025-01-01' },
  ]);
  assert.equal(planWindows({ since: '2026-01-01', until: '2026-03-01', unit: 'month' }).length, 2);
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 100, expected: 100 }), 'complete');
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 50, expected: 100 }), 'partial');
  assert.equal(windowVerdict({ route: 'browser', reachedEnd: false, seen: 50, stopReason: 'rate_limited' }), 'blocked');
  assert.equal(API_QUERY_KINDS.originals('123'), 'from:123 -is:retweet -is:reply');
  // `to:` takes the HANDLE: `to:<numeric id>` silently counted 0 self-replies
  // where the handle counted 8 (@RedDogT3, October 2026, measured 2026-11-21).
  assert.equal(API_QUERY_KINDS.self_replies('123', 'TestTrader'), 'from:123 is:reply to:testtrader');
  assert.match(decodeURIComponent(browserSearchUrl('TestTrader', { start: '2026-01-01', end: '2026-02-01' })),
    /from:testtrader since:2025-12-31 until:2026-02-02/);
});

test('the window verdict is two-sided, and ANY stop reason blocks completeness', () => {
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 100, expected: 100 }), 'complete');
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 50, expected: 100 }), 'partial', 'a shortfall means posts were missed');
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 130, expected: 100 }), 'partial',
    'a surplus means the count and the crawl disagree about the window');
  assert.equal(windowVerdict({ route: 'api', reachedEnd: true, seen: 100, expected: 100, stopReason: 'selector_drift' }), 'partial',
    'a stop reason OUTSIDE the known list still blocks completeness');
  assert.equal(windowVerdict({ route: 'api', reachedEnd: false, seen: 100, stopReason: 'selector_drift' }), 'blocked');
  assert.equal(windowVerdict({ route: 'browser', reachedEnd: false, seen: 50, stopReason: 'rate_limited' }), 'blocked');
});

test('the budget starts from what the account already spent today', () => {
  // X bills a resource once per UTC DAY, so the cap is per account per
  // UTC day. A run that is interrupted and resumed, or a second run the
  // same day, must not start at $0.
  const budget = createBudget({ budgetUsd: 1, pricing: PRICING, startingSpend: 0.5, startingPosts: 100 });
  assert.equal(budget.spent, 0.5);
  assert.equal(budget.posts, 100);
  assert.equal(budget.searchPageSize(), 100, 'the remaining $0.50 buys 100 posts');
  assert.throws(() => createBudget({ budgetUsd: 0.1, pricing: PRICING, startingSpend: 0.5 }), /already spent/);
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-api-'));
  const handle = {
    dir,
    catalogDb: registry.openCatalog({ path: path.join(dir, 'state.sqlite') }),
    indexDb: openIndex({ path: path.join(dir, 'x_index.sqlite') }),
    archiveRoot: path.join(dir, 'archive'),
    rawDir: path.join(dir, 'raw'),
    close() {
      handle.catalogDb.close();
      handle.indexDb.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return handle;
}

/** A fake API client: two pages for the originals query, one empty page for self replies. */
function fakeClient(log) {
  const page = apiPage();
  const half = Math.ceil(page.data.length / 2);
  return {
    async searchAll(params) {
      log.push(params);
      if (params.query.includes('-is:reply')) {
        if (!params.nextToken) return { status: 200, json: { ...page, data: page.data.slice(0, half), meta: { next_token: 'p2' } }, url: 'u', fetchedAt: '2026-11-20T10:00:00.000Z' };
        return { status: 200, json: { ...page, data: page.data.slice(half), meta: {} }, url: 'u', fetchedAt: '2026-11-20T10:00:01.000Z' };
      }
      return { status: 200, json: { meta: { result_count: 0 } }, url: 'u', fetchedAt: '2026-11-20T10:00:02.000Z' };
    },
    async countsAll() {
      return { status: 200, json: { data: [{ start: '2026-11-18T00:00:00.000Z', tweet_count: 4 }, { start: '2026-11-19T00:00:00.000Z', tweet_count: 3 }], meta: {} } };
    },
  };
}

test('the window crawler pages through, imports as it goes, bills each page, and marks the window complete', async () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const runId = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 't' });
    const log = [];
    const budget = createBudget({ budgetUsd: 5, pricing: PRICING });
    const result = await crawlWindows({
      ...s, client: fakeClient(log), budget, account, runId, since: '2026-11-01', until: '2026-11-20', unit: 'year',
    });
    assert.equal(result.status, 'ok');
    assert.equal(log.filter((p) => p.query.includes('-is:reply')).length, 2, 'two pages');
    assert.equal(log[1].nextToken, 'p2', 'the second page asks for the token the first returned');
    const selfReplyQueries = log.filter((p) => p.query.includes(' is:reply')).map((p) => p.query);
    assert.ok(selfReplyQueries.length > 0);
    assert.ok(selfReplyQueries.every((q) => q === `from:${USER.id} is:reply to:testtrader`),
      `the crawler's self-reply query names the handle in to: (${selfReplyQueries[0]})`);
    assert.ok(log.every((p) => p.endTime === '2026-11-20T00:00:00Z'), 'a window never ends after today');
    const windows = s.catalogDb.prepare('SELECT query_kind, status FROM x_crawl_windows ORDER BY query_kind').all();
    assert.deepEqual(windows.map((w) => w.status), ['complete', 'complete']);
    const usage = s.catalogDb.prepare('SELECT SUM(resources_returned) AS posts, SUM(est_cost_usd) AS usd FROM x_api_usage').get();
    assert.equal(usage.posts, apiPage().data.length);
    assert.equal(Number(usage.usd.toFixed(3)), Number((apiPage().data.length * 0.005).toFixed(3)));
    assert.equal(s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_posts').get().n, 5, 'the policy applied on import');
    assert.equal(fs.readdirSync(s.rawDir).length, 3, 'every page is kept raw');
    assert.equal(incrementalSince(s.catalogDb, account), '2026-11-20');
  } finally {
    s.close();
  }
});

test('a crawl stopped by the budget resumes from the saved page token', async () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const log = [];
    const runA = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 'a' });
    // $0.05 = 10 posts: page one (4 posts) fits, then fewer than 10 posts remain.
    const first = await crawlWindows({
      ...s, client: fakeClient(log), budget: createBudget({ budgetUsd: 0.05, pricing: PRICING }), account,
      runId: runA, since: '2026-11-01', until: '2026-11-20',
    });
    assert.equal(first.status, 'partial');
    assert.equal(first.stopReason, 'budget');
    const stopped = s.catalogDb.prepare("SELECT * FROM x_crawl_windows WHERE query_kind = 'originals'").get();
    assert.equal(stopped.status, 'partial');
    assert.equal(stopped.next_token, 'p2', 'the window remembers where it stopped');

    const runB = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 'b' });
    await crawlWindows({
      ...s, client: fakeClient(log), budget: createBudget({ budgetUsd: 5, pricing: PRICING }), account,
      runId: runB, since: '2026-11-01', until: '2026-11-20',
    });
    const resumed = log.filter((p) => p.query.includes('-is:reply'));
    assert.equal(resumed[1].nextToken, 'p2', 'the next run starts on page two, not page one');
    assert.equal(s.catalogDb.prepare("SELECT status FROM x_crawl_windows WHERE query_kind = 'originals'").get().status, 'complete');
  } finally {
    s.close();
  }
});

test('a re-plan crawls only the part no window covers: a backfill is not re-billed', async () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const log = [];
    const runA = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 'a' });
    await crawlWindows({
      ...s, client: fakeClient(log), budget: createBudget({ budgetUsd: 5, pricing: PRICING }), account,
      runId: runA, since: '2026-11-01', until: '2026-11-20', unit: 'year',
    });
    assert.ok(log.length > 0, 'the first crawl read something');

    // The next day's backfill asks for one more day. Without the
    // reduction it creates a NEW window over the whole period and reads
    // (and bills) every post in it again.
    const runB = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 'b' });
    const second = [];
    await crawlWindows({
      ...s, client: fakeClient(second), budget: createBudget({ budgetUsd: 5, pricing: PRICING }), account,
      runId: runB, since: '2026-11-01', until: '2026-11-21', unit: 'year',
    });
    const originals = second.filter((p) => p.query.includes('-is:reply'));
    assert.ok(originals.length > 0, 'the new day is crawled');
    assert.ok(originals.every((p) => p.startTime === '2026-11-20T00:00:00Z'),
      'only the uncovered day is crawled -- the covered one is not re-billed');
    assert.ok(!second.some((p) => p.startTime === '2026-11-01T00:00:00Z'), 'the covered range is not read again');

    const rows = s.catalogDb.prepare("SELECT window_start, window_end, status FROM x_crawl_windows WHERE query_kind = 'originals' ORDER BY window_start").all();
    assert.deepEqual(rows.map((r) => [r.window_start, r.window_end]), [['2026-11-01', '2026-11-20'], ['2026-11-20', '2026-11-21']],
      'the covered window is kept and the uncovered tail is a new one');
  } finally {
    s.close();
  }
});

test('the estimate counts each query kind per year and prices the reads', async () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const runId = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 'e' });
    const result = await estimate({
      ...s, client: fakeClient([]), budget: createBudget({ budgetUsd: 1, pricing: PRICING }), account, runId,
      since: '2026-01-01', until: '2026-11-20',
    });
    assert.equal(result.requests, 2, 'one count request per query kind');
    assert.equal(result.posts, 14);
    assert.equal(result.readCost, 0.07);
    assert.deepEqual(result.kinds.originals.byYear, { 2026: 7 });
    assert.equal(result.complete, true);
  } finally {
    s.close();
  }
});
