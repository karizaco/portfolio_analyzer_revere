# Adding X.com accounts as a source: analysis and implementation plan

*Status: IMPLEMENTATION STARTED, 2026-11-20. The decisions in Part 9 are
answered. Built and tested (70 tests): the canonical record, both
normalizers, the archive, index and importer, the API route, the scripted
browser route, the agentic runbook and prompt, photo download, OCR and the
vision reader. Not built yet: text claims, setups, positions-from-text,
episodes, outcomes and the dashboard (Phases 6–9). See "Implementation
status" at the end.*

**The import was reviewed on 2026-11-20 and eleven defects were found and
fixed; they are recorded in §10, because a contract that is only in the code
is a contract nobody can check.**

*"Measured" numbers come from the catalog (opened read-only), from the code, or from
X's own developer documentation, all on 2026-11-20 (Appendix A has the commands,
Appendix B the URLs). "Estimate" numbers are Phase 0's job to replace.*

---

## TL;DR

- **An X account is a text + image source.** Its nearest relatives already in the
  repository are:
  - **Discord**: one author's posts, position snapshots, trade actions, episodes.
  - **AsymTrading**: a catalog that is not YouTube, keyed `asym_<post_id>`, with written
    readings and media.
  - **The Komar watchlist reader**: screenshots read by OCR, with the market's ticker list
    as the arbiter.

  Reuse those pieces instead of building a new pipeline.
- **Two interchangeable fetchers, one contract.** The paid **API** route and the
  **browser** route both produce one canonical post record (`x-post-1`) and go through
  one importer. Interchangeability is a **tested** property: the same post captured both
  ways normalizes to the same record.
- **Deep history needs date windows on both routes.**
  - The API's user timeline returns only the **3,200 newest** posts (measured, X docs).
  - Full-archive search (`from:<handle>`, up to **500 posts per request**, back to March
    2006) **is** available on pay-per-use (measured).
  - The web profile also stops early. The web search page (`from:h since:… until:…`) is
    the deep route there.

  So one shared **window planner** and an `x_crawl_windows` table make every crawl
  resumable and auditable, and let one route fill the other's gaps.
- **API cost is linear and knowable before any money is spent** (measured, X pricing page):
  - **$0.005 per post returned**, so 20,000 posts cost $100;
  - **$0.010 per full-archive count request**;
  - re-reading the same post on the same UTC day is not billed again;
  - you can set a hard spending cap.

  Phase 0 sizes each account with count requests (cents to a few dollars) before reading
  any posts.
- **The browser route reads X's own JSON, not the page.** As you scroll, the web app
  fetches GraphQL timelines (`UserTweets`, `SearchTimeline`, `TweetDetail`). Capturing
  those responses yields the same structured fields the API returns. Scraping the page
  itself (the DOM) is the fallback, and its records are flagged as lower fidelity.
  - **The browser route breaks X's terms on scraping and puts the logged-in account at
    risk.** The plan says so plainly and guards it: a visible (headed) browser, human
    pacing, and a hard stop on challenges, 429s or a locked account.
  - The API route stays the compliant default.
- **"Agentic" means Claude Code supervising the scripted crawler**, through a runbook
  (optionally a project skill).
  - The agent runs windows, reads the crawler's structured stop reports, handles login,
    challenges, back-off and route switching, and checks completeness.
  - **Post payloads never pass through the model.**
  - A second mode lets Claude drive the Playwright MCP browser directly, for small gaps
    when the script's assumptions break.
  - Both modes write the same canonical JSONL.
- **Storage needs a new tier.** Both tracked databases have a **60 MB budget** enforced by
  `test/catalogSizeGuard.test.js`. Today `state.sqlite` is **23.6 MB** and `derived.sqlite`
  is **39.4 MB** (measured). A busy X account has tens of thousands of posts. So the data
  is split:
  - small registry and crawl tables go in the catalog;
  - the posts themselves go in a **tracked, deterministic JSONL archive** per account and
    month. That archive is the record, because posts get deleted and the API costs money;
  - an **untracked SQLite index** is rebuilt from the archive, the same pattern as
    `transcript_segments.sqlite`;
  - raw payloads and images stay untracked;
  - the interpretations go in `derived.sqlite`.
- **Extraction reuses the shared English engine** (`src/sevcik/signalExtractor.js` with
  the T3Live/Asym options) and adds X-specific rules:
  - a **cashtag is an explicit ticker**;
  - quoted and reposted text counts as `reported`, not as the author's own call;
  - **self-thread replies and quotes of the author's own post give setup lifecycles
    for free**;
  - position snapshots and trade actions go through the Discord episode model, lifted
    into a shared, parameterized module, with Discord's output pinned unchanged.
- **Images.** The pipeline downloads photos and classifies them (chart, portfolio,
  watchlist, fill confirmation, other).
  - It runs OCR with tesseract.js, and EasyOCR only with `--low-cpu`.
  - It reads TradingView legends and portfolio tables, with the market's ticker list as
    the arbiter.
  - An **optional** Claude vision extractor can also read them, with structured outputs,
    half-price batches and a budget cap. Its rows count only when they agree with the
    OCR words.
- **X brings its own analysis biases**:
  - **survivorship**: authors delete bad calls, so a backfill sees only the survivors;
  - **edits**: a post can be changed after the fact;
  - **exact timestamps**: the entry price is the first close at or after the post, not
    the post date's close.
- **Order and effort:**
  0. measure
  1. contract and storage
  2. API route
  3. browser route
  4. agentic mode
  5. images
  6. text claims
  7. positions
  8. setups
  9. scoring and dashboard

  About **4–5 weeks of code**. Wall time depends on the API budget and on browser pacing.

---

## Part 1: What the codebase gives us

### 1.1 Where X fits

| family | sources | X shares |
|---|---|---|
| OCR video | Revere, Qullamaggie, Komar panel | the image readers' rules: the market list arbitrates, colour gives the sign, a frame is identified by file + md5 |
| transcript | Sevcik, T3Live, Benzinga, martinlukkt, FundedMind, Asym audio | the English signal engine, `claim_kind`, outcome scoring vs SPY |
| document | O'Connell, Komar PDFs, Asym articles | a non-YouTube catalog id, written readings |
| chat | **Discord** (drendel, ariel-long, ariel-short) | one author's stream; snapshots + actions → episodes; three ingest paths converging on one table |
| **X (new)** | any account | chat-like text **plus** attached images, with explicit reply/quote/thread links |

### 1.2 The Discord precedent: what to copy, what not to copy

**Copy:**

- **Several ingest paths converge on one table.** Discord's bot REST, browser and agent
  paths all land in `discord_messages`.
  - Rows go in with `INSERT OR IGNORE` on the message id.
  - `discord_sources` keeps a watermark (`last_message_id`), and `discord_pipeline_runs`
    is the audit.
  - **For X, the importer is that convergence point.**
- **The agentic path does not embed an agent.** `ingest-agentic` prints the prompt, the
  JSONL schema, and the exact import command (`tools/discord_pipeline/agentic_prompt.md`).
- **The parsed layer is derived and versioned.** It is rebuilt from messages, carries
  `parser_version` on every row, and the messages are never rewritten.
- **The trade-action rules** in `src/discord/tradeActions.js`:
  - the earliest verb is the action;
  - an intent is not a trade;
  - the subject is the ticker, not the first name in the message;
  - a number is a price only where a price can stand.
- **The episode model** in `src/discord/episodes.js`:
  - snapshots are kept apart from actions;
  - returns are modelled close-to-close;
  - same-day trades are invisible to that model and are counted apart;
  - the curve has no survivorship bias.

**Do not copy:**

- **Raw JSON in the catalog.** `discord_messages.raw_json` averages **1,318 bytes** per
  message (measured, 5,515 messages). At X's volumes that alone would break the catalog
  budget.
- **The Node → Python shell-out.** `tools/runDiscordIngest.js --driver` has two problems:
  - it builds a Python script string and never runs it;
  - it calls `JSON.stringify(m, ensure_ascii=False)`. That is Python syntax inside a
    `'use strict'` JS file, so it throws `ReferenceError` the moment one message has
    parsed.

  This is a **pre-existing Discord defect**, worth a separate fix. X is all Node: Node 24
  has `node:sqlite` and `fetch`, and `playwright` 1.63 is already a devDependency.
- **Discord's own constants inside the episode logic.** `episodes.js` imports Discord's
  `INVERSE_INSTRUMENTS` and its Vibe-account rule, so it has to be parameterized before X
  can share it (Phase 7).

### 1.3 What `C:\Users\admin\Projects\x_unsub` offers

**Borrow:**

- **The scroll loop.** It scrolls, waits, collects, and stops after N scrolls with nothing
  new, with a hard cap on total scrolls (`grok-bot/extract-following.js`,
  `content.js:extractFollowingList`).
- **`waitForTweetPopulation`**: a MutationObserver plus a "stable for N ms" timer.
- **The stop-signal detectors and retry policy:**
  - `detectCloudflareChallenge`;
  - `detectBanSignals`: login redirect, HTTP 429 through Navigation Timing, "account
    locked/suspended" text, "rate limit exceeded" text;
  - the `classifyScanError` retryable/terminal taxonomy;
  - `withRetry`, with jittered exponential back-off and a circuit breaker.
- **Pause and resume**, built on persisted scan state.
- **The risk table and pacing advice** in `docs/cloudflare-analysis.md`.

**Do not borrow:**

- **`getPostType()`.** It tests for `[data-testid='retweet']` and `[data-testid='reply']`.
  Those are the **action buttons every post carries**, so every post reads as a repost.
  - In the page, a repost is marked by the `socialContext` line ("… reposted").
  - In GraphQL, it is marked by `retweeted_status_result`.
- **`isPinnedTweet()`.** It matches the word "pinned" anywhere in the post's text, so a
  post that *says* "pinned" counts as pinned. Use `socialContext` only.
- **The `mcp-client` approach.** It spawns `npx @xdevplatform/xurl` once per request
  through `execSync`: slow, one process per call. And its "posts in the last 30 days"
  queries `search/recent`, which only covers **7 days**. The endpoint's window, not the
  caller's parameter, bounds the answer. Use `fetch` with a bearer token instead.
- **The MV3 browser-extension architecture.** It is the wrong shape for a CLI pipeline.

### 1.4 Constraints that shape the design

1. **Storage budgets.**
   - Tracked `state.sqlite`: 23.6 MB of a 60 MB budget.
   - Tracked `derived.sqlite`: 39.4 MB of 60 MB.
   - Untracked `transcript_segments.sqlite`: 992 MB.
   - All measured. GitHub refuses any file over 100 MB.
2. **Shared modules stay shared; a source's quirks stay in the source.**
   - X vocabulary, X account quirks and broker screenshot layouts live in `src/x/`.
   - A change to a shared module needs a measured blast radius on the sources that
     already use it.
3. **One item's rows are always replaced, including with zero rows.** Superseded parser
   versions are purged on a *full* run only. This is the `src/transcript/extractRunner.js`
   rule.
4. **`evidence_text NOT NULL` and `parser_version` on every derived row.**
5. **Process budget.** The guard hook (`.claude/hooks/limit-processes.ps1`) excludes
   command lines that contain `playwright` and never counts Chromium. So the crawler has to
   police itself: **one browser crawl at a time**, enforced by a lock file that records the
   owning pid. That is the same design as the Asym downloader's lock.
6. **Parallel agents share this repository.** Stage explicit paths, commit catalog changes
   promptly, and never run two catalog writers at once.
7. **Credentials live in `.env`**, read by `src/transcript/loadEnv.js`, and are **never
   logged**. Error bodies are redacted first, as the Deepgram client does.
8. **Tests.**
   - There are 146 top-level test files (measured). An agent may not run `npm test`; it
     runs the files it needs with `node --test --test-concurrency=8 test/<file>.test.js`.
   - Live tests (network, a browser, money) go in `test/manual/`, which the suite never
     reaches.

---

## Part 2: What X looks like as a source

### 2.1 The official API (measured from docs.x.com, 2026-11-20)

| fact | value |
|---|---|
| billing model | pay-per-use credits (launched Feb 2026); X lists no free tier |
| post read | **$0.005 per post returned** |
| user read | $0.010 per user returned |
| full-archive count (`GET /2/tweets/counts/all`) | **$0.010 per request**; recent counts $0.005 |
| deduplication | the same resource is billed once per UTC day ("soft guarantee") |
| monthly cap | 3,000,000 post reads per billing cycle |
| spending limit | settable per billing cycle; requests are blocked once it is reached |
| user timeline `GET /2/users/:id/tweets` | **up to the 3,200 newest posts**; `exclude=retweets,replies`, `start_time`/`end_time`, `since_id`/`until_id` |
| full-archive search `GET /2/tweets/search/all` | **available on pay-per-use**; up to **500 posts per request**; back to March 2006; `from:` takes a handle or a numeric id |

**What this means:**

- Backfill uses full-archive search. Incremental runs use the user timeline with
  `since_id`.
- The cost is exactly `posts × $0.005`. The query decides how many posts come back. That
  makes the **reply policy** the main cost lever, measured in Phase 0:
  - originals: `from:h -is:retweet -is:reply`;
  - self-replies: `from:h is:reply to:h`;
  - all replies: everything else.
- **Prices are configuration, not code** (`config/x_api_pricing.json`), because X says
  they are subject to change.

### 2.2 The web client (expected behaviour; Phase 0 and Phase 3 pin it with captured fixtures)

- **Login is required** for search and for any full timeline. The crawler uses a
  dedicated, persistent browser profile in which the user logs in once by hand.
- **The profile timeline stops scrolling early** (depth to be measured). The search page,
  filtered by date and with "Latest" selected (`f=live`), is the deep route.
- **The data arrives as GraphQL JSON** at `/i/api/graphql/<queryId>/<OperationName>`.
  - Query ids rotate, so **match on the operation name**.
  - The expected shape is timeline `instructions` → `TimelineAddEntries` → `entries[]` →
    `tweet_results.result`.
  - A tweet can be wrapped in `TweetWithVisibilityResults`, or replaced by a tombstone.
  - The text is in `legacy.full_text`. A long post's full text is in `note_tweet`.
  - Media is in `legacy.extended_entities.media`.
  - A quote is `quoted_status_result`; a repost is `legacy.retweeted_status_result`.
  - Paging uses cursor entries.
- **Stop signals:**
  - HTTP 429 on a GraphQL response. Read its `x-rate-limit-reset` header.
  - "Something went wrong. Try reloading."
  - A redirect to `/login` or `/i/flow/login`.
  - A challenge iframe.
  - "Your account has been locked".
- **Terms of service.** X's terms forbid crawling or scraping without written consent.
  - The browser route uses the user's own session. A lock or a suspension lands on that
    account.
  - The route is opt-in per account. It is never the default.

### 2.3 The three example accounts: what you said, and what Phase 0 measures

| account | what you said | what to expect | open questions for Phase 0 |
|---|---|---|---|
| `@MichaelPBento` | mostly setups and ideas | chart screenshots with levels, cashtags, trigger/stop language, self-thread updates | total posts; % with images; % of images that are charts; how often a setup is followed up in-thread |
| `@RedDogT3` | mostly setups, some specific positions | high volume, many replies; index talk ("the Qs", "$SPY"); "I'm long X from Y" | totals by query kind; how much is replies to others; cost of a full backfill |
| `@BoujeeFinances` | actual portfolio positions | portfolio screenshots (which broker app?), holdings lists, periodic updates | snapshot cadence; screenshot layout(s); are weights shown, or dollar values, or gains? |

**`@RedDogT3` is Scott Redler.** The T3Live YouTube catalog already holds **1,060
videos** whose titles name Redler or "Red Dog" (measured), including his daily #630club.

- His X account gets `person_key = 'scott_redler'`.
- His X calls and his T3Live calls are **correlated**. They are **compared** (same-day
  agreement, who said it first) and never pooled as independent observations.
- The same rule appears in the Benzinga plan for the T3 Live partner episodes.

### 2.4 The anatomy of a post: every case the normalizer has to handle

| case | how it is recognized | what it means for extraction |
|---|---|---|
| original | no reply, quote or repost reference | the author's own claim |
| **long post** | API `note_tweet`; GraphQL `note_tweet_results` | **`text` is truncated without it.** Always request and prefer the note text |
| reply to self (thread) | `in_reply_to_user_id == author_id` | continues the author's own idea; ticker may be inherited from the parent (flagged); lifecycle evidence |
| reply to someone else | another user in `in_reply_to_user_id` | the author's own words, but the subject may be in the parent; kept only under `include_replies = all` |
| quote | `referenced_tweets[type=quoted]` / `quoted_status_result` | the author's text is the claim; **claims only in the quoted text are `reported`** |
| repost | `referenced_tweets[type=retweeted]` / `retweeted_status_result` / socialContext "reposted" | someone else's content: stored, never scored |
| edited | `edit_history_tweet_ids` | **score the earliest captured version**; flag the post when only a later version was seen |
| pinned | socialContext "Pinned" on the profile route | not a new post. Pinned order must not be read as recency |
| photo | `media.type = photo` | image pipeline |
| video / GIF | `video` / `animated_gif` | v1 stores metadata and the preview image only |
| card / link | `entities.urls`, card | url kept; no fetch of the target in v1 |
| deleted / withheld / protected | tombstone; API error object | marked, never physically deleted by a crawl (see decision 4) |

**The id is a snowflake** larger than 2^53, so it must stay a **string** everywhere.
Calling `Number()` on it silently corrupts the id.

**The id carries its own timestamp**: `(id >> 22) + 1288834974657` milliseconds. The
normalizer checks `created_at` against it (within one second). A disagreement is a parse
error, not a data point.

---

## Part 3: Design

### 3.1 Decisions

- **D1. Identity.**
  - The logical source is `x`. One registry row per account, keyed by the **numeric user
    id**, because handles get renamed.
  - Handle history is kept in its own table.
  - The catalog id of a post is `x_<post_id>`. It is namespaced like `asym_<post_id>`, so
    it can never collide with a YouTube id.
- **D2. One canonical record, two routes, one importer.**
  - Each route only produces raw payloads plus canonical records.
  - Merging, de-duplication and storage happen in exactly one place.
- **D3. Windows are the unit of work** on both routes, with explicit completeness.
- **D4. Storage tiers** (§3.8):
  - catalog: registry and audit;
  - tracked archive: the posts;
  - untracked index: rebuilt from the archive;
  - untracked raw payloads and media;
  - `derived.sqlite`: the interpretations.
- **D5. X's tables are its own.** The parsed layer gets `x_*` derived tables that use the
  same column vocabulary as `trade_signals`.
  - `trade_signals` would need a fake `transcript_id` and segment indexes.
  - Discord, FundedMind and martinlukkt already keep their own tables for the same
    reason.
- **D6. The English engine, with X options.**
  - X jargon is a **parameter** owned by `src/x/`.
  - Shared-engine changes happen only with a measured blast radius on T3Live, Benzinga
    and Asym, with Sevcik pinned unchanged.
- **D7. Lift before sharing.**
  - Attribution and options-direction (now under `src/benzinga/`) move to a shared
    `src/claims/` module, with Benzinga's output proven byte-identical.
  - The episode logic and `findPrices` move to `src/positions/`, with Discord's output
    proven identical.
- **D8. Images are evidence, not ground truth.**
  - OCR plus layout readers come first.
  - The vision LLM is optional, and its rows count only when cross-checked against OCR.
- **D9. Any account works with the generic profile.** Account profiles add quirks and
  never fork the pipeline.
- **D10. The API is the default route.**
  - The browser route is opt-in per account, after you accept the account risk.
  - The agent supervises; it does not transport payloads.
- **D11. Measure before scaling**, as the FundedMind and Benzinga plans did. Every rule is
  measured on a hand-labelled sample per account.
- **D12. Out of scope for v1:** video transcription, link-target fetching, other people's
  replies, DMs, Spaces, Communities.

### 3.2 The pipeline at a glance

```text
x_accounts ──► window planner ──┬─► route A: API fetcher (paid)        ─┐
(registry)     (x_crawl_windows) │                                       │ raw payloads (untracked)
                                 └─► route B: browser                    │
                                       B1 scripted crawler (GraphQL)     │
                                       B2 agent: supervises B1 / drives  │
                                          the Playwright MCP for gaps    │
                                                                         ▼
                         normalizers (api_v2 / web_graphql / web_dom / agent_jsonl)
                                                │  canonical x-post-1 records
                                                ▼
                                 importer: validate · merge by field priority · never delete
                        ┌───────────────────────┼─────────────────────────┐
                 archive (tracked JSONL)   index (untracked SQLite)   crawl audit (catalog)
                                                │
              media download ─► classify ─► OCR ─► readers (legend / portfolio / fill) ─► [vision, optional]
                                                │
            text claims · setups (lifecycle) · position snapshots · trade actions · episodes   (derived.sqlite)
                                                │
                       outcomes vs SPY · cross-account / cross-source · aggregate · dashboard
```

### 3.3 The canonical post record (`x-post-1`)

```json
{
  "schema": "x-post-1",
  "post_id": "1858123456789012345",
  "user_id": "123456789",
  "handle": "michaelpbento",
  "created_at": "2026-11-18T14:32:08.000Z",
  "kind": "original",
  "text": "Watching $XYZ over 123.45, stop under today's low. Daily chart below.",
  "text_source": "note_tweet",
  "lang": "en",
  "conversation_id": "1858123456789012345",
  "in_reply_to_post_id": null,
  "in_reply_to_user_id": null,
  "self_thread": false,
  "quoted_post_id": null,
  "reposted_post_id": null,
  "referenced": [
    { "type": "quoted", "post_id": "…", "handle": "…", "created_at": "…", "text": "…" }
  ],
  "entities": {
    "cashtags": ["XYZ"],
    "hashtags": [],
    "mentions": [],
    "urls": ["https://…"]
  },
  "media": [
    {
      "media_key": "3_1858…",
      "type": "photo",
      "url": "https://pbs.twimg.com/media/…jpg",
      "width": 1920,
      "height": 1080,
      "alt_text": ""
    }
  ],
  "edit": { "history_ids": ["1858123456789012345"], "is_earliest": true },
  "metrics_first_seen": {
    "likes": 41, "reposts": 6, "replies": 3, "quotes": 1, "views": 9120,
    "observed_at": "2026-11-18T15:00:00Z"
  },
  "fetched_via": "api_v2",
  "fidelity": "full",
  "first_seen_at": "2026-11-18T15:00:00Z"
}
```

**Rules:**

- **Ids are strings.**
- **`created_at` is ISO UTC**, checked against the snowflake.
- **`kind`** is one of `original | reply | quote | repost`.
- **`referenced` embeds the quoted or reposted text**, so evidence stays readable even if
  the other post is gone.
- **`fidelity` is `partial`** for page-scraped and agent-transcribed records (truncated
  text, missing ids or media).
- **Volatile metrics are not in the archive.** `metrics_first_seen` is written once and
  never updated, so re-crawls do not churn the files. Later observations go to the
  untracked index (`x_post_metrics`).
- **Field priority on merge:** `api_v2` > `web_graphql` > `agent_jsonl` > `web_dom`.
  - A longer, untruncated text always beats a truncated one — *untruncated*
    is the test, whichever route it came from, because the two routes cut
    a long post at different points.
  - A merge never downgrades a field.
  - **The entity lists and the edit history are UNIONED**, member by member:
    they are sets and a list, not fields that the higher route simply
    replaces. `is_earliest` is recomputed from the unioned history.
  - **The cashtag marker is stripped once, in `canonicalize`**, so the two
    routes spell a cashtag the same way.

### 3.4 Route A: the API fetcher

| aspect | design |
|---|---|
| auth | `X_BEARER_TOKEN` in `.env` (app-only). Plain `fetch`, no new dependency. The token is never logged; error bodies are redacted |
| resolve | `GET /2/users/by/username/:h` (`user.fields=created_at,public_metrics,description,protected,verified`). Stores `user_id`, `tweet_count_at_lookup` |
| backfill | `GET /2/tweets/search/all?query=<query kind>&start_time&end_time&max_results=500&next_token…`, one window at a time; `next_token` stored on the window row, so an interrupted run resumes mid-window |
| incremental | `GET /2/users/:id/tweets?since_id=<newest archived>&exclude=retweets` (the 3,200 cap is irrelevant for a recent delta) |
| fields | `tweet.fields=created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,entities,attachments,public_metrics,note_tweet,edit_history_tweet_ids,lang,possibly_sensitive`; `expansions=author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,in_reply_to_user_id`; `media.fields=url,preview_image_url,type,width,height,alt_text,variants`; `user.fields=username,name` |
| pacing | honour `x-rate-limit-remaining` / `x-rate-limit-reset`; at most 1 request per second on full-archive search until measured; on 429, sleep until the reset time and never retry tighter |
| budget | `--estimate` runs count requests per window and prints expected posts × price. A real run needs `--yes` plus `--budget-usd`/`--max-posts`, and **stops before** the request that would cross the cap. **The cap is per account per UTC DAY**: X bills a resource once per UTC day, so the budget is seeded from the ledger's spend for today, and a run that is interrupted and resumed — or a second run the same day — does not start at $0. `x_api_usage` (catalog) is the ledger |
| raw | every response is gzipped verbatim to `data/x_pipeline/raw/<run_tag>/api/<window>/<n>.json.gz` |
| traps | `text` truncated without `note_tweet`; `includes.tweets` long posts too; a protected account returns nothing to an app-only token; a deleted post appears as an `errors[]` entry, not a missing row |

### 3.5 Route B1: the scripted browser crawler

| aspect | design |
|---|---|
| runtime | Node, `playwright` (already a devDependency). `chromium.launchPersistentContext(profileDir, { headless: false, channel: 'chrome' or 'msedge' })` |
| profile | `X_BROWSER_PROFILE_DIR`, default **outside the repository** (`%LOCALAPPDATA%\portfolio-analyzer\x-browser-profile`), because it holds session cookies. A test pins that the default is outside the repository |
| login | `x:browser:login` opens the window and waits until the home timeline renders. **The user logs in by hand.** The crawler never types credentials (unlike x_unsub's grok-bot) |
| capture | `page.on('response')`, filtered on `/\/i\/api\/graphql\/[^/]+\/(UserTweets|UserTweetsAndReplies|SearchTimeline|TweetDetail|UserByScreenName)\b/`, then `response.json()` → raw gz, then `normalizeGraphql` |
| windows | navigate to `https://x.com/search?q=from%3A<h>%20since%3A<d0>%20until%3A<d1>&f=live`; windows overlap by one day and dedupe by id, because the date operators' timezone is not documented (Phase 3 measures it) |
| scroll | scroll by one viewport with jitter (1.2–3.5 s). Stop when the oldest captured post is older than the window start, or after **6 scrolls with no new id**, or at the scroll cap |
| caps | per session: max windows, max GraphQL responses per 15 minutes (counted), a cooldown between windows, a lock file with the pid |
| stop signals | x_unsub's detectors, plus the GraphQL `response.status() === 429` (with its reset header). Each maps to a `stop_reason` (`rate_limited`, `login_required`, `challenge`, `account_locked`, `x_error_page`, `no_graphql`, `selector_drift`) and a **distinct exit code** |
| fallback | when no GraphQL is captured for a window, a page-scrape pass over `article[data-testid="tweet"]`, `[data-testid="tweetText"]`, `time[datetime]` and `a[href*="/status/"]`; records marked `web_dom`/`partial` |
| threads | `TweetDetail` for self-thread roots whose continuations are missing, within a budget |
| incremental | profile + `/with_replies` scroll until K already-known ids in a row |
| output | raw gz + canonical JSONL in the run directory, then the importer, then a **JSON stop report** on stdout (the agent's input) |

### 3.6 Route B2: the two agentic modes

**B2a: Claude Code supervises B1 (the default agentic mode).**

- **Input.** A runbook, `tools/x_pipeline/agentic_runbook.md`, optionally wrapped as the
  project skill `.claude/skills/x-crawl/SKILL.md`, so you can type `/x-crawl
  MichaelPBento`.
- **The loop, per pending window:**
  1. Run `node tools/runXPipeline.js crawl --route browser --handle h --window <id>
     --report json`.
  2. Read the stop report.
  3. Act on it:
     - `complete` → go to the next window.
     - `rate_limited` → wait until the reset time, or end the session. Never retry
       tighter.
     - `login_required` / `challenge` → ask you to solve it in the open window; the
       crawler waits.
     - `account_locked` → **stop everything** and report.
     - `partial` → retry once with a smaller window. Then mark it partial and offer the
       API route for that window, with its cost.
     - `no_graphql` / `selector_drift` → switch to B2b on a small sample to diagnose,
       save a fixture, and stop.
- **At the end:** run `x:status` and give a coverage summary (seen vs expected counts).
- **The agent never handles post payloads** beyond a short sample for verification. That
  keeps the cost low and the data deterministic.

**B2b: Claude drives the Playwright MCP browser directly (gaps and diagnosis only).**

- **Input.** A prompt, `tools/x_pipeline/agentic_prompt.md`, the counterpart of the
  Discord prompt.
- **The loop:**
  1. Navigate to the window URL.
  2. Inject `tools/x_pipeline/collector.inpage.js`. It wraps `fetch`/`XMLHttpRequest` and
     buffers matching GraphQL responses.
  3. Scroll.
  4. Drain the buffer in batches with `browser_evaluate`.
  5. Save each batch to `data/x_pipeline/raw/<run>/agent_<n>.json`.
- **Afterwards:** run `x:import --raw-dir …`.
- **Caps:** about 300 posts per session, because payloads pass through the model's
  context.
- **Last resort:** when no GraphQL can be captured, the agent transcribes the page into
  `agent_jsonl` (fidelity partial). That JSONL is validated by the same schema as
  Discord's `ingest-agentic`.
- **Login:** the Playwright MCP browser keeps its own logged-in profile, separate from
  B1's. Two sessions of one account is normal.

**Why not a hosted agent.** Managed Agents, or any hosted sandbox, would need X's session
cookies exported off this machine, and X treats datacenter IPs as bots. The login session
and the residential IP must stay local. A Messages-API loop of our own would duplicate the
harness that Claude Code already provides here.

**For unattended scheduled runs later**, the Claude Agent SDK (`code.claude.com/docs/en/agent-sdk`)
can run the same runbook with its turn and budget limits (Phase 10).

### 3.7 Windows and completeness

- **`src/x/windows.js` splits `[since, until]` into windows:**
  - **API:** yearly windows. `next_token` handles resumption, so the window only bounds
    progress.
  - **Browser:** monthly windows. A window is split into weeks when its expected count is
    over about 400 posts, because a long scroll is where challenges and rate limits bite.
  - **Expected counts** come from the count endpoint when an API token exists. Without
    one, they come from the observed density of neighbouring windows.
- **A window is `complete` only when its route reached its natural end:**
  - **API:** no `next_token`, and every page is stored.
  - **Browser:** the scroll passed the window start with no stop signal. A scroll that
    brought NOTHING new, and a blank page, are STOPS and not a natural end — a stall
    recorded as coverage means the paid route never comes back for it.
  - **NO STOP SIGNAL** was raised. *Any* stop reason means the window is not complete,
    not just the five named ones: only a list of known reasons used to be treated as
    stops, so a reason outside it (`no_graphql`, `selector_drift`, `x_error_page`) could
    still yield a "complete" window.
  - In both cases the seen count must AGREE with the expected count within a tolerance,
    when one is known. The agreement is TWO-SIDED: a shortfall means posts were missed
    and a surplus means the count and the crawl disagree about the window. Otherwise
    the window is `partial`.
- **A re-plan is REDUCED to the part no window covers.** Extending the end of a backfill
  by one day must not create a second window over the whole period and re-bill it; the
  plan is cut against the ranges the existing windows already cover.

  That is the same idea as the catalog's `listing_complete`: absence from an incomplete
  listing proves nothing.
- **Completeness belongs to the window, not the route.** A window completed by either
  route is done. A browser `partial` can be finished by the API, at the cost the estimate
  printed.

### 3.8 Storage tiers

| tier | where | tracked | holds | why |
|---|---|---|---|---|
| catalog | `data/video_pipeline/state.sqlite` | yes | `x_accounts`, `x_account_handles`, `x_crawl_runs`, `x_crawl_windows`, `x_api_usage` | small (kilobytes); the audit of what was fetched and how |
| **archive (the record)** | `data/x_pipeline/archive/<user_id>/<YYYY>/<YYYY-MM>.jsonl` | **yes** | canonical posts, immutable content, sorted by id, canonical key order | deletions and API cost make a fetched corpus hard to re-fetch, the same reasoning as the transcripts and O'Connell. Deterministic writer: an unchanged month is a byte-identical file, so a re-crawl leaves `git diff` empty |
| raw | `data/x_pipeline/raw/<run_tag>/…json.gz` | no | API/GraphQL responses verbatim | lets the normalizer be improved and re-run; prunable |
| media | `data/x_pipeline/media/<user_id>/<post_id>_<n>.<ext>` | no | photos (md5 in the index) | too large for git; the readings are tracked |
| index (cache) | `data/x_pipeline/x_index.sqlite` | no | `x_posts`, `x_post_refs`, `x_post_media`, `x_post_metrics`, `x_image_ocr` | rebuilt from archive + media in minutes (`x:rebuild-index`); the same pattern as `transcript_segments.sqlite` |
| interpretations | `data/video_pipeline/derived.sqlite` | yes | `x_signals`, `x_setups`, `x_positions`, `x_trade_actions`, `x_episodes`, `x_image_readings` | where every other source's interpretations live |
| outputs | `data/x_*.{csv,json,html}` | no (gitignored) | aggregates, outcomes, dashboard | rebuilt by one command chain |

**Size estimate, to be measured in Phase 1:** about 1–1.5 KB per canonical post, so 20k
posts is about 25 MB of plain JSONL, split into monthly files of a few MB each.

- **Keep plain JSONL**, which diffs and reviews well, until X's archive passes about
  300 MB. Then switch to `.jsonl.gz`, written with a fixed mtime so it stays
  deterministic. That is the Benzinga storage policy.
- **`derived.sqlite` has about 20 MB of headroom.** If X's tables push it past 50 MB,
  move them to a sibling `x_derived.sqlite` with the same ATTACH pattern. Do not let
  `derived.sqlite` become the next unpushable file.

### 3.9 Database schema (sketches)

**Catalog: appended to `data/db/schema.sql`.** Additive only, idempotent.

```sql
CREATE TABLE IF NOT EXISTS x_accounts (
    user_id TEXT PRIMARY KEY,              -- numeric id as TEXT; handles change, ids do not
    handle TEXT NOT NULL,                  -- current handle, lowercase
    display_name TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT 'generic',   -- src/x/accounts/<profile>.js
    declared_kinds TEXT NOT NULL DEFAULT '',   -- 'setups,positions' -- a hint, never a rule
    person_key TEXT NOT NULL DEFAULT '',       -- cross-source identity, e.g. 'scott_redler'
    include_replies TEXT NOT NULL DEFAULT 'self'
        -- 'all' was in the first draft of this table and is NOT in the code:
        -- replies to other people are never collected, so the policy that
        -- drops them is the only policy. The user's decision, 2026-11-20.
        CHECK (include_replies IN ('none', 'self')),
    backfill_since TEXT NOT NULL DEFAULT '',   -- oldest date wanted, YYYY-MM-DD
    protected INTEGER NOT NULL DEFAULT 0,
    tweet_count_at_lookup INTEGER,
    looked_up_at TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS x_account_handles (
    user_id TEXT NOT NULL, handle TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (user_id, handle)
);
CREATE TABLE IF NOT EXISTS x_crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('api', 'browser', 'agent', 'import')),
    run_tag TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',    -- running | ok | partial | blocked | failed
    windows_planned INTEGER NOT NULL DEFAULT 0,
    windows_complete INTEGER NOT NULL DEFAULT 0,
    posts_seen INTEGER NOT NULL DEFAULT 0,
    posts_new INTEGER NOT NULL DEFAULT 0,
    posts_updated INTEGER NOT NULL DEFAULT 0,
    api_cost_usd_est REAL NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL DEFAULT '',
    raw_dir TEXT NOT NULL DEFAULT '',          -- repo-relative (portable_stored_path rule)
    kind TEXT NOT NULL DEFAULT 'live'          -- live | fixture
);
CREATE TABLE IF NOT EXISTS x_crawl_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    query_kind TEXT NOT NULL,   -- originals | self_replies | all_replies | profile | thread
    window_start TEXT NOT NULL, window_end TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | running | complete | partial | blocked | failed
    count_expected INTEGER,
    posts_seen INTEGER NOT NULL DEFAULT 0,
    oldest_seen TEXT NOT NULL DEFAULT '', newest_seen TEXT NOT NULL DEFAULT '',
    next_token TEXT NOT NULL DEFAULT '',
    last_run_id INTEGER, stop_reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, query_kind, window_start, window_end, route)
);
CREATE TABLE IF NOT EXISTS x_api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER, endpoint TEXT NOT NULL, requested_at TEXT NOT NULL,
    http_status INTEGER, resources_returned INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL, unit_price_usd REAL NOT NULL, est_cost_usd REAL NOT NULL
);
```

**Index cache: `data/db/schema_x_index.sql`, untracked file.**

```sql
x_posts         (post_id TEXT PRIMARY KEY, user_id, handle, created_at, event_session,
                 kind, text, text_source, lang, conversation_id, in_reply_to_post_id,
                 in_reply_to_user_id, self_thread, quoted_post_id, reposted_post_id,
                 cashtags_json, urls_json, media_count, edit_earliest_id, edited_after,
                 fetched_via, fidelity, first_seen_at, last_seen_at,
                 deleted_detected_at, archive_path, content_md5)
x_post_refs     (post_id, ref_type, ref_post_id, ref_handle, ref_created_at, ref_text)
x_post_media    (media_key PRIMARY KEY, post_id, idx, type, url, preview_url, width,
                 height, alt_text, local_path, md5, bytes, download_status, downloaded_at)
x_post_metrics  (post_id, observed_at, likes, reposts, replies, quotes, views, bookmarks, via)
x_image_ocr     (md5, engine, parser_version, text, words_json, mean_conf, ocr_at,
                 PRIMARY KEY (md5, engine, parser_version))
-- A post X says it no longer has. It never reaches the archive -- it is an
-- errors[] entry, not a missing row -- so without this table the fact that
-- it was deleted is lost. An OBSERVATION, not a derived row: `rebuild-index`
-- leaves it alone.
x_post_deletions (post_id PRIMARY KEY, detected_at, run_id, source, detail)
```

`x_posts` carries the references as `referenced_json` rather than in their
own `x_post_refs` table: the references are read with the post and never
queried on their own. The two columns the sketch above lists and the
implementation does not have are `edited_after` (the `edit.is_earliest` flag
carries it) and `content_md5` (the archive's own byte-identity is the
record).

`event_session` is the trading session a post belongs to, in America/New_York: before
16:00 ET on a trading day, that day; otherwise the next trading day.

**Derived: `data/db/schema_derived.sql`, plus `DERIVED_TABLES` in `src/db/derivedStore.js`.**

```sql
CREATE TABLE IF NOT EXISTS x_signals (       -- one claim per (post, ticker, run of text)
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    item_id TEXT NOT NULL,                   -- 'x_<post_id>'
    post_id TEXT NOT NULL, user_id TEXT NOT NULL, handle TEXT NOT NULL,
    posted_at TEXT NOT NULL, event_session TEXT NOT NULL,
    source_part TEXT NOT NULL,               -- text | quoted | thread_parent | image
    ticker TEXT NOT NULL,
    ticker_basis TEXT NOT NULL,              -- cashtag | caps | name | image_legend | inherited
    action TEXT NOT NULL DEFAULT '', bias TEXT NOT NULL DEFAULT 'neutral',
    claim_kind TEXT NOT NULL DEFAULT 'forward',   -- forward | reported | retrospective
    confidence_label TEXT NOT NULL DEFAULT '', confidence_score REAL,
    entry_price REAL, target_price_low REAL, target_price_high REAL, stop_price REAL,
    horizon_text TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '',
    setup_key TEXT NOT NULL DEFAULT '',
    edited_after INTEGER NOT NULL DEFAULT 0,
    capture_lag_days REAL,                   -- first_seen_at - created_at (survivorship)
    evidence_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS x_setups (        -- one row per setup lifecycle
    id INTEGER PRIMARY KEY AUTOINCREMENT, parser_version TEXT NOT NULL,
    setup_key TEXT NOT NULL,                 -- '<user_id>:<ticker>:<root_post_id>'
    user_id TEXT NOT NULL, handle TEXT NOT NULL, ticker TEXT NOT NULL,
    root_post_id TEXT NOT NULL, opened_at TEXT NOT NULL,
    pattern TEXT NOT NULL DEFAULT '',        -- breakout | flag | base | pullback | ep | ...
    direction TEXT NOT NULL DEFAULT '',      -- long | short
    trigger_rule TEXT NOT NULL DEFAULT '',   -- over | under | reclaim | break
    trigger_price REAL, stop_price REAL, targets_json TEXT NOT NULL DEFAULT '[]',
    timeframe TEXT NOT NULL DEFAULT '',      -- from words, or from the chart legend
    state TEXT NOT NULL DEFAULT 'new',       -- new | triggered | worked | stopped | invalidated | closed | stale
    states_json TEXT NOT NULL DEFAULT '[]',  -- ordered [{state, post_id, at, evidence}]
    link_kinds TEXT NOT NULL DEFAULT '',     -- reply | quote | inferred
    chart_ticker_agrees INTEGER,             -- the legend matched the text's ticker
    evidence_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS x_positions (     -- one row per (snapshot post, account label, side, ticker)
    id INTEGER PRIMARY KEY AUTOINCREMENT, parser_version TEXT NOT NULL,
    user_id TEXT NOT NULL, handle TEXT NOT NULL, snapshot_post_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL, as_of_basis TEXT NOT NULL,   -- post_time | stated
    source TEXT NOT NULL,                    -- text_list | image_portfolio | image_vision
    account_label TEXT NOT NULL DEFAULT '', side TEXT NOT NULL DEFAULT 'long',
    ticker TEXT NOT NULL, weight_pct REAL, shares REAL, avg_cost REAL,
    market_value REAL, gain_pct REAL,
    snapshot_complete INTEGER NOT NULL DEFAULT 0,   -- a full list, not "top holdings"
    row_verified INTEGER NOT NULL DEFAULT 1,        -- 0 = an unverified vision row
    image_md5 TEXT NOT NULL DEFAULT '', evidence_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- x_trade_actions : the shape of discord_trade_actions, plus user_id, handle,
--                   instrument (stock|call|put|spread|inverse_etf), source (text|image_fill)
-- x_episodes      : the shape of discord_episodes, plus user_id, handle
-- x_image_readings: md5, post_id, media_key, parser_version, image_class, class_confidence,
--                   legend_ticker, legend_timeframe, tickers_found_json, reader, reader_status,
--                   vision_model, vision_prompt_version, vision_verified, evidence_text
```

SQLite foreign keys do not cross an ATTACH, so the writer is what keeps these links
honest. That is the same note `schema_derived.sql` already carries.

### 3.10 Text claims

**The engine call.** Wrapped by `tools/x_pipeline/extractSignals.js`, parser `x-signals-1`.

- `extractSignals()` receives one segment per sentence or line of the post.
- Options:
  - `lexicon = loadSevcikLexicon()`;
  - `nameFinderFn = findEnglishCompanyNames`;
  - `requireCapsSymbols: true`;
  - `symbolStoplist = ENGLISH_SYMBOL_STOPLIST ∪ <account profile stoplist>`;
  - `confirmedSymbols` = the post's own cashtags.

**The rules the engine does not already have:**

1. **A cashtag is an explicit ticker.** `$NVDA` in `entities.cashtags`, or matched by
   `/\$[A-Z]{1,6}(?:\.[A-Z])?\b/`, enters the post's confirmed set. A bare capitalized word
   still has to pass the CAPS gate and the stoplist.
2. **Indices and futures are not holdings.** `$SPX`, `$ES_F`, `$NQ_F`, `$VIX` and "the Qs"
   map to SPY, QQQ or VIX readings, or are dropped. X's own `src/x/symbols.js` follows the
   precedent of `src/benzinga/symbols.js`.
3. **Attribution.**
   - A ticker found only in the **quoted** text gets `source_part = 'quoted'` and
     `claim_kind = 'reported'`.
   - A **repost** is never extracted for scoring.
   - Analyst and third-party language in the author's own text is tagged `reported` by
     the shared attribution module.
4. **Thread inheritance.**
   - A self-reply with no ticker inherits the root's ticker, with `ticker_basis =
     'inherited'`.
   - A reply to another user inherits only when the parent was fetched, and only under
     `include_replies = all`.
5. **Retrospective.** "Worked perfectly from my alert last week" and weekly recaps get
   `claim_kind = 'retrospective'`: kept, not scored.
6. **Options.** "Bought $TSLA 250c", "sold puts" and "BTO/STC" get their direction from
   the shared options module (D7). **A strike is not an entry price.**
7. **X jargon is a parameter** owned by `src/x/patterns.js`: "long over", "triggered",
   "starter", "full size", "PT", "SL", "BE" (break-even, the Discord trap), "trim",
   "runner".
8. **Prices.** Discord's rule 4 applies: "50sma", "3%", "6/20 setup" and "5min" are not
   prices.

**Precision bar.** Hand-label 200 extracted claims per account as one of: author call,
reported, descriptive, wrong ticker. Record the precision per account in this document and
iterate until you approve the bar. The Benzinga process measured 75 % to 82 % this way.

### 3.11 Setups and their lifecycle

- **A setup is a forward claim with a trigger or a pattern word**, plus everything linked
  to it later.
- **Explicit links**, which X gives for free:
  - a self-reply in the setup's thread;
  - a quote of the author's own setup post.
- **Inferred links** are flagged `inferred`: the same account and ticker within N trading
  days, using lifecycle words ("triggered", "stopped", "hit PT", "invalidated", "closed").
- **States** come from those words: `new → triggered → worked | stopped | invalidated |
  closed`, or `stale` when nothing happens within the horizon. They are kept in order with
  their evidence. **The final state is the last one asserted**, which is Sevcik's
  "still running" lesson.
- **Chart cross-check.** When the setup post has a chart, the legend reader's ticker must
  agree with the text's ticker (`chart_ticker_agrees`). A disagreement is reported, not
  silently resolved.

### 3.12 Positions, actions, episodes

- **Snapshots** come from:
  - text holdings lists ("Current positions: $A 22%, $B 18% …");
  - portfolio screenshots (§3.13).

  Each snapshot is marked `snapshot_complete`, because a "top 5 holdings" post must not
  close the positions it omits. That is the Vibe-account lesson.
- **Actions** come from:
  - text ("Bought $X at 12.40", "trimmed half", "stopped out");
  - **fill-confirmation screenshots**, which are evidence of an actual trade.

  The shared action vocabulary is parameterized per source.
- **Episodes** come from the lifted `src/positions/episodes.js`, using the account
  profile's inverse instruments and no-weight accounts.
  - Returns are close-to-close.
  - Same-day trades are counted apart.
  - The still-open book is marked to the last close.

### 3.13 Images

1. **Download** (`x:media`).
   - Photos only, using `name=orig`, falling back to `large`.
   - Record md5, bytes and dimensions (`sharp`).
   - Paced, resumable, with a free-space check reused from `src/asym/mediaStore.js`.
   - Videos and GIFs: metadata and the preview image only.
2. **Classify** (`src/x/imageClassify.js`).
   - Inputs: cheap pixel features (dark chart background, a price-axis column at the
     right edge) plus OCR token mix (tickers, `%`, `$`, header words such as
     Portfolio/Holdings/Positions/Allocation/P&L/"Filled").
   - Classes: `chart | portfolio | watchlist | fill | text_screenshot | other`.
   - Measured on 100+ hand-labelled images per account.
3. **OCR.**
   - tesseract.js over the whole image at 2×. It is fast and already a dependency.
   - EasyOCR only where Tesseract fails on portfolio or fill images, **always through
     `src/ocr/easyocrAdapter.js` and `--low-cpu`**.
   - Cached in `x_image_ocr` by md5, engine and parser version. That is the
     `asym_frame_ocr` rule: a parser change invalidates its own entries.
4. **Readers.**
   - **Chart legend** (`src/x/readers/chartLegend.js`). The top-left strip of a
     TradingView-style chart gives the ticker, timeframe and exchange. The SEC list
     (`loadMarketTickers`) **arbitrates and never refuses**, which is the Komar rule.
   - **Portfolio table** (`src/x/readers/portfolioTable.js`).
     - Words are grouped into rows by **vertical centre with a fixed anchor**: the
       O'Connell lesson.
     - The ticker column is arbitrated by the market list.
     - Header words give the meaning of each numeric column.
     - **The sign comes from the ink colour**: the Komar and O'Connell lesson.
     - A column with no header is `weight_kind = 'unknown'`, never guessed.
   - **Fill confirmation** (`src/x/readers/fillConfirmation.js`): side, ticker, quantity,
     price, time.
   - **Per-account layouts**, such as the broker app `@BoujeeFinances` uses, live in
     `src/x/accounts/<profile>/`. They are written only after Phase 5 shows what the
     screenshots look like.
5. **Fixtures are synthetic.** They are rendered with `sharp` (legend strips, table rows,
   red/green ink), because real screenshots are third-party content. A manual test scores
   the readers on your local labelled sample.

### 3.14 The optional vision extractor

- **Purpose.** Reading broker screenshots whose layouts the OCR readers do not cover yet.
  It is **off by default**, spends money, and sends the (public) images to Anthropic.
- **Call shape.**
  - One Messages API request per image through `@anthropic-ai/sdk`. That would be a new
    dependency; the project's list is deliberately short (sharp, tesseract.js), so this
    is your call.
  - **Structured outputs** with `output_config.format` and a JSON schema of rows: ticker,
    weight, value, gain, side, account label, unreadable cells.
  - With `zod` added, `client.messages.parse()` + `zodOutputFormat`.
- **Model.** `claude-opus-5-5` by default ($4 / $20 per million tokens), configurable.
  `claude-sonnet-5-5` ($2 / $10) and `claude-haiku-5-5` ($0.10 / $0.50) are cheaper
  options if you choose them.
- **Cost controls:**
  - bulk runs go through **Message Batches** at half price;
  - the instructions and schema are a **prompt-cached** stable prefix;
  - each image is read once and cached by md5 + model + prompt version;
  - `--max-images` and `--budget-usd` stop the run, and `messages.count_tokens` estimates
    the cost first;
  - a `refusal` stop reason is recorded, never retried blindly.
- **Cross-check against OCR. A vision row counts only when:**
  - its ticker appears in the image's OCR words, exactly or one edit away **and** in the
    market list;
  - its numbers appear in the OCR text.

  Otherwise the row is `row_verified = 0` and stays out of scoring. It is a second reader,
  not an oracle.

### 3.15 Account profiles, and "any account"

- **`x:add --handle <h>` works for any public account**, using the `generic` profile:
  - the English extractor, cashtags first;
  - images classified and OCR'd;
  - legend and generic portfolio readers;
  - `include_replies = self`.
- **A profile** (`src/x/accounts/<name>.js`) can add:
  - stoplist words: people the author addresses, show names such as "630" or "T3";
  - an extra lexicon file, `config/ticker_lexicon_x_<name>.csv`;
  - inverse instruments;
  - setup vocabulary;
  - image readers and layouts;
  - the account's own rules.

  A profile changes parameters only, never the pipeline.
- **A protected account** returns nothing to an app-only API token. The browser route sees
  it only if your logged-in account follows it. Coverage shows `protected`.
- **A non-English account** is catalogued but not extracted in v1. Coverage shows
  `unsupported_language`. The `lang` field drives this.

### 3.16 Scoring and analysis

- **Entry price.** The first daily close **at or after the post time** (America/New_York).
  - A post during market hours enters at that day's close.
  - A post after the close enters at the next session's close.

  X has minute-level timestamps, so the old "close on the post's date" rule would be
  look-ahead for posts made after the close.
- **Horizons:** 1 day, 1 week, 1 month.
- **Compared with:**
  - SPY over the same window;
  - "the same call on SPY" (the T3Live logic), with a Wilson interval;
  - `src/sevcik/outcomeAnalysis.js` for the arithmetic;
  - `src/analysis/priceProvider.js` for the prices. The Yahoo cache already holds daily
    open/high/low/close.
- **Units of a claim:**
  - **Primary:** one claim per setup lifecycle.
  - **Secondary:** one claim per (post, ticker).
  - A post that is bullish **and** bearish on one ticker is reported as conflicting and
    not scored (the `src/asym/claims.js` rule).
- **Setups:**
  - did price reach the trigger within the horizon, using daily high/low;
  - if triggered, the R-multiple to stop or target, and time to trigger;
  - the stop-breach rate using daily lows, as `analyzeDiscordTraders.js` already does.
- **Positions:** episode returns, the snapshot curve, concentration, turnover, holding
  periods.
- **X-specific honesty:**
  - **Survivorship.**
    - Claims captured live (capture lag under 2 days) are reported apart from backfilled
      ones.
    - Backfilled history only shows posts the author did **not** delete, so its hit rate
      is an upper bound.
    - Running incremental crawls from now on is what removes the bias.
  - **Edits.** The earliest captured version is scored. `edited_after = 1` rows are shown
    apart.
- **Cross-account:**
  - tickers named by several accounts, and who named them first (the Discord "Ariel
    entered first on 52 of 79" analysis);
  - Redler on X versus T3Live #630club: same-day agreement, never pooled.

### 3.17 Dashboard

`src/report/xReport.js` is built on `src/report/sourceDashboardShell.js` and follows
`docs/source-dashboard-pattern.md`.

- **Header:** an account selector.
- **Coverage funnel:**
  - posts in history (from the lookup or the counts);
  - windows complete;
  - posts archived;
  - with cashtags;
  - images, then images read;
  - claims, then setups and snapshots;
  - scored.

  A stage that was not checked shows `unknown`, never zero.
- **Tabs:** Activity, Signals, Setups, Positions, Images, Coverage.
- **Evidence for each item:**
  - the post text and, for quotes, the quoted text;
  - a link to `https://x.com/<handle>/status/<id>`;
  - the local image;
  - the extraction provenance (route, fidelity, parser version, ticker basis).

### 3.18 Safety, terms, credentials

**Terms.**

- The API route is the compliant one.
- The browser route breaks X's scraping clause. It is opt-in per account, uses a headed
  browser at human pacing, and **stops hard** on a challenge, a 429, a login wall or a
  lock.
- Consider a secondary X account for it (decision 6).
- Content fetched through the API is covered by X's developer agreement, including its
  deletion-compliance expectations (decision 4).

**Credentials.**

- `X_BEARER_TOKEN` lives only in `.env`.
- The browser profile lives outside the repository.
- Neither is ever printed. Redaction is unit-tested, as for the Deepgram key.

**Privacy.** Requests carry only the target handles and our own query parameters, with a
generic client name. Nothing about you goes to X beyond what your login session already is.

**Processes.**

- One crawl per X session, enforced by the lock.
- The crawl runs in the foreground with progress lines, so it never looks like a hang.
- Never run it alongside a YouTube job on the same network budget, and never run it in
  parallel.

---

## Part 4: Implementation phases

Each phase ends with its test files green (`node --test --test-concurrency=8 …`) and an
explicit exit check. **Phases 0, 2 and 3 touch the network. Phase 0 and every paid step
need your approval of the amount first.**

### Phase 0: Measure (about half a day of code; needs you)

| # | task | output |
|---|---|---|
| 0.1 | You create an X developer app (pay-per-use), set a **spending cap** (e.g. $20), and put `X_BEARER_TOKEN` in `.env` | — |
| 0.2 | `tools/x_pipeline/probe.js lookup` for the three handles (**$0.03**) | user ids, `tweet_count`, created date, protected |
| 0.3 | `probe.js counts` per query kind (originals, self-replies, all replies) over full history, at day granularity (**$0.01 per request**; the page count is measured) | posts per year per kind |
| 0.4 | `probe.js sample`: the 200 newest originals per account (**about $1 per account**) | raw sample, untracked |
| 0.5 | Hand-label 100 posts per account | % cashtag, % ticker, % image, image classes, claim types |
| 0.6 | Browser: log in once; capture one month per account as GraphQL; measure how far the profile scrolls | raw GraphQL sample |
| 0.7 | Compare the API and GraphQL captures of the same month: ids and fields | the first interchangeability measurement |

**Exit:** a per-account table appended to this document, with:

- sizes and mix;
- image classes;
- the API cost of a full backfill and of one month of incremental runs;
- the browser windows needed.

Then your decisions on backfill depth, reply policy and route per account.

### Phase 1: The contract, storage and the importer (no network)

| # | task | files | tests |
|---|---|---|---|
| 1.1 | the canonical record: validation, snowflake rules, kind rules | `src/x/postRecord.js` | `test/xPostRecord.test.js` |
| 1.2 | API normalizer | `src/x/normalizeApiV2.js` | `test/xNormalizeApiV2.test.js` |
| 1.3 | GraphQL normalizer | `src/x/normalizeGraphql.js` | `test/xNormalizeGraphql.test.js` |
| 1.4 | page-scrape normalizer (partial fidelity) | `src/x/normalizeDom.js` | `test/xNormalizeDom.test.js` |
| 1.5 | merge by field priority; route equivalence | `src/x/merge.js` | `test/xRouteEquivalence.test.js` |
| 1.6 | deterministic archive writer and reader | `src/x/archive.js` | `test/xArchive.test.js` |
| 1.7 | index store, attach and rebuild | `src/x/indexStore.js`, `data/db/schema_x_index.sql` | `test/xIndexStore.test.js` |
| 1.8 | catalog DDL and registry functions | `data/db/schema.sql` (appended), `src/x/registry.js` | `test/xRegistry.test.js` |
| 1.9 | importer for raw dirs, JSONL and agent JSONL | `src/x/importer.js` | `test/xImporter.test.js`, `test/xAgentJsonl.test.js` |
| 1.10 | CLI `init / add / list / status / import / rebuild-index` | `tools/runXPipeline.js` | covered by `test/xPipeline.test.js` |
| 1.11 | `.gitignore` rules and size guards | `.gitignore`, `test/catalogSizeGuard.test.js` | the index file, raw and media are untracked; the archive is tracked |

**Exit:**

- Importing the Phase 0 raw dirs gives N posts.
- A second import changes 0 rows and leaves the archive byte-identical.
- The equivalence test is green on the overlap month.

### Phase 2: Route A, the API

| # | task | files | tests |
|---|---|---|---|
| 2.1 | client: bearer auth, pacing, 429 + reset, redaction | `src/x/apiClient.js` | `test/xApiClient.test.js` (fake `fetch`, fake clock) |
| 2.2 | pricing config, estimator, budget guard, ledger | `config/x_api_pricing.json`, `src/x/apiBudget.js` | `test/xApiBudget.test.js`: stops **before** crossing the cap |
| 2.3 | window planner | `src/x/windows.js` | `test/xWindows.test.js` |
| 2.4 | backfill runner (resumable on `next_token`) and incremental runner (`since_id`) | `tools/x_pipeline/crawlApi.js` | `test/xCrawlApi.test.js` (fake server) |
| 2.5 | CLI `estimate`, `crawl --route api` | `tools/runXPipeline.js` | — |
| 2.6 | live smoke test, opt-in, a few cents | `test/manual/xApiLive.test.js` | — |

**Exit:**

- The smallest account's approved backfill is done.
- Every window is `complete`.
- Counts agree within tolerance.
- The ledger cost equals posts × price, minus same-day duplicates.

### Phase 3: Route B1, the scripted browser crawler

| # | task | files | tests |
|---|---|---|---|
| 3.1 | persistent profile path and login command | `src/x/browser/profile.js` | `test/xBrowserProfile.test.js`: the default path is outside the repository |
| 3.2 | GraphQL capture filter (operation names) | `src/x/browser/capture.js` | `test/xBrowserCapture.test.js` |
| 3.3 | scroll loop as a pure state machine | `src/x/browser/scroll.js` | `test/xBrowserScroll.test.js` |
| 3.4 | stop-signal detection | `src/x/browser/signals.js` | `test/xBrowserSignals.test.js` (fixture pages) |
| 3.5 | page-scrape fallback, thread completion, incremental | `src/x/browser/dom.js` | covered by 1.4 |
| 3.6 | crawler, lock, JSON stop report, exit codes | `tools/x_pipeline/crawlBrowser.js` | `test/xCrawlLock.test.js` |
| 3.7 | live window smoke test, headed | `test/manual/xBrowserLive.test.js` | — |

**Exit:**

- One month per account is captured.
- For windows measured both ways, the ids equal the API's.
- The date-operator timezone is measured and written here.

### Phase 4: Route B2, agentic

| # | task | files |
|---|---|---|
| 4.1 | supervision runbook (B2a), stop-reason → action table | `tools/x_pipeline/agentic_runbook.md` |
| 4.2 | optional project skill wrapping the runbook | `.claude/skills/x-crawl/SKILL.md` |
| 4.3 | direct-drive prompt (B2b) and in-page collector | `tools/x_pipeline/agentic_prompt.md`, `tools/x_pipeline/collector.inpage.js` |
| 4.4 | `crawl --route agent`: prints the filled runbook or prompt, the paths and the import command (Discord's `ingest-agentic` shape) | `tools/runXPipeline.js` |

**Exit:**

- A supervised session completes at least 3 windows, including one forced stop handled as
  the runbook says.
- A direct-drive gap fill imports cleanly, with `fetched_via` recorded.

### Phase 5: Media and image readers

| # | task | files | tests |
|---|---|---|---|
| 5.1 | media downloader | `tools/x_pipeline/fetchMedia.js` | `test/xMedia.test.js` (local HTTP fixture) |
| 5.2 | classifier | `src/x/imageClassify.js` | `test/xImageClassify.test.js` (synthetic images) |
| 5.3 | OCR wrapper and cache | `src/x/imageOcr.js` | `test/xImageOcrCache.test.js` |
| 5.4 | readers: chart legend, portfolio table, fill confirmation | `src/x/readers/*.js` | `test/xChartLegend.test.js`, `test/xPortfolioTable.test.js`, `test/xFillConfirmation.test.js` |
| 5.5 | per-account layouts, after labelling | `src/x/accounts/<profile>/…` | per layout |
| 5.6 | scoring the readers on your labelled sample | `tools/x_pipeline/measureImageReaders.js` | `test/manual/xImageReadersReal.test.js` |

**Exit:** per-class precision and recall, legend-ticker accuracy, and portfolio-row
accuracy, recorded in this document and accepted by you.

### Phase 6: Text claims

| # | task | files | tests |
|---|---|---|---|
| 6.1 | lift attribution + options direction to `src/claims/`; Benzinga stays byte-identical | `src/claims/attribution.js`, `src/claims/options.js`; Benzinga re-exports | existing Benzinga tests + `test/manual/benzingaClaimsRegression.test.js` (table diff) |
| 6.2 | X vocabulary, symbols, profile stoplists | `src/x/patterns.js`, `src/x/symbols.js`, `src/x/accounts/*.js` | `test/xPatterns.test.js` |
| 6.3 | extractor wrapper (`x-signals-1`): cashtags, attribution, inheritance, retrospective, image legend merge; always-replace per post; purge superseded versions on a full run | `tools/x_pipeline/extractSignals.js`, `src/x/signals.js` | `test/xSignals.test.js` |
| 6.4 | precision survey (200 claims per account) | `tools/x_pipeline/surveyClaims.js` | manual |

**Exit:**

- Precision per account is recorded.
- The T3Live, Benzinga, Asym and Sevcik counts are unchanged, or the delta is documented.

### Phase 7: Positions and episodes

| # | task | files | tests |
|---|---|---|---|
| 7.1 | lift `episodes.js` + `findPrices` into `src/positions/`, parameterized; Discord passes its own sets | `src/positions/episodes.js`, `src/positions/prices.js` | existing `test/discordEpisodes.test.js`, `test/discordTradeActions.test.js` + `test/manual/discordEpisodesRegression.test.js` (rebuild and diff the tables) |
| 7.2 | text holdings parser, trade actions, fill-confirmation actions | `src/x/positions.js`, `src/x/tradeActions.js` | `test/xPositions.test.js`, `test/xTradeActions.test.js` |
| 7.3 | builder: snapshots and actions → episodes, priced | `tools/x_pipeline/buildPositions.js` | `test/xEpisodes.test.js` |

**Exit:**

- Discord's tables are identical before and after the lift.
- The holdings account has a snapshot series and priced episodes.

### Phase 8: Setups

| # | task | files | tests |
|---|---|---|---|
| 8.1 | setup builder: trigger, stop, targets, pattern, timeframe | `src/x/setups.js` | `test/xSetups.test.js` |
| 8.2 | lifecycle linker: reply, quote, inferred; ordered states; final state | `src/x/setupLifecycle.js` | `test/xSetupLifecycle.test.js` |
| 8.3 | trigger and R-multiple scoring on daily bars | `src/x/setupOutcomes.js` | `test/xSetupOutcomes.test.js` (synthetic bars) |

**Exit:** setups with their state histories for the setup accounts, and the trigger rate
and R-multiple distribution reported.

### Phase 9: Outcomes, aggregation, dashboard, docs

| # | task | files | tests |
|---|---|---|---|
| 9.1 | outcomes: entry at the first close after the post; 1d/1w/1m vs SPY; same call on SPY; live vs backfill split | `tools/x_pipeline/analyzeOutcomes.js` | `test/xOutcomes.test.js` (synthetic prices) |
| 9.2 | aggregate: CSV and JSON, cross-account, Redler vs T3Live | `tools/x_pipeline/aggregate.js` | `test/xAggregate.test.js` |
| 9.3 | dashboard | `src/report/xReport.js` | `test/xReport.test.js` |
| 9.4 | end-to-end on synthetic fixtures; X rows never reach other sources' aggregators | — | `test/xPipeline.test.js` |
| 9.5 | npm scripts, a CLAUDE.md section, README | `package.json`, `CLAUDE.md`, `README.md` | — |

**Exit:** one command chain rebuilds the dashboard from the archive (`x:rebuild-index` →
`x:images` → `x:signals` → `x:setups` → `x:positions` → `x:outcomes` → `x:report`).

### Phase 10: Optional

- The vision extractor (§3.14), once you approve its dependency and budget.
- Scheduled incremental crawls: Windows Task Scheduler, or the Agent SDK running the B2a
  runbook.
- A deletion-compliance pass (`x:compliance`): look the ids up again, mark deletions, and
  purge on request.
- Market readings ("breadth is bad", "semis leading") into a shared readings table.
- Fixing the Discord `--driver` defect found in §1.2.

### Rough effort

| phase | code |
|---|---|
| 0 | half a day + your setup |
| 1 | 2–3 days |
| 2 | 1–2 days |
| 3 | 3–4 days |
| 4 | 1 day |
| 5 | 4–6 days |
| 6 | 3–4 days |
| 7 | 2–3 days |
| 8 | 2–3 days |
| 9 | 2–3 days |

That is about **4–5 weeks** of code. The API backfill is limited by the budget you set; the
browser backfill is limited by pacing, at days per busy account.

---

## Part 5: File map

```text
src/x/
  postRecord.js            canonical record, validation, snowflake helpers
  normalizeApiV2.js        API v2 → canonical
  normalizeGraphql.js      web GraphQL → canonical
  normalizeDom.js          page scrape / agent transcription → canonical (partial)
  merge.js                 field-priority merge
  archive.js               deterministic per-account-month JSONL
  indexStore.js            untracked index: attach, upsert, rebuild
  registry.js              x_accounts, handles, runs, windows, usage
  importer.js              the one convergence point
  windows.js               window planner + completeness
  apiClient.js, apiBudget.js
  browser/{profile,capture,scroll,signals,dom}.js
  imageClassify.js, imageOcr.js
  readers/{chartLegend,portfolioTable,fillConfirmation}.js
  patterns.js, symbols.js, signals.js
  setups.js, setupLifecycle.js, setupOutcomes.js
  positions.js, tradeActions.js
  accounts/{index,generic,michaelpbento,reddogt3,boujeefinances}.js
src/claims/{attribution,options}.js          lifted from src/benzinga (byte-identical behaviour)
src/positions/{episodes,prices}.js           lifted from src/discord (identical output)
src/report/xReport.js
tools/runXPipeline.js                        the single CLI (subcommands)
tools/x_pipeline/
  probe.js, crawlApi.js, crawlBrowser.js, fetchMedia.js
  extractSignals.js, buildPositions.js, analyzeOutcomes.js, aggregate.js
  measureImageReaders.js, surveyClaims.js
  agentic_runbook.md, agentic_prompt.md, collector.inpage.js
config/x_api_pricing.json
config/ticker_lexicon_x_<profile>.csv        only when a profile needs one
data/db/schema.sql                           + x_* catalog tables (appended)
data/db/schema_derived.sql                   + x_* derived tables
data/db/schema_x_index.sql                   the untracked index schema
src/db/derivedStore.js                       + DERIVED_TABLES entries
.claude/skills/x-crawl/SKILL.md              optional
test/fixtures/x/                             synthetic API, GraphQL and DOM payloads; synthetic images
```

---

## Part 6: Test plan

**Top-level tests** (fast, offline, synthetic fixtures). Each line is the claim the file
pins:

| file | pins |
|---|---|
| `xPostRecord` | required fields; an id above 2^53 round-trips as a string; `created_at` agrees with the snowflake; kind rules |
| `xNormalizeApiV2` | original, self-reply, reply to other, quote, repost, **truncated `text` vs `note_tweet`**, photo/video, edit history, a missing `includes` entry, an `errors[]` entry for a deleted post |
| `xNormalizeGraphql` | `TweetWithVisibilityResults` wrapper, tombstones, cursor entries skipped, promoted entries skipped, quote and repost results, note text |
| `xNormalizeDom` | partial fidelity flagged; **a repost is detected from socialContext, never from the retweet button** (the x_unsub trap); "pinned" in body text is not pinned |
| `xRouteEquivalence` | **the same post via the API and via GraphQL gives identical canonical content**; merge priority; a merge never downgrades |
| `xArchive` | identical input gives a byte-identical file; metrics are not in the archive; month bucketing in UTC; re-import is idempotent |
| `xIndexStore` | a rebuild from the archive equals the incremental state; the index file is never inside a tracked path |
| `xImporter` | upsert; never delete; `last_seen_at` moves; a deletion is marked and not removed; a scratch catalog attaches a sibling derived file (the `derivedPathFor` rule) |
| `xAgentJsonl` | the documented example validates; numeric ids, relative timestamps and missing ids are rejected |
| `xRegistry` | a handle rename keeps the user id; history rows |
| `xWindows` | monthly/yearly plans, adaptive split, one-day overlap, completeness rules, resume |
| `xApiClient` | `next_token` pagination; 429 sleeps until the reset time (fake clock); **the token never appears in errors or logs** |
| `xApiBudget` | the estimate from counts; a run **stops before** the request that would cross the cap; ledger rows |
| `xCrawlApi` | an interrupted window resumes from its `next_token`; incremental `since_id` |
| `xBrowserProfile` | the default profile directory is outside the repository |
| `xBrowserCapture` | the operation-name filter, so a rotated query id still matches |
| `xBrowserScroll` | stop on "6 scrolls with nothing new", on "passed the window start", and at the cap |
| `xBrowserSignals` | login redirect, X error page, GraphQL 429, challenge iframe, locked account → the right `stop_reason` and exit code |
| `xCrawlLock` | a second crawler is refused with the owning pid; a stale lock is cleared |
| `xMedia` | resume, md5, `name=orig` falling back to `large`, free-space refusal |
| `xImageClassify`, `xChartLegend`, `xPortfolioTable`, `xFillConfirmation`, `xImageOcrCache` | the readers on rendered fixtures; the market list arbitrates and never refuses; sign from ink; a column with no header is unknown; a parser change invalidates its cache |
| `xPatterns`, `xSignals` | cashtag explicit; bare caps gated; quoted text is `reported`; reposts never scored; inheritance flagged; retrospective; options direction; "50sma" and "3%" are not prices |
| `xSetups`, `xSetupLifecycle`, `xSetupOutcomes` | reply/quote links; inferred links flagged; ordered states; final state; trigger and R from daily bars |
| `xPositions`, `xTradeActions`, `xEpisodes` | holdings list parse; incomplete snapshots close nothing; fill-confirmation actions; episodes |
| `xOutcomes` | **entry = first close at or after the post** (in-hours vs after-hours); live vs backfill split; conflicting posts not scored |
| `xAggregate`, `xReport`, `xPipeline` | end to end on fixtures; unchecked stages show "unknown"; X rows never appear in the Sevcik/T3Live/Benzinga aggregators (the `asymPipeline` contamination test) |
| `catalogSizeGuard` (extended) | `x_index.sqlite`, raw and media are untracked; both tracked databases stay under budget |

**Manual tests** (`test/manual/`; network, browser, money or local data; never run by
the suite):

- `xApiLive`: one lookup + one small page, opt-in by an environment variable.
- `xBrowserLive`: one window, headed.
- `xImageReadersReal`: your labelled sample.
- `discordEpisodesRegression`: the Phase 7 lift.
- `benzingaClaimsRegression`: the Phase 6 lift.

---

## Part 7: Commands (proposed)

```bash
npm run x:init
npm run x:add -- --handle MichaelPBento --profile michaelpbento --since 2020-01-01 --replies self
npm run x:add -- --handle RedDogT3 --profile reddogt3 --person scott_redler
npm run x:list
npm run x:status -- --handle RedDogT3                  # windows, coverage, cost so far

npm run x:estimate -- --handle RedDogT3                # count requests only; prints posts × price
npm run x:crawl:api -- --handle RedDogT3 --budget-usd 25 --yes
npm run x:crawl:api -- --all --incremental             # daily delta via since_id

npm run x:browser:login                                # once; you log in by hand
npm run x:crawl:browser -- --handle BoujeeFinances --since 2025-01-01 --report json
npm run x:crawl:agentic -- --handle MichaelPBento      # prints the runbook / prompt + import command
npm run x:import -- --raw-dir data/x_pipeline/raw/<run_tag>
npm run x:rebuild-index

npm run x:media && npm run x:images                    # download, classify, OCR, read
npm run x:signals && npm run x:setups && npm run x:positions
npm run x:outcomes && npm run x:report                 # data/x_report.html
```

---

## Part 8: Risks

| risk | effect | mitigation |
|---|---|---|
| X changes its web app (GraphQL shape, query ids, DOM) | the browser route silently captures less | match on operation names; completeness against expected counts; fixtures from real captures; B2b to diagnose; the API route as the fallback |
| account lock or suspension | your X account is impacted | opt-in; secondary account; headed browser; human pacing; hard stop on signals; never retry tighter |
| API price or terms change | cost or access changes | prices in config; estimate before every paid run; spending cap at X's side and ours |
| survivorship (deleted bad calls) | backfilled hit rates biased upward | live vs backfill split; incremental crawling from day one; stated in the dashboard |
| edits after the fact | a changed call is scored as made | score the earliest version; flag `edited_after` |
| look-ahead in entry pricing | inflated results | first close at or after the post time |
| snowflake precision | silently corrupted ids | ids as strings, pinned by a test |
| image readers misread | wrong holdings | market-list arbitration; header-driven columns; unknown over guessed; vision rows only when verified |
| storage growth | an unpushable file | the tier split; size guard; gzip threshold; `x_derived.sqlite` contingency |
| cross-source correlation (Redler) | double-counted evidence | `person_key`; compare, never pool |
| parallel agents in one tree | a swept commit or a lost catalog write | explicit staging; prompt commits; one catalog writer at a time |

---

## Part 9: Decisions for you

1. **Route and budget per account.** The API (paid, compliant) for backfill and
   incremental, or the browser (free, account risk)? Recommendation: decide after Phase 0
   prints each account's backfill cost. Use the API for incremental in every case: about
   $0.15/day for an account posting 30 times a day.
2. **Reply policy.** `self` (recommended: threads carry the setup updates), `none`, or
   `all`. `all` can multiply a chatty account's cost.
3. **Track the post archive in git?** Recommendation: yes, plain JSONL until about 300 MB,
   then gzip. The alternative is untracked, with a backup elsewhere.
4. **Deleted posts.**
   - Keep them as a research record (recommended inside this private repository, excluded
     from anything shared), or
   - honour deletions as X's developer agreement expects for API content.

   Either way they are marked, not silently kept.
5. **The vision extractor.**
   - Enable it, and with which model? The default is `claude-opus-5-5`; Sonnet 5.5 and
     Haiku 5.5 are cheaper options.
   - What budget?
   - May `@anthropic-ai/sdk` (and optionally `zod`) be added to the dependency list?
6. **Which X account logs into the browser profile.** Your main account or a secondary one.
7. **Backfill depth.** All history, or a start date per account.
8. **Incremental schedule.** On demand, daily via Task Scheduler, or an agent on a schedule.

---

### The answers (2026-11-20)

| # | decision | answer |
|---|---|---|
| 1 | API access | you provide the key: `X_BEARER_TOKEN=…` in `.env` |
| 2 | browser crawling | **allowed** (opt-in per run, guarded as in §3.5) |
| 3 | reply policy | **own posts and own thread replies (tweetstorms) only**, never replies to other people. Enforced in the importer; `include_replies` accepts only `self` or `none` |
| 4 | deleted posts | a crawl cannot see a deleted post. Posts archived before their deletion are kept; nothing is purged |
| 5 | vision reader | **enabled**; `@anthropic-ai/sdk` added; default model `claude-opus-5-5`; `ANTHROPIC_API_KEY` in `.env` |

---

## Implementation status (2026-11-20)

### Where the keys go

`.env` in the repository root (gitignored; read by `src/transcript/loadEnv.js`; never printed):

```text
X_BEARER_TOKEN=<the app's Bearer Token from console.x.com -> your app -> Keys and tokens>
ANTHROPIC_API_KEY=<a Claude API key, for the vision reader>
```

### What is built

| part | files | tests |
|---|---|---|
| canonical record, snowflake rules, text normalisation, reply policy | `src/x/postRecord.js` | `test/xPostRecord.test.js` |
| API v2 / GraphQL / page-scrape / agent normalizers | `src/x/normalizeApiV2.js`, `normalizeGraphql.js`, `normalizeDom.js` | `test/xNormalizers.test.js`, `test/xBrowserRoute.test.js` |
| route equivalence + field-priority merge | `src/x/merge.js` | `test/xRouteEquivalence.test.js` |
| tracked archive, untracked index, registry, importer, ET sessions | `src/x/archive.js`, `indexStore.js`, `registry.js`, `importer.js`, `marketTime.js`, `rawStore.js` | `test/xStorage.test.js` |
| API route: client, budget guard, windows, lookup / estimate / resumable crawl | `src/x/apiClient.js`, `apiBudget.js`, `windows.js`, `crawlApi.js`, `config/x_api_pricing.json` | `test/xApiRoute.test.js` |
| browser route: stop signals, scroll machine, capture, lock, Playwright driver | `src/x/browser/*.js`, `src/x/lock.js`, `src/x/crawlBrowser.js` | `test/xBrowserRoute.test.js` |
| agentic modes A and B | `tools/x_pipeline/agentic_runbook.md`, `agentic_prompt.md`, `collector.inpage.js` | — |
| photos, OCR, classifier v1, vision reader, OCR cross-check | `src/x/images/*.js` | `test/xImages.test.js` |
| git policy | `.gitignore` | `test/xGitPolicy.test.js` |
| CLI + npm scripts | `tools/runXPipeline.js`, `x:*` in `package.json` | smoke-run |

**Schema:** catalog `x_accounts`, `x_account_handles`, `x_crawl_runs`,
`x_crawl_windows`, `x_api_usage` (`data/db/schema.sql`). Derived
`x_image_readings`, `x_positions` (`data/db/schema_derived.sql`). Untracked
index `data/db/schema_x_index.sql`.

**Registered:** `@michaelpbento` (setups, ideas), `@reddogt3` (setups,
positions, `person_key = scott_redler`), `@boujeefinances` (positions). Their
user ids are resolved on the first lookup or capture.

### Found while building, and fixed

- **The login wall moved.** In the live smoke test (2026-11-20, logged out,
  Edge via Playwright), a search redirected to
  `/i/jf/onboarding/web?redirect_after_login=…`, not to `/login`. The first
  detector missed it, and the crawler would have scrolled an empty page. Any
  login, onboarding or signup page, or any URL carrying
  `redirect_after_login`, is now `login_required`, and the real URL is pinned
  in the test.
- **Edits are counted, not eyeballed.** A test fixture claimed `ARO0` was one
  edit from `ARQQ`; it is two. The test now uses `AROQ` (one edit), the
  project's recorded misread.

### Found while REVIEWING, and fixed (2026-11-20)

The import was read end to end and the eleven defects below were found, each
one reproduced by running the code before it was changed. Every fix has a
test that fails without it.

| # | the defect | why it mattered | the fix |
|---|---|---|---|
| 1 | **A cashtag was spelled two ways.** The API gives `NVDA`, the web GraphQL gives `$NVDA` (and `#nasa`), and nothing stripped the marker. | The interchangeability contract (§3.3) was broken, and §3.10 rule 1 makes a cashtag an *explicit ticker* — `$NVDA` matches no ticker, so every GraphQL post lost its cashtags and the archive's content depended on which route saw the post first. | The marker is stripped in `canonicalize`, once, for every route. **And the fixture was corrected** to carry the real GraphQL shape, because it had been rendering the API's shape and hiding the defect. |
| 2 | **A deleted post's id was read from one field of the `errors[]` entry.** | §2.4 and §3.4 make the `errors[]` entry *the* mechanism for marking deletions, so an id lost there is a deletion nobody can mark. | `errorPostId()` takes the id from whichever field holds a plausible one, and from the detail's own `id: [...]` as a last resort. |
| 3 | **A renamed account lost EVERY post.** The user id was learned only from a record whose handle matched the registered one. | A total, silent loss of the first capture of every renamed account — and the account never recovered, because the id was never learned. `otherUser` was also never surfaced, so a run that dropped everything looked like a clean run. | The identity is learned from the batch: a matching handle first, otherwise the id the capture is *unanimous* about. An ambiguous capture is REPORTED, never guessed. `otherUser` is on the run row and in the log. |
| 4 | **A stalled browser window was recorded as COMPLETE.** "6 scrolls with nothing new" and a blank page both set `reachedEnd: true`. | §3.7 says a window is complete only when the route reached its natural end. A stall recorded as coverage means the paid route never comes back for it — the "absence from an incomplete listing proves nothing" failure, inside the plan that warns about it. | Only `passed_start` is a natural end. A stall is a stop, so the window is `partial`. |
| 5 | **A re-plan re-read (and re-billed) the whole backfill.** | The plan's headline promise is that the cost is linear and knowable. Moving `until` forward by a day created a *new* window over the same period. `coveredByCompleteWindow()` existed and was called by nobody. | A re-plan is REDUCED to the part no window covers (`uncoveredRanges`), so only the uncovered tail is crawled. |
| 6 | **The budget started at $0 every run.** | The ledger recorded every paid request and nothing read it back, so an interrupted run — or a second run the same day — could exceed `--budget-usd` several times over. | The budget is seeded from the ledger, so the cap is per account per UTC day, which is how X bills. |
| 7 | **The archive was written non-atomically, and one corrupt line made it unreadable.** | The archive is the one thing here that cannot be re-fetched cheaply, and a half-written month file made the whole corpus unreadable. | Written to a sibling `.tmp` and renamed over. A corrupt line is reported and the file is *not* rewritten, so the line is not dropped. |
| 8 | **Paths were stored as absolute, or as `../..`.** | The catalog is committed, so an absolute path names one machine's home directory and resolves nowhere on a clone. | The repository's own helper (`src/video/portablePaths.js`) is used for `raw_dir` and the archive paths. |
| 9 | **The run row was never closed, and its cost counter disagreed with the ledger.** | `x_crawl_runs` could not answer "what happened", and `accountStatus()` reported a spend the ledger did not support. | The run is closed with a status, a stop reason and a finish time, and the lookup and the count requests are added to the run's cost. |
| 10 | **Completeness was one-sided, and an unknown stop reason could still yield "complete".** | Only five reasons were treated as stops, so `no_graphql`, `selector_drift` and `x_error_page` fell through to "complete" — and a complete window is never crawled again. A surplus over the expected count passed too. | ANY stop reason means *not* complete, the agreement is two-sided, and `selector_drift` is a known reason. |
| 11 | **The derived rows were not replaced with zero rows.** | The vision reader deleted an image's position rows only when the new reading *had* rows, so a reading that found nothing left the old holdings in place — how a holding nobody can see stays in a portfolio report. | The rows are always replaced when a read succeeds, including with zero rows; a refused or failed read leaves them alone. Superseded reader versions are purged on a full run only. |

Four smaller ones, fixed the same way: a media item without a key and a post
whose author was missing each lost the **whole post**; a rename onto a handle
another account holds aborted the import with a raw `UNIQUE constraint
failed`; `include_replies` was normalised on only one of the two paths, so an
empty value reached the CHECK constraint; and the t.co stripper's alphabet
excluded `-` and `_`, so the routes disagreed about the same post.

Two decisions were taken at the same time and are worth naming: **the
derived file is attached** to the X catalog (so `x_positions` and
`x_image_readings` are reachable from the one connection, the way every
other source's interpretations are), and **an X run also writes a
`catalog_runs` row** (so the one table every source writes to shows every
source's runs).

### Not verified yet (needs your keys or your login)

- **The real GraphQL shape.** The fixtures are synthetic, modelled on the
  known structure. The first logged-in browser window is what confirms them.
  Then save one capture as a fixture.
- **Live API calls:** `lookup`, `estimate`, then a small `crawl --route api`.
- **The vision reader on real screenshots**, with a small budget first.

### Next commands (Phase 0)

```bash
node tools/runXPipeline.js lookup --handle RedDogT3                       # $0.01
node tools/runXPipeline.js estimate --handle RedDogT3 --budget-usd 3 --yes  # cents to ~$3
node tools/runXPipeline.js browser-login                                  # once, by hand
node tools/runXPipeline.js crawl --route browser --handle BoujeeFinances --since 2026-10-01 --max-windows 1 --report json
node tools/runXPipeline.js media --handle BoujeeFinances --limit 50
node tools/runXPipeline.js ocr --handle BoujeeFinances
node tools/runXPipeline.js vision --handle BoujeeFinances --budget-usd 1 --yes --limit 20
```

### Still to build (Phases 6–9)

Text claims (`x_signals`) through the shared English engine, setups and
their lifecycle, positions from text lists, the shared episode module
(lifted from Discord with its output pinned), outcomes vs SPY, the
aggregates and the dashboard. Also Message Batches for bulk vision reads at
half price; synchronous calls only today.

---

## Appendix A: Evidence, and how to reproduce it

```bash
# Database sizes against the 60 MB budget (test/catalogSizeGuard.test.js)
ls -la data/video_pipeline/*.sqlite

# Discord raw payload size in the catalog (read-only)
py -3 -c "import sqlite3; c=sqlite3.connect('file:data/video_pipeline/state.sqlite?mode=ro', uri=True); \
print(c.execute('select count(*), avg(length(raw_json)) from discord_messages').fetchone())"
#   -> (5515, 1318.5)

# Redler in the T3Live catalog (read-only)
py -3 -c "import sqlite3; c=sqlite3.connect('file:data/video_pipeline/state.sqlite?mode=ro', uri=True); \
print(c.execute(\"select count(*) from videos where channel='t3live' and (lower(title) like '%redler%' \
or lower(title) like '%red dog%')\").fetchone())"
#   -> (1060,)

# The price cache holds daily high/low (setup scoring needs them)
grep -n "high\|low" src/analysis/priceProvider.js
```

Code read for this plan:

- `tools/runDiscordIngest.js`, `tools/discord_pipeline/{README.md,agentic_prompt.md,browser_driver.py}`
- `src/discord/{schema,sources,tradeActions,episodes}.js`
- `src/db/derivedStore.js`, `data/db/schema*.sql`, `test/catalogSizeGuard.test.js`
- `src/transcript/{extractRunner,loadEnv}.js`
- `src/sevcik/{signalExtractor,outcomeAnalysis}.js`, `src/t3live/englishNames.js`
- `src/benzinga/attribution.js`, `src/asym/frameOcrCache.js`, `src/normalize/marketTickers.js`
- `src/komar/watchlistReader.js`, `src/report/sourceDashboardShell.js`
- `.claude/hooks/limit-processes.ps1`
- `x_unsub/{content.js,docs/*,grok-bot/extract-following.js,mcp-client/src/x-mcp.ts}`

## Appendix B: External sources (read 2026-11-20)

- X API pay-per-use pricing and credits: https://docs.x.com/x-api/getting-started/pricing
- X API user Posts timeline (3,200 cap): https://docs.x.com/x-api/posts/timelines/introduction
- X API search (full-archive on pay-per-use, 500 per request, back to 2006): https://docs.x.com/x-api/posts/search/introduction
- Claude Agent SDK (for the optional unattended runner): https://code.claude.com/docs/en/agent-sdk
