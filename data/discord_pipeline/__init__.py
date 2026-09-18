"""Idempotent schema bootstrap for the Discord channel-ingestion POC.

Sibling tables for the video pipeline. Lives in the same SQLite at
``data/video_pipeline/state.sqlite``.

Schema definitions live in ``data/db/schema.sql`` (the single source of truth).
This module re-exports helpers that call ``bootstrap_schema()`` on startup.
"""

from __future__ import annotations

import datetime as _dt
import sqlite3
from pathlib import Path


def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


# Path to the shared schema file, resolved relative to this file's location.
_SCHEMA_SQL_PATH = Path(__file__).resolve().parents[1] / 'db' / 'schema.sql'


def bootstrap_schema(connection: sqlite3.Connection) -> None:
    """Execute data/db/schema.sql to create all shared tables. Idempotent."""
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(_SCHEMA_SQL_PATH.read_text(encoding='utf-8'))
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
            print(f"tables: have {sorted(tables)} want {sorted(want)}",
                  file=sys.stderr)
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
