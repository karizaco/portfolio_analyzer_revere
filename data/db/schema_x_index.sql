-- The X post INDEX. Untracked: data/x_pipeline/x_index.sqlite.
--
-- Every row here is rebuildable from the tracked archive
-- (data/x_pipeline/archive/<user_id>/<YYYY>/<YYYY-MM>.jsonl) and the
-- downloaded media, by `node tools/runXPipeline.js rebuild-index`. It is a
-- CACHE in the sense CLAUDE.md uses the word for transcript_segments.sqlite:
-- fast to query, never the record.
--
-- Ids are TEXT. An X id is a 64-bit snowflake, larger than 2^53, and a JS
-- Number cannot hold it.

CREATE TABLE IF NOT EXISTS x_posts (
    post_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- The trading session the post belongs to (America/New_York): before
    -- 16:00 ET on a weekday, that day; otherwise the next weekday.
    -- Market holidays are resolved at pricing time ("the first close at or
    -- after the post").
    event_session TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    text_source TEXT NOT NULL DEFAULT 'text',
    lang TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    in_reply_to_post_id TEXT NOT NULL DEFAULT '',
    in_reply_to_user_id TEXT NOT NULL DEFAULT '',
    self_thread INTEGER NOT NULL DEFAULT 0,
    quoted_post_id TEXT NOT NULL DEFAULT '',
    reposted_post_id TEXT NOT NULL DEFAULT '',
    cashtags_json TEXT NOT NULL DEFAULT '[]',
    urls_json TEXT NOT NULL DEFAULT '[]',
    referenced_json TEXT NOT NULL DEFAULT '[]',
    media_count INTEGER NOT NULL DEFAULT 0,
    edit_earliest_id TEXT NOT NULL DEFAULT '',
    is_earliest_version INTEGER NOT NULL DEFAULT 1,
    fetched_via TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    archive_path TEXT NOT NULL DEFAULT '',
    -- When X was first seen to have deleted this post. Empty until it is.
    deleted_detected_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_x_posts_user_time ON x_posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_x_posts_conversation ON x_posts(conversation_id);

-- A post X says it no longer has.
--
-- A DELETED POST IS AN ENTRY IN THE API's errors[], not a missing row, so
-- it never reaches the archive -- and without this table the fact that it
-- was deleted is lost, which is what the deletion-compliance obligation
-- and the survivorship analysis both need.
--
-- This is an OBSERVATION, not a derived row: it cannot be rebuilt from
-- the archive, so `rebuild-index` leaves it alone.
CREATE TABLE IF NOT EXISTS x_post_deletions (
    post_id TEXT PRIMARY KEY,
    detected_at TEXT NOT NULL,
    run_id INTEGER,
    -- 'api_v2' | 'web_graphql' | 'web_dom'
    source TEXT NOT NULL DEFAULT '',
    -- The error's own words, so a reader can see WHY it was not there.
    detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS x_post_media (
    media_key TEXT NOT NULL,
    post_id TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    preview_url TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    alt_text TEXT NOT NULL DEFAULT '',
    -- Filled by the media downloader.
    local_path TEXT NOT NULL DEFAULT '',
    md5 TEXT NOT NULL DEFAULT '',
    bytes INTEGER,
    -- pending | ok | failed | skipped
    download_status TEXT NOT NULL DEFAULT 'pending',
    download_detail TEXT NOT NULL DEFAULT '',
    downloaded_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (post_id, media_key)
);

CREATE INDEX IF NOT EXISTS idx_x_post_media_status ON x_post_media(download_status);

-- Engagement, observed over time. Volatile, so it is kept OUT of the
-- tracked archive (only the first observation is written there, once).
CREATE TABLE IF NOT EXISTS x_post_metrics (
    post_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    likes INTEGER,
    reposts INTEGER,
    replies INTEGER,
    quotes INTEGER,
    views INTEGER,
    bookmarks INTEGER,
    via TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (post_id, observed_at, via)
);

-- OCR words of a downloaded image, by md5. A parser change invalidates its
-- own entries (the asym_frame_ocr rule).
CREATE TABLE IF NOT EXISTS x_image_ocr (
    md5 TEXT NOT NULL,
    engine TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    words_json TEXT NOT NULL DEFAULT '[]',
    mean_conf REAL,
    ocr_at TEXT NOT NULL,
    PRIMARY KEY (md5, engine, parser_version)
);
