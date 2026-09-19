"""Pure message-parsing helpers for Discord scrapers.

No Playwright imports; unit-testable offline.  The ``parse_message_element``
function accepts a message HTML fragment and returns a dict matching the schema
``import_jsonl.py`` expects.  ``parse_message_dict`` validates and normalises a
raw dict against ``REQUIRED_MESSAGE_KEYS``.
"""

import re
from datetime import datetime, timezone
from typing import Any

ID_RE = re.compile(r'id="(?:message-id-|message-)(?P<id>[0-9]{17,20})"')
SNOWFLAKE_RE = re.compile(r"[0-9]{17,20}")

REQUIRED_MESSAGE_KEYS = (
    "discord_message_id",
    "author_id",
    "author_name",
    "content",
    "posted_at",
    "edited_at",
    "is_pinned",
    "has_attachments",
)

EMPTY_MESSAGE: dict[str, Any] = {
    "discord_message_id": "",
    "author_id": "",
    "author_name": "",
    "content": "",
    "posted_at": "",
    "edited_at": None,
    "is_pinned": False,
    "has_attachments": False,
}


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


def _first_match(text: str, patterns: list[str]) -> str:
    for pat in patterns:
        m = re.search(pat, text, flags=re.DOTALL)
        if m:
            return (m.group("v") or "").strip()
    return ""


def _strip_tags(fragment: str) -> str:
    """Cheap HTML-to-text — lxml pulls in too much for Discord-sized payloads."""
    if not fragment:
        return ""
    s = re.sub(r"<[^>]+>", " ", fragment)
    for ent, ch in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                    ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(ent, ch)
    return re.sub(r"\s+", " ", s).strip()


def _extract_reply_author(reply_html: str) -> str:
    """Best-effort extract of the replied-to message's author username."""
    if not reply_html:
        return ""
    author = _first_match(reply_html, [
        r'<span[^>]*class="[^"]*username[^"]*"[^>]*>(?P<v>[^<]+)</span>',
    ])
    if author:
        return author
    # Sometimes the reply author is rendered via an aria-label or alt.
    alt = _first_match(reply_html, [
        r'<img[^>]*alt="(?P<v>[^"]+)"[^>]*>',
    ])
    if alt and alt != "Unknown":
        return alt
    return ""


def parse_message_element(html: str) -> dict[str, Any]:
    """Best-effort parse of a Discord message ``<li>`` element."""
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
    has_attachments = ("attachment" in html or "embed" in html
                        or "imageContent" in html)

    reply_ctx = _first_match(html, [
        r'<div[^>]*class="[^"]*repliedMessageContent[^"]*"[^>]*>(?P<v>.*?)</div>',
    ])
    reply_to_snowflake = ""
    if reply_ctx:
        reply_text = _strip_tags(reply_ctx)
        reply_to_snowflake = parse_message_id(reply_ctx)
        reply_author = _extract_reply_author(reply_ctx)
        if reply_author:
            content = f"@replying to {reply_author}: {reply_text} -- {content}"
        else:
            content = f"@replying to (unknown): {reply_text} -- {content}"

    if not content and not has_attachments:
        return dict(EMPTY_MESSAGE)

    posted_iso = parse_iso8601(posted_at)
    edited_iso = parse_iso8601(edited_ts) if edited_ts else ""

    return {
        "discord_message_id": msg_id,
        "author_id": author_id,
        "author_name": author_name,
        "content": content or "[embed-only]",
        "posted_at": posted_iso,
        "edited_at": edited_iso or None,
        "is_pinned": pinned,
        "has_attachments": has_attachments,
        "snowflake": msg_id,
        "author_name_enriched": author_name,
        "content_text": content or "[embed-only]",
        "timestamp_iso": posted_iso,
        "edited": edited_iso,
        "reply_to_snowflake": reply_to_snowflake,
    }


def parse_message_dict(raw_dict: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalise a raw message dict against REQUIRED_MESSAGE_KEYS."""
    result = dict(EMPTY_MESSAGE)
    result.update({k: v for k, v in raw_dict.items() if v is not None})
    missing = [k for k in REQUIRED_MESSAGE_KEYS if k not in result]
    for k in missing:
        result[k] = EMPTY_MESSAGE[k]
    if not result["discord_message_id"]:
        raise ValueError("parse_message_dict: discord_message_id is empty")
    return result
