#!/usr/bin/env node
'use strict';

/**
 * Check `--query split` LIVE against an account's completed `all_own` crawl,
 * without touching the real catalog, index or archive.
 *
 *   node tools/x_pipeline/checkSplitQuery.js --handle chickengenius [--scratch DIR] [--rounds 4]
 *
 * The account's complete browser `all_own` windows define a date range. The
 * same range is crawled again with the split queries (originals, then
 * self-replies) into a SCRATCH catalog, index and archive, and the two
 * archives are compared post by post over that range.
 *
 * They must hold the same own posts. The split queries only stop FETCHING
 * what the importer drops anyway (replies to other people, reposts), so a
 * post the `all_own` crawl kept and the split crawl did not is a post the
 * split mode would lose. That is the failure this check exists to catch.
 *
 * A small tolerance (2 posts, or 1 %) absorbs posts deleted or edited since
 * the original crawl; every difference is printed either way, so a person can
 * read them. A post only the split crawl found is reported and does not fail
 * the check.
 *
 * Exit 0 when the archives agree, 1 when the split crawl lost posts, 3 when
 * the crawl stopped (a login wall, a challenge) or never completed enough of
 * the range to compare.
 */

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { loadEnv } = require('../../src/transcript/loadEnv');
const registry = require('../../src/x/registry');
const { openIndex } = require('../../src/x/indexStore');
const { DEFAULT_ARCHIVE_ROOT } = require('../../src/x/archive');
const { makeRunTag } = require('../../src/x/rawStore');
const { sessionCookiesFromEnv } = require('../../src/x/browser/cookies');
const { crawlBrowserWindows } = require('../../src/x/crawlBrowser');

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const RETRYABLE = new Set(['rate_limited', 'network_error', 'x_error_page', 'no_graphql']);
const SPLIT_KINDS = ['originals', 'self_replies'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i += 1; }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every archived record of one user, by post id. */
function readArchive(root, userId) {
  const posts = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          posts.set(record.post_id, record);
        }
      }
    }
  };
  walk(path.join(root, String(userId)));
  return posts;
}

/** The date ranges both split kinds completed, as [start, end) pairs. */
function coveredRanges(db, accountId) {
  const byKind = SPLIT_KINDS.map((kind) => db.prepare(`SELECT window_start s, window_end e FROM x_crawl_windows
    WHERE account_id = ? AND route = 'browser' AND query_kind = ? AND status = 'complete' ORDER BY window_start`)
    .all(accountId, kind));
  const days = (rows) => {
    const set = new Set();
    for (const { s, e } of rows) {
      for (let d = new Date(`${s}T00:00:00Z`); d.toISOString().slice(0, 10) < e; d.setUTCDate(d.getUTCDate() + 1)) {
        set.add(d.toISOString().slice(0, 10));
      }
    }
    return set;
  };
  const [a, b] = byKind.map(days);
  return new Set([...a].filter((day) => b.has(day)));
}

const describe = (r) => `${r.post_id}  ${r.created_at}  ${r.kind}${r.self_thread ? ' (self-thread)' : ''}  `
  + `${String(r.text || '').replace(/\s+/g, ' ').slice(0, 70)}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.handle) {
    console.error('usage: checkSplitQuery.js --handle H [--scratch DIR] [--rounds 4]');
    process.exit(2);
  }
  const handle = String(args.handle).replace(/^@/, '').toLowerCase();
  const rounds = Number(args.rounds || 4);
  const scratch = path.resolve(String(args.scratch
    || path.join(require('node:os').tmpdir(), `x_split_check_${handle}_${Date.now()}`)));
  if (scratch.toLowerCase().startsWith(ROOT.toLowerCase())) {
    console.error('[split-check] the scratch directory must be outside the repository');
    process.exit(2);
  }

  // The real catalog is only READ.
  const { DatabaseSync } = require('node:sqlite');
  const real = new DatabaseSync(CATALOG, { readOnly: true });
  const account = real.prepare('SELECT * FROM x_accounts WHERE handle = ?').get(handle);
  if (!account || !account.user_id) throw new Error(`@${handle} is not registered with a user id`);
  const span = real.prepare(`SELECT MIN(window_start) s, MAX(window_end) e, COUNT(*) n,
      SUM(status = 'complete') done FROM x_crawl_windows
    WHERE account_id = ? AND route = 'browser' AND query_kind = 'all_own'`).get(account.account_id);
  real.close();
  if (!span.n || span.done !== span.n) {
    throw new Error(`@${handle}: ${span.done || 0} of ${span.n || 0} all_own windows are complete -- `
      + 'the comparison needs a finished crawl');
  }
  console.log(`[split-check] @${handle}: the all_own crawl covers ${span.s}..${span.e} in ${span.n} windows`);
  console.log(`[split-check] scratch: ${scratch}`);

  fs.mkdirSync(scratch, { recursive: true });
  const catalogDb = registry.openCatalog({ path: path.join(scratch, 'catalog.sqlite') });
  const indexDb = openIndex({ path: path.join(scratch, 'index.sqlite') });
  const archiveRoot = path.join(scratch, 'archive');
  let scratchAccount = registry.getAccount(catalogDb, handle) || registry.addAccount(catalogDb, {
    handle, userId: String(account.user_id), backfillSince: span.s,
    includeReplies: account.include_replies || undefined,
    declaredKinds: account.declared_kinds || undefined,
  });
  scratchAccount = registry.getAccount(catalogDb, scratchAccount.account_id);

  loadEnv();
  const session = sessionCookiesFromEnv();
  let last = null;
  for (let round = 1; round <= rounds; round += 1) {
    const runTag = makeRunTag('browser', handle);
    const runId = registry.startRun(catalogDb, { accountId: scratchAccount.account_id, route: 'browser', runTag, kind: 'fixture' });
    console.log(`[split-check] round ${round} of ${rounds}`);
    // eslint-disable-next-line no-await-in-loop
    last = await crawlBrowserWindows({
      catalogDb, indexDb, account: scratchAccount, runId, archiveRoot,
      rawDir: path.join(scratch, 'raw', runTag),
      sessionCookies: session.missing.length || session.malformed.length ? [] : session.cookies,
      since: span.s, until: span.e, maxWindows: 80, headless: true, concurrency: 1, queryMode: 'split',
      log: (line) => console.log(line),
    });
    const pending = last.windows.filter((w) => w.status !== 'complete').length;
    console.log(`[split-check] round ${round}: ${last.status}${last.stop_reason ? ` (${last.stop_reason})` : ''}, `
      + `${last.windows.length - pending}/${last.windows.length} window(s) complete`);
    if (last.status === 'ok' && !/left for the next session/.test(last.message || '') && !pending) break;
    if (last.status !== 'ok' && !RETRYABLE.has(last.stop_reason)) {
      console.log(`[split-check] STOPPED: ${last.message}`);
      process.exitCode = 3;
      return;
    }
    if (round === rounds) break;
    const waitMs = last.retry_at ? Math.max(0, Date.parse(last.retry_at) - Date.now()) + 3 * 60 * 1000 : 10 * 60 * 1000;
    console.log(`[split-check] waiting ${Math.round(waitMs / 60000)} min before the next round`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(waitMs);
  }

  // The comparison, over the days both split kinds completed.
  const covered = coveredRanges(catalogDb, scratchAccount.account_id);
  const totalDays = Math.round((Date.parse(`${span.e}T00:00:00Z`) - Date.parse(`${span.s}T00:00:00Z`)) / 86400000);
  const share = totalDays ? covered.size / totalDays : 0;
  console.log(`[split-check] both split queries completed ${covered.size} of ${totalDays} days (${(share * 100).toFixed(1)} %)`);
  if (share < 0.9) {
    console.log('[split-check] too little of the range completed to compare -- run it again later');
    process.exitCode = 3;
    return;
  }
  const inRange = (r) => covered.has(String(r.created_at).slice(0, 10));
  const before = [...readArchive(DEFAULT_ARCHIVE_ROOT, account.user_id).values()].filter(inRange);
  const after = [...readArchive(archiveRoot, account.user_id).values()].filter(inRange);
  const afterIds = new Set(after.map((r) => r.post_id));
  const beforeIds = new Set(before.map((r) => r.post_id));
  const lost = before.filter((r) => !afterIds.has(r.post_id));
  const found = after.filter((r) => !beforeIds.has(r.post_id));
  const count = (rows) => rows.reduce((acc, r) => {
    const key = r.self_thread ? 'self-thread' : r.kind;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log(`[split-check] all_own archive: ${before.length} own posts ${JSON.stringify(count(before))}`);
  console.log(`[split-check] split archive:   ${after.length} own posts ${JSON.stringify(count(after))}`);
  console.log(`[split-check] only in all_own (the split crawl lost them): ${lost.length}`);
  for (const r of lost) console.log(`  - ${describe(r)}`);
  console.log(`[split-check] only in split (not a failure): ${found.length}`);
  for (const r of found) console.log(`  + ${describe(r)}`);
  const tolerance = Math.max(2, Math.floor(before.length * 0.01));
  const pass = lost.length <= tolerance;
  console.log(`[split-check] ${pass ? 'PASS' : 'FAIL'}: ${lost.length} lost, tolerance ${tolerance}`);
  process.exitCode = pass ? 0 : 1;
  indexDb.close();
  catalogDb.close();
}

main().catch((error) => {
  console.error(`[split-check] failed: ${error.message}`);
  process.exit(3);
});
