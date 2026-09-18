"""Discord channel-ingestion POC. Re-exports the schema helpers and ships a
temp-SQLite self-test used by ``__main__.py`` for ``py -3 -m
tools.discord_pipeline``.
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

from data.discord_pipeline import bootstrap_schema, register_source, utc_now_iso

__all__ = ["bootstrap_schema", "register_source", "utc_now_iso", "self_test"]


def self_test() -> int:
    """Boot the schema in a temp sqlite + register + re-register + verify."""
    tmp = Path(tempfile.mkdtemp(prefix="discord-pkg-schema-"))
    try:
        conn = sqlite3.connect(str(tmp / "state.sqlite"))
        conn.row_factory = sqlite3.Row
        bootstrap_schema(conn)
        first_id = register_source(conn, "smoke-source", "99999", "88888", "text")
        if first_id != 1:
            print(f"[smoke] expected source id=1, got {first_id}", file=sys.stderr)
            return 1
        if register_source(conn, "smoke-source", "99999", "88888", "text") != first_id:
            print("[smoke] re-register changed id", file=sys.stderr)
            return 1
        conn.close()
        conn = sqlite3.connect(str(tmp / "state.sqlite"))
        conn.row_factory = sqlite3.Row
        tables = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name LIKE 'discord%' ORDER BY name")}
        want = {"discord_sources", "discord_messages", "discord_pipeline_runs"}
        if tables != want:
            print(f"[smoke] tables: have {sorted(tables)} want {sorted(want)}",
                  file=sys.stderr)
            return 1
        idx = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND tbl_name LIKE 'discord%'")}
        missing = {"idx_discord_messages_source_posted",
                   "idx_discord_messages_tickers"} - idx
        if missing:
            print(f"[smoke] missing indexes: {sorted(missing)}", file=sys.stderr)
            return 1
        bootstrap_schema(conn)  # idempotent re-run
        conn.close()
    finally:
        for c in tmp.iterdir():
            c.unlink(missing_ok=True)
        tmp.rmdir()
    print("[smoke] discord_pipeline schema bootstrap is idempotent on a temp sqlite")
    return 0
