"""Discord channel message ingest.

Reads ``DISCORD_BOT_TOKEN`` from the environment, fetches
``/channels/{id}/messages`` with cursor pagination (``before=<oldest_id>&limit=100``),
honours ``Retry-After`` on HTTP 429, writes new rows to ``discord_messages``,
and advances ``discord_sources.last_message_id``.

CLI:
  python -m tools.discord_pipeline.ingest_channel --source <name> [--limit N]
  python -m tools.discord_pipeline.ingest_channel --list-sources

No new deps — ``urllib.request`` + ``json`` + ``sqlite3`` only.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from data.discord_pipeline import (
    bootstrap_schema,
    register_source,
    utc_now_iso,
)

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = str(WORKSPACE_ROOT / "data" / "video_pipeline" / "state.sqlite")
DEFAULT_DISCORD_API = "https://discord.com/api/v10"
PAGE_SIZE = 100
MAX_ATTEMPTS = 5
BACKOFF_BASE = 2.0  # seconds; exponential


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch Discord channel messages into the portfolio SQLite.")
    parser.add_argument("--source", default="",
                        help="Registered source name to ingest.")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max NEW messages this run; 0 = no cap.")
    parser.add_argument("--list-sources", action="store_true",
                        help="Print the registered sources table and exit.")
    parser.add_argument("--db-path", default=os.environ.get("DISCORD_DB_PATH", DEFAULT_DB_PATH),
                        help="SQLite path.")
    parser.add_argument("--api-base",
                        default=os.environ.get("DISCORD_API_BASE", DEFAULT_DISCORD_API),
                        help="Override the Discord API base.")
    return parser.parse_args(argv)


def connect_database(db_path: str | Path) -> sqlite3.Connection:
    db = Path(db_path)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def fetch_with_retry(url: str, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    """GET ``url`` honouring 429 Retry-After + exponential backoff."""
    request = urllib.request.Request(url, headers=headers, method="GET")
    backoff = BACKOFF_BASE
    last_err: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as http_error:
            status = http_error.code
            headers = dict(http_error.headers or {})
            body = http_error.read() if hasattr(http_error, "read") else b""
            if status == 429:
                ra = headers.get("Retry-After") or headers.get("retry-after")
                try:
                    wait = float(ra) if ra else backoff
                except (TypeError, ValueError):
                    wait = backoff
                print(f"[discord] 429 rate-limited; sleeping {wait:.2f}s "
                      f"(attempt {attempt}/{MAX_ATTEMPTS})", file=sys.stderr)
                time.sleep(max(wait, 0.5))
                backoff *= 2
                continue
            if 500 <= status < 600:
                last_err = http_error
                print(f"[discord] {status} server error; sleeping {backoff:.2f}s "
                      f"(attempt {attempt}/{MAX_ATTEMPTS})", file=sys.stderr)
                time.sleep(backoff)
                backoff *= 2
                continue
            return status, headers, body
        except urllib.error.URLError as url_error:
            last_err = url_error
            print(f"[discord] URLError: {url_error}; sleeping {backoff:.2f}s "
                  f"(attempt {attempt}/{MAX_ATTEMPTS})", file=sys.stderr)
            time.sleep(backoff)
            backoff *= 2
    raise RuntimeError(f"discord fetch failed after {MAX_ATTEMPTS} attempts: {last_err!r}")


def fetch_channel_page(*, api_base: str, channel_id: str, token: str,
                        before_id: str | None) -> list[dict[str, object]]:
    params = {"limit": str(PAGE_SIZE)}
    if before_id:
        params["before"] = before_id
    url = f"{api_base.rstrip('/')}/channels/{channel_id}/messages?{urllib.parse.urlencode(params)}"
    headers = {
        "Authorization": f"Bot {token}",
        "User-Agent": "portfolio_analyzer_revere-discord-poc (Python urllib)",
    }
    status, response_headers, body = fetch_with_retry(url, headers)
    if status in (401, 403):
        raise RuntimeError(
            f"Discord auth failure ({status}). Check DISCORD_BOT_TOKEN and that "
            f"MESSAGE_CONTENT intent is enabled. Body: {body[:200]!r}")
    if status == 404:
        raise RuntimeError(
            f"Discord channel not found ({status}) for channel_id={channel_id}. "
            f"Verify the channel_id + READ_MESSAGE_HISTORY.")
    if status >= 400:
        raise RuntimeError(f"Discord API error {status}: {body[:200]!r}")
    remaining = response_headers.get("X-RateLimit-Remaining")
    if remaining is not None:
        try:
            if int(remaining) <= 1:
                time.sleep(0.5)
        except ValueError:
            pass
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError(f"unexpected payload type: {type(payload).__name__}")
    return payload


def parse_message(raw: dict[str, object]) -> dict[str, object]:
    author = raw.get("author") or {}
    return {
        "discord_message_id": str(raw.get("id") or ""),
        "author_id": str(author.get("id") or ""),
        "author_name": str(author.get("username") or author.get("global_name") or ""),
        "content": str(raw.get("content") or ""),
        "posted_at": str(raw.get("timestamp") or ""),
    }


def record_run(connection: sqlite3.Connection, *, source_id: int, run_tag: str,
               started_at: str, finished_at: str | None,
               fetched_count: int, new_count: int, error: str = "") -> int:
    cur = connection.execute(
        """INSERT INTO discord_pipeline_runs
              (source_id, run_tag, started_at, finished_at,
               fetched_count, new_count, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (source_id, run_tag, started_at, finished_at,
         fetched_count, new_count, error),
    )
    connection.commit()
    return int(cur.lastrowid or 0)


def _insert_message(connection: sqlite3.Connection, *, source_id: int,
                    raw: dict[str, object]) -> bool:
    """Insert a single Discord message. Return True if newly inserted."""
    parsed = parse_message(raw)
    msg_id = parsed["discord_message_id"]
    if not msg_id:
        return False
    cur = connection.execute(
        """INSERT INTO discord_messages
              (source_id, discord_message_id, author_id, author_name,
               content, posted_at, ingested_at, has_tickers, ticker_list,
               raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)
           ON CONFLICT(discord_message_id) DO NOTHING""",
        (source_id, msg_id, parsed["author_id"], parsed["author_name"],
         parsed["content"], parsed["posted_at"], utc_now_iso(),
         json.dumps(raw, ensure_ascii=False)))
    return cur.rowcount > 0


def ingest_source(connection: sqlite3.Connection, *, name: str, limit: int,
                  api_base: str) -> int:
    row = connection.execute(
        "SELECT id, channel_id, last_message_id FROM discord_sources WHERE name = ?",
        (name,)).fetchone()
    if row is None:
        print(f"[discord] source {name!r} not registered. Use "
              f"`node tools/runDiscordIngest.js add-source {name} <channel_id>`.",
              file=sys.stderr)
        return 1
    source_id = int(row["id"])
    channel_id = str(row["channel_id"])
    cursor_before = str(row["last_message_id"] or "") or None

    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        print("[discord] DISCORD_BOT_TOKEN is not set; ingest is a no-op. "
              "Run `node tools/runDiscordIngest.js status` to inspect sources.",
              file=sys.stderr)
        now = utc_now_iso()
        record_run(connection, source_id=source_id, run_tag=now,
                   started_at=now, finished_at=now,
                   fetched_count=0, new_count=0, error="DISCORD_BOT_TOKEN unset")
        return 0

    started_at = utc_now_iso()
    cursor = cursor_before
    fetched_total = new_total = 0
    error_message = ""
    finished_at: str | None = None
    try:
        while True:
            page = fetch_channel_page(
                api_base=api_base, channel_id=channel_id,
                token=token, before_id=cursor)
            if not page:
                break
            page_new = 0
            oldest_id: str | None = None
            for raw in page:
                msg_id = str((raw.get("id") if isinstance(raw, dict) else "") or "")
                if msg_id:
                    if oldest_id is None or msg_id < oldest_id:
                        oldest_id = msg_id
                    fetched_total += 1
                try:
                    if _insert_message(connection, source_id=source_id, raw=raw):
                        page_new += 1
                except sqlite3.IntegrityError:
                    pass
            new_total += page_new
            print(f"[discord] source={name} page_size={len(page)} new={page_new} "
                  f"cursor={cursor or '<start>'}", file=sys.stderr)
            if oldest_id:
                cursor = oldest_id
                connection.execute(
                    "UPDATE discord_sources SET last_message_id = ?, last_run_at = ? "
                    "WHERE id = ?",
                    (oldest_id, utc_now_iso(), source_id))
            else:
                connection.execute(
                    "UPDATE discord_sources SET last_run_at = ? WHERE id = ?",
                    (utc_now_iso(), source_id))
            connection.commit()
            if limit and new_total >= limit:
                break
            if len(page) < PAGE_SIZE:
                break
        finished_at = utc_now_iso()
    except Exception as exc:  # noqa: BLE001 — last-resort so we record a run row
        error_message = str(exc)
        finished_at = utc_now_iso()
        print(f"[discord] ERROR for source={name}: {exc}", file=sys.stderr)

    record_run(connection, source_id=source_id, run_tag=started_at,
               started_at=started_at, finished_at=finished_at,
               fetched_count=fetched_total, new_count=new_total,
               error=error_message)
    print(json.dumps({
        "source": name, "channel_id": channel_id,
        "fetched": fetched_total, "new": new_total,
        "cursor_before": cursor_before, "cursor_after": cursor,
        "started_at": started_at, "finished_at": finished_at,
        "error": error_message or None,
    }, indent=2))
    return 0 if not error_message else 1


def list_sources(db_path: Path) -> int:
    if not db_path.exists():
        print(f"[discord] no state.sqlite at {db_path}; nothing to list.")
        return 0
    conn = connect_database(db_path)
    bootstrap_schema(conn)
    rows = conn.execute(
        """SELECT s.id, s.name, s.channel_id, s.guild_id, s.channel_kind,
                  s.added_at, s.last_run_at, s.last_message_id, s.enabled,
                  (SELECT COUNT(*) FROM discord_messages m
                   WHERE m.source_id = s.id) AS message_count,
                  (SELECT COUNT(*) FROM discord_messages m
                   WHERE m.source_id = s.id AND m.has_tickers = 1) AS ticker_count
           FROM discord_sources s ORDER BY s.id""").fetchall()
    conn.close()
    if not rows:
        print("[discord] no sources registered yet.")
        print("  node tools/runDiscordIngest.js add-source <name> <channel_id> --guild-id <id>")
        return 0
    headers = ("id", "name", "channel_id", "guild_id", "channel_kind", "enabled",
               "message_count", "ticker_count", "last_message_id", "last_run_at")
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join("---" for _ in headers) + "|")
    for r in rows:
        print("| " + " | ".join(
            str(r[h] if r[h] is not None else "").replace("|", "\\|")
            for h in headers) + " |")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    db_path = Path(args.db_path or DEFAULT_DB_PATH)
    if args.list_sources:
        return list_sources(db_path)
    if not args.source:
        return list_sources(db_path)
    conn = connect_database(db_path)
    bootstrap_schema(conn)
    try:
        return ingest_source(conn, name=args.source,
                             limit=max(0, args.limit), api_base=args.api_base)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
