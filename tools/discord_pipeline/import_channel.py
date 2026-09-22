#!/usr/bin/env python3
"""Fetch messages from Discord channels via user token and import into SQLite.

Usage:
    python tools/discord_pipeline/import_channel.py <source_name> <channel_id> <user_token> [--messages N]
"""
import sys, json, argparse, sqlite3, re, os
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
try:
    import requests
except ImportError:
    print("requests not installed: pip install requests", file=sys.stderr)
    sys.exit(1)

BASE_URL = "https://discord.com/api/v9"
DB = str(Path(__file__).resolve().parents[2] / "data" / "video_pipeline" / "state.sqlite")

# Ticker regex — matches $TICKER or plain TICKER (2-5 uppercase letters, bounded)
# No lexicon dependency — captures ALL ticker-like tokens for downstream filtering
TICKER_RE = re.compile(r'(?<![A-Z])\$?([A-Z]{2,5})(?![A-Z])')

# Exclude common English/trading words that aren't tickers
STOPWORDS = {
    'THE','AND','FOR','YOU','ARE','BUT','NOT','WITH','HAS','HAD',
    'WAS','HIS','HER','ITS','OUR','ALL','ANY','CAN','LET','GET',
    'NOW','SEE','WAY','WHO','BIG','NEW','OLD','TOP','LOT','OUT',
    'ONE','TWO','MAY','BEST','JUST','MORE','THAN','THEM','SOME',
    'INTO','FROM','THIS','THAT','WILL','BEEN','WERE','WHEN','VERY',
    'ALSO','EVEN','MOST','ONLY','OVER','UNDER','AFTER','ABOUT',
    'LIKE','THRU','THEN','FIRST','LAST','NEXT','SAME','MUCH','MANY',
    'BEFORE','AROUND','AWAY','BACK','HERE','THERE','WHILE','STILL',
    'ALREADY','THROUGH','THINK','WANT','LOOK','KEEP','MAKE','EVERY',
    'BELOW','ABOVE','WHICH','WHERE','BEING','THEIR','WOULD','COULD',
    'SHOULD','RIGHT','LEFT','THESE','THOSE','YOUR','OURS','THEIR',
    'VWAP','LOD','HOD','TODAY','YESTERDAY','TOMORROW','HIGH','LOW',
    'OPEN','CLOSE','PRE','POST','MID','BID','ASK','SIZ','PS','EPS',
    'YTD','MTD','WTD','WEEK','MONTH','YEAR','ANNUAL','QUARTER',
    'USD','EUR','GBP','JPY','CAD','AUD','CHF','CNY','INR',
    'ETF','IPO','SPA','SEC','FDA','FOMC','EPA','PPP','HSA',
    'SOLD','BOUGHT','SELL','BUY','CALL','PUT','STR','LONG','SHORT',
    'EXIT','ENTRY','STOP','LIMIT','MARKET','SHARES','PERCENT','POSITION',
    'ADD','TRIM','CUT','HALVE','DOUBLE','EXIT','SIZE','SCALE','FULL',
}

def extract_tickers(content: str) -> list[str]:
    if not content:
        return []
    found = []
    for m in TICKER_RE.findall(content.upper()):
        if m not in STOPWORDS:
            found.append(m)
    # unique, preserve order
    return list(dict.fromkeys(found))

def fetch_messages(channel_id: str, token: str, limit: int = 200) -> list[dict]:
    headers = {"Authorization": token, "Content-Type": "application/json"}
    params = {"limit": 100}
    messages = []
    while len(messages) < limit:
        url = f"{BASE_URL}/channels/{channel_id}/messages"
        r = requests.get(url, headers=headers, params=params, timeout=30)
        if r.status_code == 403:
            raise Exception("Forbidden — not a member of this channel or no access")
        if r.status_code != 200:
            raise Exception(f"HTTP {r.status_code}: {r.text[:300]}")
        batch = r.json()
        if not batch:
            break
        messages.extend(batch)
        if len(messages) >= limit:
            break
        oldest_id = str(int(batch[-1]["id"]) - 1)
        params["before"] = oldest_id
    return messages[:limit]

def import_messages(source_name: str, channel_id: str, token: str, limit: int = 200):
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    cur.execute("SELECT id FROM discord_sources WHERE name = ?", (source_name,))
    row = cur.fetchone()
    if not row:
        print(f"ERROR: source '{source_name}' not found in discord_sources table", file=sys.stderr)
        print("Run: node tools/runDiscordIngest.js add-source <name> <channel_id> --guild-id <guild_id>", file=sys.stderr)
        sys.exit(1)
    source_id = row[0]

    print(f"Fetching messages for source '{source_name}' (channel {channel_id})...", file=sys.stderr)
    messages = fetch_messages(channel_id, token, limit)
    print(f"Fetched {len(messages)} messages", file=sys.stderr)

    cur.execute("SELECT last_message_id FROM discord_sources WHERE id = ?", (source_id,))
    last_id_on_disk = cur.fetchone()[0] or "0"

    imported = 0
    skipped = 0
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    new_last_id = last_id_on_disk

    for msg in messages:
        msg_id = msg["id"]
        if int(msg_id) <= int(last_id_on_disk):
            skipped += 1
            continue

        content = msg.get("content", "") or ""
        author = msg.get("author", {})
        author_id = author.get("id", "0")
        author_name = author.get("username", "unknown")
        posted_at = msg.get("timestamp", "")
        tickers = extract_tickers(content)
        ticker_str = ",".join(tickers) if tickers else ""
        raw_json = json.dumps(msg)

        cur.execute("""
            INSERT OR IGNORE INTO discord_messages
            (source_id, discord_message_id, author_id, author_name, content, posted_at, ingested_at, has_tickers, ticker_list, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (source_id, msg_id, author_id, author_name, content, posted_at, now, 1 if tickers else 0, ticker_str, raw_json))

        if int(msg_id) > int(new_last_id):
            new_last_id = msg_id
        imported += 1

    cur.execute("UPDATE discord_sources SET last_message_id = ?, last_run_at = ? WHERE id = ?",
                (new_last_id, now, source_id))

    cur.execute("""
        INSERT INTO discord_pipeline_runs (source_id, run_tag, started_at, finished_at, fetched_count, new_count)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (source_id, 'user-token-import', now, now, len(messages), imported))

    conn.commit()
    conn.close()

    print(f"Imported {imported} new messages, skipped {skipped} old ones", file=sys.stderr)
    print(f"Last message ID: {new_last_id}", file=sys.stderr)
    return imported, skipped

def main():
    parser = argparse.ArgumentParser(description="Fetch Discord messages and import to SQLite")
    parser.add_argument("source_name", help="Source name (e.g. drendel)")
    parser.add_argument("channel_id", help="Discord channel ID")
    parser.add_argument("token", help="Discord user token")
    parser.add_argument("--messages", "-n", type=int, default=200, help="Number of messages to fetch")
    args = parser.parse_args()
    import_messages(args.source_name, args.channel_id, args.token, args.messages)

if __name__ == "__main__":
    main()
