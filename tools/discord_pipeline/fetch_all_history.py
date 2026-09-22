#!/usr/bin/env python3
"""
Fetch ALL available message history from a Discord channel using the search API.
Uses min_id/max_id (snowflake) for date filtering — no Nitro needed.

Discord's search endpoint: GET /api/v9/channels/{id}/messages/search
Parameters:
  min_id = snowflake of oldest message to include
  max_id = snowflake of newest message to include
  query  = empty string searches all messages
  limit  = up to 100 per page
"""
import sys, json, argparse, requests, time
from datetime import datetime, timezone

BASE_URL = "https://discord.com/api/v9"
DISCORD_EPOCH = 1420070400000  # Discord's epoch (Dec 1, 2014) in milliseconds

def date_to_snowflake(dt: datetime) -> int:
    """Convert a datetime to a Discord snowflake ID."""
    ts_ms = int(dt.timestamp() * 1000)
    return ((ts_ms - DISCORD_EPOCH) << 22) | 0x3FFFF

def snowflake_to_date(snowflake: int) -> datetime:
    ts_ms = ((snowflake >> 22) + DISCORD_EPOCH)
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)

def fetch_all_messages(channel_id: str, token: str, oldest_dt=None, newest_dt=None) -> list[dict]:
    headers = {"Authorization": token, "Content-Type": "application/json"}

    params = {"query": "", "limit": 100}

    if newest_dt:
        params["max_id"] = str(date_to_snowflake(newest_dt))
    if oldest_dt:
        params["min_id"] = str(date_to_snowflake(oldest_dt))

    messages = []
    while True:
        url = f"{BASE_URL}/channels/{channel_id}/messages/search"
        r = requests.get(url, headers=headers, params=params, timeout=30)
        if r.status_code == 401:
            raise Exception("Invalid token")
        if r.status_code == 403:
            raise Exception("Forbidden — check token permissions")
        if r.status_code == 429:
            retry = int(r.headers.get("retry-after", 5))
            print(f"Rate limited, waiting {retry}s...", file=sys.stderr)
            time.sleep(retry)
            continue
        if r.status_code != 200:
            raise Exception(f"HTTP {r.status_code}: {r.text[:300]}")

        data = r.json()
        if isinstance(data, dict):
            batch = data.get("messages", [])
            total = data.get("total_results", len(batch))
        else:
            batch = data

        if not batch:
            break

        messages.extend(batch)
        print(f"  Fetched {len(messages)} messages...", file=sys.stderr)

        # Get oldest message ID for next page
        oldest_in_batch = min(m["id"] for m in batch)
        params["max_id"] = str(int(oldest_in_batch) - 1)

        # Safety: stop if we've paginated many times
        if len(messages) >= 10000:
            print(f"  Safety limit reached (10000), stopping", file=sys.stderr)
            break

        time.sleep(0.5)  # be nice to Discord API

    return messages

def main():
    parser = argparse.ArgumentParser(description="Fetch ALL Discord channel history via search API")
    parser.add_argument("channel_id")
    parser.add_argument("token")
    parser.add_argument("--oldest", help="Oldest date e.g. 2026-01-01")
    parser.add_argument("--newest", help="Newest date e.g. 2026-12-31")
    args = parser.parse_args()

    oldest_dt = None
    newest_dt = None

    if args.oldest:
        oldest_dt = datetime.fromisoformat(args.oldest).replace(tzinfo=timezone.utc)
        print(f"Oldest: {oldest_dt} -> snowflake {date_to_snowflake(oldest_dt)}", file=sys.stderr)
    if args.newest:
        newest_dt = datetime.fromisoformat(args.newest).replace(tzinfo=timezone.utc)
        print(f"Newest: {newest_dt} -> snowflake {date_to_snowflake(newest_dt)}", file=sys.stderr)

    print(f"Fetching all messages from channel {args.channel_id}...", file=sys.stderr)
    messages = fetch_all_messages(args.channel_id, args.token, oldest_dt, newest_dt)
    print(f"Total: {len(messages)} messages", file=sys.stderr)

    if messages:
        oldest = min(m["id"] for m in messages)
        newest = max(m["id"] for m in messages)
        print(f"Range: {snowflake_to_date(int(oldest))} to {snowflake_to_date(int(newest))}", file=sys.stderr)

    for m in messages:
        sys.stdout.write(json.dumps(m) + "\n")

if __name__ == "__main__":
    main()
