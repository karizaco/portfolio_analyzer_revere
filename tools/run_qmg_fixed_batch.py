#!/usr/bin/env python3
"""
Parallel QMG 1080p OCR scan with the fixed preprocessing pipeline.
Runs N workers scanning videos from data/video_pipeline/downloads_1080p/.
"""
import subprocess, os, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

VIDEO_DIR = 'data/video_pipeline/downloads_1080p'
OUTPUT_ROOT = 'data/video_ocr_probe'
RUN_TAG = 'qmg-fixed-20260921c'
WORKERS = 4

# Load all MP4 files from the directory
files = sorted(f for f in os.listdir(VIDEO_DIR) if f.endswith('.mp4'))
print(f'Found {len(files)} MP4 files in {VIDEO_DIR}')

# Parse date and video_id from filename (format: YYYYMMDD_videoId.mp4)
videos = []
for filename in files:
    base = filename.replace('.mp4', '')
    parts = base.split('_', 1)
    if len(parts) == 2:
        date, vid = parts
        videos.append({
            'date': date,
            'vid': vid,
            'path': os.path.join(VIDEO_DIR, filename)
        })

print(f'Parsed {len(videos)} videos')

def scan_video(v):
    """Run scanVideoWithOcr.js for one video. Returns (date, success, stdout_stderr)."""
    cmd = [
        'node',
        'tools/scanVideoWithOcr.js',
        '--video', v['path'],
        '--date', v['date'],
        '--output-kind', 'snapshot',
        '--prefilter-profile', 'chart_stream',
        '--chart-stream-parser',
        '--basename', 'qmg',
        '--output-root', OUTPUT_ROOT,
        '--run-tag', RUN_TAG,
        '--max-captures', '3',
        '--fps', '0.25'
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        return (v['date'], result.returncode == 0, result.stdout[-200:] + result.stderr[-200:])
    except subprocess.TimeoutExpired:
        return (v['date'], False, 'TIMEOUT')
    except Exception as e:
        return (v['date'], False, str(e))

done = 0
errors = 0
ok_dates = []

with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    futures = {ex.submit(scan_video, v): v for v in videos}
    for future in as_completed(futures):
        v = futures[future]
        date, success, info = future.result()
        if success:
            done += 1
            ok_dates.append(date)
        else:
            errors += 1
            print(f'\nERR {date}: {info[:150]}', flush=True)

        total = done + errors
        if total % 10 == 0 or total == len(videos):
            print(f'Progress: {done} OK, {errors} ERR ({total}/{len(videos)})', flush=True)

print(f'\n=== DONE: {done} OK, {errors} ERR out of {len(videos)} videos ===')
if ok_dates:
    print(f'Success rate: {100*done/len(videos):.1f}%')