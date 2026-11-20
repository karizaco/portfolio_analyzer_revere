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
const { openIndex, rebuildIndex } = require('../src/x/indexStore');
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
