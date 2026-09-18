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

CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    upload_date TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    download_path TEXT NOT NULL DEFAULT '',
    output_path TEXT NOT NULL DEFAULT '',
    selected_timestamp REAL,
    selected_score REAL,
    review_reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    transcript_path TEXT NOT NULL DEFAULT '',
    transcript_segment_count INTEGER NOT NULL DEFAULT 0,
    transcript_fetched_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel);

CREATE TABLE IF NOT EXISTS worker_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    command_json TEXT NOT NULL,
    raw_output_path TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    inserted_count INTEGER NOT NULL,
    updated_count INTEGER NOT NULL,
    missing_upload_dates INTEGER NOT NULL,
    malformed_rows INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

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
