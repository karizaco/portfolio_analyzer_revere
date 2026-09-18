"""Idempotent schema bootstrap for the Discord channel-ingestion POC.

Sibling tables for the video pipeline. Lives in the same SQLite at
``data/video_pipeline/state.sqlite``. Mirrors ``whiteboard_worker.py``'s
additive-migration style: ``CREATE TABLE IF NOT EXISTS`` + guarded
``PRAGMA table_info`` checks, so repeated calls are no-ops.
"""

from __future__ import annotations

import datetime as _dt
import sqlite3


def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


SCHEMA_SQL = """
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
"""


def bootstrap_schema(connection: sqlite3.Connection) -> None:
    """Create the Discord sibling tables if missing. Idempotent."""
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA_SQL)
    connection.commit()


def register_source(
    connection: sqlite3.Connection,
    name: str,
    channel_id: str,
    guild_id: str,
    channel_kind: str = "text",
) -> int:
    """Insert a source (no-op on duplicate name). Returns the row id."""
    if not name or not channel_id or not guild_id:
        raise ValueError("name, channel_id, and guild_id are all required")
    if channel_kind not in {"text", "thread", "forum"}:
        raise ValueError(f"channel_kind must be text/thread/forum, got {channel_kind!r}")

    existing = connection.execute(
        "SELECT id FROM discord_sources WHERE name = ?", (name,)
    ).fetchone()
    if existing is not None:
        return int(existing["id"] if isinstance(existing, sqlite3.Row) else existing[0])

    cursor = connection.execute(
        """INSERT OR IGNORE INTO discord_sources
               (name, channel_id, guild_id, channel_kind, added_at, enabled)
           VALUES (?, ?, ?, ?, ?, 1)""",
        (name, channel_id, guild_id, channel_kind, utc_now_iso()),
    )
    connection.commit()
    if cursor.lastrowid:
        return int(cursor.lastrowid)
    row = connection.execute(
        "SELECT id FROM discord_sources WHERE name = ?", (name,)
    ).fetchone()
    return int(row["id"] if isinstance(row, sqlite3.Row) else row[0])


def self_test() -> int:
    """Round-trip the schema in a temp SQLite. 0 = OK, 1 = failure."""
    import sys
    import tempfile
    from pathlib import Path

    tmp = Path(tempfile.mkdtemp(prefix="discord-schema-"))
    try:
        conn = sqlite3.connect(str(tmp / "state.sqlite"))
        conn.row_factory = sqlite3.Row
        bootstrap_schema(conn)
        rid = register_source(conn, "smoke-test", "111", "222", "text")
        if rid != 1:
            print(f"expected source id=1, got {rid}", file=sys.stderr)
            return 1
        if register_source(conn, "smoke-test", "111", "222", "text") != rid:
            print("re-register changed id", file=sys.stderr)
            return 1
        conn.close()
        conn = sqlite3.connect(str(tmp / "state.sqlite"))
        conn.row_factory = sqlite3.Row
        tables = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'discord%'")}
        want = {"discord_sources", "discord_messages", "discord_pipeline_runs"}
        if tables != want:
            print(f"tables: have {sorted(tables)} want {sorted(want)}", file=sys.stderr)
            return 1
        idx = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_discord%'")}
        if not {"idx_discord_messages_source_posted", "idx_discord_messages_tickers"}.issubset(idx):
            print(f"missing indexes: {idx}", file=sys.stderr)
            return 1
        bootstrap_schema(conn)  # idempotent re-run
        conn.close()
    finally:
        for c in tmp.iterdir():
            c.unlink(missing_ok=True)
        tmp.rmdir()
    print("[data.discord_pipeline] self-test OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
