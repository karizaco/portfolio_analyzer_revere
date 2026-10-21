"""
Reset the SQLite rows for videos whose media was destroyed on 2026-10-21.

The `videos` table still points at the mp4 paths that were inside the git
working tree. Those files no longer exist, so the stale `download_path` makes
the downloader skip them (it filters on
`download_path NOT LIKE '%downloads_1080p%'`), and the `scanning`/`done`
status makes it skip them too.

This script clears `download_path` and sets `status='pending'` for an explicit
list of video_ids, writing the previous values to a JSON manifest first so the
change is reversible and auditable.

Usage:
    python tools/resetLostVideoRows.py --ids id1,id2,... [--manifest data/_lost_rows.json]
    python tools/resetLostVideoRows.py --manifest data/_lost_rows.json --restore
"""

import argparse
import json
import os
import sqlite3
import sys

DB_PATH = 'data/video_pipeline/state.sqlite'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', help='comma-separated video_ids to reset')
    ap.add_argument('--manifest', default='data/_lost_rows_manifest.json',
                    help='path to the manifest of previous values')
    ap.add_argument('--restore', action='store_true',
                    help='restore the previous values recorded in the manifest')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        sys.exit(f'no SQLite at {DB_PATH}')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    if args.restore:
        if not os.path.exists(args.manifest):
            sys.exit(f'no manifest at {args.manifest}')
        with open(args.manifest, encoding='utf-8') as fh:
            entries = json.load(fh)
        for e in entries:
            conn.execute(
                'UPDATE videos SET download_path=?, status=?, error=? WHERE video_id=?',
                (e['download_path'], e['status'], e['error'], e['video_id']))
        conn.commit()
        print(f'restored {len(entries)} rows')
        conn.close()
        return

    if not args.ids:
        sys.exit('--ids is required unless --restore is given')

    ids = [i.strip() for i in args.ids.split(',') if i.strip()]
    q = ','.join('?' * len(ids))
    rows = conn.execute(
        f'SELECT video_id, channel, status, download_path, error FROM videos '
        f'WHERE video_id IN ({q})', ids).fetchall()

    missing = sorted(set(ids) - {r['video_id'] for r in rows})
    if missing:
        print(f'WARN: {len(missing)} id(s) not in catalog: {missing[:5]}')

    entries = []
    for r in rows:
        entries.append({
            'video_id': r['video_id'],
            'channel': r['channel'],
            'status': r['status'],
            'download_path': r['download_path'],
            'error': r['error'],
        })

    if args.dry_run:
        for e in entries:
            print(f"  {e['video_id']:14s} {e['status']:9s} {e['download_path']}")
        print(f'dry run: would reset {len(entries)} rows')
        conn.close()
        return

    with open(args.manifest, 'w', encoding='utf-8') as fh:
        json.dump(entries, fh, indent=2)

    for e in entries:
        conn.execute(
            "UPDATE videos SET download_path='', status='pending', error='' WHERE video_id=?",
            (e['video_id'],))
    conn.commit()

    print(f'reset {len(entries)} rows to status=pending, download_path=""')
    print(f'manifest written to {args.manifest}')
    conn.close()


if __name__ == '__main__':
    main()
