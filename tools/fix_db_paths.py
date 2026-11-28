import sqlite3, os

c = sqlite3.connect('data/video_pipeline/state.sqlite')
c.row_factory = sqlite3.Row

# Find all rows where download_path points to downloads_hires
hires = c.execute("SELECT video_id, upload_date, download_path FROM videos WHERE download_path LIKE '%downloads_hires%' AND channel='qullamaggie'").fetchall()
print(f'Rows pointing to downloads_hires: {len(hires)}')

fixed = 0
for r in hires:
    vid = r['video_id']
    dp = r['download_path']
    if dp and 'downloads_hires' in dp:
        new_path = dp.replace('downloads_hires', 'downloads_1080p')
        # Try various path separators
        for sep in ['/', '\\']:
            check = new_path.replace('/', sep)
            if os.path.exists(check):
                c.execute('UPDATE videos SET download_path=? WHERE video_id=?', (new_path, vid))
                print(f'  Fixed: {vid}: {dp} -> {new_path}')
                fixed += 1
                break
        else:
            print(f'  No 1080p file for: {vid}: {dp}')

print(f'Fixed: {fixed}')
c.commit()
