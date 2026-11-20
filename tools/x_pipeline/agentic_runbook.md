# Agentic X crawl, mode A: supervise the scripted crawler

You are supervising a browser crawl of one X account for the portfolio
analyzer. **You do not handle post content.** The scripted crawler
(`tools/runXPipeline.js crawl --route browser`) captures the posts
deterministically and imports them itself. Your job is the judgement around
it: run one window at a time, read its stop report, decide what happens next,
and keep the user's X account safe.

The account to crawl is given to you as `<handle>`. Optionally you also get
`--since` / `--until` dates.

## Hard rules

1. **One crawl at a time.** Never start a second crawler while one is running
   (the crawler refuses anyway, with the owning pid).
2. **Never retry tighter after a stop signal.** A rate limit is waited out; a
   challenge is solved by the user; a locked account ends everything.
3. **Never kill python processes.** If you must stop a hung crawler, stop the
   node process only (`tools/killNodeProcesses.ps1`).
4. **Do not paste post text into the conversation** beyond a short sample
   when you verify a result.
5. **Replies to other people are never collected.** The importer enforces this
   (own posts + own thread replies only); do not work around it.

## Before the first window

```bash
node tools/runXPipeline.js status --handle <handle>
```

- If the account is not registered: `node tools/runXPipeline.js add --handle <handle>`.
- If the browser profile has never been logged in, ask the user to run
  `node tools/runXPipeline.js browser-login` and log into X in the window that
  opens. Do not ask for their password, and never type it yourself.

## The loop

Run exactly one window per call:

```bash
node tools/runXPipeline.js crawl --route browser --handle <handle> --max-windows 1 --report json
```

stdout is a JSON report. Act on `status` / `stop_reason`:

| report | what you do |
|---|---|
| `status: ok`, window `complete` | continue with the next window after the crawler's own cool-down |
| `status: ok`, window `partial` (`scroll_cap`) | run once more with `--unit week` for that range; if still partial, note it and move on |
| `stop_reason: rate_limited` | stop the session. Report `retry_at`. Resume no earlier than that time (use a scheduled wake-up if you have one) |
| `stop_reason: challenge` | tell the user to solve it in the open browser window; the crawler waits up to 5 minutes. If it still fails, stop |
| `stop_reason: login_required` | ask the user to run `browser-login`; stop until they confirm |
| `stop_reason: x_error_page` | wait 10 minutes, retry the same window once; if it repeats, stop |
| `stop_reason: no_graphql` | X may have changed its web app. Do not loop. Switch to mode B (`agentic_prompt.md`) on ONE small window to diagnose, save what you see, and report |
| `stop_reason: account_locked` (exit code 4) | **STOP EVERYTHING.** Tell the user. Do not run any further X command |

Exit code 3 means "blocked, resumable"; 4 means "account locked".

Keep a budget: by default at most 6 windows per session (`--max-windows`),
then stop and report. The user decides when to continue.

## At the end

```bash
node tools/runXPipeline.js status --handle <handle>
```

Report to the user:

- windows complete / partial / blocked, and the date range they cover;
- posts archived (new this session) and how many were filtered (replies to
  others, reposts);
- any window that used the page-scrape fallback (partial fidelity);
- what remains, and the earliest safe time to resume if a rate limit stopped you.

If a window stays partial or blocked in the browser, offer to finish it with
the API route instead. First give its cost: run `estimate`; each post read
costs $0.005.
