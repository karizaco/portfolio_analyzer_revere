#!/usr/bin/env python3
"""Dump the catalog's upload_date for every video in state.sqlite.

`data/video_pipeline/state.sqlite` is the authoritative record of what should be
on disk, including each video's real `upload_date` (742/742 rows populated).
Node has no SQLite driver in this project, so this script exports the one
column the date tools need to JSON:

    { "<video_id>": "<YYYYMMDD>" }

Usage:
    py -3 tools/dumpUploadDates.py
    py -3 tools/dumpUploadDates.py --out data/qmg_upload_dates.json
"""

import argparse
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, "data", "video_pipeline", "state.sqlite")
DEFAULT_OUT = os.path.join(ROOT, "data", "qmg_upload_dates.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("missing database: %s" % args.db, file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    try:
        rows = conn.execute(
            "SELECT video_id, upload_date, channel FROM videos "
            "WHERE upload_date IS NOT NULL AND upload_date != ''"
        ).fetchall()
    finally:
        conn.close()

    dates = {}
    by_channel = {}
    for video_id, upload_date, channel in rows:
        if len(upload_date) != 8 or not upload_date.isdigit():
            continue
        dates[video_id] = upload_date
        by_channel[channel] = by_channel.get(channel, 0) + 1

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(dates, fh, indent=1, sort_keys=True)

    print("[upload-dates] %d videos -> %s" % (len(dates), os.path.relpath(args.out, ROOT)))
    for channel, n in sorted(by_channel.items()):
        print("[upload-dates]   %s: %d" % (channel, n))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
