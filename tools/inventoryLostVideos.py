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

  2. It names a file under an OLDER NAMING SCHEME. 514 rows point at
     `downloads_1080p/<video_id>.mp4`; the current convention is
     `downloads_1080p/<upload_date>_<video_id>.mp4`. Those pointers never
     resolve, whatever happened to the media.

So a pointer is NOT evidence that a file is missing, and it is NOT evidence
that a file is present. The only way to answer is to look at the disk.

This tool therefore asks the disk TWO questions for every row, because there
are two ways a row's media can be found:

  1. Does the pointer resolve to a real file?
  2. Does a file named the way the downloader writes it —
     `<upload_date>_<video_id>.mp4` — exist in one of the download
     directories?

The second question is the one the pointer-only version of this tool did not
ask, and it is not a rare case: a video can be on disk with no pointer
naming it. Asking only the first question put two videos whose media IS on
disk (`bEidyFtV-lY`, `M0pV73RV2qo`) into the re-download list, which
contradicted this tool's own principle. The two-question rule is the one
`tools/reconcileCatalogStatus.js` and `src/video/downloadCandidates.js`
already use; this tool now uses the same one.

The manifest lists the MISSING videos — the re-download list — and counts the
ones that are still on disk.

The previous version listed every row with a pointer (716 of them) and its
note claimed they had all been deleted on 2026-10-21. That was wrong: 179
of them are still on disk, and a further 514 point at filenames that never
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

# The directories a download writes into, under data/video_pipeline/. The
# first is the historical 720p directory; the second is where the hires
# batch lands; the third is the 1080p directory. A file can be in any of them.
DOWNLOAD_DIRS = ('downloads', 'downloads_hires', 'downloads_1080p')

# Where those directories live, relative to the repository root.
MEDIA_ROOT = os.path.join('data', 'video_pipeline')

# A download smaller than this is a truncated file, not a video.
MIN_FILE_BYTES = 1024 * 1024


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


def is_real_file(candidate):
    """Is this a video file, rather than a truncated download?

    A file smaller than a megabyte is a truncated download, not a video, so
    it does not count as present. The same rule is used by
    `tools/reconcileCatalogStatus.js` and `src/video/downloadCandidates.js`.
    """
    if not candidate or not os.path.exists(candidate):
        return False
    try:
        return os.path.getsize(candidate) > MIN_FILE_BYTES
    except OSError:
        return False


def locate_media(upload_date, video_id, download_path, media_root=None):
    """Where this row's media is, if it is on disk at all.

    Two answers, and both are checked: the pointer the catalog holds, and the
    name the downloader itself writes. The second is what finds a file that
    is on disk with no pointer naming it.

    Returns (found_path, found_by) where found_by is 'pointer', 'own_name',
    or None when the media is not on disk.
    """
    pointer = resolve_pointer(download_path)
    if is_real_file(pointer):
        return pointer, 'pointer'

    root = media_root or os.path.join(ROOT, MEDIA_ROOT)
    own_name = expected_filename(upload_date, video_id)
    for directory in DOWNLOAD_DIRS:
        candidate = os.path.join(root, directory, own_name)
        if is_real_file(candidate):
            return candidate, 'own_name'

    return None, None



def portable_media_path(path):
    """A path inside the repository is stored relative to its root.

    A path outside it keeps its absolute form — there is no honest relative
    form for a file that lives somewhere else entirely. This is the same rule
    the catalog's pointers follow (`portable_stored_path()` in
    `tools/whiteboard_worker.py`, `toPortablePath()` in
    `src/video/downloadCandidates.js`).
    """
    if not path:
        return path
    relative = os.path.relpath(path, ROOT)
    if relative.startswith('..') or os.path.isabs(relative):
        return os.path.normpath(path)
    return relative.replace(os.sep, '/')


def main():
    parser = argparse.ArgumentParser(description='Inventory the videos the catalog records.')
    parser.add_argument('--db', default=DB, help='path to state.sqlite')
    parser.add_argument('--out', default=OUT, help='path to write the manifest to')
    parser.add_argument('--media-root', default=os.path.join(ROOT, MEDIA_ROOT),
                        help='the directory the download directories live under')
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
        found_path, found_by = locate_media(dt, vid, dp, args.media_root)
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

        if found_path:
            entry['present'] = True
            # WHICH of the two questions found it. 'own_name' means the
            # pointer is stale and the media is on disk under the name the
            # downloader writes — the case a pointer-only inventory missed.
            entry['found_by'] = found_by
            entry['media_path'] = portable_media_path(found_path)
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
    found_by_own_name = [p for p in present if p.get('found_by') == 'own_name']

    print('=== video inventory (from state.sqlite) ===')
    for (directory, channel), count in sorted(by.items()):
        print(f'  {directory:22s} {channel:14s} {count:4d}')
    print(f'rows with a pointer : {len(rows)}')
    print(f'  still on disk     : {len(present)}')
    print(f'    found by pointer: {len(present) - len(found_by_own_name)}')
    print(f'    found by own name: {len(found_by_own_name)}')
    print(f'  missing           : {len(missing)}')
    print(f'qullamaggie missing : {len(qullamaggie)}')
    if found_by_own_name:
        print('media on disk that no pointer names:')
        for entry in found_by_own_name:
            print(f"  {entry['video_id']}  {entry['media_path']}")

    manifest = {
        'note': (
            'Videos whose media is not on disk, according to state.sqlite and the '
            'filesystem of the machine that ran this tool, as of the generation date '
            'below. The catalog\'s download_path is a pointer that goes stale: a file '
            'can be deleted, or the pointer can name a file under an older naming '
            'scheme (<video_id>.mp4 instead of <upload_date>_<video_id>.mp4). Both are '
            'recorded as missing here. The videos still on disk are listed under '
            'present_videos, with their count, so the two sets can be told apart — '
            'and so the claim can be checked rather than believed. Each present '
            'entry records whether it was found by its pointer (found_by: pointer) '
            'or by the name the downloader writes (found_by: own_name) — a file can '
            'be on disk with no pointer naming it. Regenerate after moving media '
            'between machines. Re-download with the visios client; see CLAUDE.md for '
            'the 39 hardcoded 720p-only IDs and the rate-limit rules. '
            'tools/reconcileCatalogStatus.js reports the media that has no pointer '
            'naming it and reconciles the status column against the filesystem.'
        ),
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'total': len(missing),
        'pointer_rows': len(rows),
        'present_count': len(present),
        'present_by_own_name_count': len(found_by_own_name),
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
