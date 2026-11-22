"""Playwright DOM scraper for Discord channels — returns raw data to caller.

No JSONL writing. This module owns the browser lifecycle, DOM traversal,
scroll-until-populated logic, and LIVE session persistence (storage_state
written from the headed context the user logged into).

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
    """Parse a single message list-item element's HTML into a raw dict."""
    if not element_html:
        return None
    id_m = re.search(r'id="chat-messages-[0-9]{17,20}-([0-9]{17,20})"', element_html)
    if not id_m:
        id_m = re.search(r'data-list-item-id="chat-messages___([0-9]{17,20})"', element_html)
    if not id_m:
        id_m = re.search(r'data-message-id="([0-9]{17,20})"', element_html)
    if not id_m:
        # message-<id> but NOT the "messages-" inside chat-messages-
        id_m = re.search(r'id="message-(?![s-])([0-9]{17,20})"', element_html)
    if not id_m:
        id_m = re.search(r'id="message-id-([0-9]{17,20})"', element_html)
    if not id_m:
        return None
    snowflake = id_m.group(1)
    author_id_m = re.search(r'data-author-id="([0-9]{17,20})"', element_html)
    author_id = author_id_m.group(1) if author_id_m else '0'
    author_name_m = re.search(
        r'<span[^>]*class="[^"]*username[^"]*"[^>]*>([^<]+)</span>', element_html
    )
    author_name = author_name_m.group(1).strip() if author_name_m else 'Unknown'
    ts_m = re.search(r'<time[^>]*datetime="([^"]+)"', element_html)
    posted_at = ts_m.group(1) if ts_m else ''
    is_pinned = 'pinnedMessage' in element_html
    has_attachments = (
        'attachment' in element_html or 'embed' in element_html
        or 'imageContent' in element_html or 'originalLink' in element_html
    )
    return {
        'snowflake': snowflake,
        'author_id': author_id,
        'author_name': author_name,
        'posted_at': posted_at,
        'is_pinned': is_pinned,
        'has_attachments': has_attachments,
        '_html': element_html,
    }



def _wait_for_login(page, timeout_seconds: int) -> bool:
    """Block until login + MFA are fully done (or timeout).

    A wrong 2FA code must NOT end the wait — Discord stays on the MFA screen
    and the user can re-enter a new code. We only return success when the MFA
    UI is gone AND we either see chat messages or a clearly logged-in app shell.
    """
    print(
        f"{SELECTOR_LOG} waiting up to {timeout_seconds}s for login + 2FA "
        f"(wrong codes are OK — keep trying until it accepts) …",
        flush=True,
    )
    deadline = time.time() + max(1, int(timeout_seconds))
    last_note = ""
    stable_ok = 0
    while time.time() < deadline:
        try:
            url = page.url or ""
        except Exception:
            url = ""
        try:
            body = page.evaluate("() => (document.body && document.body.innerText) || ''") or ""
        except Exception:
            body = ""
        body_l = body.lower()
        on_login = LOGIN_PATH_FRAGMENT in url
        on_mfa = (
            "multi-factor authentication" in body_l
            or "enter discord auth code" in body_l
            or "enter the code" in body_l
            or ("auth code" in body_l and "verify" in body_l)
            or "two-factor" in body_l
            or "authentication code" in body_l
        )
        invalid_code = (
            "invalid" in body_l and ("code" in body_l or "auth" in body_l)
        ) or "incorrect code" in body_l
        try:
            has_messages = _message_locator_count(page) > 0
        except Exception:
            has_messages = False
        note = (
            f"url={url!r} login={on_login} mfa={on_mfa} "
            f"invalid_code={invalid_code} messages={has_messages}"
        )
        if note != last_note:
            print(f"{SELECTOR_LOG} auth wait: {note}", flush=True)
            if invalid_code and on_mfa:
                print(
                    f"{SELECTOR_LOG} 2FA code rejected — enter a fresh code "
                    f"(window stays open)",
                    flush=True,
                )
            last_note = note
        # Stay put on MFA forever (until timeout) so the user can retry codes.
        if on_mfa or on_login:
            stable_ok = 0
            time.sleep(LOGIN_POLL_SECONDS)
            continue
        if has_messages:
            stable_ok += 1
        else:
            # Logged-in app without messages yet (still loading channel)
            app_shell = any(
                s in body_l
                for s in (
                    "direct messages",
                    "friends",
                    "servers",
                    "text channels",
                    "voice channels",
                )
            )
            stable_ok = stable_ok + 1 if app_shell else 0
        # Require a couple of consecutive clean polls so a flicker off MFA
        # during a failed submit does not close the window.
        if stable_ok >= 2:
            print(f"{SELECTOR_LOG} login+2FA complete (url={url})", flush=True)
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


def _session_looks_authenticated(state: dict[str, Any] | None) -> bool:
    """Reject anonymous / mid-2FA dumps.

    Discord often hides the plain `token` key. A real session still has either
    that token or a MultiAccountStore with at least one user. Lots of localStorage
    keys alone is NOT enough — the MFA page also writes dozens of empty stores.
    """
    if not isinstance(state, dict):
        return False
    origins = state.get("origins") or []
    ls_map = {}
    for origin in origins:
        for item in origin.get("localStorage") or []:
            ls_map[str(item.get("name") or "")] = str(item.get("value") or "")
    token = ls_map.get("token") or ""
    if len(token) > 20:
        return True
    multi = ls_map.get("MultiAccountStore") or ""
    if '"users":[{' in multi.replace(' ', '') or '"users":[ {' in multi:
        return True
    # users array non-empty: "users":[{...}]
    if re.search(r'"users"\s*:\s*\[\s*\{', multi):
        return True
    return False


def _profile_dir_for(session_state_path: str | Path | None) -> Path | None:
    if not session_state_path:
        return None
    sp = Path(session_state_path)
    name = sp.stem.replace("browser_session_", "browser_profile_")
    if name == sp.stem:
        name = sp.stem + "_profile"
    return sp.parent / name


def _save_live_session(context, session_state_path: str | Path | None) -> bool:
    """Write storage_state from the LIVE headed context."""
    if not session_state_path:
        return False
    sp = Path(session_state_path)
    try:
        sp.parent.mkdir(parents=True, exist_ok=True)
        state = context.storage_state()
        sp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        auth = _session_looks_authenticated(state)
        ls_n = sum(len(o.get("localStorage") or []) for o in (state.get("origins") or []))
        print(
            f"{SELECTOR_LOG} saved live session -> {sp} "
            f"(cookies={len(state.get('cookies') or [])}, localStorage_keys={ls_n}, "
            f"authenticated_heuristic={auth})",
            flush=True,
        )
        return auth
    except Exception as exc:
        print(f"{SELECTOR_LOG} failed to save live session: {exc}", file=sys.stderr)
        return False


def _message_locator_count(page) -> int:
    selectors = [
        "li[id^='chat-messages-']",
        "li[id^='message-']",
        "li[data-list-item-id^='chat-messages___']",
        "ol[data-list-id='chat-messages'] li",
    ]
    total = 0
    for sel in selectors:
        try:
            total = max(total, page.locator(sel).count())
        except Exception:
            continue
    return total


def _collect_message_htmls(page) -> list[str]:
    script = """
    () => {
      const sels = [
        "li[id^='chat-messages-']",
        "li[id^='message-']",
        "li[data-list-item-id^='chat-messages___']",
      ];
      const out = [];
      const seen = new Set();
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const id = el.id || el.getAttribute('data-list-item-id') || '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(el.outerHTML);
        }
      }
      return out;
    }
    """
    try:
        return page.evaluate(script) or []
    except Exception as exc:
        print(f"{SELECTOR_LOG} collect html failed: {exc}", file=sys.stderr)
        return []


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

    # Load prior session if available AND it looks authenticated.
    storage_state: dict[str, Any] | None = None
    if session_state_path:
        sp = Path(session_state_path)
        if sp.exists():
            try:
                candidate = json.loads(sp.read_text(encoding="utf-8"))
                if _session_looks_authenticated(candidate):
                    storage_state = candidate
                    print(f"{SELECTOR_LOG} loaded authenticated session from {sp}")
                else:
                    print(
                        f"{SELECTOR_LOG} ignoring unauthenticated session file {sp} "
                        "(will require login, then overwrite with live state)"
                    )
            except Exception as exc:
                print(f"{SELECTOR_LOG} could not parse session {sp}: {exc}; ignoring.",
                      file=sys.stderr)

    result: list[dict[str, Any]] = []
    profile_dir = _profile_dir_for(session_state_path)

    with sync_playwright() as pw:
        context = None
        browser = None
        launch_errors: list[str] = []

        # Prefer a persistent profile so login survives process exit.
        if profile_dir is not None and not headless:
            profile_dir.mkdir(parents=True, exist_ok=True)
            for channel in ("msedge", "chrome", "chromium", None):
                try:
                    kwargs: dict[str, Any] = {
                        "user_data_dir": str(profile_dir),
                        "headless": False,
                        "viewport": {"width": 1400, "height": 900},
                        "args": ["--disable-blink-features=AutomationControlled"],
                    }
                    if channel:
                        kwargs["channel"] = channel
                    context = pw.chromium.launch_persistent_context(**kwargs)
                    print(f"{SELECTOR_LOG} persistent profile via {channel or 'bundled'} at {profile_dir}")
                    break
                except Exception as exc:
                    launch_errors.append(f"persistent/{channel}: {exc}")
                    context = None

        if context is None:
            for channel in ("msedge", "chrome", "chromium", None):
                try:
                    if channel:
                        browser = pw.chromium.launch(channel=channel, headless=headless)
                    else:
                        browser = pw.chromium.launch(headless=headless)
                    context = browser.new_context(
                        storage_state=storage_state,
                        viewport={"width": 1400, "height": 900},
                    )
                    print(f"{SELECTOR_LOG} launched ephemeral context via {channel or 'bundled'}")
                    break
                except Exception as exc:
                    launch_errors.append(f"ephemeral/{channel}: {exc}")
                    browser = None
                    context = None

        if context is None:
            raise RuntimeError(
                "Could not launch a browser for Discord scrape. Tried: "
                + "; ".join(launch_errors[-6:])
            )

        try:
            page = context.pages[0] if context.pages else context.new_page()

            try:
                _retry(lambda: page.goto(url, wait_until="domcontentloaded", timeout=45000))
            except Exception as exc:
                print(f"{SELECTOR_LOG} initial navigation failed: {exc}", file=sys.stderr)

            needs_auth = LOGIN_PATH_FRAGMENT in (page.url or "")
            try:
                body0 = page.evaluate("() => (document.body && document.body.innerText) || ''") or ""
            except Exception:
                body0 = ""
            body0_l = body0.lower()
            if (
                "multi-factor" in body0_l
                or "enter discord auth code" in body0_l
                or ("auth code" in body0_l and "verify" in body0_l)
            ):
                needs_auth = True
            if needs_auth:
                print(f"{SELECTOR_LOG} Not fully logged in (currently at {page.url}).")
                print(f"{SELECTOR_LOG} Complete login AND 2FA in the browser window.")
                if not _wait_for_login(page, login_timeout):
                    print(f"{SELECTOR_LOG} login/2FA timeout after {login_timeout}s", file=sys.stderr)
                    try:
                        debug_path = DEFAULT_SESSION_DIR / "last_discord_page.html"
                        DEFAULT_SESSION_DIR.mkdir(parents=True, exist_ok=True)
                        debug_path.write_text(page.content(), encoding="utf-8")
                        print(f"{SELECTOR_LOG} wrote page dump to {debug_path}")
                    except Exception:
                        pass
                    _save_live_session(context, session_state_path)
                    return []
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                except Exception as exc:
                    print(f"{SELECTOR_LOG} post-login navigation failed: {exc}", file=sys.stderr)

            # Persist immediately after we believe we are past login.
            _save_live_session(context, session_state_path)

            print(f"{SELECTOR_LOG} Waiting for message list to render ...")
            deadline = time.time() + 45
            while time.time() < deadline:
                if _message_locator_count(page) > 0:
                    break
                time.sleep(0.5)
            else:
                print(
                    f"{SELECTOR_LOG} WARNING: no message list items after 45s; "
                    "dumping whatever is on page."
                )
                try:
                    debug_path = DEFAULT_SESSION_DIR / "last_discord_page.html"
                    DEFAULT_SESSION_DIR.mkdir(parents=True, exist_ok=True)
                    debug_path.write_text(page.content(), encoding="utf-8")
                    print(f"{SELECTOR_LOG} wrote page dump to {debug_path}")
                except Exception as exc:
                    print(f"{SELECTOR_LOG} page dump failed: {exc}", file=sys.stderr)

            seen_ids: set[str] = set()
            no_new_runs = 0
            while len(result) < messages and no_new_runs < NO_NEW_SCROLL_LIMIT:
                htmls = _collect_message_htmls(page)
                new_here = 0
                for h in htmls:
                    try:
                        msg = _extract_message_dict(h)
                    except Exception as exc:
                        print(f"{SELECTOR_LOG} parse failed on one element: {exc}", file=sys.stderr)
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
                print(
                    f"{SELECTOR_LOG} accumulated {len(result)} messages "
                    f"(+{new_here} new this batch)"
                )
                no_new_runs = no_new_runs + 1 if new_here == 0 else 0
                if len(result) >= messages:
                    break
                try:
                    page.keyboard.press("PageUp")
                    time.sleep(scroll_pause_ms / 1000.0)
                except Exception as exc:
                    print(f"{SELECTOR_LOG} scroll error: {exc}", file=sys.stderr)
                    break

            # Final save after scrolling (cookies may refresh during use).
            _save_live_session(context, session_state_path)
        finally:
            try:
                context.close()
            except Exception:
                pass
            if browser is not None:
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
