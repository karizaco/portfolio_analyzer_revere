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

-- `transcript_segments` used to be declared here. It is the largest table in
-- the pipeline (698,450 rows, about 98 MB) and it is a CACHE of the transcript
-- JSON under data/video_pipeline/transcripts/ -- so it lives in its own,
-- untracked database file. See data/db/schema_transcript_segments.sql and
-- src/transcript/segmentStore.js: the tools ATTACH that file and their SQL is
-- unchanged, because an unqualified `transcript_segments` resolves to it.

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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- forward | retrospective. A retrospective row is a call being GRADED
    -- ("I was bullish on X last week"), not a call being made, and the
    -- outcome scoring excludes it.
    --
    -- It is declared here AND added at runtime by the extractors
    -- ("ALTER TABLE trade_signals ADD COLUMN claim_kind TEXT"). The
    -- runtime ALTER is what migrated the existing catalogs; declaring it
    -- is what makes a FRESH clone correct -- without this, a fresh
    -- database has no such column until an extractor runs, and every
    -- aggregator query that reads it fails on the first run.
    --
    -- It sits AFTER created_at because that is where the ALTER put it in
    -- the tracked catalog, so a table created from this file has the same
    -- column order as the tracked one.
    claim_kind TEXT NOT NULL DEFAULT 'forward'
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_video ON trade_signals(video_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_ticker_time
    ON trade_signals(ticker, event_time_sec);
CREATE INDEX IF NOT EXISTS idx_trade_signals_bias ON trade_signals(bias);
CREATE INDEX IF NOT EXISTS idx_trade_signals_parser ON trade_signals(parser_version);

-- The SETUPS the speaker described -------------------------------------
--
-- A setup is NOT a signal. The speaker does not disclose positions; he
-- describes setups and ideas -- "if it holds this level, long". A signal
-- is a trade-shaped sentence with a direction and a price; a setup is
-- the THING he is talking about, which may be talked about for ten
-- minutes, may be revisited, and may end up worked, failed, or
-- invalidated.
--
-- So this table is one row per (video, ticker), and the columns are the
-- lifecycle of that setup:
--
--   state          the state it is IN at the end of the video
--   states         every state it went through, in order
--   mentions       how many times he talked about it
--
-- The STATES are read off the words he uses:
--
--   new           "mam tady novou predikci"
--   running       "predikce bezi" -- still live
--   worked        "predikce vysla"
--   failed        "predikce nevisla"
--   invalidated   "predikce zneplatnena"
--   old           "byla stara" -- being reviewed
--
-- The CERTAINTY is how strongly he said it, and it is a separate scale
-- from the signal's confidence, because it is a different question:
--
--   certain / high / even / conditional / low / unknown
--
-- "conditional" is its own level and not a point between "high" and
-- "low". He says "podmineny long" as his DEFAULT form for a live
-- setup, so a scale that forced it onto that line would have to call it
-- either better or worse than a coin flip, and the corpus does not
-- support either.
CREATE TABLE IF NOT EXISTS sevcik_setups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    transcript_id INTEGER NOT NULL REFERENCES video_transcripts(id),
    ticker TEXT NOT NULL,
    -- The name he SAID, which is not the ticker: "Tesla" for TSLA.
    spoken_name TEXT NOT NULL DEFAULT '',
    -- The state the setup is IN at the end of the video.
    state TEXT NOT NULL DEFAULT 'running'
        CHECK (state IN ('new', 'running', 'worked', 'failed',
                         'invalidated', 'old')),
    -- Every state it went through, in order, comma-separated.
    states TEXT NOT NULL DEFAULT '',
    -- How many times he talked about the setup.
    mentions INTEGER NOT NULL DEFAULT 0,
    -- The span of transcript segments the setup covers.
    segment_start_index INTEGER NOT NULL DEFAULT 0,
    segment_end_index INTEGER NOT NULL DEFAULT 0,
    event_time_sec REAL,
    -- The certainty scale.
    certainty_level TEXT NOT NULL DEFAULT 'unknown'
        CHECK (certainty_level IN ('certain', 'high', 'even',
                                    'conditional', 'low', 'unknown')),
    certainty_confidence REAL,
    -- The word that carried the certainty, verbatim.
    certainty_marker TEXT NOT NULL DEFAULT '',
    -- A probability the speaker stated, when he stated one.
    probability REAL,
    -- He said he does not know the direction.
    direction_uncertain INTEGER NOT NULL DEFAULT 0,
    -- The setup was still live at the end of the video.
    still_running INTEGER NOT NULL DEFAULT 0,
    invalidated INTEGER NOT NULL DEFAULT 0,
    worked INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    -- The exact transcript sentences that mention the setup.
    evidence_text TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_sevcik_setups_video ON sevcik_setups(video_id);
CREATE INDEX IF NOT EXISTS idx_sevcik_setups_ticker ON sevcik_setups(ticker);
CREATE INDEX IF NOT EXISTS idx_sevcik_setups_state ON sevcik_setups(state);
CREATE INDEX IF NOT EXISTS idx_sevcik_setups_certainty
    ON sevcik_setups(certainty_level);

-- Sevcik TA evaluation feature store ------------------------------------
--
-- One row per scored claim (signal or setup) with event alignment, indicator
-- snapshot at claim time, regime labels, archetype, gap context, and optional
-- R-multiple simulation fields. Rebuilt by tools/analyzeSevcikTa.js.

CREATE TABLE IF NOT EXISTS sevcik_ta_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_row_id INTEGER,
    video_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    yahoo_symbol TEXT NOT NULL DEFAULT '',
    bias TEXT NOT NULL DEFAULT '',
    claim_kind TEXT NOT NULL DEFAULT '',
    claim_date TEXT NOT NULL DEFAULT '',
    executable_date TEXT NOT NULL DEFAULT '',
    alignment_confidence TEXT NOT NULL DEFAULT '',
    alignment_rule TEXT NOT NULL DEFAULT '',
    venue TEXT NOT NULL DEFAULT '',
    asof_date TEXT NOT NULL DEFAULT '',
    close REAL,
    rsi14 REAL,
    macd REAL,
    macd_signal REAL,
    macd_hist REAL,
    sma20 REAL,
    sma50 REAL,
    sma200 REAL,
    ema21 REAL,
    atr14 REAL,
    atr_pct REAL,
    bb_mid REAL,
    bb_upper REAL,
    bb_lower REAL,
    bb_bandwidth REAL,
    volume_z20 REAL,
    adx14 REAL,
    bar_count INTEGER NOT NULL DEFAULT 0,
    trend_regime TEXT NOT NULL DEFAULT '',
    vol_regime TEXT NOT NULL DEFAULT '',
    mtf_score REAL,
    mtf_label TEXT NOT NULL DEFAULT '',
    archetype TEXT NOT NULL DEFAULT '',
    gap_talk INTEGER NOT NULL DEFAULT 0,
    linguistic_gap_setup INTEGER,
    market_gap_observed INTEGER,
    real_gap INTEGER,
    has_gap INTEGER,
    gap_pct REAL,
    gap_direction TEXT NOT NULL DEFAULT '',
    gap_filled_5d INTEGER,
    r_multiple REAL,
    r_multiple_clipped REAL,
    mfe_r REAL,
    mae_r REAL,
    exit_reason TEXT NOT NULL DEFAULT '',
    stop_mode TEXT NOT NULL DEFAULT '',
    confidence_band TEXT NOT NULL DEFAULT '',
    hit_1w INTEGER,
    hit_1m INTEGER,
    return_1w REAL,
    return_1m REAL,
    aligned_return_1w REAL,
    aligned_return_1m REAL,
    feature_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, video_id, ticker, claim_date, executable_date, bias, source_row_id)
);

CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_ticker ON sevcik_ta_features(ticker);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_exec ON sevcik_ta_features(executable_date);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_arch ON sevcik_ta_features(archetype);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_trend ON sevcik_ta_features(trend_regime);

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

CREATE TABLE IF NOT EXISTS asym_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE REFERENCES asym_posts(video_id),
    -- The overall market assessment. The author calls this "Market
    -- Backdrop" in the current format and "Overall" in the older one.
    backdrop TEXT NOT NULL DEFAULT '',
    -- The index trend. "Overall Trend" now, "Index Trends" before.
    trend TEXT NOT NULL DEFAULT '',
    -- The new-highs/new-lows breadth reading.
    breadth TEXT NOT NULL DEFAULT '',
    -- The up/down momentum reading.
    momentum TEXT NOT NULL DEFAULT '',
    -- The per-cap-size breakdown, as JSON:
    --   {"trend":[{"cap":"Large Cap","state":"mixed"}], ...}
    cap_sizes TEXT NOT NULL DEFAULT '',
    -- The sectors in focus and the ones to avoid, as JSON:
    --   [{"sector":"Technology","tier":"primary","evidence":"..."}]
    sectors TEXT NOT NULL DEFAULT '',
    -- The plan sections, as JSON:
    --   [{"number":1,"title":"Market Posture","state":"...","body":[...]}]
    plan_sections TEXT NOT NULL DEFAULT '',
    -- The conditional scenarios, as JSON.
    scenarios TEXT NOT NULL DEFAULT '',
    -- The Bottom Line paragraph.
    bottom_line TEXT NOT NULL DEFAULT '',
    -- The indices the prose mentions. Context, not calls.
    index_tickers TEXT NOT NULL DEFAULT '',
    -- The parsed narrative paragraphs.
    paragraphs TEXT NOT NULL DEFAULT '',
    -- Which parser version produced this row, so a re-run with a changed
    -- parser can be told apart from the previous one.
    parser_version TEXT NOT NULL DEFAULT '',
    parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asym_articles_backdrop ON asym_articles(backdrop);
CREATE INDEX IF NOT EXISTS idx_asym_articles_trend ON asym_articles(trend);

-- The MEDIA of a post: what was downloaded, and what is known about it.
--
-- This is a separate table from asym_posts rather than more columns there,
-- because asym_posts is the CORPUS -- what the publication published -- and
-- this is the state of the PIPELINE over that corpus. A paid post has a
-- corpus row and no media row, and a post whose media failed to download
-- has both, with the failure recorded here.
--
-- The signed Mux URL is deliberately NOT stored. It carries a token that
-- expires (measured: about 24 hours), so a stored URL would be a stale
-- promise. The URL is resolved at download time from media_upload_id, which
-- is permanent.
CREATE TABLE IF NOT EXISTS asym_media (
    -- The key is (video_id, kind), NOT video_id alone: a post can have BOTH a
    -- 1080p video and a 16 kHz MP3 of its audio, and with video_id alone
    -- the audio download OVERWROTE the video row and orphaned the MP4.
    video_id TEXT NOT NULL REFERENCES asym_posts(video_id),
    -- The Mux media-upload id. The same one asym_posts carries; kept here so
    -- this table can be read on its own.
    media_upload_id TEXT NOT NULL DEFAULT '',
    -- video | audio. The AUDIO-only path keeps a 16 kHz mono MP3 instead
    -- of the 1920x1080 MP4, and the two are different files, so the row
    -- has to say which one it is holding.
    kind TEXT NOT NULL DEFAULT 'video',
    -- Where the MP4 is, relative to the repository root.
    file_path TEXT NOT NULL DEFAULT '',
    file_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration_sec REAL NOT NULL DEFAULT 0,
    -- pending | downloaded | error | missing
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NOT NULL DEFAULT '',
    -- The transcript that was made from this media, and how much of it
    -- there is. The authoritative transcript row is in video_transcripts;
    -- these two columns exist so the report can join one table instead of
    -- two.
    transcript_path TEXT NOT NULL DEFAULT '',
    segment_count INTEGER NOT NULL DEFAULT 0,
    transcribed_at TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    downloaded_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_asym_media_status ON asym_media(status);

-- The FRAMES of a post, and the sector table read out of them.
--
-- The Market Pulse video is a TradeStation SCREENCAST, and its
-- left-hand panel is a live table of the eleven GICS sectors with their
-- numbers. That table is the one piece of QUANTITATIVE market data in
-- this source that the written report does not carry -- the article
-- gives the author's picks, and this gives the measurements behind
-- them.
--
-- A frame is cheap to get: ffmpeg seeks into the remote MP4 with an
-- HTTP Range request, so one 1080p frame costs about six seconds and a
-- few megabytes instead of the 271 MB the whole video would.
--
-- The table SCROLLS, so one frame shows only part of the eleven rows.
-- Several frames are read per post and merged on the sector name,
-- which is why there is one row per (post, sector) and not per frame.
CREATE TABLE IF NOT EXISTS asym_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES asym_posts(video_id),
    -- Which frame of the post this is, 0-based.
    frame_index INTEGER NOT NULL,
    -- Where in the video it was taken, in seconds.
    timestamp_sec REAL NOT NULL DEFAULT 0,
    -- The PNG, relative to the repository root.
    file_path TEXT NOT NULL DEFAULT '',
    file_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    -- remote | local. Whether the frame came off the CDN or off a video
    -- that was already on disk.
    source TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, frame_index)
);

CREATE INDEX IF NOT EXISTS idx_asym_frames_video ON asym_frames(video_id);

-- The sector table, one row per (post, sector).
--
-- The values are the ones ON SCREEN: the 1-month rate of change and the
-- % Change column. The SIGN of the % Change is taken from the GLYPH
-- COLOUR rather than from the OCR, because the table renders positives
-- green and negatives red and the OCR loses the sign.
-- The OCR of a sector frame, cached.
--
-- Reading the table out of a frame is the slowest thing in this pipeline
-- and a frame does not change, so the reading is kept: keyed by the frame's
-- path, and valid only while the file is the same file (same size, same
-- mtime) and the parser is the same version.
CREATE TABLE IF NOT EXISTS asym_frame_ocr (
    frame_path TEXT PRIMARY KEY,
    file_bytes INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL DEFAULT '',
    rows_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0,
    parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS asym_sectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES asym_posts(video_id),
    -- One of the eleven GICS sectors.
    sector TEXT NOT NULL,
    -- The "1 Mo ROC" column.
    roc_1mo REAL,
    -- The "% Change" column, signed.
    pct_change REAL,
    -- The "Rate of Change (1yr)" column, signed. The table carries
    -- three numbers per sector: 1-month ROC, day % Change, and 1-year
    -- ROC. The 1-year column is white text, so its sign comes from the
    -- glyph itself and is NOT taken from a colour band.
    roc_1yr REAL,
    -- The spread of the readings that produced the 1-year value.
    roc1yr_spread REAL NOT NULL DEFAULT 0,
    -- colour | ocr. Where the sign came from.
    sign_source TEXT NOT NULL DEFAULT '',
    -- The frame the row was read from.
    frame_path TEXT NOT NULL DEFAULT '',
    -- How many frames read this row.
    readings INTEGER NOT NULL DEFAULT 0,
    -- How many of those readings were COMPLETE -- the cell was read
    -- whole, last digit included. An incomplete reading cannot be
    -- compared with a complete one, so the complete ones are the
    -- canonical reading.
    complete_readings INTEGER NOT NULL DEFAULT 0,
    -- 1 when the value came from an incomplete reading, so it is a
    -- lower bound rather than a reading of the cell.
    approximate INTEGER NOT NULL DEFAULT 0,
    -- The spread of the readings that produced the value.
    change_spread REAL NOT NULL DEFAULT 0,
    frame_timestamp_sec REAL NOT NULL DEFAULT 0,
    confidence REAL,
    parser_version TEXT NOT NULL DEFAULT '',
    parsed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(video_id, sector)
);

CREATE INDEX IF NOT EXISTS idx_asym_sectors_video ON asym_sectors(video_id);
CREATE INDEX IF NOT EXISTS idx_asym_sectors_sector ON asym_sectors(sector);


-- The Market Monitor sheet behind each free post.
--
-- Every free Market Pulse links a Google Sheet whose first tab is a daily
-- breadth / momentum tape. The sheet is PUBLIC (CSV export needs no login),
-- and it is the measurement behind the written "Breadth: Positive" reading
-- the same way the TradeStation sector table is the measurement behind the
-- sector picks.
--
-- asym_monitor_sheets   one row per post that has a spreadsheet URL
-- asym_monitor_days     one row per (post, date) from that sheet
CREATE TABLE IF NOT EXISTS asym_monitor_sheets (
    video_id TEXT PRIMARY KEY REFERENCES asym_posts(video_id),
    spreadsheet_id TEXT NOT NULL DEFAULT '',
    spreadsheet_url TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    file_bytes INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    first_date TEXT NOT NULL DEFAULT '',
    last_date TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asym_monitor_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES asym_posts(video_id),
    -- The calendar day the row is about, YYYYMMDD.
    day TEXT NOT NULL,
    -- Small+ market-wide breadth / momentum.
    breadth_nh REAL,
    breadth_nl REAL,
    breadth_net REAL,
    momentum_up REAL,
    momentum_down REAL,
    momentum_net REAL,
    -- Per-group JSON: { tech: {nh,nl,up,down}, ... }.
    groups_json TEXT NOT NULL DEFAULT '',
    -- The MA colour cells for QQQ/SPY/MDY/IWM, as free text.
    indices_json TEXT NOT NULL DEFAULT '',
    source_row INTEGER NOT NULL DEFAULT 0,
    UNIQUE(video_id, day)
);

CREATE INDEX IF NOT EXISTS idx_asym_monitor_days_video ON asym_monitor_days(video_id);
CREATE INDEX IF NOT EXISTS idx_asym_monitor_days_day ON asym_monitor_days(day);

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

CREATE TABLE IF NOT EXISTS market_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    transcript_id INTEGER NOT NULL REFERENCES video_transcripts(id),
    -- What the reading is about.
    --   market      the index / the tape as a whole
    --   sector      a GICS sector ("Semiconductors")
    --   macro_event an event ("CPI", "the Fed")
    --   earnings_event an earnings event ("Nvidia", a date)
    scope TEXT NOT NULL DEFAULT 'market'
        CHECK (scope IN ('market', 'sector', 'macro_event', 'earnings_event')),
    -- The subject as it was said: "the Qs", "semis", "the 10-year".
    subject TEXT NOT NULL DEFAULT '',
    -- The tradeable proxy the reading is scored with: QQQ for "the Qs",
    -- SMH for "semis", '' when there is none.
    proxy_ticker TEXT NOT NULL DEFAULT '',
    -- bullish | bearish | neutral | mixed | watch
    stance TEXT NOT NULL DEFAULT 'neutral'
        CHECK (stance IN ('bullish', 'bearish', 'neutral', 'mixed', 'watch')),
    -- forward | retrospective | reported
    claim_kind TEXT NOT NULL DEFAULT 'forward',
    -- recap | preview | setup | interview | sponsor
    section TEXT NOT NULL DEFAULT '',
    -- The horizon, when one was stated.
    horizon_text TEXT NOT NULL DEFAULT '',
    -- The event the reading is about, when it has one (YYYYMMDD).
    event_date TEXT NOT NULL DEFAULT '',
    event_time_sec REAL,
    -- The EXACT transcript text this reading was read from. NOT NULL, for
    -- the same reason trade_signals.evidence_text is: a reading you cannot
    -- point at is a reading you cannot check.
    evidence_text TEXT NOT NULL,
    -- Which extractor version produced this row.
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One row per (video, subject, stance): a show that says "semis are
    -- the leadership" three times says it once, and the reader wants the
    -- stance, not the repetition.
    UNIQUE(video_id, scope, subject, stance, event_date, parser_version)
);

CREATE INDEX IF NOT EXISTS idx_market_readings_video ON market_readings(video_id);
CREATE INDEX IF NOT EXISTS idx_market_readings_scope ON market_readings(scope, stance);
CREATE INDEX IF NOT EXISTS idx_market_readings_subject ON market_readings(subject);
