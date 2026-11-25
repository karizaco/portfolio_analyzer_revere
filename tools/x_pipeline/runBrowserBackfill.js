#!/usr/bin/env node
'use strict';

/**
 * An unattended browser backfill over several accounts, in sessions.
 *
 *   node tools/x_pipeline/runBrowserBackfill.js --handles chickengenius,BoujeeFinances
 *        [--session-windows 12] [--break-minutes 10] [--concurrency 1] [--headed]
 *        [--since D] [--until D] [--query all|split]
 *
 * Each SESSION is one `runXPipeline.js crawl --route browser` with a window
 * cap. Between sessions there is a break, and an account is finished when a
 * session finds no pending window left. It costs no API credits: the
 * browser route reads with the user's own X session.
 *
 * WHAT STOPS IT, and it never retries tighter:
 *
 * - `rate_limited` with a retry time: it waits until X's own reset (plus a
 *   few minutes) and goes on. That is X's schedule, not a retry.
 * - A lost connection, X's "Something went wrong" page, or a session that
 *   ended without a report (`network_error`, `x_error_page`, `no_graphql`,
 *   a crash): it waits and tries again, up to six times in a row -- 10, 20,
 *   then 30 minutes for a lost connection, 30, 60, then 90 for the others.
 *   A session that completed a window before it failed restarts that count,
 *   because the failure followed progress, not a run of failures.
 * - THE COMPUTER SLEPT during the session: it waits 5 minutes for the
 *   network to come back and tries again, and the stop does not count.
 *   The process is frozen while asleep; on waking, the page in flight fails
 *   (measured three times on 2026-11-23, each within two minutes of the
 *   wake), its window stays resumable, and the next session picks it up.
 *   Counting those failures cost a 90-minute wait after a one-hour
 *   hibernation. A sleep is detected as a jump in the wall clock between
 *   two 30-second ticks.
 * - ANY other stop (a login wall, a challenge, a locked account): it stops
 *   for good and exits non-zero, so a person looks before anything else
 *   runs.
 * - Two sessions in a row that completed no window: it stops, because
 *   something is wrong that a third session would not fix.
 *
 * Every session's report is appended to data/x_pipeline/raw/backfill_<stamp>.jsonl
 * (untracked, like the raw captures).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'tools', 'runXPipeline.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[arg.slice(2)] = true;
    else { out[arg.slice(2)] = next; i += 1; }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stops that are about the connection or X's page, not about the account.
const TRANSIENT = new Set(['network_error', 'x_error_page', 'no_graphql']);
const MAX_TRANSIENT_IN_A_ROW = 6;
// A lost connection is waited out for 10, 20, then 30 minutes. X's own
// error page gets three times longer (30, 60, 90): on 2026-11-22 it appeared
// after about 80 searches in 80 minutes, well inside the published
// allowance, so it may be a softer limit of X's, and that gets more room.
const transientWaitMs = (attempt, reason) => Math.min(attempt, 3) * (reason === 'network_error' ? 10 : 30) * 60 * 1000;
// After a sleep, the wait is for the network to come back, not for X.
const WAKE_WAIT_MS = 5 * 60 * 1000;
// A tick is due every 30 s; a gap this long means the machine was asleep.
const TICK_MS = 30 * 1000;
const SLEEP_GAP_MS = 3 * 60 * 1000;

/**
 * What to do after a transient stop.
 *
 *   attempt     the transient stops counted so far for this account
 *   reason      the stop reason (`network_error` waits less than the others)
 *   slept       the computer slept during the session
 *   progressed  the session completed at least one window before it stopped
 *
 * Returns the new count, the wait, and whether the stop was counted.
 */
function transientPlan({ attempt, reason, slept, progressed }) {
  if (slept) return { attempt, waitMs: WAKE_WAIT_MS, counted: false };
  const next = progressed ? 1 : attempt + 1;
  return { attempt: next, waitMs: transientWaitMs(next, reason), counted: true };
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** One crawl session; resolves to its JSON report, or null when there was none. */
function crawlSession(handle, args) {
  const argv = [CLI, 'crawl', '--route', 'browser', '--handle', handle,
    '--max-windows', String(args.sessionWindows), '--concurrency', String(args.concurrency), '--report', 'json'];
  if (args.headed) argv.push('--headed');
  if (args.query) argv.push('--query', args.query);
  if (args.since) argv.push('--since', args.since);
  if (args.until) argv.push('--until', args.until);
  return new Promise((resolve) => {
    // The crawl's progress lines go to stderr; they are passed through as
    // they come, so a long session is never a silent one.
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => {
      const at = stdout.indexOf('{');
      let report = null;
      try { report = at >= 0 ? JSON.parse(stdout.slice(at)) : null; } catch (_) { report = null; }
      resolve({ code, report, stdout });
    });
  });
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (!raw.handles) {
    console.error('usage: runBrowserBackfill.js --handles a,b,c [--session-windows 12] [--break-minutes 10] '
      + '[--concurrency 1] [--headed] [--since D] [--until D] [--query all|split]');
    process.exit(2);
  }
  const args = {
    handles: String(raw.handles).split(',').map((h) => h.trim()).filter(Boolean),
    sessionWindows: Number(raw['session-windows'] || 12),
    breakMs: Number(raw['break-minutes'] || 10) * 60 * 1000,
    concurrency: Number(raw.concurrency || 1),
    headed: Boolean(raw.headed),
    since: raw.since ? String(raw.since) : '',
    until: raw.until ? String(raw.until) : '',
    query: raw.query ? String(raw.query) : '',
  };
  const logFile = path.join(ROOT, 'data', 'x_pipeline', 'raw', `backfill_${stamp().replace(/[-:]/g, '')}.jsonl`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const totals = {};

  // The wall clock jumps when the machine sleeps; a 30-second tick sees it.
  const clock = { last: Date.now(), sleptAt: 0 };
  const tick = () => {
    const now = Date.now();
    if (now - clock.last > SLEEP_GAP_MS) clock.sleptAt = now;
    clock.last = now;
  };
  setInterval(tick, TICK_MS).unref();

  for (const handle of args.handles) {
    totals[handle] = { sessions: 0, windows_complete: 0, windows_other: 0, posts_new: 0, posts_filtered: 0 };
    let idle = 0;
    let transient = 0;
    // Wait and try again after a transient stop; false once the budget is spent.
    const retryLater = async (why, { reason = '', slept = false, progressed = false } = {}) => {
      const plan = transientPlan({ attempt: transient, reason, slept, progressed });
      transient = plan.attempt;
      if (plan.counted && transient > MAX_TRANSIENT_IN_A_ROW) {
        console.log(`[backfill] @${handle}: ${why} -- ${MAX_TRANSIENT_IN_A_ROW} times in a row, stopping.`);
        return false;
      }
      const note = plan.counted ? `${transient} of ${MAX_TRANSIENT_IN_A_ROW}` : 'the computer slept; not counted';
      console.log(`[backfill] @${handle}: ${why}; trying again in ${Math.round(plan.waitMs / 60000)} min (${note}).`);
      await sleep(plan.waitMs);
      return true;
    };
    for (;;) {
      console.log(`[backfill] ${stamp()} @${handle}: session ${totals[handle].sessions + 1}`);
      const startedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const { code, report } = await crawlSession(handle, args);
      tick();
      const slept = clock.sleptAt >= startedAt;
      fs.appendFileSync(logFile, `${JSON.stringify({ at: stamp(), handle, code, slept, report })}\n`);
      if (!report) {
        // eslint-disable-next-line no-await-in-loop
        if (await retryLater(`the crawl ended (exit ${code}) without a report`, { slept })) continue;
        process.exitCode = 1;
        return finish(totals, logFile);
      }
      totals[handle].sessions += 1;
      const complete = report.windows.filter((w) => w.status === 'complete').length;
      totals[handle].windows_complete += complete;
      totals[handle].windows_other += report.windows.length - complete;
      totals[handle].posts_new += report.posts_new || 0;
      totals[handle].posts_filtered += report.posts_filtered || 0;
      console.log(`[backfill] @${handle}: ${complete}/${report.windows.length} window(s) complete, `
        + `${report.posts_new} new post(s); allowance ${JSON.stringify(report.allowance || null)}`);

      if (report.status !== 'ok') {
        if (report.stop_reason === 'rate_limited' && report.retry_at) {
          const waitMs = Math.max(0, Date.parse(report.retry_at) - Date.now()) + (2 + Math.random() * 3) * 60 * 1000;
          console.log(`[backfill] X's allowance resets at ${report.retry_at}; waiting ${Math.round(waitMs / 60000)} min.`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(waitMs);
          continue;
        }
        if (TRANSIENT.has(report.stop_reason)) {
          // eslint-disable-next-line no-await-in-loop
          if (await retryLater(`${report.stop_reason}: ${report.message}`,
            { reason: report.stop_reason, slept, progressed: complete > 0 })) continue;
          process.exitCode = 3;
          return finish(totals, logFile);
        }
        console.log(`[backfill] @${handle}: STOPPED (${report.stop_reason}): ${report.message}`);
        process.exitCode = 3;
        return finish(totals, logFile);
      }
      transient = 0;
      if (!report.windows.length) break; // nothing pending: this account is done
      idle = complete ? 0 : idle + 1;
      if (idle >= 2) {
        // A window that keeps stalling stays pending for a later run; it
        // must not hold up the other accounts.
        console.log(`[backfill] @${handle}: two sessions completed no window -- moving on; `
          + 'the unfinished windows stay pending.');
        break;
      }
      // Done only when nothing was left for later AND every window this
      // session touched completed: a partial window needs another session.
      const left = /left for the next session/.test(report.message || '');
      if (!left && complete === report.windows.length) break;
      console.log(`[backfill] break ${Math.round(args.breakMs / 60000)} min (${report.message})`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(args.breakMs);
    }
    console.log(`[backfill] @${handle}: done -- ${JSON.stringify(totals[handle])}`);
  }
  return finish(totals, logFile);
}

function finish(totals, logFile) {
  console.log(`[backfill] ${stamp()} totals ${JSON.stringify(totals)}`);
  console.log(`[backfill] session reports: ${path.relative(ROOT, logFile)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backfill] failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { transientPlan, transientWaitMs, WAKE_WAIT_MS, MAX_TRANSIENT_IN_A_ROW };
