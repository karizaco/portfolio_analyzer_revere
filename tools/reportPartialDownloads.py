"""Report the orphan `.part` files in the download directories.

A `.part` file is yt-dlp's name for a download in progress. One that is
still growing means a download is running; one that stopped growing means
the download was killed and left the partial file behind.

This REPORTS. It does not delete: a partial file may be the only copy of
a download that is worth resuming, and whether to reclaim the space is the
maintainer's decision.

Usage:
    py -3 tools/reportPartialDownloads.py
    py -3 tools/reportPartialDownloads.py --json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite')
PIPELINE = os.path.join(ROOT, 'data', 'video_pipeline')

DOWNLOAD_DIRS = ('downloads_1080p', 'downloads_hires', 'downloads')


def find_rows():
    if not os.path.exists(DB):
        return {}
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = {
        r['video_id']: dict(r)
        for r in conn.execute(
            'select video_id, channel, upload_date, title, status, download_path '
            'from videos'
        )
    }
    conn.close()
    return rows


def video_id_of(filename):
    """`20220217_9uhm2AUgiOs.mp4.part` -> `9uhm2AUgiOs`."""
    base = filename
    for suffix in ('.mp4.part', '.part'):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if '_' in base:
        head, _, tail = base.partition('_')
        if head.isdigit() and len(head) == 8:
            return tail
    return base


def candidate_ids(video_id):
    """The forms a video id can take in a file name.

    A September 2026 download run named its partial files `<_id>.mp4.part`,
    with an underscore prepended to the id. So a file called
    `_Vn-EBl95hes.mp4.part` is the video `Vn-EBl95hes`, and a file called
    `__2urSPdZVec.mp4.part` is the video `_2urSPdZVec` -- whose own id
    starts with an underscore. Both forms have to be tried when a file is
    matched against the catalog.
    """
    forms = [video_id]
    if video_id.startswith('_'):
        forms.append(video_id[1:])
    else:
        forms.append('_' + video_id)
    return forms


def relative_path(full_path):
    """A path relative to the repository root, when it is inside it."""
    if not full_path:
        return full_path
    normalised = full_path.replace('\\', '/')
    marker = 'portfolio_analyzer_revere/'
    index = normalised.lower().find(marker.lower())
    if index >= 0:
        return normalised[index + len(marker):]
    return normalised


def lookup_row(rows, video_id):
    for form in candidate_ids(video_id):
        row = rows.get(form)
        if row:
            return row, form
    return None, video_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args()

    rows = find_rows()
    report = []
    total_bytes = 0

    for name in DOWNLOAD_DIRS:
        directory = os.path.join(PIPELINE, name)
        if not os.path.isdir(directory):
            continue
        for entry in sorted(os.listdir(directory)):
            if not entry.endswith('.part'):
                continue
            full = os.path.join(directory, entry)
            size = os.path.getsize(full)
            mtime = os.path.getmtime(full)
            vid = video_id_of(entry)
            row, matched_id = lookup_row(rows, vid)

            # Is there a COMPLETED copy of this video next to the partial one?
            stem = entry[: -len('.part')]
            complete = None
            for candidate in (stem, f'{stem[:-4]}.mp4' if stem.endswith('.mp4') else stem):
                probe = os.path.join(directory, candidate)
                if os.path.exists(probe):
                    complete = probe
                    break
            if complete is None and row and row.get('download_path'):
                probe = row['download_path'].replace('\\', '/')
                if not os.path.isabs(probe):
                    probe = os.path.join(ROOT, probe)
                if os.path.exists(probe):
                    complete = probe

            total_bytes += size
            report.append({
                'directory': name,
                'file': entry,
                'video_id': vid,
                'catalog_video_id': matched_id if row else None,
                'size_bytes': size,
                'size_mb': round(size / (1024 * 1024), 1),
                'last_modified': datetime.fromtimestamp(mtime, timezone.utc)
                    .replace(microsecond=0).isoformat(),
                'age_days': round((datetime.now(timezone.utc).timestamp() - mtime) / 86400, 1),
                'in_catalog': bool(row),
                'channel': row.get('channel') if row else None,
                'upload_date': row.get('upload_date') if row else None,
                'catalog_status': row.get('status') if row else None,
                'completed_copy_exists': bool(complete),
                'completed_copy': relative_path(complete) if complete else None,
            })

    if args.json:
        print(json.dumps({
            'partial_files': len(report),
            'total_bytes': total_bytes,
            'total_gb': round(total_bytes / (1024 ** 3), 2),
            'files': report,
        }, indent=2))
        return 0

    resumable = [r for r in report if not r['completed_copy_exists']]
    superseded = [r for r in report if r['completed_copy_exists']]
    in_catalog = [r for r in report if r['in_catalog']]
    not_in_catalog = [r for r in report if not r['in_catalog']]

    print('=== PARTIAL DOWNLOADS IN THE PIPELINE DIRECTORIES ===')
    print(f'files: {len(report)}   total: {total_bytes / (1024 ** 3):.2f} GiB')
    print(f'  in the catalog:            {len(in_catalog)}')
    print(f'  not in the catalog:        {len(not_in_catalog)}')
    print(f'  a completed copy exists:   {len(superseded)}   (the partial file is redundant)')
    print(f'  no completed copy exists:  {len(resumable)}   (the partial file is all there is)')
    print()

    # The same download, attempted twice: yt-dlp truncated the leading
    # underscore of a Qullamaggie id in one attempt and not in the other.
    groups = {}
    for r in report:
        key = r['video_id'].lstrip('_')
        groups.setdefault(key, []).append(r)
    duplicates = {k: v for k, v in groups.items() if len(v) > 1}
    if duplicates:
        print('--- THE SAME VIDEO, PARTIAL FILES TWICE (a leading-underscore id, truncated '
              'and not) ---')
        for key, members in sorted(duplicates.items()):
            print(f'  {key}:')
            for m in sorted(members, key=lambda x: -x['size_bytes']):
                print(f'      {m["size_mb"]:>8.1f} MB  {m["file"]}')
        print()

    print('--- NO COMPLETED COPY: these are the only copy of the download ---')
    for r in sorted(resumable, key=lambda x: -x['size_bytes']):
        print(f'  {r["size_mb"]:>8.1f} MB  {r["last_modified"]}  {r["directory"]}/{r["file"]}')
        print(f'             catalog: {"yes (" + str(r["catalog_video_id"]) + ")" if r["in_catalog"] else "NO -- not in the catalog"}'
              f'  channel: {r["channel"]}  date: {r["upload_date"]}  status: {r["catalog_status"]}')
    print()
    print('--- A COMPLETED COPY EXISTS: the partial file is redundant ---')
    for r in sorted(superseded, key=lambda x: -x['size_bytes']):
        print(f'  {r["size_mb"]:>8.1f} MB  {r["last_modified"]}  {r["directory"]}/{r["file"]}')
        print(f'             completed copy: {r["completed_copy"]}')
    print()
    print('Nothing was deleted. Reclaiming the space is a separate, deliberate step.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
