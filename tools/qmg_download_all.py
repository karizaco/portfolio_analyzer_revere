#!/usr/bin/env python3
"""
Parallel QMG 1080p downloader — all pending videos, 4 workers.
Skips age-restricted and bot-detected gracefully.
"""
import subprocess, os, sys, sqlite3, json
from concurrent.futures import ThreadPoolExecutor, as_completed

DB = 'data/video_pipeline/state.sqlite'
VIDEO_DIR = 'data/video_pipeline/downloads_1080p'
WORKERS = 4
YT_DLP = [sys.executable, '-m', 'yt_dlp']
RUN_TAG = 'qmg-dl-20260922'

os.makedirs(VIDEO_DIR, exist_ok=True)

def get_pending():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("SELECT video_id, title, upload_date FROM videos WHERE channel='qullamaggie' ORDER BY upload_date")
    rows = cur.fetchall()
    conn.close()

    disk = {f.rsplit('_', 1)[1].replace('.mp4', '') for f in os.listdir(VIDEO_DIR) if f.endswith('.mp4')}
    pending = [(r[0], r[1], r[2]) for r in rows if r[0] not in disk]
    return pending

def download_one(vid, title, date):
    url = f'https://www.youtube.com/watch?v={vid}'
    out = os.path.join(VIDEO_DIR, f'{date}_{vid}.%(ext)s')
    cmd = YT_DLP + [
        '--no-playlist', '-f', '137',
        '-o', out,
        '--quiet', '--no-warnings',
        '--extractor-args', 'youtube:player_client=visionos',
        url
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode == 0:
            # Rename .part if needed
            part = os.path.join(VIDEO_DIR, f'{date}_{vid}.part')
            if os.path.exists(part):
                ext = 'mp4'
                final = os.path.join(VIDEO_DIR, f'{date}_{vid}.{ext}')
                if os.path.exists(final):
                    os.remove(part)
                else:
                    os.rename(part, final)
            return (vid, date, 'OK', '')
        # Check stderr for age restriction
        err = result.stderr or ''
        if 'age' in err.lower() or 'sign in to confirm your age' in err.lower():
            return (vid, date, 'AGE', err[-200:])
        if 'reloaded' in err.lower() or 'captcha' in err.lower():
            return (vid, date, 'BOT', err[-200:])
        return (vid, date, 'ERR', err[-300:])
    except subprocess.TimeoutExpired:
        return (vid, date, 'TIMEOUT', '')
    except Exception as e:
        return (vid, date, 'EXC', str(e))

pending = get_pending()
print(f'Pending downloads: {len(pending)}')

done, age, bot, err, skip = 0, 0, 0, 0, 0
results = []

with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    futures = {ex.submit(download_one, v[0], v[1], v[2]): v for v in pending}
    for future in as_completed(futures):
        vid, date, status, info = future.result()
        results.append((vid, date, status))
        if status == 'OK':
            done += 1
        elif status == 'AGE':
            age += 1
        elif status == 'BOT':
            bot += 1
        elif status == 'ERR':
            err += 1
            print(f'\nERR {date} {vid}: {info[:150]}', flush=True)
        else:
            skip += 1

        total = done + age + bot + err + skip
        if total % 20 == 0 or total == len(pending):
            print(f'Progress: {done} OK  {age} age-restricted  {bot} bot  {err} err ({total}/{len(pending)})', flush=True)

print(f'\n=== DONE ===')
print(f'OK: {done}  age-restricted: {age}  bot-detected: {bot}  error: {err}')
print(f'Saved to: {VIDEO_DIR}')
# Save results
with open(f'{RUN_TAG}_results.json', 'w') as f:
    json.dump(results, f)
print(f'Results: {RUN_TAG}_results.json')
