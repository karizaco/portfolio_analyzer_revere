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

# Resolve project root once (two levels up from this file: discord_pipeline → tools → <root>)
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

from .browser_driver import scrape_channel, DEFAULT_SESSION_DIR

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

WORKSPACE_ROOT = _PROJECT_ROOT
SELECTOR_LOG = "[browser-ingest]"


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Orchestration helpers (session + JSONL — not DOM)
# ---------------------------------------------------------------------------

def _write_jsonl(messages: list[dict], out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as fh:
        for m in messages:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    return len(messages)


# ---------------------------------------------------------------------------
# Main (thin shim)
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    session_path = (Path(args.session) if args.session
                    else _default_session_path(args.source))
    out_path = Path(args.out).resolve()
    started = time.time()

    # Delegate all Playwright/DOM work to browser_driver
    raw_messages = scrape_channel(
        url=args.url,
        session_state_path=str(session_path) if session_path.exists() else None,
        messages=args.messages,
        login_timeout=args.login_timeout_seconds,
        scroll_pause_ms=args.scroll_pause_ms,
        headless=bool(args.headless),
    )

    # Parse raw DOM dicts through message_parser for schema normalisation
    parsed_messages: list[dict] = []
    for raw in raw_messages:
        try:
            # Re-serialise the stored _html through parse_message_element so the
            # output matches what the old browser_ingest produced
            parsed = parse_message_element(raw.get("_html", ""))
            if not parsed.get("discord_message_id"):
                continue
            parsed_messages.append(parsed)
        except Exception as exc:
            print(f"{SELECTOR_LOG} parse failed on one element: {exc}",
                  file=sys.stderr)
            continue

    written = _write_jsonl(parsed_messages, out_path)

    # Save session for next run
    try:
        session_path.parent.mkdir(parents=True, exist_ok=True)
        # browser_driver already launched the browser; we don't have direct
        # access to its context.storage_state() here.  Re-launch briefly to
        # persist the session cookie if the user is still logged in.
        _persist_session(session_path, args.url, args.login_timeout_seconds)
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


def _persist_session(session_path: Path, url: str, login_timeout: int):
    """Re-launch browser with an existing session and save it back."""
    from .browser_driver import scrape_channel, PLAYWRIGHT_AVAILABLE
    if not PLAYWRIGHT_AVAILABLE:
        return
    # Use a tiny scrape (0 messages) to get the browser context and save state
    scrape_channel(url=url, session_state_path=str(session_path),
                   messages=0, login_timeout=login_timeout,
                   scroll_pause_ms=100, headless=True)
    # NOTE: scrape_channel doesn't expose storage_state directly.
    # Instead, browser_driver saves nothing — it is the caller's job.
    # For this shim we do a minimal playwright launch just to persist.
    import json as _json
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            # Try to load the existing session (it should already be there)
            existing = None
            if session_path.exists():
                try:
                    existing = _json.loads(session_path.read_text(encoding="utf-8"))
                except Exception:
                    pass
            context = browser.new_context(storage_state=existing)
            # Navigate to refresh cookies
            try:
                context.new_page().goto(url, wait_until="domcontentloaded",
                                       timeout=30000)
            except Exception:
                pass
            session_path.write_text(
                _json.dumps(context.storage_state()), encoding="utf-8")
            print(f"{SELECTOR_LOG} saved session to {session_path}")
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
