-- Shared schema for the CATALOG, data/video_pipeline/state.sqlite.
-- The interpretation tables live in derived.sqlite (schema_derived.sql),
-- which is also tracked. This file is the source of truth for the catalog.
-- Do NOT add a derived CREATE TABLE here: whiteboard_worker.py executes
-- this file on every open, and an unqualified CREATE lands in the catalog.
-- All CREATE TABLE statements are idempotent (IF NOT EXISTS).

-- Tracks which schema versions have been applied.
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- Video pipeline tables ---------------------------------------------------

-- The column order below matches the tracked catalog in
-- data/video_pipeline/state.sqlite exactly, so a fresh clone and the shipped
-- database have the same table shape. Nothing reads this table positionally
-- -- every query names its columns -- but the two being interchangeable is
-- worth the ordering constraint, and the shipped table's CHECK on `status` is
-- a real constraint the shipped catalog enforces.
CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    upload_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'downloading', 'scanning', 'review', 'done', 'no_match', 'error')),
    download_path TEXT NOT NULL DEFAULT '',
    output_path TEXT NOT NULL DEFAULT '',
    selected_timestamp REAL,
    selected_score REAL,
    review_reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    transcript_segment_count INTEGER NOT NULL DEFAULT 0,
    transcript_fetched_at TEXT NOT NULL DEFAULT '',
    -- Whether the ORIGINAL FILE is still needed. NOT a status: `done`
    -- already means two things and the downloaders exclude it, so a
    -- deletion flag living there would hide a deleted file from every
    -- re-fetch. '' keeps the file (the default, and the safe one);
    -- 'scanned' is a done probe log naming this video, file stays;
    -- 'disposable' is that log AND a pixel-verified ground-truth pin
    -- for the date. See src/video/analysisState.js.
    analysis_state TEXT NOT NULL DEFAULT ''
        CHECK (analysis_state IN ('', 'scanned', 'disposable'))
);


CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);

CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);

CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel);


CREATE TABLE IF NOT EXISTS worker_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);


-- Column order matches the tracked catalog in data/video_pipeline/state.sqlite.
CREATE TABLE IF NOT EXISTS catalog_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    command_json TEXT NOT NULL,
    raw_output_path TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    inserted_count INTEGER NOT NULL,
    updated_count INTEGER NOT NULL,
    missing_upload_dates INTEGER NOT NULL,
    malformed_rows INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    -- 'live' for a real channel run, 'fixture' for a test fixture.
    kind TEXT NOT NULL DEFAULT 'live',
    -- How many of the catalog's rows for this channel were NOT in the
    -- listing this run fetched. See `not_listed` in the run's JSON summary:
    -- a video missing from a `/videos` listing may have become a Short, a
    -- livestream or members-only content, so this is an observation and not
    -- proof of deletion.
    not_listed_count INTEGER NOT NULL DEFAULT 0,
    -- 1 when this run's listing covered the whole channel, 0 when it was
    -- truncated or a video failed -- in which case a row missing from the
    -- listing proves nothing. 0 is also the value for a run recorded before
    -- this column existed: the run made no such claim.
    listing_complete INTEGER NOT NULL DEFAULT 0,
    -- What `row_count` counts: 'listing_rows' for a catalog run (the rows the
    -- channel listing yielded), 'work_list_videos' for a fill-dates run (the
    -- videos in the work list). The two are not comparable, so the column
    -- says which is which. '' means the run made no such claim.
    row_count_kind TEXT NOT NULL DEFAULT ''
);


-- Transcript / trade-signal tables (Sevcik prediction streams) ----------
--
-- These tables are for the TRANSCRIPT-first source: a YouTube channel whose
-- videos carry spoken trade commentary rather than an on-screen position
-- list. The OCR pipeline reads pixels; this one reads words.
--
-- The design keeps three things apart that the earlier pipeline conflates:
--
--   video_transcripts   one canonical transcript artifact per video, and
--                        WHICH PROVIDER produced it (YouTube auto-captions,
--                        Deepgram, or a human). The provider matters because
--                        the two are not equally trustworthy, and a later
--                        reader has to know which one a signal came from.
--   transcript_segments the normalized (start, end, text) triples. Both
--                        providers are normalized into this ONE shape, so
--                        everything downstream is provider-agnostic. THIS
--                        TABLE IS NOT IN THIS FILE -- it lives in its own
--                        untracked database (see schema_transcript_segments.sql).
--   trade_signals       the extracted structured trade ideas. Every row
--                        carries the EXACT transcript text it came from, so a
--                        claim is always checkable against its evidence.
--
-- Nothing here overwrites `videos.transcript_path` -- that column is the
-- existing project's own single-transcript pointer, and this pipeline writes
-- it too so the two views of a transcript agree.

CREATE TABLE IF NOT EXISTS video_transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('youtube_auto', 'deepgram', 'manual')),
    language TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    segment_count INTEGER NOT NULL DEFAULT 0,
    -- Provider-reported quality, when there is one. Deepgram returns a
    -- per-word confidence; the YouTube auto-captions carry none, so this
    -- stays NULL for them rather than being invented.
    quality_score REAL,
    -- md5 of the transcript text. Two runs of the same provider over the
    -- same video produce the same text, so this is what makes a re-run
    -- idempotent instead of a second row.
    checksum TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id)
);


CREATE INDEX IF NOT EXISTS idx_video_transcripts_provider ON video_transcripts(provider);


-- AsymTrading Substack tables ---------------------------------------------
--
-- The AsymTrading source is a Substack publication, not a YouTube channel,
-- so its catalog has things a YouTube channel does not: a PAYWALL, a
-- post SLUG, and a body that is TEXT rather than pixels.
--
-- So the publication's posts get their OWN table rather than going into
-- the videos table. Two reasons:
--
--   1. The videos table is keyed on a YouTube video id and its status
--      column carries the OCR pipeline's lifecycle (pending -> scanning ->
--      done). A Substack post's lifecycle is different -- catalogued, body
--      read, media transcribed -- and overloading the OCR vocabulary would
--      make both harder to read.
--   2. A paid post has NO media and NO body. It cannot be a "video" in any
--      sense the rest of the pipeline means, but it IS a post that exists
--      and that a subscriber would be able to read. Recording it keeps the
--      corpus honest: the catalog says what was published and what the
--      pipeline was allowed to read.
--
-- The two tables are:
--
--   asym_posts      one row per Substack post, for EVERY post -- free and
--                    paid. The access column records which. This is the
--                    corpus.
--   asym_articles   one row per FREE post whose body was read and parsed.
--                    The parsed market readings live here rather than in
--                    the transcript tables, because they are the author's
--                    own spreadsheet readings and not speech.
--
-- WHY THE PARSED READINGS ARE NOT trade_signals
--
-- trade_signals is a TICKER table: one row per (video, ticker) with a
-- direction, a confidence and the sentence it came from. The market
-- readings here are not calls on a ticker -- "breadth is Positive" is a
-- statement about the market, and it applies to no ticker at all. Putting
-- it in trade_signals would either force a fake ticker onto it or lose
-- the readings that carry no ticker.
--
-- The article's TICKER mentions (the indices SPY/QQQ/MDY/IWM) are kept in
-- asym_articles.index_tickers as a list, for the same reason: they are
-- context in a market reading, not calls.

CREATE TABLE IF NOT EXISTS asym_posts (
    -- The catalog id. The Substack post id, namespaced so it can never
    -- collide with a YouTube video id. See src/asym/channel.js.
    video_id TEXT PRIMARY KEY,
    -- Substack's own numeric post id. What the API keys media by.
    post_id TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    -- The author's own date label, e.g. "10/28/2026". It is the date the
    -- POST is about, which is not always the date it was published: 86 of
    -- the corpus's posts are published after midnight UTC and so carry a
    -- UTC date one day later than the label.
    post_label TEXT NOT NULL DEFAULT '',
    -- The publication timestamp, ISO-8601.
    post_date TEXT NOT NULL DEFAULT '',
    -- The calendar date the post is ABOUT, as YYYYMMDD -- the same shape
    -- videos.upload_date uses, so the two catalogs sort together.
    upload_date TEXT NOT NULL DEFAULT '',
    -- 'everyone' or 'only_paid', as Substack reports it.
    audience TEXT NOT NULL DEFAULT '',
    -- 'free' | 'paywalled' | 'teaser_only' | 'empty_body'. What the
    -- pipeline could actually read, which is not the same as what the
    -- publication says. These are the REASNS asymAccess() returns, and
    -- they are what is stored -- so a query for 'paid' finds nothing.
    access TEXT NOT NULL DEFAULT '',
    -- The series: market_pulse, swing_trading_course, and so on.
    series TEXT NOT NULL DEFAULT '',
    -- 1 when the post carries an embedded video.
    has_media INTEGER NOT NULL DEFAULT 0,
    -- The Mux media-upload id of that video.
    media_upload_id TEXT NOT NULL DEFAULT '',
    -- EVERY media-upload id on the post, as a JSON array. A post can carry
    -- more than one embedded video, and `media_upload_id` above is only the
    -- first one -- the one the pipeline scores. This keeps the rest.
    media_upload_ids TEXT NOT NULL DEFAULT '',
    -- The video's length in seconds, when the API reports it.
    media_duration REAL,
    -- The breadth/momentum spreadsheet the post links to.
    spreadsheet_url TEXT NOT NULL DEFAULT '',
    -- The day's TC2000 stock list the post links to.
    tc2000_url TEXT NOT NULL DEFAULT '',
    -- The word count Substack reports for the body.
    word_count INTEGER NOT NULL DEFAULT 0,
    -- Whether the extraction pipeline skips this post.
    quarantined INTEGER NOT NULL DEFAULT 0,
    -- Why it was skipped.
    quarantine_reason TEXT NOT NULL DEFAULT '',
    -- When the body was read, if it was.
    body_fetched_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id)
);


CREATE INDEX IF NOT EXISTS idx_asym_posts_date ON asym_posts(upload_date);

CREATE INDEX IF NOT EXISTS idx_asym_posts_access ON asym_posts(access);

CREATE INDEX IF NOT EXISTS idx_asym_posts_series ON asym_posts(series);

CREATE INDEX IF NOT EXISTS idx_asym_posts_media ON asym_posts(has_media);


-- Discord pipeline tables -------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_kind TEXT NOT NULL DEFAULT 'text',
    -- Whose messages the channel is about. Empty means EVERY author, which
    -- is what a channel nobody else posts in is. A shared channel names
    -- one person here, and the ingest skips the rest: plechac's two
    -- channels carry about 40 members each and his messages are 1,840 of
    -- the 14,100 in them.
    author_id TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    last_run_at TEXT,
    last_message_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
);


CREATE TABLE IF NOT EXISTS discord_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES discord_sources(id),
    discord_message_id TEXT NOT NULL UNIQUE,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    has_tickers INTEGER NOT NULL DEFAULT 0,
    ticker_list TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL
);


CREATE INDEX IF NOT EXISTS idx_discord_messages_source_posted
    ON discord_messages(source_id, posted_at);

CREATE INDEX IF NOT EXISTS idx_discord_messages_tickers
    ON discord_messages(has_tickers, posted_at);


CREATE TABLE IF NOT EXISTS discord_pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES discord_sources(id),
    run_tag TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
);


-- Benzinga source tables ---------------------------------------------------
--
-- Benzinga is a TRANSCRIPT source, so its catalog rows live in the same
-- `videos` table as every other channel. What it needs beyond that is the
-- listing membership and the length, because the channel's content is
-- decided by three facts a video id does not carry: which listing it came
-- from, how long it is, and whether it had been streamed yet.
--
--   video_listing_entries   one row per (video, listing). The `videos` table
--                            cannot hold this: a video can be in the
--                            streams tab AND the videos tab AND a show
--                            playlist, and `videos.source_url` holds only the
--                            last listing that was fetched.
--   market_readings         what a video says about the MARKET, a SECTOR or
--                            a MACRO EVENT, as opposed to a ticker.
--
-- WHY market_readings IS NOT trade_signals
--
-- `trade_signals` is a TICKER table: one row per (video, ticker) with a
-- direction, a confidence and the sentence it came from. "Breadth is
-- positive" and "we like semiconductors" are market readings, not calls on
-- a ticker -- they apply to no single name. Putting them in trade_signals
-- would either force a fake ticker onto them or lose them.
--
-- The same reasoning is why the AsymTrading source keeps its own readings
-- in its own table rather than in trade_signals.

CREATE TABLE IF NOT EXISTS video_listing_entries (
    video_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    -- streams | videos | shorts | playlist
    listing_kind TEXT NOT NULL DEFAULT '',
    -- The listing URL this row was taken from.
    listing_url TEXT NOT NULL DEFAULT '',
    -- The YouTube playlist id, when the listing is a playlist.
    playlist_id TEXT NOT NULL DEFAULT '',
    playlist_title TEXT NOT NULL DEFAULT '',
    -- The video's length in seconds, as the listing reported it.
    duration_sec REAL,
    -- was_live | is_live | is_upcoming | post_live | '' (not a stream)
    live_status TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, listing_kind, playlist_id)
);


CREATE INDEX IF NOT EXISTS idx_video_listing_entries_channel
    ON video_listing_entries(channel, listing_kind);


-- Caption availability is an observation, not a transcript. A video may
-- have captions before anyone fetches them; a refused/rate-limited probe must
-- stay distinguishable from a confirmed absence of tracks.
CREATE TABLE IF NOT EXISTS video_caption_availability (
    video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'available', 'unavailable', 'refused', 'error')),
    track_count INTEGER NOT NULL DEFAULT 0,
    auto_track_count INTEGER NOT NULL DEFAULT 0,
    manual_track_count INTEGER NOT NULL DEFAULT 0,
    languages_json TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'youtube_list_subs'
);


CREATE INDEX IF NOT EXISTS idx_video_caption_availability_status
    ON video_caption_availability(status);


-- Per-video date lookup outcomes. Batch/network failures are recorded against
-- each unresolved id so a later run can target only items that are eligible
-- for retry instead of treating the batch as one opaque failure.
CREATE TABLE IF NOT EXISTS video_date_resolution (
    video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved', 'future_event', 'age_gated',
                          'rate_limited', 'network_error', 'unavailable', 'error')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    upload_date TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT NOT NULL DEFAULT '',
    retry_after TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_run_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE INDEX IF NOT EXISTS idx_video_date_resolution_status_retry
    ON video_date_resolution(status, retry_after);

-- OCR scan outcomes. NOT analysis_state: that column only answers whether
-- the original media file is still needed. This table records whether a
-- video was scanned with a named production profile, and what came out.
CREATE TABLE IF NOT EXISTS ocr_scan_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    upload_date TEXT NOT NULL DEFAULT '',
    run_tag TEXT NOT NULL DEFAULT '',
    profile_id TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT '',
    cluster_rule TEXT NOT NULL DEFAULT '',
    max_captures INTEGER,
    status TEXT NOT NULL DEFAULT 'error'
        CHECK (status IN ('ok', 'timeout', 'error', 'missing_media', 'partial')),
    ticker_count INTEGER NOT NULL DEFAULT 0,
    tickers_json TEXT NOT NULL DEFAULT '[]',
    log_path TEXT NOT NULL DEFAULT '',
    elapsed_ms INTEGER,
    finished_at TEXT NOT NULL DEFAULT (datetime('now')),
    detail TEXT NOT NULL DEFAULT '',
    UNIQUE (video_id, run_tag)
);


CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_video_status
    ON ocr_scan_outcomes(video_id, status);

CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_date_status
    ON ocr_scan_outcomes(upload_date, status);

CREATE INDEX IF NOT EXISTS idx_ocr_scan_outcomes_profile_status
    ON ocr_scan_outcomes(profile_id, status);




-- =====================================================================
-- The O'Connell source ("Pristine Capital"), read as DOCUMENTS.
--
-- WHY IT HAS ITS OWN TABLES AND NOT `videos` / `trade_signals`
--
-- `videos` is named for YouTube, and its `status` column is an OCR
-- pipeline's lifecycle. A newsletter PDF has neither. `trade_signals`
-- and `market_readings` both carry a NOT NULL `transcript_id` that
-- REFERENCES video_transcripts(id): they are transcript-shaped, and this
-- source has no transcript, so reusing them would mean either a foreign
-- key to nothing or a change to tables four other sources depend on.
--
-- So this source gets its own tables, the way AsymTrading does. The id
-- is namespaced (`oconnell_<source_date>`), so it can never collide.
--
-- WHY THE SOURCE DATE AND THE PUBLISH DATE ARE SEPARATE
--
-- The filename is the SESSION the issue covers; the newsletter goes out
-- the morning after. The 20261112 issue was published 2026-11-13 10:20.
-- The id is the session date, because that is what the corpus is read
-- by, and the publish timestamp is a separate column.
-- =====================================================================

-- One row per document in the corpus.
CREATE TABLE IF NOT EXISTS oconnell_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The namespaced catalog id: `oconnell_20261112`, `oconnell_20260303_2`.
    doc_id TEXT NOT NULL UNIQUE,
    -- The session the issue covers, from the filename. YYYYMMDD.
    source_date TEXT NOT NULL,
    -- The publish timestamp, from the document's own print footer.
    publish_date TEXT NOT NULL DEFAULT '',
    publish_time TEXT NOT NULL DEFAULT '',
    -- Disambiguates a second document on the same date (`_2` in the name).
    sequence TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    series TEXT NOT NULL DEFAULT '',
    -- market_analysis_watchlist | weekend_watchlist | research_note |
    -- knowledge_hub | special
    kind TEXT NOT NULL DEFAULT 'special',
    -- paid | free | unknown
    access TEXT NOT NULL DEFAULT 'unknown',
    page_count INTEGER NOT NULL DEFAULT 0,
    source_url TEXT NOT NULL DEFAULT '',
    -- The path RELATIVE to the corpus folder. The corpus lives outside
    -- this repository, so an absolute path would name one machine's home
    -- directory in a tracked artifact.
    pdf_path TEXT NOT NULL DEFAULT '',
    pdf_bytes INTEGER NOT NULL DEFAULT 0,
    pdf_checksum TEXT NOT NULL DEFAULT '',
    -- The standalone position-log screenshot beside the PDF, if there is
    -- one. It is a higher-resolution copy of the table the PDF embeds.
    positions_path TEXT NOT NULL DEFAULT '',
    positions_checksum TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE INDEX IF NOT EXISTS idx_oconnell_issues_date ON oconnell_issues(source_date);

CREATE INDEX IF NOT EXISTS idx_oconnell_issues_kind ON oconnell_issues(kind);


-- X (x.com) source tables ---------------------------------------------------
--
-- See docs/x-source-plan.md. Only the REGISTRY and the CRAWL AUDIT live in
-- the catalog: they are small. The posts themselves are NOT here -- a busy
-- account is tens of thousands of posts, and the catalog has a 60 MB budget
-- (test/catalogSizeGuard.test.js). The posts live in the tracked JSONL
-- archive under data/x_pipeline/archive/ (the record) and in an untracked
-- index rebuilt from it (data/x_pipeline/x_index.sqlite).
--
-- An account is keyed by an internal account_id, NOT by its handle (handles
-- get renamed and reused) and not by the numeric user id alone (the browser
-- route can register an account before the user id is known). The user id
-- is UNIQUE once known, and a handle that suddenly maps to a different user
-- id is an error, never a silent re-assignment.

CREATE TABLE IF NOT EXISTS x_accounts (
    account_id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- X's numeric user id, as TEXT (ids are not safe as JS numbers).
    -- NULL until the first lookup or the first captured post resolves it.
    user_id TEXT UNIQUE,
    -- The current handle, lowercase, without the at-sign.
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    -- Which src/x/accounts/<profile>.js applies. 'generic' works for anyone.
    profile TEXT NOT NULL DEFAULT 'generic',
    -- What the account is SAID to post (setups,positions). A hint for the
    -- reader of the dashboard, never a rule the extractor obeys.
    declared_kinds TEXT NOT NULL DEFAULT '',
    -- Cross-source identity: scott_redler links RedDogT3 to the T3Live
    -- channel. Correlated evidence is compared, never pooled.
    person_key TEXT NOT NULL DEFAULT '',
    -- self = own posts + own thread replies (tweetstorms); never replies to
    -- other people. The user's decision, 2026-11-20.
    include_replies TEXT NOT NULL DEFAULT 'self'
        CHECK (include_replies IN ('none', 'self')),
    -- The oldest date wanted, YYYY-MM-DD (empty = everything).
    backfill_since TEXT NOT NULL DEFAULT '',
    protected INTEGER NOT NULL DEFAULT 0,
    tweet_count_at_lookup INTEGER,
    followers_at_lookup INTEGER,
    account_created_at TEXT NOT NULL DEFAULT '',
    looked_up_at TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS x_account_handles (
    account_id INTEGER NOT NULL REFERENCES x_accounts(account_id),
    handle TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (account_id, handle)
);


-- One row per crawl or import INVOCATION. Written at the START and updated
-- as the run goes, so an interrupted run still leaves a row that says what
-- it did (the fill-dates lesson in CLAUDE.md).
CREATE TABLE IF NOT EXISTS x_crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES x_accounts(account_id),
    route TEXT NOT NULL CHECK (route IN ('api', 'browser', 'agent', 'import')),
    run_tag TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    -- running | ok | partial | blocked | failed
    status TEXT NOT NULL DEFAULT 'running',
    windows_planned INTEGER NOT NULL DEFAULT 0,
    windows_complete INTEGER NOT NULL DEFAULT 0,
    posts_seen INTEGER NOT NULL DEFAULT 0,
    posts_new INTEGER NOT NULL DEFAULT 0,
    posts_updated INTEGER NOT NULL DEFAULT 0,
    posts_filtered INTEGER NOT NULL DEFAULT 0,
    -- Posts that were DROPPED because they belong to another user id. A
    -- run that dropped everything must not look like a run that found
    -- nothing, so the count is on the row.
    posts_other_user INTEGER NOT NULL DEFAULT 0,
    -- Posts X says it no longer has (an errors[] entry, not a missing row).
    posts_rejected INTEGER NOT NULL DEFAULT 0,
    api_cost_usd_est REAL NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL DEFAULT '',
    -- Repo-relative when inside the repository (the portable-path rule).
    raw_dir TEXT NOT NULL DEFAULT '',
    -- live | fixture
    kind TEXT NOT NULL DEFAULT 'live'
);


CREATE INDEX IF NOT EXISTS idx_x_crawl_runs_account ON x_crawl_runs(account_id, started_at);


-- The unit of work. A window is COMPLETE only when its route reached its
-- natural end (the API ran out of pages; the browser scrolled past the
-- window start with no stop signal). Absence from an incomplete window
-- proves nothing -- the same rule as catalog_runs.listing_complete.
CREATE TABLE IF NOT EXISTS x_crawl_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES x_accounts(account_id),
    -- originals | self_replies | all_own (the browser's one query)
    query_kind TEXT NOT NULL,
    -- ISO dates; window_end is EXCLUSIVE.
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('api', 'browser', 'agent')),
    -- pending | running | complete | partial | blocked | failed
    status TEXT NOT NULL DEFAULT 'pending',
    count_expected INTEGER,
    posts_seen INTEGER NOT NULL DEFAULT 0,
    oldest_seen TEXT NOT NULL DEFAULT '',
    newest_seen TEXT NOT NULL DEFAULT '',
    -- The API's pagination token, so an interrupted window resumes mid-way.
    next_token TEXT NOT NULL DEFAULT '',
    last_run_id INTEGER,
    stop_reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, query_kind, window_start, window_end, route)
);


CREATE INDEX IF NOT EXISTS idx_x_crawl_windows_status
    ON x_crawl_windows(account_id, status);


-- The API ledger: one row per paid request. The price is copied onto the
-- row because X's prices change; the row says what was believed at the time.
CREATE TABLE IF NOT EXISTS x_api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    endpoint TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    http_status INTEGER,
    resources_returned INTEGER NOT NULL DEFAULT 0,
    -- post_read | user_read | counts_all_request | counts_recent_request
    unit TEXT NOT NULL,
    unit_price_usd REAL NOT NULL,
    est_cost_usd REAL NOT NULL
);


CREATE INDEX IF NOT EXISTS idx_x_api_usage_run ON x_api_usage(run_id);
