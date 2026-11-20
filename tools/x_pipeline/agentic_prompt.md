# Agentic X crawl, mode B: drive the browser yourself (gaps and diagnosis only)

Use this when the scripted crawler cannot do a window (`stop_reason:
no_graphql`), or to fill a small gap. Every captured response passes through
your context, so **keep it small: at most about 300 posts per session.** For
anything bigger, use mode A (`agentic_runbook.md`) or the API route.

You need a browser tool that can navigate, scroll, and evaluate JavaScript in
the page (the Playwright MCP: `browser_navigate`, `browser_press_key`,
`browser_evaluate`, `browser_snapshot`). The browser must be logged into X
with the user's session. If it is not, stop and say:
"I need you to log into X in this browser, then re-run me."

## Steps

1. **Pick the window** the user gave you (handle, `since`, `until`). Build the
   search URL. The one-day overlap on each side is deliberate:

   `https://x.com/search?q=from%3A<handle>%20since%3A<since-1d>%20until%3A<until+1d>&src=typed_query&f=live`

2. **Install the collector BEFORE the page loads**, so it also sees the
   first page of results. Read `tools/x_pipeline/collector.inpage.js`, then
   use `browser_run_code_unsafe` to register it as an init script and
   navigate:

   ```js
   async (page) => {
     await page.addInitScript({ content: COLLECTOR_SOURCE });
     await page.goto(SEARCH_URL);
     return page.evaluate(() => window.__xCollector && window.__xCollector.stats());
   }
   ```

   Replace COLLECTOR_SOURCE with the file's content as a string literal, and
   SEARCH_URL with the URL from step 1. If that tool is not available,
   navigate first and inject the file with `browser_evaluate`. Then click the
   "Top" tab and then the "Latest" tab. The page re-fetches its first results
   without a reload, and the collector captures them.

3. **Check the stop signals** below with a snapshot before you scroll.

4. **Scroll** with the End key (`browser_press_key End`), pausing 2–4 seconds
   between presses. Every few scrolls, check progress:

   `browser_evaluate`: `() => window.__xCollector.stats()`

5. **Drain** when `buffered` > 0:

   `browser_evaluate`: `() => window.__xCollector.drain(150000)`

   Write the returned JSON array, unchanged, to
   `data/x_pipeline/raw/<run>/agent_<n>.json`. Use `<run>` = `agent_<handle>_<YYYYMMDD>`
   and n = 1, 2, 3… **Do not edit or summarise it.**

6. **Stop scrolling** when the posts on screen are older than `since`, when 6
   scrolls in a row bring nothing new (`stats().posts` stops growing), or when
   you reach about 300 posts.

7. **Report** to the user:
   - the run directory;
   - the number of files and posts captured;
   - the exact import command:
     `node tools/runXPipeline.js import --handle <handle> --raw-dir data/x_pipeline/raw/<run>`

   Do not run the import yourself unless the user asked you to.

## Stop signals: stop at once and report

- The URL is `/login` or `/i/flow/login` → the user must log in.
- A challenge ("verify you are human", an Arkose or Cloudflare frame) → the user must solve it.
- `stats().lastStatus === 429`, or "Rate limit exceeded" on the page → stop and report `stats().rateLimitReset`.
- "Something went wrong. Try reloading." twice in a row → stop.
- "Your account has been locked" → **stop everything** and tell the user.

## Last resort: transcribing the page

Use this only when the collector captures nothing but posts are visible.
Write JSONL, one object per post, to `data/x_pipeline/raw/<run>/agent_dom.jsonl`:

```json
{"post_id": "1858123456789012345", "handle": "TestTrader", "created_at": "2026-11-18T14:32:08.000Z", "kind": "original", "text": "Watching $NVDA over 145.50", "in_reply_to_handle": "", "quoted_post_id": "", "text_truncated": false, "media_urls": ["https://pbs.twimg.com/media/AAA111?format=jpg&name=small"]}
```

| field | rule |
|---|---|
| `post_id` | a **string** of digits copied from the post's `/status/<id>` link. Never a number, never guessed |
| `created_at` | the `datetime` attribute of the post's `<time>` element. **Absolute ISO-8601**; "2h" is refused |
| `kind` | `original`, `reply` or `quote`. Skip reposts ("<name> reposted") entirely |
| `in_reply_to_handle` | for a reply, the handle after "Replying to"; replies to OTHER people are dropped on import anyway |
| `text_truncated` | `true` when the post shows "Show more" |
| `media_urls` | `src` of the post's photo `<img>` elements (pbs.twimg.com/media/…) |

These records are imported at partial fidelity, and a later full capture
replaces their fields.
