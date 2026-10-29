"""Inventory the videos recorded in state.sqlite.

The downloaded media under data/video_pipeline/ is NOT tracked by git, so
state.sqlite is the only authoritative record of what should be on disk.
Run this to produce a re-download manifest:

    python tools/inventoryLostVideos.py

    python tools/inventoryLostVideos.py --db other.sqlite --out other.json

WHAT THE MANIFEST IS (AND IS NOT)
The catalog's `download_path` is a POINTER, and it goes stale in two ways:

  1. The file it points at was deleted. (The sparse-checkout incident of
     2026-10-21 removed ~215 GB of untracked media.)

  2. It names a file under an OLDER NAMING SCHEME. 324 rows point at
     `downloads_1080p/<video_id>.mp4`; the current convention is
     `downloads_1080p/<upload_date>_<video_id>.mp4`. Those pointers never
     resolve, whatever happened to the media.

So a pointer is NOT evidence that a file is missing, and it is NOT evidence
that a file is present. The only way to answer is to look at the disk.

This tool therefore resolves every pointer and records whether the file is
actually there. The manifest lists the MISSING videos — the re-download
list — and counts the ones that are still on disk.

The previous version listed every row with a pointer (716 of them) and its
note claimed they had all been deleted on 2026-10-21. That was wrong: 179
of them are still on disk, and a further 324 point at filenames that never
existed under that naming scheme. A reader of that manifest could not tell
which videos it actually had to fetch.
"""
import argparse
import collections
import datetime
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite')
OUT = os.path.join(ROOT, 'data', 'qmg_video_recovery_manifest.json')


def resolve_pointer(download_path):
    """Resolve a catalog `download_path` to a local path.

    The column holds absolute paths written on whichever machine did the
    download, and repo-relative paths. An absolute path from another machine
    cannot be resolved here — it simply will not exist, which is the honest
    answer.

    Returns None when there is no pointer at all.
    """
    if not download_path:
        return None
    if os.path.isabs(download_path):
        return os.path.normpath(download_path)
    return os.path.normpath(os.path.join(ROOT, download_path.replace(chr(92), '/')))


def expected_filename(upload_date, video_id):
    """The name the downloader writes today: `<upload_date>_<video_id>.mp4`."""
    return f'{upload_date}_{video_id}.mp4' if upload_date else f'{video_id}.mp4'


def main():
    parser = argparse.ArgumentParser(description='Inventory the videos the catalog records.')
    parser.add_argument('--db', default=DB, help='path to state.sqlite')
    parser.add_argument('--out', default=OUT, help='path to write the manifest to')
    args = parser.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f'No catalog at {args.db}.')

    connection = sqlite3.connect(args.db)
    rows = connection.execute(
        'select video_id, channel, upload_date, download_path, title from videos '
        'where download_path is not null and download_path != ""'
    ).fetchall()
    connection.close()

    by = collections.Counter()
    missing = []
    present = []

    for vid, ch, dt, dp, title in rows:
        norm = dp.replace(chr(92), '/')
        directory = os.path.basename(os.path.dirname(norm))
        pointer_filename = os.path.basename(norm)
        resolved = resolve_pointer(dp)
        on_disk = bool(resolved) and os.path.exists(resolved)
        by[(directory, ch)] += 1

        entry = {
            'video_id': vid,
            'channel': ch,
            'date': dt,
            'dir': directory,
            'filename': pointer_filename,
            # The name the file has TODAY. For the rows written under the
            # older scheme this differs from `filename`, and that difference
            # is why those pointers never resolved.
            'expected_filename': expected_filename(dt, vid),
            'title': (title or '')[:70],
        }

        if on_disk:
            entry['present'] = True
            present.append(entry)
        else:
            entry['present'] = False
            # Why the pointer does not resolve: the file was deleted, or the
            # pointer names a file under an older naming scheme.
            legacy = pointer_filename != entry['expected_filename']
            entry['pointer_uses_legacy_name'] = legacy
            missing.append(entry)

    qullamaggie = [m for m in missing if m['channel'] == 'qullamaggie']
    qullamaggie_present = [m for m in present if m['channel'] == 'qullamaggie']

    print('=== video inventory (from state.sqlite) ===')
    for (directory, channel), count in sorted(by.items()):
        print(f'  {directory:22s} {channel:14s} {count:4d}')
    print(f'rows with a pointer : {len(rows)}')
    print(f'  still on disk     : {len(present)}')
    print(f'  missing           : {len(missing)}')
    print(f'qullamaggie missing : {len(qullamaggie)}')

    manifest = {
        'note': (
            'Videos whose media is not on disk, according to state.sqlite and the '
            'filesystem of the machine that ran this tool, as of the generation date '
            'below. The catalog\'s download_path is a pointer that goes stale: a file '
            'can be deleted, or the pointer can name a file under an older naming '
            'scheme (<video_id>.mp4 instead of <upload_date>_<video_id>.mp4). Both are '
            'recorded as missing here. The videos still on disk are listed under '
            'present_videos, with their count, so the two sets can be told apart — '
            'and so the claim can be checked rather than believed. Regenerate after '
            'moving media between machines. Re-download with the visios client; see '
            'CLAUDE.md for the 39 hardcoded 720p-only IDs and the rate-limit rules.'
        ),
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'total': len(missing),
        'pointer_rows': len(rows),
        'present_count': len(present),
        'qullamaggie_count': len(qullamaggie),
        'qullamaggie_present_count': len(qullamaggie_present),
        'videos': missing,
        'present_videos': present,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
    print(f'wrote {args.out}')

    print('\nfirst 5 qullamaggie to re-download:')
    for entry in qullamaggie[:5]:
        flag = ' (legacy name)' if entry.get('pointer_uses_legacy_name') else ''
        print(f"  {entry['date']} {entry['dir']}/{entry['expected_filename']}  {entry['title']}{flag}")


if __name__ == '__main__':
    main()
