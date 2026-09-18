"""Ticker extractor for Discord messages. Mirrors ``src/normalize/tickerScan.js``:
uppercase + strip non-alnum (keep ``.``), token-split, match the seed
lexicon at ``config/ticker_lexicon_seed.csv``, reject anything that fails
the strict shape check. Writes one CSV row per (message with at least one
ticker) to ``data/video_pipeline/discord_signals.csv``.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import sys
from pathlib import Path

from data.discord_pipeline import bootstrap_schema

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = WORKSPACE_ROOT / "data" / "video_pipeline" / "state.sqlite"
DEFAULT_OUTPUT_CSV = WORKSPACE_ROOT / "data" / "video_pipeline" / "discord_signals.csv"
DEFAULT_LEXICON = WORKSPACE_ROOT / "config" / "ticker_lexicon_seed.csv"

STRICT_TICKER_PATTERN = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$")
TOKEN_SPLIT_PATTERN = re.compile(r"[\s,;:()\[\]{}<>/\\|`'\"]+")
NORMALIZE_PATTERN = re.compile(r"[^A-Z0-9.]")


def load_seed_lexicon(lexicon_path: Path) -> set[str]:
    if not lexicon_path.exists():
        raise FileNotFoundError(
            f"ticker seed lexicon not found: {lexicon_path}.")
    tickers: set[str] = set()
    with lexicon_path.open("r", encoding="utf-8") as handle:
        first = True
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if first:
                first = False
                if line.lower().startswith("ticker"):
                    continue
            ticker = line.split(",", 1)[0].strip().upper()
            if ticker:
                tickers.add(ticker)
    return tickers


def normalize_token(raw_token: str) -> str:
    return NORMALIZE_PATTERN.sub("", str(raw_token or "").upper())


def extract_tickers(message_body: str, seed_tickers: set[str]) -> list[str]:
    if not message_body:
        return []
    matched: set[str] = set()
    for raw in TOKEN_SPLIT_PATTERN.split(message_body):
        token = normalize_token(raw)
        if not token or not STRICT_TICKER_PATTERN.match(token):
            continue
        if token in seed_tickers:
            matched.add(token)
    return sorted(matched)


def fetch_messages(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """SELECT m.id AS row_id, m.discord_message_id, m.author_name, m.content,
                  m.posted_at, m.has_tickers, m.ticker_list, s.name AS source_name
           FROM discord_messages m
           JOIN discord_sources s ON s.id = m.source_id
           ORDER BY m.posted_at ASC, m.id ASC""").fetchall()


def stamp_message(connection: sqlite3.Connection, row_id: int, ticker_list: str) -> None:
    connection.execute(
        "UPDATE discord_messages SET has_tickers = ?, ticker_list = ? WHERE id = ?",
        (1 if ticker_list else 0, ticker_list, row_id))


def write_csv(output_path: Path, rows: list[dict[str, str]]) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["source_name", "posted_at", "discord_message_id",
              "author_name", "tickers"]
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract tickers from ingested Discord messages.")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_CSV))
    parser.add_argument("--lexicon", default=str(DEFAULT_LEXICON))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"[discord-extract] no state.sqlite at {db_path}; nothing to extract.")
        return 0

    seed_tickers = load_seed_lexicon(Path(args.lexicon))
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    bootstrap_schema(conn)
    try:
        messages = fetch_messages(conn)
        signals: list[dict[str, str]] = []
        touched = 0
        for row in messages:
            tickers = extract_tickers(row["content"], seed_tickers)
            ticker_csv = ",".join(tickers)
            if ticker_csv != (row["ticker_list"] or ""):
                stamp_message(conn, int(row["row_id"]), ticker_csv)
                touched += 1
            if tickers:
                signals.append({
                    "source_name": row["source_name"],
                    "posted_at": row["posted_at"],
                    "discord_message_id": row["discord_message_id"],
                    "author_name": row["author_name"],
                    "tickers": ticker_csv,
                })
        conn.commit()
    finally:
        conn.close()

    written = write_csv(Path(args.output), signals)
    print(json.dumps({
        "db_path": str(db_path),
        "output_csv": str(args.output),
        "lexicon": str(args.lexicon),
        "seed_ticker_count": len(seed_tickers),
        "messages_scanned": len(messages),
        "rows_stamped": touched,
        "signals_written": written,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
