"""Discord channel browser-scraper (Playwright).

Third ingest path alongside ``ingest_channel.py`` (REST + bot token) and
``import_jsonl.py`` (agentic prompt). Opens a real headed Chromium, lets the
user log in manually if needed, scrolls N messages into view, and writes a
JSONL file in the exact schema ``import_jsonl.py`` accepts.

One-time setup: ``pip install -r requirements.txt && playwright install chromium``.
Selectors below are best-effort: Discord rotates DOM classes often, so each
extraction step warns on failure rather than crashing the scrape.
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except Exception:
    PLAYWRIGHT_AVAILABLE = False

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SESSION_DIR = WORKSPACE_ROOT / "data" / "discord_pipeline" / ".cache"
LOGIN_PATH_FRAGMENT = "/login"
NO_NEW_SCROLL_LIMIT = 2
LOGIN_POLL_SECONDS = 2
SELECTOR_LOG = "[browser-ingest]"

# Pure parsing helpers (no Playwright deps) — exported for unit tests.
ID_RE = re.compile(r"id=\"(?:message-id-|message-)(?P<id>[0-9]{17,20})\"")
SNOWFLAKE_RE = re.compile(r"[0-9]{17,20}")
EMPTY_MESSAGE = {"discord_message_id": "", "author_id": "", "author_name": "",
                "content": "", "posted_at": "", "edited_at": None,
                "is_pinned": False, "has_attachments": False}


def parse_message_id(text: str) -> str:
    """Extract a Discord message snowflake from an ``id`` attr or HTML fragment."""
    if not text:
        return ""
    m = ID_RE.search(text)
    if m:
        return m.group("id")
    m = re.search(r'data-message-id="(?P<id>[0-9]{17,20})"', text)
    if m:
        return m.group("id")
    m = SNOWFLAKE_RE.search(text)
    return m.group(0) if m else ""


def parse_iso8601(value: str) -> str:
    """ISO-8601 UTC string; accepts Discord's relative + absolute forms."""
    if not value:
        return ""
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def parse_message_element(html: str) -> dict[str, Any]:
    """Best-effort parse of a Discord message <li>. Pure regex, no DOM."""
    if not html:
        return dict(EMPTY_MESSAGE)
    msg_id = parse_message_id(html)
    if not msg_id:
        return dict(EMPTY_MESSAGE)

    author_id_m = re.search(r'data-author-id="(?P<aid>[0-9]{17,20})"', html)
    author_id = author_id_m.group("aid") if author_id_m else "0"

    author_name = _first_match(html, [
        r'<span[^>]*class="[^"]*username[^"]*"[^>]*>(?P<v>[^<]+)</span>',
        r'<h2[^>]*>\s*<span[^>]*class="[^"]*username[^"]*"[^>]*>(?P<v>[^<]+)</span>',
    ]) or "Unknown"

    content_raw = _first_match(html, [
        r'<div[^>]*id="message-content-[^"]*"[^>]*>(?P<v>.*?)</div>\s*<',
        r'<div[^>]*class="[^"]*markdown[^"]*"[^>]*>(?P<v>.*?)</div>\s*<',
    ])
    content = _strip_tags(content_raw) if content_raw else ""

    posted_at = _first_match(html, [
        r'<time[^>]*datetime="(?P<v>[^"]+)"',
        r'<time[^>]*title="(?P<v>[^"]+)"',
    ])
    edited_marker = re.search(r'class="[^"]*\bedited\b', html)
    edited_ts_m = re.search(
        r'<time[^>]*datetime="(?P<v>[^"]+)"[^>]*>.{0,120}?class="[^"]*\bedited\b',
        html, flags=re.DOTALL)
    edited_ts = edited_ts_m.group("v") if (edited_marker and edited_ts_m) else ""

    pinned = "pinnedMessage" in html
    has_attachments = ('attachment' in html or 'embed' in html
                       or 'imageContent' in html)

    reply_ctx = _first_match(html, [
        r'<div[^>]*class="[^"]*repliedMessageContent[^"]*"[^>]*>(?P<v>.*?)</div>',
    ])
    if reply_ctx:
        content = f"@replying to {author_name}: {_strip_tags(reply_ctx)} -- {content}"

    if not content and not has_attachments:
        return dict(EMPTY_MESSAGE)

    return {
        "discord_message_id": msg_id, "author_id": author_id,
        "author_name": author_name, "content": content or "[embed-only]",
        "posted_at": parse_iso8601(posted_at),
        "edited_at": parse_iso8601(edited_ts) if edited_ts else None,
        "is_pinned": pinned, "has_attachments": has_attachments,
    }


def _first_match(text: str, patterns: list[str]) -> str:
    for pat in patterns:
        m = re.search(pat, text, flags=re.DOTALL)
        if m:
            return (m.group("v") or "").strip()
    return ""


def _strip_tags(fragment: str) -> str:
    """Cheap HTML→text — lxml pulls in too much for Discord-sized payloads."""
    if not fragment:
        return ""
    s = re.sub(r"<[^>]+>", " ", fragment)
    for ent, ch in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                    ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(ent, ch)
    return re.sub(r"\s+", " ", s).strip()


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


def _wait_for_login(page: Page, timeout_seconds: int) -> bool:
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


def _scrape_channel(page: Page, target_count: int,
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
