"""Inventory the videos recorded in state.sqlite.

The downloaded media under data/video_pipeline/ is NOT tracked by git, so
state.sqlite is the only authoritative record of what should be on disk.
Run this to produce a re-download manifest:

    python tools/inventoryLostVideos.py
"""
import sqlite3, os, collections, json

DB = os.path.join('data', 'video_pipeline', 'state.sqlite')
c = sqlite3.connect(DB)
rows = c.execute(
    'select video_id, channel, upload_date, download_path, title from videos '
    'where download_path is not null and download_path != ""'
).fetchall()

by = collections.Counter()
manifest = []
for vid, ch, dt, dp, title in rows:
    norm = dp.replace(chr(92), '/')
    d = os.path.dirname(norm)
    fname = os.path.basename(norm)
    by[(os.path.basename(d), ch)] += 1
    manifest.append({
        'video_id': vid, 'channel': ch, 'date': dt,
        'dir': os.path.basename(d), 'filename': fname, 'title': (title or '')[:70]
    })

print('=== lost video inventory (from recovered state.sqlite) ===')
for (d, ch), n in sorted(by.items()):
    print(f'  {d:22s} {ch:14s} {n:4d}')
print('TOTAL', len(rows))

qm = [m for m in manifest if m['channel'] == 'qullamaggie']
print(f'\nqullamaggie videos to re-download: {len(qm)}')
os.makedirs('data', exist_ok=True)
with open('data/qmg_video_recovery_manifest.json', 'w', encoding='utf-8') as f:
    json.dump({
        'note': ('Videos deleted from data/video_pipeline/ on 2026-10-21. '
                 'Re-download with the visios client; see CLAUDE.md for the '
                 '39 hardcoded 720p-only IDs and the rate-limit rules.'),
        'total': len(manifest),
        'qullamaggie_count': len(qm),
        'videos': manifest,
    }, f, indent=2)
print('wrote data/qmg_video_recovery_manifest.json')
print('\nfirst 5 qullamaggie:')
for m in qm[:5]:
    print(f"  {m['date']} {m['dir']}/{m['filename']}  {m['title']}")
