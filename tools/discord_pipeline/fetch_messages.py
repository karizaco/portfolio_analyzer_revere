#!/usr/bin/env python3
"""Fetch messages from a Discord channel using a user token — no browser needed.

Usage:
    python tools/discord_pipeline/fetch_messages.py <channel_id> <user_token> [--messages N]

Output: JSONL to stdout (one message per line, raw API response)
"""
import sys, json, argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
try:
    import requests
except ImportError:
    print("requests not installed: pip install requests", file=sys.stderr)
    sys.exit(1)

BASE_URL = "https://discord.com/api/v9"


def fetch_messages(channel_id: str, token: str, limit: int = 200) -> list[dict]:
    headers = {"Authorization": token, "Content-Type": "application/json"}
    params = {"limit": min(limit, 100)}
    messages = []
    while len(messages) < limit:
        url = f"{BASE_URL}/channels/{channel_id}/messages"
        r = requests.get(url, headers=headers, params=params, timeout=30)
        if r.status_code == 401:
            raise Exception("Invalid token — check Authorization header")
        if r.status_code == 403:
            raise Exception(f"Forbidden (403) — likely not a member of this channel or token lacks access")
        if r.status_code != 200:
            raise Exception(f"HTTP {r.status_code}: {r.text[:200]}")
        batch = r.json()
        if not batch:
            break
        messages.extend(batch)
        # Use oldest message ID as cursor for next page
        oldest_id = str(int(batch[0]["id"]) - 1)
        params["before"] = oldest_id
    return messages[:limit]


def main():
    parser = argparse.ArgumentParser(description="Fetch Discord messages via user token")
    parser.add_argument("channel_id", help="Discord channel ID")
    parser.add_argument("token", help="Discord user token (Nj...)")
    parser.add_argument("--messages", "-n", type=int, default=200, help="Number of messages to fetch")
    args = parser.parse_args()

    print(f"Fetching up to {args.messages} messages from channel {args.channel_id}...", file=sys.stderr)
    try:
        msgs = fetch_messages(args.channel_id, args.token, args.messages)
        print(f"Fetched {len(msgs)} messages", file=sys.stderr)
        for m in msgs:
            sys.stdout.write(json.dumps(m) + "\n")
        sys.stdout.flush()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
