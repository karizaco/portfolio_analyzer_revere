#!/usr/bin/env python3
"""Re-run age-restricted QMG videos with android player client."""
import json, subprocess, time, sys

with open('qmg-dl-20260922_results.json') as f:
    results = json.load(f)

age_ids = [r[0] for r in results if r[2] == 'AGE']
print(f"Retrying {len(age_ids)} videos with android client...")

ok_count = 0
age_count = 0
err_count = 0

for i, vid in enumerate(age_ids):
    args = [
        sys.executable, '-m', 'yt_dlp',
        '-f', '137',
        '--extractor-args', 'youtube:player_client=android',
        '-o', f'data/video_pipeline/downloads_1080p/{vid}.%(ext)s',
        f'https://www.youtube.com/watch?v={vid}'
    ]
    r = subprocess.run(args, capture_output=True, text=True, timeout=90)

    status = (
        'OK' if r.returncode == 0 else
        'AGE' if 'Sign in to confirm your age' in r.stderr else
        'FMT_ERR' if 'Requested format is not available' in r.stderr else
        '403' if 'HTTP Error 403' in r.stderr else
        '500' if 'HTTP Error 500' in r.stderr else
        'DNS' if 'Failed to resolve' in r.stderr else
        'ERR'
    )

    print(f"{status} {vid}")
    if status != 'OK':
        print(f"  {r.stderr[:150].strip()}")

    # Update result
    for res in results:
        if res[0] == vid:
            res[2] = status
            break

    if status == 'OK': ok_count += 1
    elif status == 'AGE': age_count += 1
    else: err_count += 1

    if (i+1) % 20 == 0:
        print(f"\n--- Progress: {i+1}/{len(age_ids)} ---")

    time.sleep(0.5)

with open('qmg-dl-20260922_retry_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f"\n=== DONE ===")
print(f"OK: {ok_count}  AGE: {age_count}  Other errors: {err_count}")
print("Results: qmg-dl-20260922_retry_results.json")
