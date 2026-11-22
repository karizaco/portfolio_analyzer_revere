'use strict';

/**
 * Route A: crawl an account through the paid X API.
 *
 *   lookup      one user read ($0.01): the numeric id, the post count
 *   estimate    count requests ($0.01 each): how many posts each query
 *               would return, per year -- BEFORE paying for any of them
 *   backfill    full-archive search over date windows, resumable
 *   incremental the same, from the newest complete window to today
 *
 * WINDOWS NEVER END AFTER TODAY. A window that ended "now" would be marked
 * complete while posts are still arriving, and re-reading it later would be
 * paid twice. So `until` defaults to today 00:00 UTC (exclusive), and the
 * next incremental run starts exactly there.
 */

const path = require('node:path');

const { API_QUERY_KINDS, planWindows, uncoveredRanges, windowVerdict } = require('./windows');
const { importRecords, filteredTotal } = require('./importer');
const { markDeleted } = require('./indexStore');
const { normalizeEnvelope, saveRaw } = require('./rawStore');
const registry = require('./registry');

const ROOT = path.resolve(__dirname, '..', '..');
const ARCHIVE_START = '2006-03-21';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function fromClause(account) {
  return account.user_id || account.handle;
}

/**
 * One user read. Pins the account's user id.
 */
async function lookupAccount({ catalogDb, client, budget, account, runId, log = () => {} }) {
  if (!budget.canAfford('user_read')) throw new Error('the budget does not cover one user lookup');
  const response = await client.lookupUser(account.handle);
  const charge = budget.charge('user_read', 1);
  registry.recordApiUsage(catalogDb, {
    runId, endpoint: 'users/by/username', httpStatus: response.status, resources: 1, ...charge,
  });
  // The run's own cost counter: the ledger row and the run row must agree.
  registry.addToRun(catalogDb, runId, { api_cost_usd_est: charge.cost });
  const user = response.json && response.json.data;
  if (!user) throw new Error(`no such X user: @${account.handle}`);
  registry.recordLookup(catalogDb, account.account_id, user);
  log(`[x-api] @${user.username}: user ${user.id}, ${user.public_metrics ? user.public_metrics.tweet_count : '?'} posts in total`
    + `${user.protected ? ' (PROTECTED -- an app-only token cannot read it)' : ''}`);
  return registry.getAccount(catalogDb, account.account_id);
}

/**
 * Count what each query kind would return, per day, over [since, until).
 *
 * @returns {Promise<{kinds: object, requests: number, cost: number, posts: number, readCost: number, complete: boolean}>}
 */
async function estimate({ catalogDb, client, budget, account, since, until, runId, log = () => {} }) {
  const from = fromClause(account);
  const start = `${since < ARCHIVE_START ? ARCHIVE_START : since}T00:00:00Z`;
  const end = `${until}T00:00:00Z`;
  const kinds = {};
  let requests = 0;
  let complete = true;
  for (const [kind, build] of Object.entries(API_QUERY_KINDS)) {
    const query = build(from, account.handle);
    const days = [];
    let nextToken;
    do {
      if (!budget.canAfford('counts_all_request')) {
        complete = false;
        log('[x-api] budget reached while counting; the estimate is INCOMPLETE');
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const response = await client.countsAll({ query, startTime: start, endTime: end, nextToken });
      requests += 1;
      const charge = budget.charge('counts_all_request');
      registry.recordApiUsage(catalogDb, {
        runId, endpoint: 'tweets/counts/all', httpStatus: response.status, resources: 0, ...charge,
      });
      registry.addToRun(catalogDb, runId, { api_cost_usd_est: charge.cost });
      for (const bucket of (response.json && response.json.data) || []) {
        days.push({ date: String(bucket.start).slice(0, 10), count: Number(bucket.tweet_count) || 0 });
      }
      nextToken = response.json && response.json.meta && response.json.meta.next_token;
    } while (nextToken);
    const byYear = {};
    for (const day of days) byYear[day.date.slice(0, 4)] = (byYear[day.date.slice(0, 4)] || 0) + day.count;
    kinds[kind] = { query, total: days.reduce((sum, day) => sum + day.count, 0), byYear, days };
  }
  const posts = Object.values(kinds).reduce((sum, kind) => sum + kind.total, 0);
  return {
    kinds,
    requests,
    cost: budget.spent,
    posts,
    readCost: Number((posts * budget.pricing.post_read).toFixed(2)),
    complete,
  };
}

/**
 * The expected count of a window, from daily buckets.
 */
function expectedFor(days, window) {
  if (!days) return null;
  return days.filter((day) => day.date >= window.start && day.date < window.end)
    .reduce((sum, day) => sum + day.count, 0);
}

/**
 * Backfill (or incrementally extend) an account over [since, until).
 *
 * @returns {Promise<{status: string, stopReason: string, windowsDone: number, imported: object}>}
 */
async function crawlWindows(options) {
  const {
    catalogDb, indexDb, client, budget, account, runId, rawDir, archiveRoot, log = () => {},
  } = options;
  const until = options.until || todayUtc();
  const since = options.since || account.backfill_since || ARCHIVE_START;
  const unit = options.unit || 'year';
  const from = fromClause(account);
  const windows = planWindows({ since, until, unit });

  // A re-plan is REDUCED to the part no window covers yet. Without this,
  // extending the end of a backfill by one day creates a NEW window over
  // the whole period, and the crawler re-reads -- and re-bills -- every
  // post in it at $0.005 a post.
  const effective = [];
  for (const kind of Object.keys(API_QUERY_KINDS)) {
    const existing = registry.windowRanges(catalogDb, account.account_id, kind, 'api');
    const days = options.counts && options.counts.kinds[kind] ? options.counts.kinds[kind].days : null;
    for (const window of windows) {
      for (const part of uncoveredRanges(existing, window.start, window.end)) {
        effective.push({ kind, window: { start: part.start, end: part.end } });
      }
    }
    registry.ensureWindows(catalogDb, account.account_id, 'api', kind,
      effective.filter((row) => row.kind === kind).map((row) => ({ ...row.window, expected: expectedFor(days, row.window) })));
  }
  registry.updateRun(catalogDb, runId, { windows_planned: effective.length });

  const totals = { seen: 0, new: 0, updated: 0, filtered: 0, otherUser: 0, rejected: 0, invalid: 0 };
  let windowsDone = 0;
  let stopReason = '';
  const pending = registry.pendingWindows(catalogDb, account.account_id, 'api')
    .filter((window) => window.window_start >= since && window.window_end <= until);

  outer:
  for (const window of pending) {
    const query = API_QUERY_KINDS[window.query_kind](from, account.handle);
    let nextToken = window.next_token || undefined;
    let seen = Number(window.posts_seen) || 0;
    let oldest = window.oldest_seen;
    let newest = window.newest_seen;
    registry.updateWindow(catalogDb, window.id, { status: 'running', last_run_id: runId, stop_reason: '' });
    let page = 0;
    for (;;) {
      const size = budget.searchPageSize();
      if (!size) {
        stopReason = 'budget';
        registry.updateWindow(catalogDb, window.id, { status: 'partial', stop_reason: 'budget', next_token: nextToken || '' });
        log(`[x-api] budget reached at $${budget.spent.toFixed(2)}; window ${window.window_start}..${window.window_end} keeps its place`);
        break outer;
      }
      let response;
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await client.searchAll({
          query, startTime: `${window.window_start}T00:00:00Z`, endTime: `${window.window_end}T00:00:00Z`, nextToken, maxResults: size,
        });
      } catch (error) {
        stopReason = error.code === 'rate_limited' ? 'rate_limited' : (error.code || 'error');
        registry.updateWindow(catalogDb, window.id, {
          status: error.code === 'rate_limited' ? 'blocked' : 'failed', stop_reason: `${stopReason}: ${error.message}`.slice(0, 300),
          next_token: nextToken || '',
        });
        if (error.code === 'rate_limited' || error.code === 'payment_required' || error.code === 'unauthorized') break outer;
        throw error;
      }
      page += 1;
      const body = response.json || {};
      const returned = Array.isArray(body.data) ? body.data.length : 0;
      const charge = budget.charge('post_read', returned);
      registry.recordApiUsage(catalogDb, {
        runId, endpoint: 'tweets/search/all', httpStatus: response.status, resources: returned, ...charge,
      });
      registry.addToRun(catalogDb, runId, { api_cost_usd_est: charge.cost });

      const envelope = {
        route: 'api_v2', operation: 'search_all', url: response.url, status: response.status,
        fetched_at: response.fetchedAt, query_kind: window.query_kind, window: [window.window_start, window.window_end], body,
      };
      saveRaw(rawDir, `${window.query_kind}_${window.window_start}_${String(page).padStart(4, '0')}`, envelope);
      const { records, rejected } = normalizeEnvelope(envelope);
      // A deleted or protected post arrives as an errors[] entry, not as a
      // missing row. It is COUNTED, so a window that quietly lost posts
      // says so instead of looking complete -- and it is MARKED, because
      // a deletion that is not recorded is a deletion nobody can see.
      totals.rejected += rejected.length;
      for (const item of rejected) {
        if (!item.post_id) continue;
        markDeleted(indexDb, item.post_id, {
          detectedAt: response.fetchedAt, runId, source: 'api_v2', detail: item.reason || '',
        });
      }
      const result = importRecords({ catalogDb, indexDb, account: registry.getAccount(catalogDb, account.account_id), records, archiveRoot });
      seen += result.seen;
      if (result.oldest && (!oldest || result.oldest < oldest)) oldest = result.oldest;
      if (result.newest && (!newest || result.newest > newest)) newest = result.newest;
      totals.seen += result.seen;
      totals.new += result.new;
      totals.updated += result.updated;
      totals.filtered += filteredTotal(result.filtered);
      totals.otherUser += result.otherUser;
      totals.invalid += result.invalid.length;
      registry.addToRun(catalogDb, runId, {
        posts_seen: result.seen, posts_new: result.new, posts_updated: result.updated, posts_filtered: filteredTotal(result.filtered),
        posts_other_user: result.otherUser, posts_rejected: rejected.length,
      });
      if (result.otherUser) {
        // Posts that belong to somebody else are DROPPED by the policy, and
        // a batch of them is what a stale handle or a wrong account looks
        // like. It is reported, because a run that dropped everything must
        // not look like a run that found nothing.
        log(`[x-api] ${window.query_kind}: ${result.otherUser} post(s) belong to another user id and were not imported`);
      }
      if (result.identityError) {
        log(`[x-api] ${window.query_kind}: ${result.identityError}`);
      }

      nextToken = body.meta && body.meta.next_token ? body.meta.next_token : undefined;
      registry.updateWindow(catalogDb, window.id, { posts_seen: seen, oldest_seen: oldest || '', newest_seen: newest || '', next_token: nextToken || '' });
      log(`[x-api] ${window.query_kind} ${window.window_start}..${window.window_end} page ${page}: ${returned} posts`
        + ` (+${result.new} new), $${budget.spent.toFixed(3)} spent`);
      if (!nextToken) {
        const verdict = windowVerdict({ route: 'api', reachedEnd: true, seen, expected: window.count_expected });
        registry.updateWindow(catalogDb, window.id, { status: verdict, stop_reason: verdict === 'partial' ? 'fewer_than_counted' : '' });
        if (verdict === 'complete') {
          windowsDone += 1;
          registry.addToRun(catalogDb, runId, { windows_complete: 1 });
        }
        break;
      }
    }
  }

  return {
    status: stopReason ? (stopReason === 'budget' ? 'partial' : 'blocked') : 'ok',
    stopReason,
    windowsDone,
    imported: totals,
  };
}

/**
 * Where an incremental run starts: the end of the newest COMPLETE window.
 */
function incrementalSince(catalogDb, account) {
  const rows = catalogDb.prepare(`SELECT query_kind, MAX(window_end) AS end FROM x_crawl_windows
    WHERE account_id = ? AND status = 'complete' GROUP BY query_kind`).all(account.account_id);
  const ends = Object.fromEntries(rows.map((row) => [row.query_kind, row.end]));
  // The browser's one query covers both kinds; the API's two queries cover
  // the account only where BOTH reached.
  const apiEnd = ends.originals && ends.self_replies
    ? (ends.originals < ends.self_replies ? ends.originals : ends.self_replies)
    : '';
  const browserEnd = ends.all_own || '';
  return apiEnd > browserEnd ? apiEnd : browserEnd;
}

module.exports = {
  ARCHIVE_START,
  crawlWindows,
  estimate,
  expectedFor,
  incrementalSince,
  lookupAccount,
  todayUtc,
  ROOT,
};
