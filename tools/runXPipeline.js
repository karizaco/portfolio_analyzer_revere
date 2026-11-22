'use strict';

/**
 * The X (x.com) source CLI. See docs/x-source-plan.md.
 *
 *   init                         create the tables and folders
 *   add --handle H [--profile P] [--person K] [--since YYYY-MM-DD] [--replies self|none] [--kinds setups,positions]
 *   list
 *   status --handle H [--json]
 *
 *   lookup --handle H                                   API, one user read ($0.01)
 *   estimate --handle H --budget-usd N --yes [--since D] [--until D]
 *                                                       API count requests ($0.01 each): posts and read cost per year
 *   crawl --route api --handle H --budget-usd N --yes [--since D] [--until D] [--unit year|month] [--max-posts N] [--incremental]
 *   crawl --route browser --handle H [--since D] [--until D] [--unit month|week] [--max-windows N] [--window-id ID]
 *         [--concurrency 1|2] [--headed] [--report json]
 *                                                       free (the user's own session, no API credits); headless by
 *                                                       default, --headed shows the window; at most 2 tabs at once
 *   crawl --route agent --handle H                      print the agentic runbook / prompt and the import command
 *   browser-import-cookies [--file EXPORT.json] [--headed]
 *                                                       carry an existing X session into the profile: X_AUTH_TOKEN
 *                                                       and X_CT0 from .env (or a Cookie-Editor export), then check it
 *   browser-login                                       open the browser profile and log into X by hand (once)
 *
 *   import --handle H (--raw-dir DIR | --file FILE)     import raw captures or agent JSONL
 *   rebuild-index                                       rebuild the untracked index from the tracked archive
 *   media --handle H [--limit N]                        download the photos of archived posts
 *   ocr --handle H [--limit N]                          Tesseract OCR of downloaded photos (cached)
 *   vision --handle H --budget-usd N --yes [--limit N] [--provider minimax|anthropic] [--model M]
 *                                                       vision reading of portfolio/position screenshots (MiniMax by
 *                                                       default: MiniMax-M3.1-Flash, or --model MiniMax-M3)
 *
 * Credentials come from .env (never printed): X_BEARER_TOKEN for the API,
 * X_AUTH_TOKEN + X_CT0 (the session cookies) for the browser, and
 * MINIMAX_API_KEY for the vision reader (ANTHROPIC_API_KEY with --provider anthropic).
 */

const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { loadEnv } = require('../src/transcript/loadEnv');
const registry = require('../src/x/registry');
const { openIndex, rebuildIndex, markDeleted, DEFAULT_INDEX_PATH } = require('../src/x/indexStore');
const { DEFAULT_ARCHIVE_ROOT } = require('../src/x/archive');
const { DEFAULT_RAW_ROOT, listRawFiles, makeRunTag, normalizeEnvelope, readRaw } = require('../src/x/rawStore');
const { importRecords, filteredTotal } = require('../src/x/importer');
const { describeProblem, readCookieExport, sessionCookiesFromEnv } = require('../src/x/browser/cookies');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function fail(message, code = 1) {
  console.error(`[x] ${message}`);
  process.exit(code);
}

function requireAccount(catalogDb, args) {
  if (!args.handle) fail('--handle is required');
  const account = registry.getAccount(catalogDb, String(args.handle));
  if (!account) fail(`@${args.handle} is not registered. Run: node tools/runXPipeline.js add --handle ${args.handle}`);
  return account;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/**
 * The X session cookies: from a Cookie-Editor export (--file) or from
 * .env (X_AUTH_TOKEN, X_CT0). Fails naming the cookies -- never a value.
 */
function sessionCookiesOrFail(args) {
  let result;
  if (args.file) {
    try {
      result = readCookieExport(String(args.file));
    } catch (error) {
      return fail(error.message);
    }
  } else {
    loadEnv();
    result = sessionCookiesFromEnv();
  }
  const problem = describeProblem(result);
  if (problem) fail(`the X session cookies are not usable -- ${problem}`);
  return result.cookies;
}

function apiClient() {
  loadEnv();
  // eslint-disable-next-line global-require
  const { createXApiClient } = require('../src/x/apiClient');
  return createXApiClient({
    bearerToken: process.env.X_BEARER_TOKEN,
    log: (line) => console.log(line),
  });
}

/**
 * The spending cap for an account, for TODAY.
 *
 * X bills a resource once per UTC DAY, so the cap is per account per UTC
 * day: a run that is interrupted and resumed, or a second run the same
 * day, must not start at $0. The day's spend so far is read from the
 * ledger and the budget starts there.
 *
 * @param {object} catalogDb
 * @param {object} args
 * @param {number} fallbackUsd
 * @param {object} [account]
 * @returns {object} the budget
 */
function budgetFrom(catalogDb, args, fallbackUsd, account) {
  // eslint-disable-next-line global-require
  const { createBudget } = require('../src/x/apiBudget');
  const budgetUsd = args['budget-usd'] === undefined ? fallbackUsd : Number(args['budget-usd']);
  if (!(budgetUsd >= 0)) fail('--budget-usd must be a number');
  let startingSpend = 0;
  let startingPosts = 0;
  if (account && account.account_id) {
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const spent = registry.apiSpendSince(catalogDb, account.account_id, dayStart);
    startingSpend = spent.usd;
    startingPosts = spent.posts;
    if (spent.usd > 0) {
      console.log(`[x] this account has already spent $${spent.usd.toFixed(3)} today (${spent.posts} posts); `
        + 'the budget starts there');
    }
  }
  return createBudget({
    budgetUsd,
    maxPosts: args['max-posts'] ? Number(args['max-posts']) : undefined,
    startingSpend,
    startingPosts,
  });
}

/**
 * Close a run, and record it in the shared `catalog_runs` table.
 *
 * @param {object} catalogDb
 * @param {number} runId
 * @param {string} status
 * @param {string} [stopReason]
 * @param {object} [account]
 * @param {string} [rawDir]
 */
function finishRun(catalogDb, runId, status, stopReason = '', account = null, rawDir = '') {
  registry.finishRun(catalogDb, runId, {
    status, stopReason, account, rawDir, command: process.argv.slice(2).join(' '),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\s*\/\*\*?/, ''));
    return;
  }

  const catalogDb = registry.openCatalog();
  try {
    if (command === 'init') {
      openIndex().close();
      console.log(`[x] catalog tables ready in ${relative(registry.CATALOG_DB_PATH)}`);
      console.log(`[x] index ready at ${relative(DEFAULT_INDEX_PATH)} (untracked)`);
      console.log(`[x] archive root ${relative(DEFAULT_ARCHIVE_ROOT)} (tracked)`);
      return;
    }

    if (command === 'add') {
      if (!args.handle) fail('--handle is required');
      const account = registry.addAccount(catalogDb, {
        handle: String(args.handle),
        profile: args.profile ? String(args.profile) : undefined,
        personKey: args.person ? String(args.person) : undefined,
        backfillSince: args.since ? String(args.since) : undefined,
        includeReplies: args.replies ? String(args.replies) : undefined,
        declaredKinds: args.kinds ? String(args.kinds) : undefined,
        userId: args['user-id'] ? String(args['user-id']) : undefined,
      });
      console.log(JSON.stringify(account, null, 2));
      return;
    }

    if (command === 'list') {
      const rows = registry.listAccounts(catalogDb);
      if (!rows.length) console.log('(no X accounts registered)');
      for (const row of rows) {
        console.log(`@${row.handle}  user=${row.user_id || '?'}  profile=${row.profile}  replies=${row.include_replies}`
          + `  since=${row.backfill_since || 'all'}${row.person_key ? `  person=${row.person_key}` : ''}`
          + `${row.tweet_count_at_lookup !== null ? `  posts_at_lookup=${row.tweet_count_at_lookup}` : ''}`);
      }
      return;
    }

    if (command === 'status') {
      const account = requireAccount(catalogDb, args);
      const status = registry.accountStatus(catalogDb, account.account_id);
      const indexDb = openIndex();
      const posts = account.user_id
        ? indexDb.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last,
            SUM(media_count > 0) AS with_media FROM x_posts WHERE user_id = ?`).get(account.user_id)
        : { n: 0 };
      indexDb.close();
      const payload = { account, posts, ...status };
      if (args.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`@${account.handle} (user ${account.user_id || 'not resolved yet'})`);
        console.log(`  archived posts: ${posts.n}${posts.n ? ` (${posts.first} .. ${posts.last}, ${posts.with_media} with media)` : ''}`);
        console.log(`  API spend so far (estimate): $${status.api_spend_usd.toFixed(3)}`);
        for (const w of status.windows) {
          console.log(`  windows ${w.route}/${w.query_kind} ${w.status}: ${w.n} (posts seen ${w.seen || 0}${w.expected ? ` of ~${w.expected}` : ''})`);
        }
        for (const run of status.runs) {
          console.log(`  run ${run.id} ${run.route} ${run.status} ${run.started_at} seen=${run.posts_seen} new=${run.posts_new}`
            + ` filtered=${run.posts_filtered} $${Number(run.api_cost_usd_est).toFixed(3)}${run.stop_reason ? ` stop=${run.stop_reason}` : ''}`);
        }
      }
      return;
    }

    if (command === 'lookup') {
      const account = requireAccount(catalogDb, args);
      // eslint-disable-next-line global-require
      const { lookupAccount } = require('../src/x/crawlApi');
      const client = apiClient();
      const runId = registry.startRun(catalogDb, { accountId: account.account_id, route: 'api', runTag: makeRunTag('lookup', account.handle) });
      try {
        const updated = await lookupAccount({
          catalogDb, client, budget: budgetFrom(catalogDb, args, 0.05, account), account, runId, log: console.log,
        });
        finishRun(catalogDb, runId, 'ok', '', updated);
        console.log(JSON.stringify(updated, null, 2));
      } catch (error) {
        finishRun(catalogDb, runId, 'failed', error.message.slice(0, 300), account);
        throw error;
      }
      return;
    }

    if (command === 'estimate') {
      const account = requireAccount(catalogDb, args);
      if (!args.yes) fail('estimate makes paid count requests ($0.01 each). Add --yes (and --budget-usd, default 3).');
      // eslint-disable-next-line global-require
      const { estimate, lookupAccount, todayUtc, ARCHIVE_START } = require('../src/x/crawlApi');
      const client = apiClient();
      const budget = budgetFrom(catalogDb, args, 3, account);
      const runId = registry.startRun(catalogDb, { accountId: account.account_id, route: 'api', runTag: makeRunTag('estimate', account.handle) });
      try {
        let current = account;
        if (!current.user_id) current = await lookupAccount({ catalogDb, client, budget, account: current, runId, log: console.log });
        const since = String(args.since || current.backfill_since || ARCHIVE_START);
        const until = String(args.until || todayUtc());
        const result = await estimate({ catalogDb, client, budget, account: current, since, until, runId, log: console.log });
        registry.updateRun(catalogDb, runId, { api_cost_usd_est: budget.spent });
        finishRun(catalogDb, runId, result.complete ? 'ok' : 'partial', result.complete ? '' : 'budget', current);
        console.log(`\n@${current.handle} ${since} .. ${until} (exclusive)`);
        for (const [kind, data] of Object.entries(result.kinds)) {
          console.log(`  ${kind.padEnd(13)} ${String(data.total).padStart(7)} posts   query: ${data.query}`);
          for (const [year, n] of Object.entries(data.byYear).sort()) console.log(`      ${year}: ${n}`);
        }
        console.log(`  TOTAL ${result.posts} posts -> a full API backfill would cost about $${result.readCost}`
          + ` (at $${budget.pricing.post_read}/post; an upper bound)`);
        console.log(`  this estimate cost $${budget.spent.toFixed(2)} (${result.requests} count requests)`
          + `${result.complete ? '' : ' -- INCOMPLETE, the budget ran out'}`);
      } catch (error) {
        finishRun(catalogDb, runId, 'failed', error.message.slice(0, 300), account);
        throw error;
      }
      return;
    }

    if (command === 'browser-import-cookies') {
      // eslint-disable-next-line global-require
      const { importSession } = require('../src/x/crawlBrowser');
      // Headless unless --headed: nothing here needs a person at the window.
      const result = await importSession({ cookies: sessionCookiesOrFail(args), log: console.log, headless: !args.headed });
      console.log(JSON.stringify(result, null, 2));
      if (!result.loggedIn) {
        fail(`X did not accept the session (${result.stop_reason}). Copy fresh auth_token and ct0 values from a `
          + 'window where you are logged in, and do not log out of that window.', 3);
      }
      if (args.file) console.log('[x] the session is in the profile now -- delete the cookie export file.');
      return;
    }

    if (command === 'browser-login') {
      // eslint-disable-next-line global-require
      const { browserLogin } = require('../src/x/crawlBrowser');
      const result = await browserLogin({ log: console.log });
      if (!result.loggedIn) fail('login was not completed in time');
      return;
    }

    if (command === 'crawl') {
      const account = requireAccount(catalogDb, args);
      const route = String(args.route || 'api');
      if (route === 'agent') {
        printAgentInstructions(account);
        return;
      }
      if (route === 'api') {
        if (!args.yes) fail('an API crawl reads paid posts ($0.005 each). Run `estimate` first, then add --yes --budget-usd N.');
        if (args['budget-usd'] === undefined) fail('--budget-usd is required for an API crawl');
        loadEnv();
        if (!process.env.X_BEARER_TOKEN) fail('X_BEARER_TOKEN is not set (put it in .env -- see docs/x-source-plan.md)');
      }
      const runTag = makeRunTag(route, account.handle);
      const rawDir = path.join(DEFAULT_RAW_ROOT, runTag);
      const indexDb = openIndex();
      const runId = registry.startRun(catalogDb, { accountId: account.account_id, route, runTag, rawDir });
      try {
        if (route === 'api') {
          if (!args.yes) fail('an API crawl reads paid posts ($0.005 each). Run `estimate` first, then add --yes --budget-usd N.');
          if (args['budget-usd'] === undefined) fail('--budget-usd is required for an API crawl');
          // eslint-disable-next-line global-require
          const { crawlWindows, incrementalSince, lookupAccount, todayUtc } = require('../src/x/crawlApi');
          const client = apiClient();
          let current = account;
          const budget = budgetFrom(catalogDb, args, 0, current);
          if (!current.user_id) current = await lookupAccount({ catalogDb, client, budget, account: current, runId, log: console.log });
          let since = args.since ? String(args.since) : undefined;
          if (args.incremental) {
            since = incrementalSince(catalogDb, current) || current.backfill_since || undefined;
            if (!since) fail('nothing to increment from: no complete window yet. Run a backfill first.');
          }
          const until = String(args.until || todayUtc());
          if (since && since >= until) {
            console.log(`[x] already up to date (through ${since})`);
            finishRun(catalogDb, runId, 'ok', '', current, rawDir);
            return;
          }
          const result = await crawlWindows({
            catalogDb, indexDb, client, budget, account: current, runId, rawDir, since, until,
            unit: args.unit ? String(args.unit) : (args.incremental ? 'month' : 'year'), log: console.log,
          });
          finishRun(catalogDb, runId, result.status, result.stopReason, current, rawDir);
          console.log(JSON.stringify({ route: 'api', handle: current.handle, ...result, spent_usd: budget.spent, run_id: runId }, null, 2));
          return;
        }
        if (route === 'browser') {
          // eslint-disable-next-line global-require
          const { crawlBrowserWindows } = require('../src/x/crawlBrowser');
          loadEnv();
          const session = sessionCookiesFromEnv();
          const report = await crawlBrowserWindows({
            catalogDb, indexDb, account, runId, rawDir,
            // The .env session, when one is there; otherwise the profile's own.
            sessionCookies: session.missing.length || session.malformed.length ? [] : session.cookies,
            since: args.since ? String(args.since) : undefined,
            until: args.until ? String(args.until) : undefined,
            unit: args.unit ? String(args.unit) : undefined,
            maxWindows: args['max-windows'] ? Number(args['max-windows']) : undefined,
            windowId: args['window-id'] ? Number(args['window-id']) : undefined,
            // The user's choices (2026-11-22): no window on their screen, and
            // never more than two tabs at once (clamped in src/x/browser/pacing.js).
            headless: !args.headed,
            concurrency: args.concurrency ? Number(args.concurrency) : 1,
            log: args.report === 'json' ? (line) => console.error(line) : console.log,
          });
          finishRun(catalogDb, runId, report.status, report.stop_reason, account, rawDir);
          console.log(JSON.stringify(report, null, 2));
          if (report.status !== 'ok') process.exitCode = report.stop_reason === 'account_locked' ? 4 : 3;
          return;
        }
        fail(`unknown route ${route} (api | browser | agent)`);
      } catch (error) {
        finishRun(catalogDb, runId, 'failed', String(error.message).slice(0, 300), account, rawDir);
        throw error;
      } finally {
        indexDb.close();
      }
    }

    if (command === 'import') {
      const account = requireAccount(catalogDb, args);
      const files = args['raw-dir'] ? listRawFiles(path.resolve(String(args['raw-dir'])))
        : (args.file ? [path.resolve(String(args.file))] : fail('--raw-dir or --file is required'));
      const indexDb = openIndex();
      const runId = registry.startRun(catalogDb, { accountId: account.account_id, route: 'import', runTag: makeRunTag('import', account.handle) });
      const totals = { files: 0, seen: 0, new: 0, updated: 0, filtered: 0, invalid: 0, rejected: 0, otherUser: 0 };
      try {
        for (const file of files) {
          let current = registry.getAccount(catalogDb, account.account_id);
          const known = new Map(current.user_id ? [[current.handle, current.user_id]] : []);
          for (const envelope of readRaw(file)) {
            const { records, rejected } = normalizeEnvelope(envelope, { knownUsers: known });
            totals.rejected += rejected.length;
            // A post X says it no longer has is an OBSERVATION, and it is
            // recorded: a deletion that is not recorded is a deletion
            // nobody can see (and the compliance pass cannot honour).
            for (const item of rejected) {
              if (!item.post_id) continue;
              markDeleted(indexDb, item.post_id, { runId, source: envelope.route || '', detail: item.reason || '' });
            }
            const result = importRecords({ catalogDb, indexDb, account: current, records });
            current = registry.getAccount(catalogDb, account.account_id);
            totals.seen += result.seen;
            totals.new += result.new;
            totals.updated += result.updated;
            totals.filtered += filteredTotal(result.filtered);
            totals.invalid += result.invalid.length;
            totals.otherUser += result.otherUser;
            if (result.otherUser) {
              console.error(`[x] ${result.otherUser} post(s) belong to another user id and were not imported`);
            }
            if (result.identityError) console.error(`[x] ${result.identityError}`);
            for (const bad of result.invalid.slice(0, 3)) console.error(`[x] invalid ${bad.post_id}: ${bad.errors.join('; ')}`);
          }
          totals.files += 1;
        }
        registry.updateRun(catalogDb, runId, {
          posts_seen: totals.seen, posts_new: totals.new, posts_updated: totals.updated, posts_filtered: totals.filtered,
          posts_other_user: totals.otherUser, posts_rejected: totals.rejected,
        });
        finishRun(catalogDb, runId, 'ok', '', account);
        console.log(JSON.stringify(totals, null, 2));
      } finally {
        indexDb.close();
      }
      return;
    }

    if (command === 'rebuild-index') {
      const result = rebuildIndex();
      console.log(`[x] rebuilt the index from the archive: ${result.posts} posts`);
      return;
    }

    if (command === 'media' || command === 'ocr' || command === 'vision') {
      // eslint-disable-next-line global-require
      const images = require('../src/x/images/runImages');
      const account = requireAccount(catalogDb, args);
      await images.run(command, { catalogDb, account, args, log: console.log });
      return;
    }

    fail(`unknown command ${command}. Run: node tools/runXPipeline.js help`);
  } finally {
    catalogDb.close();
  }
}

function printAgentInstructions(account) {
  console.log(`Agentic X crawl for @${account.handle}`);
  console.log('---------------------------------------');
  console.log('MODE A (default) -- Claude Code supervises the scripted browser crawler.');
  console.log('  Give Claude Code this runbook and the handle:');
  console.log('    tools/x_pipeline/agentic_runbook.md');
  console.log('  It runs one window at a time with:');
  console.log(`    node tools/runXPipeline.js crawl --route browser --handle ${account.handle} --max-windows 1 --report json`);
  console.log('  and acts on each JSON stop report. Post payloads never pass through the model.');
  console.log('');
  console.log('MODE B -- Claude drives the Playwright MCP browser itself (small gaps / diagnosis only).');
  console.log('    prompt:    tools/x_pipeline/agentic_prompt.md');
  console.log('    collector: tools/x_pipeline/collector.inpage.js');
  console.log('  It saves captured responses under data/x_pipeline/raw/<run>/ and you then import them:');
  console.log(`    node tools/runXPipeline.js import --handle ${account.handle} --raw-dir data/x_pipeline/raw/<run>`);
}

main().catch((error) => {
  console.error(`[x] failed: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
