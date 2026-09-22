"""Playwright DOM scraper for Discord channels — returns raw data to caller.

No file I/O, no JSONL writing, no session persistence.  This module owns only
the browser lifecycle, DOM traversal, and scroll-until-populated logic.

Public API
----------
scrape_channel(url, session_state_path=None, messages=100,
               login_timeout=120, scroll_pause_ms=1500, headless=False)
    → list[dict]   raw DOM-derived message dicts (unparsed by message_parser)

__main__ interface mirrors the function signature so Node can shell out:
    python -m tools.discord_pipeline.browser_driver --url <url> [--session <path>]
        [--messages N] [--login-timeout-seconds N] [--scroll-pause-ms N]
        [--headless]
and receive JSON on stdout.
"""

import sys
import json
import re
import time
from pathlib import Path
from typing import Any

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except Exception:
    PLAYWRIGHT_AVAILABLE = False

# ---------------------------------------------------------------------------
# Module-level constants (mirrored from browser_ingest.py — not orchestration)
# ---------------------------------------------------------------------------

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SESSION_DIR = WORKSPACE_ROOT / "data" / "discord_pipeline" / ".cache"
LOGIN_PATH_FRAGMENT = "/login"
NO_NEW_SCROLL_LIMIT = 2
LOGIN_POLL_SECONDS = 2
SELECTOR_LOG = "[browser-driver]"


# ---------------------------------------------------------------------------
# Raw DOM extraction helpers
# ---------------------------------------------------------------------------

def _extract_message_dict(element_html: str) -> dict[str, Any] | None:
    """Parse a single <li id="message-..."> element's HTML into a raw dict.

    Returns None if the element cannot be parsed at all.
    The returned dict is UNVALIDATED — callers (JS wrapper) pipe it through
    ``message_parser.parse_message_element`` for schema normalisation.
    """
    import re as _re

    # message snowflake
    m = _re.search(r'id="(?:message-id-|message-)(?P<id>[0-9]{17,20})"', element_html)
    if not m:
        return None
    snowflake = m.group("id")

    # author
    author_id_m = _re.search(r'data-author-id="(?P<aid>[0-9]{17,20})"', element_html)
    author_id = author_id_m.group("aid") if author_id_m else "0"

    author_name_m = _re.search(
        r'<span[^>]*class="[^"]*username[^"]*"[^>]*>(?P<v>[^<]+)</span>',
        element_html, _re.DOTALL)
    author_name = (author_name_m.group("v").strip() if author_name_m
                   else "Unknown")

    # timestamp
    ts_m = _re.search(r'<time[^>]*datetime="(?P<v>[^"]+)"', element_html)
    posted_at = ts_m.group("v") if ts_m else ""

    # edited marker
    edited_m = _re.search(
        r'<time[^>]*datetime="(?P<v>[^"]+)"[^>]*>.{0,120}?class="[^"]*\bedited\b',
        element_html, _re.DOTALL)
    edited_at = edited_m.group("v") if edited_m else ""

    # content
    content_m = _re.search(
        r'<div[^>]*id="message-content-[^"]*"[^>]*>(?P<v>.*?)</div>\s*<',
        element_html, _re.DOTALL)
    content_html = content_m.group("v") if content_m else ""
    # strip tags cheaply
    content = _re.sub(r"<[^>]+>", " ", content_html).strip()
    for ent, ch in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                    ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        content = content.replace(ent, ch)
    content = _re.sub(r"\s+", " ", content).strip()

    # pinned / attachments
    is_pinned = "pinnedMessage" in element_html
    has_attachments = ("attachment" in element_html or "embed" in element_html
                       or "imageContent" in element_html)

    # reply context
    reply_m = _re.search(
        r'<div[^>]*class="[^"]*repliedMessageContent[^"]*"[^>]*>(?P<v>.*?)</div>',
        element_html, _re.DOTALL)
    reply_text = ""
    reply_to_snowflake = ""
    if reply_m:
        reply_text = _re.sub(r"<[^>]+>", " ", reply_m.group("v")).strip()
        reply_id_m = _re.search(r'[0-9]{17,20}', reply_m.group("v"))
        reply_to_snowflake = reply_id_m.group(0) if reply_id_m else ""

    return {
        "snowflake": snowflake,
        "author_id": author_id,
        "author_name": author_name,
        "posted_at_raw": posted_at,
        "edited_at_raw": edited_at,
        "content": content,
        "is_pinned": is_pinned,
        "has_attachments": has_attachments,
        "reply_text": reply_text,
        "reply_to_snowflake": reply_to_snowflake,
        "_html": element_html,          # retained for debugging / re-parsing
    }


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


# ---------------------------------------------------------------------------
# Main scraping entry point
# ---------------------------------------------------------------------------

def scrape_channel(
    url: str,
    session_state_path: str | None = None,
    messages: int = 100,
    login_timeout: int = 120,
    scroll_pause_ms: int = 1500,
    headless: bool = False,
) -> list[dict[str, Any]]:
    """Launch Chromium, navigate to ``url``, scroll, and return raw message dicts.

    Parameters
    ----------
    url:
        Discord channel URL (e.g. https://discord.com/channels/<guild>/<channel>).
    session_state_path:
        Optional path to a Playwright storage-state JSON file previously saved
        from ``context.storage_state()``.  If absent a fresh anonymous context
        is created.
    messages:
        Target number of unique messages to accumulate (default 100).
    login_timeout:
        Seconds to wait for manual Discord login before bailing (default 120).
    scroll_pause_ms:
        Milliseconds to sleep between PageUp presses (default 1500).
    headless:
        Run Chromium headless (default False).  Discord often blocks headless;
        this flag exists for testing only.

    Returns
    -------
    list[dict]
        Raw DOM-derived message dicts.  These are NOT validated or normalised;
        pipe each through ``message_parser.parse_message_element`` before
        writing to JSONL.
    """
    if not PLAYWRIGHT_AVAILABLE:
        raise RuntimeError(
            "Playwright is not installed. Run: pip install -r requirements.txt && playwright install chromium"
        )

    # Load prior session if available
    storage_state: dict[str, Any] | None = None
    if session_state_path:
        sp = Path(session_state_path)
        if sp.exists():
            try:
                storage_state = json.loads(sp.read_text(encoding="utf-8"))
                print(f"{SELECTOR_LOG} loaded existing session from {sp}")
            except Exception as exc:
                print(f"{SELECTOR_LOG} could not parse session {sp}: {exc}; ignoring.",
                      file=sys.stderr)

    result: list[dict[str, Any]] = []

    with sync_playwright() as pw:
        # Try real browsers first (your existing Discord session is already logged in)
        for channel in ['msedge', 'chrome', 'chromium']:
            try:
                browser = pw.chromium.launch(channel=channel, headless=False)
                print(f"{SELECTOR_LOG} Launched via --browser-channel={channel}")
                break
            except Exception:
                continue
        else:
            # Fall back to bundled Chromium (may get detected by Discord)
            browser = pw.chromium.launch(headless=headless)
            print(f"{SELECTOR_LOG} Launched bundled Chromium (may be detected)")
        try:
            context = browser.new_context(storage_state=storage_state)
            page = context.new_page()

            # Initial navigation
            try:
                _retry(lambda: page.goto(url, wait_until="domcontentloaded",
                                         timeout=45000))
            except Exception as exc:
                print(f"{SELECTOR_LOG} initial navigation failed: {exc}",
                      file=sys.stderr)

            # Handle login if redirected
            if LOGIN_PATH_FRAGMENT in (page.url or ""):
                print(f"{SELECTOR_LOG} Not logged in (currently at {page.url}).")
                if not _wait_for_login(page, login_timeout):
                    print(f"{SELECTOR_LOG} login timeout after {login_timeout}s",
                          file=sys.stderr)
                    return []
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                except Exception as exc:
                    print(f"{SELECTOR_LOG} post-login navigation failed: {exc}",
                          file=sys.stderr)

            # Wait for message list to render
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
                print(f"{SELECTOR_LOG} WARNING: no li[id^='message-'] after 30s; "
                      "dumping whatever is on page.")

            # Scroll-and-collect loop
            seen_ids: set[str] = set()
            no_new_runs = 0
            while len(result) < messages and no_new_runs < NO_NEW_SCROLL_LIMIT:
                htmls = page.eval_on_selector_all(
                    "li[id^='message-']",
                    "els => els.map(e => e.outerHTML)")
                new_here = 0
                for h in htmls:
                    try:
                        msg = _extract_message_dict(h)
                    except Exception as exc:
                        print(f"{SELECTOR_LOG} parse failed on one element: {exc}",
                              file=sys.stderr)
                        continue
                    if not msg or not msg["snowflake"]:
                        continue
                    sid = msg["snowflake"]
                    if sid in seen_ids:
                        continue
                    seen_ids.add(sid)
                    result.append(msg)
                    new_here += 1
                    if len(result) >= messages:
                        break
                print(f"{SELECTOR_LOG} accumulated {len(result)} messages "
                      f"(+{new_here} new this batch)")
                no_new_runs = no_new_runs + 1 if new_here == 0 else 0
                if len(result) >= messages:
                    break
                try:
                    page.keyboard.press("PageUp")
                    time.sleep(scroll_pause_ms / 1000.0)
                except Exception as exc:
                    print(f"{SELECTOR_LOG} scroll error: {exc}", file=sys.stderr)
                    break
        finally:
            try:
                browser.close()
            except Exception:
                pass

    return result


# ---------------------------------------------------------------------------
# CLI entry point (for Node subprocess)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Playwright DOM scraper for Discord channels — outputs JSON "
                    "list of raw message dicts to stdout.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--session", default=None)
    parser.add_argument("--messages", type=int, default=100)
    parser.add_argument("--login-timeout-seconds", type=int, default=120)
    parser.add_argument("--scroll-pause-ms", type=int, default=1500)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    try:
        raw_messages = scrape_channel(
            url=args.url,
            session_state_path=args.session,
            messages=args.messages,
            login_timeout=args.login_timeout_seconds,
            scroll_pause_ms=args.scroll_pause_ms,
            headless=bool(args.headless),
        )
    except Exception as exc:
        sys.stderr.write(f"{SELECTOR_LOG} fatal: {exc}\n")
        sys.exit(1)

    sys.stdout.write(json.dumps(raw_messages, ensure_ascii=False))
