-- Derived tables. Tracked, in data/video_pipeline/derived.sqlite.
--
-- These used to live in state.sqlite. They were split out so neither
-- tracked file approaches GitHub's 100 MB limit. The catalog connection
-- ATTACHes this file (src/db/derivedStore.js), so an unqualified table
-- name still resolves here once the catalog no longer has the table.
--
-- REFERENCES to a catalog table are omitted: SQLite foreign keys do not
-- cross an ATTACH. The writer is what keeps the link honest.
--
-- Do NOT add these CREATE TABLEs back to schema.sql. whiteboard_worker.py
-- executes that file on every open, and an unqualified CREATE lands in
-- the catalog.

-- `transcript_segments` used to be declared here. It is the largest table in
-- the pipeline (698,450 rows, about 98 MB) and it is a CACHE of the transcript
-- JSON under data/video_pipeline/transcripts/ -- so it lives in its own,
-- untracked database file. See data/db/schema_transcript_segments.sql and
-- src/transcript/segmentStore.js: the tools ATTACH that file and their SQL is
-- unchanged, because an unqualified `transcript_segments` resolves to it.

CREATE TABLE IF NOT EXISTS trade_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    transcript_id INTEGER NOT NULL,
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
    transcript_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    -- The name he SAID, which is not the ticker: "Tesla" for TSLA.
    spoken_name TEXT NOT NULL DEFAULT '',
    -- The state the setup is IN at the end of the video.
    state TEXT NOT NULL DEFAULT 'running'
        CHECK (state IN ('new', 'running', 'worked', 'failed',
                         'invalidated', 'old', 'open')),
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
                                    'conditional', 'low', 'unknown', 'stated')),
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
    -- Added by the setup extractor after the first schema. A video can hold
    -- the same ticker on more than one row (the segmenter splits a run), so
    -- there is no UNIQUE(video_id, ticker) -- the live table has 117 such
    -- pairs, and a unique constraint would refuse the copy.
    claim_kind TEXT,
    bias TEXT,
    is_prediction INTEGER
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


CREATE TABLE IF NOT EXISTS asym_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
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
    video_id TEXT NOT NULL,
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
    video_id TEXT NOT NULL,
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
    video_id TEXT NOT NULL,
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
    video_id TEXT PRIMARY KEY,
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
    video_id TEXT NOT NULL,
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


CREATE TABLE IF NOT EXISTS market_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    transcript_id INTEGER NOT NULL,
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


-- A SETUP is the author's stated intent: a ticker, a kind of setup, a
-- direction, and a thesis. It is NOT a position -- it is what he said he
-- was looking at, whether or not he ever took it.
--
-- The evidence rule is the project's standing one: a setup whose prose
-- could not be read is still a setup, and its `evidence_quality` says
-- so. A missing holding is better than a wrong one.
CREATE TABLE IF NOT EXISTS oconnell_setups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    -- The company name he wrote beside the ticker, when he wrote one.
    company_name TEXT NOT NULL DEFAULT '',
    -- His own words for the setup: "200D SMA Reclaim", "PEG Continuation".
    setup_label TEXT NOT NULL DEFAULT '',
    -- The normalised vocabulary term: peg | relative_strength | breakout |
    -- base | earnings | russell | cannabis | ...
    setup_kind TEXT NOT NULL DEFAULT '',
    -- '' when he did not say a direction.
    direction TEXT NOT NULL DEFAULT ''
        CHECK (direction IN ('', 'long', 'short', 'neutral')),
    -- The thesis, as read from the page.
    thesis TEXT NOT NULL DEFAULT '',
    -- The exact text the thesis was read from. NOT NULL, for the same
    -- reason trade_signals.evidence_text is: a reading you cannot point
    -- at is a reading you cannot check.
    evidence_text TEXT NOT NULL DEFAULT '',
    evidence_page INTEGER NOT NULL DEFAULT 0,
    -- heading_only | prose
    evidence_quality TEXT NOT NULL DEFAULT 'heading_only'
        CHECK (evidence_quality IN ('heading_only', 'prose')),
    -- The section the setup was found under: "Technical Trading",
    -- "Watchlist", ...
    section TEXT NOT NULL DEFAULT '',
    horizon_text TEXT NOT NULL DEFAULT '',
    -- forward | retrospective | reported
    claim_kind TEXT NOT NULL DEFAULT 'forward'
        CHECK (claim_kind IN ('forward', 'retrospective', 'reported')),
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One row per setup per document. The same setup running across
    -- documents is a different row on each -- that IS the timeline.
    UNIQUE(doc_id, ticker, setup_label)
);


CREATE INDEX IF NOT EXISTS idx_oconnell_setups_doc ON oconnell_setups(doc_id);

CREATE INDEX IF NOT EXISTS idx_oconnell_setups_ticker ON oconnell_setups(ticker);

CREATE INDEX IF NOT EXISTS idx_oconnell_setups_kind ON oconnell_setups(setup_kind);


-- A POSITION is what he actually held. It is a LOT, not a ticker: the
-- same ticker appears on several rows of the position log with different
-- cost basis and entry date, and those are different lots. Measured on
-- 20250910: MSOS is on four rows of the equities table.
--
-- So the key carries the lot, not the ticker.
CREATE TABLE IF NOT EXISTS oconnell_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    -- equity | option
    instrument TEXT NOT NULL DEFAULT 'equity'
        CHECK (instrument IN ('equity', 'option')),
    ticker TEXT NOT NULL,
    -- The option contract, for the options table: "01/15/27 5 Call (BTO)".
    contract TEXT NOT NULL DEFAULT '',
    -- The options table's own "Setup" column: "Rescheduling".
    setup_label TEXT NOT NULL DEFAULT '',
    change_pct REAL,
    underlying_change_pct REAL,
    option_change_pct REAL,
    cost_basis REAL,
    price REAL,
    gain_loss_pct REAL,
    -- The position-sizing stars: 1 small, 2 medium, 3 large.
    size_stars INTEGER NOT NULL DEFAULT 0,
    stop_price REAL,
    risk_pct REAL,
    r2_price REAL,
    -- ABOVE | BELOW
    sma20 TEXT NOT NULL DEFAULT '',
    sma50 TEXT NOT NULL DEFAULT '',
    beta REAL,
    delta REAL,
    -- YYYYMMDD
    entry_date TEXT NOT NULL DEFAULT '',
    trade_length_days INTEGER,
    -- The "Exits" column: the exits he has already taken on this lot.
    exits TEXT NOT NULL DEFAULT '',
    exit_date TEXT NOT NULL DEFAULT '',
    exit_price REAL,
    -- The identity of the lot, and the uniqueness key. It is a string
    -- rather than the columns themselves because a NULL cost basis
    -- never equals another NULL cost basis in a UNIQUE constraint.
    lot_key TEXT NOT NULL DEFAULT '',
    -- Which image the row was read from: the standalone screenshot, or
    -- the copy embedded in the PDF.
    source_image TEXT NOT NULL DEFAULT '',
    source_row INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(doc_id, lot_key)
);


CREATE INDEX IF NOT EXISTS idx_oconnell_positions_doc ON oconnell_positions(doc_id);

CREATE INDEX IF NOT EXISTS idx_oconnell_positions_ticker ON oconnell_positions(ticker);

CREATE INDEX IF NOT EXISTS idx_oconnell_positions_entry ON oconnell_positions(entry_date);


-- The position log's own summary blocks: the cash split, the trend model
-- and the running win rates. These are per DOCUMENT, not per position.
CREATE TABLE IF NOT EXISTS oconnell_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL UNIQUE,
    equity_count INTEGER NOT NULL DEFAULT 0,
    option_count INTEGER NOT NULL DEFAULT 0,
    cash_pct REAL,
    invested_pct REAL,
    -- The trend model reading: -3 .. +3.
    trend_model INTEGER,
    max_loss_stock_pct REAL,
    max_loss_options_pct REAL,
    win_rate_stock_pct REAL,
    win_rate_options_pct REAL,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- The readings that are not about a ticker: the market, a sector, an
-- event. The same shape as `market_readings`, but its own table, because
-- that one carries a transcript foreign key.
CREATE TABLE IF NOT EXISTS oconnell_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    -- market | sector | macro_event | earnings_event
    scope TEXT NOT NULL DEFAULT 'market'
        CHECK (scope IN ('market', 'sector', 'macro_event', 'earnings_event')),
    subject TEXT NOT NULL DEFAULT '',
    proxy_ticker TEXT NOT NULL DEFAULT '',
    -- bullish | bearish | neutral | mixed | watch
    stance TEXT NOT NULL DEFAULT 'neutral'
        CHECK (stance IN ('bullish', 'bearish', 'neutral', 'mixed', 'watch')),
    claim_kind TEXT NOT NULL DEFAULT 'forward'
        CHECK (claim_kind IN ('forward', 'retrospective', 'reported')),
    section TEXT NOT NULL DEFAULT '',
    horizon_text TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL DEFAULT '',
    evidence_text TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(doc_id, scope, subject, stance, section)
);


CREATE INDEX IF NOT EXISTS idx_oconnell_readings_doc ON oconnell_readings(doc_id);

CREATE INDEX IF NOT EXISTS idx_oconnell_readings_scope ON oconnell_readings(scope, stance);


-- The OCR cache. An entry is used only while the file is the same file
-- (same size, same mtime) AND the parser version is unchanged -- so a
-- parser change invalidates the cache by itself, and a re-run over an
-- unchanged corpus costs seconds.
CREATE TABLE IF NOT EXISTS oconnell_ocr_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL,
    source_size INTEGER NOT NULL DEFAULT 0,
    source_mtime INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_key, source_size, source_mtime, parser_version)
);

-- Discord position parse (created at runtime before this split).
CREATE TABLE IF NOT EXISTS discord_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    as_of_date TEXT NOT NULL,
    as_of_source TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL,
    sub_account TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL,
    ticker TEXT NOT NULL,
    weight_pct REAL,
    stated_price REAL,
    annotation TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    is_new INTEGER NOT NULL DEFAULT 0,
    snapshot_notes TEXT NOT NULL DEFAULT '',
    header TEXT NOT NULL DEFAULT '',
    long_exposure_pct REAL,
    short_exposure_pct REAL,
    cash_pct REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_positions_date
    ON discord_positions(as_of_date, account, side, ticker);
CREATE INDEX IF NOT EXISTS idx_discord_positions_message
    ON discord_positions(message_id);

CREATE TABLE IF NOT EXISTS discord_trade_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    posted_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL DEFAULT '',
    ticker_inferred INTEGER NOT NULL DEFAULT 0,
    price REAL,
    stop_price REAL,
    stop_text TEXT NOT NULL DEFAULT '',
    size_pct REAL,
    size_note TEXT NOT NULL DEFAULT '',
    fraction REAL,
    fraction_basis TEXT NOT NULL DEFAULT '',
    stated_result_pct REAL,
    atr_multiple REAL,
    verb TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_actions_ticker
    ON discord_trade_actions(source_name, ticker, posted_at);
CREATE INDEX IF NOT EXISTS idx_discord_actions_message
    ON discord_trade_actions(message_id);

CREATE TABLE IF NOT EXISTS discord_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    source_name TEXT NOT NULL,
    basis TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    sub_account TEXT NOT NULL DEFAULT '',
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    direction INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    entry_weight REAL,
    entry_price REAL,
    entry_price_at REAL,
    exit_date TEXT NOT NULL DEFAULT '',
    exit_weight REAL,
    exit_price REAL,
    exit_price_at REAL,
    exit_action TEXT NOT NULL DEFAULT '',
    return_pct REAL,
    priced INTEGER NOT NULL DEFAULT 0,
    still_open INTEGER NOT NULL DEFAULT 0,
    left_censored INTEGER NOT NULL DEFAULT 0,
    implied_open INTEGER NOT NULL DEFAULT 0,
    ambiguous_inverse INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_episodes_ticker
    ON discord_episodes(source_name, ticker, entry_date);
