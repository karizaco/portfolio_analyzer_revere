'use strict';

/**
 * The X registry and crawl audit, in the catalog (state.sqlite).
 *
 * Small tables only: accounts, their handle history, runs, windows and the
 * API ledger. The posts are in the archive (src/x/archive.js).
 *
 * TWO RULES
 *
 * 1. A HANDLE IS NOT AN IDENTITY. Handles are renamed and reused. Once an
 *    account's numeric user id is known it is fixed, and a capture that
 *    puts a DIFFERENT user id behind the same handle is refused -- importing
 *    it would silently merge two people's posts.
 * 2. A RUN IS RECORDED WHEN IT STARTS, and its counters are updated as it
 *    goes, so an interrupted run still leaves a row that says what it did.
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeHandle } = require('./postRecord');
const { toPortableArtifactPath } = require('../video/portablePaths');

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Open the catalog and make sure the X tables exist.
 *
 * The DERIVED file is attached too, through the repository's own helper:
 * `x_positions` and `x_image_readings` live in it, exactly as every
 * other source's interpretations do, and a second connection for them
 * would be a second place to forget to write. `attachDerived` is
 * idempotent, and a scratch catalog gets a sibling derived file rather
 * than the production one -- the repository's rule.
 *
 * @param {object} [options]
 * @param {string} [options.path]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openCatalog(options = {}) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  // eslint-disable-next-line global-require
  const { attachDerived, derivedPathFor } = require('../db/derivedStore');
  const file = options.path || CATALOG_DB_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrateCatalog(db);
  // The derived file is attached WITHOUT re-running its schema when it is
  // already there: the schema is a tracked file, and a read-only command
  // must not rewrite it. A scratch catalog gets a sibling derived file,
  // which does not exist yet, so it is created -- the repository's rule.
  const derivedPath = derivedPathFor(db);
  attachDerived(db, { createSchema: fs.existsSync(derivedPath) ? false : undefined });
  return db;
}

/**
 * Bring a catalog that was written by an older schema up to date.
 *
 * `CREATE TABLE IF NOT EXISTS` does NOT add a column to a table that
 * already exists, so a column added to the schema file is missing from a
 * catalog that was created before it. The column is added here, guarded
 * by the table's own definition -- the same rule the Python worker's
 * migrations follow.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateCatalog(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(x_crawl_runs)').all().map((row) => String(row.name)));
  for (const [name, ddl] of [['posts_other_user', 'INTEGER NOT NULL DEFAULT 0'],
    ['posts_rejected', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE x_crawl_runs ADD COLUMN ${name} ${ddl}`);
  }
}

/**
 * The reply policy, as it is stored.
 *
 * 'self' keeps the account's own posts, its own quotes and its own thread
 * replies; 'none' keeps only its own posts and quotes. A reply to somebody
 * else is never collected.
 *
 * @param {string} [value]
 * @returns {'self'|'none'}
 */
function normalizeReplies(value) {
  const text = String(value || '').trim();
  const policy = text || 'self';
  if (!['self', 'none'].includes(policy)) {
    throw new Error(`include_replies must be self or none (replies to other people are never collected), got ${value}`);
  }
  return policy;
}

/**
 * Register an account, or update its settings. Idempotent on the handle.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @returns {object} the account row
 */
function addAccount(db, input) {
  const handle = normalizeHandle(input.handle);
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error(`not an X handle: ${input.handle}`);
  const now = nowIso();
  const existing = getAccount(db, handle);
  if (existing) {
    // The value is normalised and checked on BOTH paths: the insert path
    // defaults an empty value to 'self', and the update path used to pass
    // an empty string straight to the CHECK constraint, which failed with
    // a raw SQLite error instead of a usable message.
    const includeReplies = normalizeReplies(input.includeReplies ?? existing.include_replies);
    const patch = {
      display_name: input.displayName ?? existing.display_name,
      profile: input.profile ?? existing.profile,
      declared_kinds: input.declaredKinds ?? existing.declared_kinds,
      person_key: input.personKey ?? existing.person_key,
      include_replies: includeReplies,
      backfill_since: input.backfillSince ?? existing.backfill_since,
    };
    db.prepare(`UPDATE x_accounts SET display_name = ?, profile = ?, declared_kinds = ?, person_key = ?,
        include_replies = ?, backfill_since = ?, updated_at = ? WHERE account_id = ?`).run(
      patch.display_name, patch.profile, patch.declared_kinds, patch.person_key, patch.include_replies,
      patch.backfill_since, now, existing.account_id,
    );
    if (input.userId) resolveUserId(db, existing.account_id, String(input.userId));
    return getAccount(db, existing.account_id);
  }
  db.prepare(`INSERT INTO x_accounts (user_id, handle, display_name, profile, declared_kinds, person_key,
      include_replies, backfill_since, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.userId ? String(input.userId) : null,
    handle,
    input.displayName || '',
    input.profile || 'generic',
    input.declaredKinds || '',
    input.personKey || '',
    normalizeReplies(input.includeReplies),
    input.backfillSince || '',
    now,
    now,
  );
  const account = getAccount(db, handle);
  noteHandle(db, account.account_id, handle);
  return account;
}

/**
 * Look an account up by handle, account id, or user id.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|number} key
 * @returns {object|null}
 */
function getAccount(db, key) {
  if (typeof key === 'number') {
    return db.prepare('SELECT * FROM x_accounts WHERE account_id = ?').get(key) || null;
  }
  const text = String(key || '');
  if (/^\d+$/.test(text)) {
    const byUser = db.prepare('SELECT * FROM x_accounts WHERE user_id = ?').get(text);
    if (byUser) return byUser;
  }
  return db.prepare('SELECT * FROM x_accounts WHERE handle = ?').get(normalizeHandle(text)) || null;
}

/** @returns {object[]} */
function listAccounts(db) {
  return db.prepare('SELECT * FROM x_accounts ORDER BY account_id').all();
}

function noteHandle(db, accountId, handle) {
  const now = nowIso();
  db.prepare(`INSERT INTO x_account_handles (account_id, handle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, handle) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(accountId, handle, now, now);
}

/**
 * Fix the account's user id (rule 1).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} userId
 * @param {string} [handleSeen] - the handle the capture showed, if any
 */
function resolveUserId(db, accountId, userId, handleSeen) {
  const account = getAccount(db, accountId);
  if (!account) throw new Error(`no account ${accountId}`);
  if (account.user_id && account.user_id !== String(userId)) {
    throw new Error(`@${account.handle} is user ${account.user_id}, but a capture shows user ${userId} -- `
      + 'the handle was renamed or reused. Refusing to merge two accounts.');
  }
  if (!account.user_id) {
    const other = db.prepare('SELECT handle FROM x_accounts WHERE user_id = ?').get(String(userId));
    if (other) throw new Error(`user ${userId} is already registered as @${other.handle}`);
    db.prepare('UPDATE x_accounts SET user_id = ?, updated_at = ? WHERE account_id = ?').run(String(userId), nowIso(), accountId);
  }
  const seen = normalizeHandle(handleSeen || '');
  if (seen && seen !== account.handle) {
    // The same user id under a new handle: a RENAME. Follow it -- unless
    // another account already holds that handle, in which case the capture
    // is ambiguous and the raw UNIQUE-constraint error would abort the
    // whole import instead of naming the conflict.
    const holder = db.prepare('SELECT account_id FROM x_accounts WHERE handle = ? AND account_id != ?').get(seen, accountId);
    if (holder) {
      throw new Error(`the handle @${seen} belongs to account ${holder.account_id}, so @${account.handle}'s rename `
        + `to @${seen} cannot be applied. Resolve the two accounts by hand.`);
    }
    db.prepare('UPDATE x_accounts SET handle = ?, updated_at = ? WHERE account_id = ?').run(seen, nowIso(), accountId);
  }
  if (seen) noteHandle(db, accountId, seen);
}

/**
 * Store what a user lookup returned.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {object} user - API v2 user object
 */
function recordLookup(db, accountId, user) {
  resolveUserId(db, accountId, String(user.id), user.username);
  const metrics = user.public_metrics || {};
  db.prepare(`UPDATE x_accounts SET display_name = ?, protected = ?, tweet_count_at_lookup = ?,
      followers_at_lookup = ?, account_created_at = ?, looked_up_at = ?, updated_at = ? WHERE account_id = ?`).run(
    user.name || '', user.protected ? 1 : 0, metrics.tweet_count ?? null, metrics.followers_count ?? null,
    user.created_at || '', nowIso(), nowIso(), accountId,
  );
}

/**
 * Start a run.
 *
 * @returns {number} run id
 */
function startRun(db, { accountId, route, runTag, rawDir = '', kind = 'live' }) {
  // The raw directory is STORED the repository's way: relative to the
  // repository root when it is inside it, absolute when it is outside --
  // because the catalog is COMMITTED, and a path naming one machine's
  // home directory resolves nowhere on a clone.
  const result = db.prepare(`INSERT INTO x_crawl_runs (account_id, route, run_tag, started_at, raw_dir, kind)
    VALUES (?, ?, ?, ?, ?, ?)`).run(accountId, route, runTag, nowIso(),
  toPortableArtifactPath(rawDir, { repoRoot: ROOT }), kind);
  return Number(result.lastInsertRowid);
}

const RUN_FIELDS = ['status', 'windows_planned', 'windows_complete', 'posts_seen', 'posts_new', 'posts_updated',
  'posts_filtered', 'posts_other_user', 'posts_rejected', 'api_cost_usd_est', 'stop_reason', 'finished_at'];

/**
 * Update a run's counters/status.
 */
function updateRun(db, runId, patch) {
  const keys = Object.keys(patch).filter((key) => RUN_FIELDS.includes(key));
  if (!keys.length) return;
  db.prepare(`UPDATE x_crawl_runs SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((key) => patch[key]), runId);
}

/**
 * Add a run's counters (incrementally, as a run goes).
 */
function addToRun(db, runId, deltas) {
  const keys = Object.keys(deltas).filter((key) => ['posts_seen', 'posts_new', 'posts_updated', 'posts_filtered',
    'posts_other_user', 'posts_rejected', 'api_cost_usd_est', 'windows_complete'].includes(key));
  if (!keys.length) return;
  db.prepare(`UPDATE x_crawl_runs SET ${keys.map((key) => `${key} = ${key} + ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((key) => deltas[key]), runId);
}

/**
 * Make sure the planned windows exist (existing rows keep their state).
 *
 * @returns {number} windows inserted
 */
function ensureWindows(db, accountId, route, queryKind, windows) {
  const insert = db.prepare(`INSERT OR IGNORE INTO x_crawl_windows (account_id, query_kind, window_start, window_end,
      route, count_expected, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  for (const window of windows) {
    const result = insert.run(accountId, queryKind, window.start, window.end, route, window.expected ?? null, nowIso());
    inserted += Number(result.changes || 0);
  }
  return inserted;
}

/**
 * Windows still to do, newest first.
 */
function pendingWindows(db, accountId, route, queryKind) {
  const params = [accountId, route];
  let sql = `SELECT * FROM x_crawl_windows WHERE account_id = ? AND route = ?
    AND status IN ('pending', 'running', 'partial', 'failed')`;
  if (queryKind) {
    sql += ' AND query_kind = ?';
    params.push(queryKind);
  }
  sql += ' ORDER BY window_start DESC, query_kind';
  return db.prepare(sql).all(...params);
}

const WINDOW_FIELDS = ['status', 'count_expected', 'posts_seen', 'oldest_seen', 'newest_seen', 'next_token',
  'last_run_id', 'stop_reason'];

function updateWindow(db, windowId, patch) {
  const keys = Object.keys(patch).filter((key) => WINDOW_FIELDS.includes(key));
  if (!keys.length) return;
  db.prepare(`UPDATE x_crawl_windows SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((key) => patch[key]), nowIso(), windowId);
}

/**
 * The ranges the account's windows already cover.
 *
 * Every window that exists -- complete, in progress, or failed -- covers
 * its own range, so a re-plan is reduced to what is left. (A window that
 * is being resumed is covering its range; without this a re-plan would
 * create a SECOND window over the same ground and crawl it twice.)
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} queryKind
 * @param {string} route
 * @returns {Array<{start: string, end: string}>}
 */
function windowRanges(db, accountId, queryKind, route) {
  const params = [accountId, route];
  let sql = 'SELECT window_start, window_end FROM x_crawl_windows WHERE account_id = ? AND route = ?';
  if (queryKind) {
    sql += ' AND query_kind = ?';
    params.push(queryKind);
  }
  sql += ' ORDER BY window_start';
  return db.prepare(sql).all(...params).map((row) => ({ start: row.window_start, end: row.window_end }));
}

/**
 * The account's posting density, in posts a day.
 *
 * The browser route has no count endpoint, so its expected count comes
 * from the density of the windows it has already crawled -- the only
 * estimate available there.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} route
 * @param {string} queryKind
 * @returns {number} posts a day, or 0 when nothing has been observed
 */
function windowDensity(db, accountId, route, queryKind) {
  const rows = db.prepare(`SELECT window_start, window_end, posts_seen FROM x_crawl_windows
    WHERE account_id = ? AND route = ? AND query_kind = ? AND posts_seen > 0`).all(accountId, route, queryKind);
  let posts = 0;
  let days = 0;
  for (const row of rows) {
    const span = (Date.parse(`${row.window_end}T00:00:00Z`) - Date.parse(`${row.window_start}T00:00:00Z`)) / 86400000;
    if (!(span > 0)) continue;
    posts += row.posts_seen;
    days += span;
  }
  return days > 0 ? posts / days : 0;
}

/**
 * Close a run, and record it in the SHARED run table.
 *
 * Every other source writes a `catalog_runs` row, so a reader of that
 * table sees every source's runs. X keeps its own `x_crawl_runs` table
 * (its windows and its ledger are X-shaped), but it ALSO writes one
 * `catalog_runs` row -- otherwise an X run is invisible to the one table
 * a reader looks at.
 *
 * `row_count_kind` is '' on purpose: the run counted POSTS, not the rows
 * of a channel listing, and the column exists so that two runs whose
 * `row_count` means different things are not compared.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @param {object} options
 * @param {string} options.status - ok | partial | blocked | failed
 * @param {string} [options.stopReason]
 * @param {object} [options.account] - an x_accounts row
 * @param {string} [options.command] - the command that ran
 * @param {string} [options.rawDir]
 * @param {string} [options.kind] - live | fixture
 * @returns {number|null} the catalog_runs row id
 */
function finishRun(db, runId, options) {
  const status = options.status || 'ok';
  const stopReason = options.stopReason || '';
  updateRun(db, runId, { status, stop_reason: stopReason, finished_at: nowIso() });
  const run = db.prepare('SELECT * FROM x_crawl_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const complete = run.windows_planned > 0 && run.windows_complete >= run.windows_planned;
  const account = options.account || null;
  const result = db.prepare(`INSERT INTO catalog_runs (source_url, command_json, raw_output_path, row_count,
      inserted_count, updated_count, missing_upload_dates, malformed_rows, created_at, channel, kind,
      not_listed_count, listing_complete, row_count_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    account ? `https://x.com/${account.handle}` : '',
    options.command || '',
    toPortableArtifactPath(options.rawDir || '', { repoRoot: ROOT }),
    run.posts_seen,
    run.posts_new,
    run.posts_updated,
    0,
    0,
    nowIso(),
    'x',
    options.kind || run.kind || 'live',
    0,
    complete ? 1 : 0,
    '',
  );
  return Number(result.lastInsertRowid);
}

/**
 * What an account has spent on the API since a moment.
 *
 * X bills a resource once per UTC day, so the spending cap is per account
 * per UTC day -- and this is what the budget is seeded from. A run that
 * starts at $0 every time would let a day exceed its cap by however many
 * runs were started.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} sinceIso - an ISO instant, inclusive
 * @returns {{usd: number, posts: number}}
 */
function apiSpendSince(db, accountId, sinceIso) {
  const row = db.prepare(`SELECT COALESCE(SUM(u.est_cost_usd), 0) AS usd,
      COALESCE(SUM(CASE WHEN u.unit = 'post_read' THEN u.resources_returned ELSE 0 END), 0) AS posts
    FROM x_api_usage u JOIN x_crawl_runs r ON r.id = u.run_id
    WHERE r.account_id = ? AND u.requested_at >= ?`).get(accountId, sinceIso);
  return { usd: Number(row.usd || 0), posts: Number(row.posts || 0) };
}

/**
 * Is this date range already covered by a COMPLETE window on any route?
 */
function coveredByCompleteWindow(db, accountId, queryKinds, start, end) {
  const placeholders = queryKinds.map(() => '?').join(', ');
  const row = db.prepare(`SELECT 1 FROM x_crawl_windows WHERE account_id = ? AND status = 'complete'
    AND query_kind IN (${placeholders}) AND window_start <= ? AND window_end >= ? LIMIT 1`).get(accountId, ...queryKinds, start, end);
  return Boolean(row);
}

function recordApiUsage(db, row) {
  db.prepare(`INSERT INTO x_api_usage (run_id, endpoint, requested_at, http_status, resources_returned, unit,
      unit_price_usd, est_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.runId ?? null, row.endpoint, row.requestedAt || nowIso(), row.httpStatus ?? null, row.resources || 0,
    row.unit, row.unitPrice, row.cost,
  );
}

/**
 * A summary for `status`.
 */
function accountStatus(db, accountId) {
  const windows = db.prepare(`SELECT route, query_kind, status, COUNT(*) AS n, SUM(posts_seen) AS seen,
      SUM(count_expected) AS expected FROM x_crawl_windows WHERE account_id = ?
    GROUP BY route, query_kind, status ORDER BY route, query_kind, status`).all(accountId);
  const runs = db.prepare(`SELECT id, route, run_tag, started_at, finished_at, status, posts_seen, posts_new,
      posts_updated, posts_filtered, api_cost_usd_est, stop_reason FROM x_crawl_runs WHERE account_id = ?
    ORDER BY id DESC LIMIT 5`).all(accountId);
  const spend = db.prepare(`SELECT COALESCE(SUM(u.est_cost_usd), 0) AS usd FROM x_api_usage u
    JOIN x_crawl_runs r ON r.id = u.run_id WHERE r.account_id = ?`).get(accountId);
  return { windows, runs, api_spend_usd: Number(spend.usd || 0) };
}

module.exports = {
  CATALOG_DB_PATH,
  accountStatus,
  addAccount,
  addToRun,
  apiSpendSince,
  coveredByCompleteWindow,
  ensureWindows,
  finishRun,
  getAccount,
  listAccounts,
  normalizeReplies,
  openCatalog,
  pendingWindows,
  recordApiUsage,
  recordLookup,
  resolveUserId,
  startRun,
  updateRun,
  updateWindow,
  windowDensity,
  windowRanges,
};
