"""Discord channel browser-scraper (Playwright).

When run as a script (python tools/discord_pipeline/browser_ingest.py), the
project root is prepended to sys.path so sub-package imports resolve.

Third ingest path alongside ``ingest_channel.py`` (REST + bot token) and
``import_jsonl.py`` (agentic prompt). Opens a real headed Chromium, lets the
user log in manually if needed, scrolls N messages into view, and writes a
JSONL file in the exact schema ``import_jsonl.py`` accepts.

One-time setup: ``pip install -r requirements.txt && playwright install chromium``.
Selectors below are best-effort: Discord rotates DOM classes often, so each
extraction step warns on failure rather than crashing the scrape.
"""

import sys
from pathlib import Path as _Path

# Resolve project root once (two levels up from this file: discord_pipeline → tools → <root>)
_PROJECT_ROOT = _Path(__file__).resolve().parents[2]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

try:
    from .message_parser import (
        parse_message_element,
        EMPTY_MESSAGE,
        REQUIRED_MESSAGE_KEYS,
        parse_message_dict,
    )
except ImportError:
    # Support running as a standalone script (no known parent package)
    from tools.discord_pipeline.message_parser import (
        parse_message_element,
        EMPTY_MESSAGE,
        REQUIRED_MESSAGE_KEYS,
        parse_message_dict,
    )

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except Exception:
    PLAYWRIGHT_AVAILABLE = False

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

WORKSPACE_ROOT = _Path(__file__).resolve().parents[2]
DEFAULT_SESSION_DIR = WORKSPACE_ROOT / "data" / "discord_pipeline" / ".cache"
LOGIN_PATH_FRAGMENT = "/login"
NO_NEW_SCROLL_LIMIT = 2
LOGIN_POLL_SECONDS = 2
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
# Page helpers (Playwright)
# ---------------------------------------------------------------------------

def _wait_for_login(page, timeout_seconds: int) -> bool:
    """Block until the URL leaves /login (or timeout)."""
    deadline = time.time() + max(0, timeout_seconds)
    print(f"{SELECTOR_LOG} Waiting up to {timeout_seconds}s for the user to log in "
          "to Discord in the open browser window.")
    while time.time() < deadline:
        try:
            url = page.url or ""
        except Exception:
            time.sleep(LOGIN_POLL_SECONDS)
            continue
        if LOGIN_PATH_FRAGMENT not in url:
            print(f"{SELECTOR_LOG} Login detected at {url}")
            return True
        time.sleep(LOGIN_POLL_SECONDS)
    return False


def _retry(op, *, attempts: int = 2, backoff: float = 1.0):
    """Run ``op()`` up to ``attempts`` times; re-raise the last error."""
    for i in range(1, max(1, attempts) + 1):
        try:
            return op()
        except Exception as exc:
            if i >= attempts:
                raise
            print(f"{SELECTOR_LOG} transient error {type(exc).__name__}: {exc}; "
                  f"backing off {backoff:.1f}s (attempt {i}/{attempts})")
            time.sleep(backoff)
            backoff *= 2


def _scrape_channel(page, target_count: int,
                    scroll_pause_ms: int) -> list[dict[str, Any]]:
    print(f"{SELECTOR_LOG} Waiting for message list to render …")
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            count = page.locator("li[id^='message-']").count()
        except Exception:
            count = 0
        if count > 0:
            break
        time.sleep(0.5)
    else:
        print(f"{SELECTOR_LOG} WARNING: no li[id^='message-'] elements after 30s. "
              "Selectors may have changed; dumping whatever is on page.")

    seen_ids: set[str] = set()
    messages: list[dict[str, Any]] = []
    no_new_runs = 0
    while len(messages) < target_count and no_new_runs < NO_NEW_SCROLL_LIMIT:
        htmls = page.eval_on_selector_all(
            "li[id^='message-']",
            "els => els.map(e => e.outerHTML)")
        new_here = 0
        for h in htmls:
            try:
                msg = parse_message_element(h)
            except Exception as exc:
                print(f"{SELECTOR_LOG} parse failed on one element: {exc}",
                      file=sys.stderr)
                continue
            if not msg["discord_message_id"] or msg["discord_message_id"] in seen_ids:
                continue
            seen_ids.add(msg["discord_message_id"])
            messages.append(msg)
            new_here += 1
            if len(messages) >= target_count:
                break
        print(f"{SELECTOR_LOG} accumulated {len(messages)} messages "
              f"(+{new_here} new this batch)")
        no_new_runs = no_new_runs + 1 if new_here == 0 else 0
        if len(messages) >= target_count:
            break
        try:
            page.keyboard.press("PageUp")
            time.sleep(scroll_pause_ms / 1000.0)
        except Exception as exc:
            print(f"{SELECTOR_LOG} scroll error: {exc}", file=sys.stderr)
            break
    return messages


def _write_jsonl(messages: list[dict[str, Any]], out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as fh:
        for m in messages:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    return len(messages)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not PLAYWRIGHT_AVAILABLE:
        print(f"{SELECTOR_LOG} Playwright is not installed. Run:\n"
              "    pip install -r requirements.txt\n    playwright install chromium",
              file=sys.stderr)
        return 2

    session_path = (Path(args.session) if args.session
                    else _default_session_path(args.source))
    storage_state: dict[str, Any] | None = None
    if session_path.exists():
        try:
            storage_state = json.loads(session_path.read_text(encoding="utf-8"))
            print(f"{SELECTOR_LOG} loaded existing session from {session_path}")
        except Exception as exc:
            print(f"{SELECTOR_LOG} could not parse {session_path}: {exc}; ignoring.",
                  file=sys.stderr)

    headless = bool(args.headless)
    if headless:
        print(f"{SELECTOR_LOG} WARNING: --headless set; Discord typically blocks "
              "headless browsers. Use only for testing.", file=sys.stderr)

    out_path = Path(args.out).resolve()
    started = time.time()
    messages: list[dict[str, Any]] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        try:
            context = browser.new_context(storage_state=storage_state)
            page = context.new_page()
            try:
                _retry(lambda: page.goto(args.url, wait_until="domcontentloaded",
                                         timeout=45000))
            except Exception as exc:
                print(f"{SELECTOR_LOG} initial navigation failed: {exc}",
                      file=sys.stderr)

            if LOGIN_PATH_FRAGMENT in (page.url or ""):
                print(f"{SELECTOR_LOG} Not logged in (currently at {page.url}).")
                if not _wait_for_login(page, args.login_timeout_seconds):
                    print(f"{SELECTOR_LOG} login timeout after "
                          f"{args.login_timeout_seconds}s", file=sys.stderr)
                    return 1
                try:
                    page.goto(args.url, wait_until="domcontentloaded", timeout=45000)
                except Exception as exc:
                    print(f"{SELECTOR_LOG} post-login navigation failed: {exc}",
                          file=sys.stderr)

            messages = _scrape_channel(page, args.messages, args.scroll_pause_ms)
            written = _write_jsonl(messages, out_path)

            try:
                session_path.parent.mkdir(parents=True, exist_ok=True)
                session_path.write_text(
                    json.dumps(context.storage_state()), encoding="utf-8")
                print(f"{SELECTOR_LOG} saved session to {session_path}")
            except Exception as exc:
                print(f"{SELECTOR_LOG} could not save session: {exc}",
                      file=sys.stderr)
        finally:
            try:
                browser.close()
            except Exception:
                pass

    elapsed = time.time() - started
    print(json.dumps({
        "source": args.source, "url": args.url,
        "messages_loaded": len(messages), "messages_written": len(messages),
        "jsonl_path": str(out_path), "elapsed_seconds": round(elapsed, 2),
        "headless": headless, "session_path": str(session_path),
    }, indent=2))
    return 0 if messages else 1


if __name__ == "__main__":
    raise SystemExit(main())
