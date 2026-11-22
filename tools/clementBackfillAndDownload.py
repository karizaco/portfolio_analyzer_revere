"""Backfill clement Discord history + download image attachments."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "video_pipeline" / "state.sqlite"
MEDIA_DIR = ROOT / "data" / "discord_pipeline" / "media" / "clement"
SOURCE = "clement"
CHANNEL = "1377847455621713980"
# Aim high; stop when channel exhausted
MAX_MESSAGES = 5000
SLEEP = 0.75

def load_token() -> str:
    env = ROOT / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("DISCORD_USER_TOKEN=") and not line.strip().startswith("#"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DISCORD_USER_TOKEN missing from .env")

TICKER_RE = re.compile(r"(?<![A-Z])\$?([A-Z]{2,5})(?![A-Z])")

def is_image(att: dict) -> bool:
    ct = (att.get("content_type") or "").lower()
    name = (att.get("filename") or "").lower()
    if ct.startswith("image/"):
        return True
    return name.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"))

def ext_for(att: dict) -> str:
    name = att.get("filename") or ""
    suffix = Path(name).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
        return suffix
    ct = (att.get("content_type") or "").lower()
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }.get(ct, ".bin")

def main() -> int:
    token = load_token()
    headers = {
        "Authorization": token,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Content-Type": "application/json",
    }
    me = requests.get("https://discord.com/api/v9/users/@me", headers=headers, timeout=30)
    print("auth", me.status_code, (me.json() or {}).get("username") if me.ok else me.text[:120])
    if me.status_code != 200:
        return 1

    # --- fetch all messages ---
    messages: list[dict] = []
    before = None
    while len(messages) < MAX_MESSAGES:
        params = {"limit": 100}
        if before:
            params["before"] = before
        r = requests.get(
            f"https://discord.com/api/v9/channels/{CHANNEL}/messages",
            headers=headers,
            params=params,
            timeout=45,
        )
        if r.status_code == 429:
            retry = float(r.headers.get("Retry-After") or r.json().get("retry_after") or 5)
            print(f"rate-limited, sleep {retry}s")
            time.sleep(retry + 0.5)
            continue
        if r.status_code != 200:
            print("fetch fail", r.status_code, r.text[:300])
            break
        batch = r.json()
        print(f"batch {len(batch)} total_so_far {len(messages)+len(batch)} before={before}")
        if not batch:
            break
        messages.extend(batch)
        before = batch[-1]["id"]
        if len(batch) < 100:
            break
        time.sleep(SLEEP)

    print("fetched_messages", len(messages))
    if not messages:
        return 1

    # --- import ---
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    source_id = conn.execute("SELECT id FROM discord_sources WHERE name=?", (SOURCE,)).fetchone()["id"]
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    imported = skipped = 0
    newest = "0"
    oldest = messages[-1]["id"]
    for msg in messages:
        mid = str(msg["id"])
        if int(mid) > int(newest):
            newest = mid
        content = msg.get("content") or ""
        author = msg.get("author") or {}
        tickers = list({m for m in TICKER_RE.findall(content.upper())})
        cur = conn.execute(
            """INSERT OR IGNORE INTO discord_messages
               (source_id, discord_message_id, author_id, author_name, content, posted_at,
                ingested_at, has_tickers, ticker_list, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                source_id,
                mid,
                str(author.get("id") or "0"),
                str(author.get("username") or "unknown"),
                content,
                msg.get("timestamp") or "",
                now,
                1 if tickers else 0,
                ",".join(tickers),
                json.dumps(msg, ensure_ascii=False),
            ),
        )
        if cur.rowcount:
            imported += 1
        else:
            skipped += 1
            # refresh raw_json so attachments stay current even on known rows
            conn.execute(
                "UPDATE discord_messages SET raw_json=?, content=?, author_name=? WHERE discord_message_id=?",
                (
                    json.dumps(msg, ensure_ascii=False),
                    content,
                    str(author.get("username") or "unknown"),
                    mid,
                ),
            )
    conn.execute(
        "UPDATE discord_sources SET last_message_id=?, last_run_at=? WHERE id=?",
        (newest, now, source_id),
    )
    conn.execute(
        """INSERT INTO discord_pipeline_runs
           (source_id, run_tag, started_at, finished_at, fetched_count, new_count, error)
           VALUES (?,?,?,?,?,?,NULL)""",
        (source_id, "clement-full-backfill", now, now, len(messages), imported),
    )
    conn.commit()
    print("import", {"imported": imported, "updated_existing": skipped, "newest": newest, "oldest": oldest})
    print(
        "db_total",
        conn.execute("SELECT COUNT(*) FROM discord_messages WHERE source_id=?", (source_id,)).fetchone()[0],
    )
    print(
        "db_range",
        tuple(
            conn.execute(
                "SELECT MIN(posted_at), MAX(posted_at) FROM discord_messages WHERE source_id=?",
                (source_id,),
            ).fetchone()
        ),
    )

    # --- download images ---
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = MEDIA_DIR / "manifest.jsonl"
    # load already-downloaded attachment ids
    have = set()
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                have.add(json.loads(line)["attachment_id"])
            except Exception:
                pass

    dl_ok = dl_skip = dl_fail = 0
    image_msgs = 0
    with manifest_path.open("a", encoding="utf-8") as man:
        for msg in messages:
            atts = [a for a in (msg.get("attachments") or []) if is_image(a)]
            if not atts:
                continue
            image_msgs += 1
            posted = (msg.get("timestamp") or "")[:10].replace("-", "") or "unknown"
            for a in atts:
                aid = str(a.get("id") or "")
                if not aid:
                    continue
                if aid in have:
                    dl_skip += 1
                    continue
                url = a.get("url") or a.get("proxy_url")
                if not url:
                    dl_fail += 1
                    continue
                ext = ext_for(a)
                fname = f"{posted}_{msg['id']}_{aid}{ext}"
                dest = MEDIA_DIR / fname
                try:
                    req = urllib.request.Request(
                        url,
                        headers={
                            "User-Agent": "Mozilla/5.0",
                            # CDN often works without auth; if not, Authorization may help
                            "Authorization": token,
                        },
                    )
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        data = resp.read()
                        ct = resp.headers.get("Content-Type", "")
                    dest.write_bytes(data)
                    md5 = hashlib.md5(data).hexdigest()
                    rec = {
                        "attachment_id": aid,
                        "message_id": str(msg["id"]),
                        "posted_at": msg.get("timestamp"),
                        "author": (msg.get("author") or {}).get("username"),
                        "filename_orig": a.get("filename"),
                        "content_type": a.get("content_type") or ct,
                        "width": a.get("width"),
                        "height": a.get("height"),
                        "size": a.get("size") or len(data),
                        "local_path": str(dest.relative_to(ROOT)).replace("\\", "/"),
                        "md5": md5,
                        "caption": msg.get("content") or "",
                        "downloaded_at": now,
                    }
                    man.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    man.flush()
                    have.add(aid)
                    dl_ok += 1
                    print("DL", dest.name, f"{a.get('width')}x{a.get('height')}", len(data), "bytes")
                    time.sleep(0.25)
                except Exception as exc:
                    dl_fail += 1
                    print("FAIL", aid, type(exc).__name__, exc)

    print(
        "download_summary",
        {
            "image_messages": image_msgs,
            "downloaded": dl_ok,
            "skipped_existing": dl_skip,
            "failed": dl_fail,
            "media_dir": str(MEDIA_DIR),
            "files_on_disk": len(list(MEDIA_DIR.glob('*.*'))) - (1 if manifest_path.exists() else 0),
        },
    )
    conn.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
