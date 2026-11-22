"""Discord channel browser-scraper — thin shim for direct CLI invocation.

For programmatic use import ``browser_driver.scrape_channel`` directly.
For Node.js orchestration use ``tools/runDiscordIngest.js``.

When run as a script (python tools/discord_pipeline/browser_ingest.py), the
project root is prepended to sys.path so sub-package imports resolve.

This module handles:
  1. CLI argument parsing
  2. Session persistence (read/write storage_state JSON)
  3. JSONL output writing
  4. Result summary printing

The Playwright/DOM work is delegated to ``browser_driver.scrape_channel``.
"""

import sys
import json
import re
import time
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import argparse

try:
    from .message_parser import (
        parse_message_element,
        EMPTY_MESSAGE,
        REQUIRED_MESSAGE_KEYS,
        parse_message_dict,
    )
except ImportError:
    from tools.discord_pipeline.message_parser import (
        parse_message_element,
        EMPTY_MESSAGE,
        REQUIRED_MESSAGE_KEYS,
        parse_message_dict,
    )

try:
    from .browser_driver import scrape_channel, DEFAULT_SESSION_DIR, PLAYWRIGHT_AVAILABLE
except ImportError:
    from tools.discord_pipeline.browser_driver import (
        scrape_channel,
        DEFAULT_SESSION_DIR,
        PLAYWRIGHT_AVAILABLE,
    )

WORKSPACE_ROOT = _PROJECT_ROOT
SELECTOR_LOG = "[browser-ingest]"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Scrape a Discord channel via headful Chromium; write "
                    "a JSONL file compatible with import_jsonl.py.")
    p.add_argument("--source", required=True, help="Registered source name.")
    p.add_argument("--url", required=True,
                   help="Discord channel URL "
                        "(https://discord.com/channels/<guild>/<channel>).")
    p.add_argument("--messages", type=int, default=200,
                   help="Target message count (default 200).")
    p.add_argument("--out", default="./discord_dump.jsonl",
                   help="JSONL output path (default ./discord_dump.jsonl).")
    p.add_argument("--session", default="",
                   help="Playwright storage_state path. Default: "
                        "data/discord_pipeline/.cache/browser_session_<source>.json")
    p.add_argument("--login-timeout-seconds", type=int, default=120,
                   help="Seconds to wait for the user to log in (default 120).")
    p.add_argument("--scroll-pause-ms", type=int, default=1500,
                   help="Pause between scroll-up iterations (default 1500ms).")
    p.add_argument("--headless", action="store_true",
                   help="Run Chromium headless. Off by default; Discord bans "
                        "headless, so enable only for testing.")
    return p.parse_args(argv)


def _default_session_path(source: str) -> Path:
    DEFAULT_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", source).strip("_") or "default"
    return DEFAULT_SESSION_DIR / f"browser_session_{safe}.json"


def _write_jsonl(messages: list[dict], out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as fh:
        for m in messages:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    return len(messages)


def _persist_session(session_path: Path, url: str) -> bool:
    """No-op for session writes.

    Session persistence is done inside ``browser_driver.scrape_channel`` from
    the LIVE headed context the user logged into. A previous version of this
    function launched a *headless* browser with the old state and overwrote
    the session file with anonymous cookies — wiping a successful login.
    """
    if session_path.exists():
        print(f"{SELECTOR_LOG} session file present at {session_path} "
              f"(saved by browser_driver during scrape)")
        return True
    print(f"{SELECTOR_LOG} no session file at {session_path} — login may have failed")
    return False



def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    session_path = (Path(args.session) if args.session
                    else _default_session_path(args.source))
    out_path = Path(args.out).resolve()
    started = time.time()

    raw_messages = scrape_channel(
        url=args.url,
        session_state_path=str(session_path),  # driver creates/updates after login
        messages=args.messages,
        login_timeout=args.login_timeout_seconds,
        scroll_pause_ms=args.scroll_pause_ms,
        headless=bool(args.headless),
    )

    parsed_messages: list[dict] = []
    for raw in raw_messages:
        try:
            parsed = parse_message_element(raw.get("_html", ""))
            if not parsed.get("discord_message_id"):
                continue
            parsed_messages.append(parsed)
        except Exception as exc:
            print(f"{SELECTOR_LOG} parse failed on one element: {exc}",
                  file=sys.stderr)
            continue

    written = _write_jsonl(parsed_messages, out_path)

    try:
        _persist_session(session_path, args.url)
    except Exception as exc:
        print(f"{SELECTOR_LOG} could not save session: {exc}", file=sys.stderr)

    elapsed = time.time() - started
    print(json.dumps({
        "source": args.source, "url": args.url,
        "messages_loaded": len(raw_messages),
        "messages_written": written,
        "jsonl_path": str(out_path), "elapsed_seconds": round(elapsed, 2),
        "headless": bool(args.headless), "session_path": str(session_path),
    }, indent=2))
    return 0 if parsed_messages else 1


if __name__ == "__main__":
    raise SystemExit(main())
