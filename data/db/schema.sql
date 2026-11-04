-- Shared schema for the video pipeline and Discord pipeline.
-- Both pipelines write to data/video_pipeline/state.sqlite.
-- This file is the single source of truth for table definitions.
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
    transcript_fetched_at TEXT NOT NULL DEFAULT ''
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
--                        everything downstream is provider-agnostic.
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

CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL REFERENCES video_transcripts(id),
    video_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    text TEXT NOT NULL,
    -- Provider confidence for this segment, when the provider reports one.
    confidence REAL,
    UNIQUE(transcript_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_video_time
    ON transcript_segments(video_id, start_sec);

CREATE TABLE IF NOT EXISTS trade_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    transcript_id INTEGER NOT NULL REFERENCES video_transcripts(id),
    -- The transcript segments this signal was read from. A signal can span
    -- more than one segment, so the span is recorded rather than a single
    -- index.
    segment_start_index INTEGER NOT NULL,
    segment_end_index INTEGER NOT NULL,
    event_time_sec REAL,
    ticker TEXT NOT NULL,
    -- buy / add / sell / trim / short / cover / hold / watch
    action TEXT NOT NULL DEFAULT '',
    -- bullish / bearish / neutral / mixed
    bias TEXT NOT NULL DEFAULT 'neutral'
        CHECK (bias IN ('bullish', 'bearish', 'neutral', 'mixed')),
    confidence_label TEXT NOT NULL DEFAULT '',
    confidence_score REAL,
    entry_price REAL,
    target_price_low REAL,
    target_price_high REAL,
    stop_price REAL,
    -- "today", "swing", "a few weeks" -- the horizon, when it was said.
    horizon_text TEXT NOT NULL DEFAULT '',
    -- A one-line summary of the reason, when one could be extracted.
    rationale TEXT NOT NULL DEFAULT '',
    -- The EXACT transcript text this signal was read from. A signal without
    -- its evidence is not checkable, so this is NOT NULL.
    evidence_text TEXT NOT NULL,
    -- Which extractor version produced this row, so a re-run with a changed
    -- parser can be told apart from the previous one.
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_video ON trade_signals(video_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_ticker_time
    ON trade_signals(ticker, event_time_sec);
CREATE INDEX IF NOT EXISTS idx_trade_signals_bias ON trade_signals(bias);
CREATE INDEX IF NOT EXISTS idx_trade_signals_parser ON trade_signals(parser_version);

-- Discord pipeline tables -------------------------------------------------

CREATE TABLE IF NOT EXISTS discord_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_kind TEXT NOT NULL DEFAULT 'text',
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
