'use strict';

// The archive (tracked record), the index (untracked cache), the registry
// and the importer that ties them together -- on scratch files only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { normalizeApiV2Page } = require('../src/x/normalizeApiV2');
const { normalizeGraphqlResponse } = require('../src/x/normalizeGraphql');
const { writeToArchive, iterateArchive } = require('../src/x/archive');
const { openIndex, rebuildIndex, markDeleted } = require('../src/x/indexStore');
const { importRecords } = require('../src/x/importer');
const registry = require('../src/x/registry');
const { eventSession } = require('../src/x/marketTime');
const { IDS, USER, apiPage, graphqlTimeline } = require('./fixtures/x/scenario');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-storage-'));
  const catalogDb = registry.openCatalog({ path: path.join(dir, 'state.sqlite') });
  const indexDb = openIndex({ path: path.join(dir, 'x_index.sqlite') });
  const archiveRoot = path.join(dir, 'archive');
  const handle = {
    dir, catalogDb, indexDb, archiveRoot,
    close() {
      for (const db of [handle.catalogDb, handle.indexDb]) {
        try { db.close(); } catch (_) { /* already closed */ }
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return handle;
}

function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

test('the archive is deterministic: the same records, in any order, give byte-identical files', () => {
  const s = scratch();
  try {
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records;
    writeToArchive(records, { archiveRoot: s.archiveRoot });
    const first = snapshotTree(s.archiveRoot);
    const stats = writeToArchive([...records].reverse(), { archiveRoot: s.archiveRoot });
    assert.equal(stats.filesWritten, 0, 'nothing is rewritten when nothing changed');
    assert.equal(stats.postsNew, 0);
    assert.deepEqual(snapshotTree(s.archiveRoot), first);

    const file = Object.keys(first)[0];
    assert.match(file, /^123456789[\\/]2026[\\/]2026-11\.jsonl$/);
    const ids = first[file].trim().split('\n').map((line) => JSON.parse(line).post_id);
    assert.deepEqual(ids, [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)), 'sorted by id, numerically');
    assert.equal([...iterateArchive({ archiveRoot: s.archiveRoot })].length, records.length);
  } finally {
    s.close();
  }
});

test('the importer keeps own posts and own thread replies, and drops replies to others and reposts', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: '@TestTrader' });
    assert.equal(account.user_id, null, 'the user id is not known yet');
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records;
    const result = importRecords({ ...s, account, records });

    assert.equal(registry.getAccount(s.catalogDb, 'testtrader').user_id, USER.id, 'the first capture pins the user id');
    assert.deepEqual(result.filtered, { reply_to_other: 1, repost: 1 });
    assert.equal(result.new, 5);
    const kept = new Set(s.indexDb.prepare('SELECT post_id FROM x_posts').all().map((row) => row.post_id));
    assert.ok(kept.has(IDS.selfReply), 'an own thread reply is kept');
    assert.ok(!kept.has(IDS.replyOther), 'a reply to somebody else is never kept');
    assert.ok(!kept.has(IDS.repost), 'a repost is never kept');

    const row = s.indexDb.prepare('SELECT * FROM x_posts WHERE post_id = ?').get(IDS.original);
    assert.equal(row.event_session, eventSession(row.created_at));
    assert.equal(s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_post_media WHERE post_id = ?').get(IDS.original).n, 1);
    assert.equal(s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_post_metrics').get().n, 5);
  } finally {
    s.close();
  }
});

test('a second route adds an observation and merges, but never duplicates a post', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader' });
    importRecords({ ...s, account, records: normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-19T09:00:00.000Z' }).records });
    const before = s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_posts').get().n;
    const result = importRecords({ ...s, account, records: normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records });
    assert.equal(result.new, 0);
    assert.equal(s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_posts').get().n, before);
    const row = s.indexDb.prepare('SELECT fetched_via, first_seen_at FROM x_posts WHERE post_id = ?').get(IDS.original);
    assert.equal(row.fetched_via, 'api_v2', 'the higher-fidelity route wins');
    assert.equal(row.first_seen_at, '2026-11-19T09:00:00.000Z');
    assert.equal(s.indexDb.prepare('SELECT COUNT(*) AS n FROM x_post_metrics WHERE post_id = ?').get(IDS.original).n, 2,
      'each capture is one more engagement observation');
  } finally {
    s.close();
  }
});

test('a handle that turns up behind a different user id is refused, a rename is followed', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    assert.throws(() => registry.resolveUserId(s.catalogDb, account.account_id, '555'), /Refusing to merge two accounts/);
    registry.resolveUserId(s.catalogDb, account.account_id, USER.id, 'NewName');
    assert.equal(registry.getAccount(s.catalogDb, USER.id).handle, 'newname');
    assert.deepEqual(s.catalogDb.prepare('SELECT handle FROM x_account_handles ORDER BY handle').all().map((r) => r.handle),
      ['newname', 'testtrader']);
    assert.throws(() => registry.addAccount(s.catalogDb, { handle: 'someone', includeReplies: 'all' }), /never collected/);
  } finally {
    s.close();
  }
});

test('a renamed account keeps its posts: the identity is learned from the capture', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'oldhandle' });
    assert.equal(account.user_id, null, 'the user id is not known yet');
    // A capture that shows the account's NEW handle. The old code learned
    // the user id only from a record whose handle matched the registered
    // one, so EVERY post was rejected as another user's and the account
    // stayed unidentified forever -- a total, silent loss.
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
      .map((record) => ({ ...record, handle: 'newhandle' }));
    const result = importRecords({ ...s, account, records });

    assert.equal(result.identityError, '');
    assert.equal(result.otherUser, 0, 'the posts are not another user\'s');
    assert.equal(result.new, 5, 'the posts are kept');
    assert.equal(registry.getAccount(s.catalogDb, 'oldhandle'), null, 'the account followed its rename');
    assert.equal(registry.getAccount(s.catalogDb, 'newhandle').user_id, USER.id, 'and learned its user id');
    assert.deepEqual(s.catalogDb.prepare('SELECT handle FROM x_account_handles ORDER BY handle').all().map((r) => r.handle),
      ['newhandle', 'oldhandle'], 'the handle history keeps both');
  } finally {
    s.close();
  }
});

test('an ambiguous capture is reported, and the account is never guessed at', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'oldhandle' });
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records;
    // Two user ids, and neither of them is the registered handle: the
    // capture cannot say which account it belongs to.
    const mixed = records.map((record, index) => ({
      ...record, handle: 'newhandle', user_id: index % 2 ? '555555555' : USER.id,
    }));
    const result = importRecords({ ...s, account, records: mixed });
    assert.match(result.identityError, /cannot be learned/);
    assert.equal(registry.getAccount(s.catalogDb, 'oldhandle').user_id, null, 'no identity is invented');
    assert.equal(result.new, 0, 'nothing is imported under a guessed identity');
  } finally {
    s.close();
  }
});

test('the run\'s cost counter agrees with the ledger', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader' });
    const runId = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 't1' });
    // The lookup and the count requests are PAID requests, so they are
    // ledgered -- and the run row has to carry them too, or the run's own
    // cost disagrees with the money that was actually spent.
    registry.recordApiUsage(s.catalogDb, { runId, endpoint: 'users/by/username', httpStatus: 200, resources: 1, unit: 'user_read', unitPrice: 0.01, cost: 0.01 });
    registry.addToRun(s.catalogDb, runId, { api_cost_usd_est: 0.01 });
    const run = s.catalogDb.prepare('SELECT api_cost_usd_est FROM x_crawl_runs WHERE id = ?').get(runId);
    const ledger = s.catalogDb.prepare('SELECT COALESCE(SUM(est_cost_usd), 0) AS usd FROM x_api_usage WHERE run_id = ?').get(runId);
    assert.equal(Number(run.api_cost_usd_est), Number(ledger.usd));
  } finally {
    s.close();
  }
});

test('a corrupt archive line is reported, and the file is left exactly as it is', () => {
  // The archive is the record: a fetched post cannot be re-fetched
  // cheaply and the author can delete it. So one bad line must not make
  // the whole archive unreadable -- and rewriting the file to "clean it
  // up" would DROP that line, and with it whatever it said.
  const s = scratch();
  try {
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records;
    writeToArchive(records, { archiveRoot: s.archiveRoot });
    const file = path.join(s.archiveRoot, USER.id, '2026', '2026-11.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[1] = '{not json at all';
    fs.writeFileSync(file, lines.join('\n'));
    const before = fs.readFileSync(file, 'utf8');

    const stats = writeToArchive(records, { archiveRoot: s.archiveRoot });
    assert.equal(stats.corruptFiles.length, 1, 'the corruption is reported');
    assert.equal(stats.corruptFiles[0].lines.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is not rewritten, so nothing is lost');
    assert.equal([...iterateArchive({ archiveRoot: s.archiveRoot })].length, records.length - 1,
      'the good records are still readable');
  } finally {
    s.close();
  }
});

test('a deleted post is MARKED, not silently dropped', () => {
  // A deleted post is an entry in the API's errors[], not a missing row, so
  // it never reaches the archive -- and without a record of it the fact
  // that X withdrew it is lost, which is what the compliance obligation
  // and the survivorship analysis both need.
  const s = scratch();
  try {
    const { errors } = normalizeApiV2Page({
      data: [],
      errors: [{ value: '1858000000000000000', title: 'Not Found Error', resource_type: 'tweet' }],
    }, { fetchedAt: '2026-11-20T10:00:00.000Z' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].post_id, '1858000000000000000');
    markDeleted(s.indexDb, errors[0].post_id, { detectedAt: '2026-11-20T10:00:00.000Z', source: 'api_v2' });
    const row = s.indexDb.prepare('SELECT * FROM x_post_deletions WHERE post_id = ?').get('1858000000000000000');
    assert.equal(row.source, 'api_v2');
    assert.equal(row.detected_at, '2026-11-20T10:00:00.000Z');
  } finally {
    s.close();
  }
});

test('a post whose AUTHOR is missing is not lost over a field the capture could not carry', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
      .map((record) => ({ ...record, handle: '' }));
    const result = importRecords({ ...s, account, records });
    assert.equal(result.invalid.length, 0, 'no post is invalid over a missing handle');
    assert.equal(result.otherUser, 0);
    assert.equal(result.new, 5, 'the posts are kept');
    const row = s.indexDb.prepare('SELECT handle FROM x_posts WHERE post_id = ?').get(IDS.original);
    assert.equal(row.handle, 'testtrader', 'the account\'s own handle stands in for it');
  } finally {
    s.close();
  }
});

test('a rename onto a handle another account holds is a rejection, not a crash', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    registry.addAccount(s.catalogDb, { handle: 'otherguy', userId: '999' });
    // A capture shows the account under the OTHER account's handle.
    const records = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
      .map((record) => ({ ...record, handle: 'otherguy' }));
    const result = importRecords({ ...s, account, records });
    assert.equal(result.new, 0, 'nothing is imported under an ambiguous identity');
    assert.ok(result.invalid.length > 0, 'the conflict is reported');
    assert.match(result.invalid[0].errors.join(' '), /belongs to account/);
    assert.equal(registry.getAccount(s.catalogDb, 'otherguy').handle, 'otherguy', 'the other account is untouched');
  } finally {
    s.close();
  }
});

test('an X run is visible in the SHARED catalog_runs table', () => {
  // Every other source writes a catalog_runs row, so a reader of that one
  // table sees every source's runs. X keeps its own x_crawl_runs table
  // (its windows and its ledger are X-shaped), but it writes this row too.
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader' });
    const runId = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 't1' });
    registry.addToRun(s.catalogDb, runId, { posts_seen: 12, posts_new: 9, posts_updated: 3 });
    registry.finishRun(s.catalogDb, runId, { status: 'ok', account, command: 'crawl --route api' });
    const row = s.catalogDb.prepare("SELECT * FROM catalog_runs WHERE channel = 'x'").get();
    assert.ok(row, 'the run is in the table every source writes to');
    assert.equal(row.source_url, 'https://x.com/testtrader');
    assert.equal(row.row_count, 12);
    assert.equal(row.inserted_count, 9);
    assert.equal(row.updated_count, 3);
    assert.equal(row.row_count_kind, '', 'the run counted POSTS, not the rows of a listing');
    const run = s.catalogDb.prepare('SELECT * FROM x_crawl_runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'ok');
    assert.ok(run.finished_at, 'the run is closed');
  } finally {
    s.close();
  }
});

test('the index rebuilds from the archive alone', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader' });
    importRecords({ ...s, account, records: normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records });
    const before = s.indexDb.prepare('SELECT post_id, text, kind, archive_path FROM x_posts ORDER BY post_id').all();
    s.indexDb.close();
    fs.rmSync(path.join(s.dir, 'x_index.sqlite'));
    const { posts } = rebuildIndex({ archiveRoot: s.archiveRoot, indexPath: path.join(s.dir, 'x_index.sqlite') });
    assert.equal(posts, before.length);
    s.indexDb = openIndex({ path: path.join(s.dir, 'x_index.sqlite') });
    const after = s.indexDb.prepare('SELECT post_id, text, kind, archive_path FROM x_posts ORDER BY post_id').all();
    assert.deepEqual(after.map((r) => [r.post_id, r.text, r.kind]), before.map((r) => [r.post_id, r.text, r.kind]));
  } finally {
    s.close();
  }
});

test('a post belongs to the trading session it can still be entered in', () => {
  assert.equal(eventSession('2026-11-18T14:32:08Z'), '2026-11-18', '09:32 ET Wednesday: that day');
  assert.equal(eventSession('2026-11-18T21:30:00Z'), '2026-11-19', '16:30 ET Wednesday: after the close, the next day');
  assert.equal(eventSession('2026-11-20T22:00:00Z'), '2026-11-23', 'Friday evening: Monday');
  assert.equal(eventSession('2026-11-21T15:00:00Z'), '2026-11-23', 'Saturday: Monday');
});

test('runs and windows: recorded at the start, resumable, counted as they go', () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader' });
    const runId = registry.startRun(s.catalogDb, { accountId: account.account_id, route: 'api', runTag: 't1' });
    const inserted = registry.ensureWindows(s.catalogDb, account.account_id, 'api', 'originals',
      [{ start: '2026-01-01', end: '2027-01-01' }, { start: '2025-01-01', end: '2026-01-01' }]);
    assert.equal(inserted, 2);
    assert.equal(registry.ensureWindows(s.catalogDb, account.account_id, 'api', 'originals', [{ start: '2026-01-01', end: '2027-01-01' }]), 0);
    const pending = registry.pendingWindows(s.catalogDb, account.account_id, 'api');
    assert.deepEqual(pending.map((w) => w.window_start), ['2026-01-01', '2025-01-01'], 'newest first');
    registry.updateWindow(s.catalogDb, pending[0].id, { status: 'complete' });
    registry.addToRun(s.catalogDb, runId, { posts_seen: 3, posts_new: 2 });
    registry.addToRun(s.catalogDb, runId, { posts_seen: 4 });
    const run = s.catalogDb.prepare('SELECT * FROM x_crawl_runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'running', 'an interrupted run still leaves its row');
    assert.equal(run.posts_seen, 7);
    assert.equal(registry.pendingWindows(s.catalogDb, account.account_id, 'api').length, 1);
  } finally {
    s.close();
  }
});
