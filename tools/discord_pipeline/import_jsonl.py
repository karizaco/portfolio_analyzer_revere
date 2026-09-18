"""Discord JSONL importer — companion to ``ingest_channel.py``.

Same downstream pipeline (``discord_messages`` table + ``extract_tickers.py`` +
``discord_signals.csv``), different source: an external computer-use agent
(Claude/Grok/OpenClaw) browses Discord in a real browser and emits a JSONL file
of the messages it sees. This script ingests that JSONL.

CLI:
  python -m tools.discord_pipeline.import_jsonl --source <name> [--file <path>]
  python -m tools.discord_pipeline.import_jsonl --source <name> --file -

Required per-line keys: discord_message_id, author_id, author_name, content,
posted_at. Optional: edited_at, is_pinned, has_attachments (all preserved in
``raw_json`` but not broken out into dedicated columns — the existing schema
has none of them, and this importer is purely additive).

No new deps — ``json`` + ``sqlite3`` only. Idempotent on duplicate
``discord_message_id`` (UNIQUE constraint). After all rows are inserted, the
``extract_tickers`` module runs by default to keep the CSV + ``has_tickers``
flags in sync; pass ``--skip-extract`` to disable.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from data.discord_pipeline import bootstrap_schema, utc_now_iso
from tools.discord_pipeline import REQUIRED_MESSAGE_KEYS

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = str(WORKSPACE_ROOT / "data" / "video_pipeline" / "state.sqlite")
MAX_FILE_BYTES_WARN = 10 * 1024 * 1024  # 10 MB sanity threshold

# Required keys for the canonical Discord message JSONL schema
REQUIRED_KEYS = REQUIRED_MESSAGE_KEYS


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Import a JSONL dump of Discord messages into the SQLite store.")
    p.add_argument("--source", required=True,
                   help="Registered source name (must exist in discord_sources).")
    p.add_argument("--file", default="./discord_dump.jsonl",
                   help="Path to JSONL file, or '-' for stdin.")
    p.add_argument("--limit", type=int, default=0, help="Max lines to import (0 = no cap).")
    p.add_argument("--skip-extract", action="store_true",
                   help="Do not auto-run extract_tickers after import.")
    p.add_argument("--db-path",
                   default=os.environ.get("DISCORD_DB_PATH", DEFAULT_DB_PATH))
    return p.parse_args(argv)


def connect(db_path):
    db = Path(db_path)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def open_input(file_arg):
    if file_arg == "-":
        return sys.stdin, "<stdin>"
    path = Path(file_arg)
    if not path.exists():
        sys.exit(f"[discord-jsonl] file not found: {path}")
    if path.stat().st_size > MAX_FILE_BYTES_WARN:
        print(f"[discord-jsonl] WARNING: {path} is "
              f"{path.stat().st_size / (1024*1024):.1f} MB (>10 MB)", file=sys.stderr)
    return path.open("r", encoding="utf-8"), str(path)


def resolve_source_id(conn, name):
    row = conn.execute(
        "SELECT id FROM discord_sources WHERE name = ?", (name,)).fetchone()
    if row is None:
        sys.exit(f"[discord-jsonl] source {name!r} not registered. "
                 f"Run `node tools/runDiscordIngest.js add-source {name} "
                 f"<channel_id> --guild-id <id>` first.")
    return int(row["id"] if isinstance(row, sqlite3.Row) else row[0])


def import_lines(*, source_id, file_arg, limit, db_path):
    conn = connect(db_path)
    bootstrap_schema(conn)
    handle, label = open_input(file_arg)
    total = new = dup = err = 0
    max_id = ""
    try:
        with handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                total += 1
                if limit and new >= limit:
                    break
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"[discord-jsonl] line {total}: malformed JSON "
                          f"({exc.msg}); skipping.", file=sys.stderr)
                    err += 1
                    continue
                if not isinstance(payload, dict):
                    print(f"[discord-jsonl] line {total}: not a JSON object; "
                          f"skipping.", file=sys.stderr)
                    err += 1
                    continue
                missing = [k for k in REQUIRED_KEYS if not payload.get(k)]
                if missing:
                    print(f"[discord-jsonl] line {total}: missing keys "
                          f"{missing!r}; skipping.", file=sys.stderr)
                    err += 1
                    continue

                msg_id = str(payload["discord_message_id"])
                # edited_at / is_pinned / has_attachments live in raw_json only
                raw_json = json.dumps(payload, ensure_ascii=False)
                cur = conn.execute(
                    """INSERT OR IGNORE INTO discord_messages
                          (source_id, discord_message_id, author_id, author_name,
                           content, posted_at, ingested_at,
                           has_tickers, ticker_list, raw_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)""",
                    (source_id, msg_id, str(payload["author_id"]),
                     str(payload["author_name"]), str(payload["content"]),
                     str(payload["posted_at"]), utc_now_iso(), raw_json))
                if cur.rowcount and cur.rowcount > 0:
                    new += 1
                    if msg_id > max_id:
                        max_id = msg_id
                else:
                    dup += 1
        conn.commit()

        if max_id:
            conn.execute(
                "UPDATE discord_sources SET last_message_id = ?, last_run_at = ? "
                "WHERE id = ?", (max_id, utc_now_iso(), source_id))
        else:
            conn.execute(
                "UPDATE discord_sources SET last_run_at = ? WHERE id = ?",
                (utc_now_iso(), source_id))
        conn.commit()
    finally:
        conn.close()
    return {"total_lines": total, "new_rows_inserted": new,
            "duplicate_rows_skipped": dup, "errors": err,
            "label": label, "max_message_id": max_id}


def run_extract(db_path):
    py = "py" if os.name == "nt" else "python3"
    py_args = ["-3"] if os.name == "nt" else []
    r = subprocess.run(
        [py, *py_args, "-m", "tools.discord_pipeline.extract_tickers",
         "--db-path", db_path],
        capture_output=True, text=True, check=False)
    if r.returncode != 0:
        print(f"[discord-jsonl] extract_tickers failed: {r.stderr.strip()}",
              file=sys.stderr)


def count_ticker_rows(db_path, source_id):
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM discord_messages "
            "WHERE source_id = ? AND has_tickers = 1", (source_id,)).fetchone()
        return int(row["c"] if isinstance(row, sqlite3.Row) else row[0])
    finally:
        conn.close()


def main(argv=None):
    args = parse_args(argv)
    bootstrap = connect(args.db_path)
    bootstrap_schema(bootstrap)
    source_id = resolve_source_id(bootstrap, args.source)
    bootstrap.close()

    summary = import_lines(source_id=source_id, file_arg=args.file,
                           limit=max(0, args.limit), db_path=args.db_path)

    if not args.skip_extract:
        run_extract(args.db_path)
    ticker_rows = count_ticker_rows(args.db_path, source_id)

    print(json.dumps({
        "source": args.source,
        "source_id": source_id,
        "file": summary["label"],
        "total_lines": summary["total_lines"],
        "new_rows_inserted": summary["new_rows_inserted"],
        "duplicate_rows_skipped": summary["duplicate_rows_skipped"],
        "ticker_rows_detected": ticker_rows,
        "errors": summary["errors"],
        "max_message_id": summary["max_message_id"],
        "extract_run": not args.skip_extract,
    }, indent=2))
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())