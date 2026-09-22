#!/usr/bin/env python3
"""Re-run QMG SABR-blocked videos using YouTube cookies from Firefox private mode."""
import json, subprocess, time, sys, os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
COOKIES = APP_ROOT / "youtube_cookies.txt"
OUT_DIR = APP_ROOT / "data" / "video_pipeline" / "downloads_1080p"
DB = APP_ROOT / "data" / "video_pipeline" / "state.sqlite"

# Load the retry results (has correct FMT_ERR vs AGE breakdown)
with open('qmg-dl-20260922_retry_results.json') as f:
    results = json.load(f)

# Videos that are SABR-blocked (need cookies)
fmt_err_ids = [r[0] for r in results if r[2] == 'FMT_ERR']
# Truly age-restricted (cookies won't help)
age_ids = [r[0] for r in results if r[2] == 'AGE']

print(f"SABR-blocked (retrying with cookies): {len(fmt_err_ids)}")
print(f"Truly age-restricted (skipping): {len(age_ids)}: {age_ids}")

if not COOKIES.exists():
    print(f"ERROR: Cookie file not found: {COOKIES}")
    sys.exit(1)

ok_count = 0
sabr_count = 0
age_count = 0
err_count = 0

for i, vid in enumerate(fmt_err_ids):
    out_file = OUT_DIR / f"{vid}.mp4"
    if out_file.exists():
        print(f"SKIP {vid} (already downloaded)")
        ok_count += 1
        continue

    args = [
        sys.executable, '-m', 'yt_dlp',
        '--cookies', str(COOKIES),
        '-f', '137',
        '-o', str(out_file),
        f'https://www.youtube.com/watch?v={vid}'
    ]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT {vid} (5min exceeded, skipping)")
        err_count += 1
        if (i+1) % 10 == 0:
            print(f"\n--- Progress: {i+1}/{len(fmt_err_ids)} ---")
        time.sleep(1)
        continue

    if r.returncode == 0:
        print(f"OK {vid}")
        ok_count += 1
        # Update status
        for res in results:
            if res[0] == vid:
                res[2] = 'OK'
                break
    elif 'Sign in to confirm your age' in r.stderr or 'age-restricted' in r.stderr.lower():
        print(f"AGE {vid} (cookies didn't help - truly age-gated)")
        age_count += 1
        for res in results:
            if res[0] == vid:
                res[2] = 'AGE'
                break
    elif 'SABR' in r.stderr or 'format is not available' in r.stderr or 'Requested format is not available' in r.stderr:
        print(f"SABR {vid} (still blocked)")
        sabr_count += 1
    else:
        print(f"ERR {vid}: {r.stderr[:120].strip()}")
        err_count += 1

    if (i+1) % 10 == 0:
        print(f"\n--- Progress: {i+1}/{len(fmt_err_ids)} ---")

    time.sleep(0.5)

with open('qmg-dl-20260922_cookie_retry.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f"\n=== DONE ===")
print(f"OK (downloaded with cookies): {ok_count}")
print(f"AGE (cookies didn't help): {age_count}")
print(f"SABR (still blocked): {sabr_count}")
print(f"ERR: {err_count}")
print("Results: qmg-dl-20260922_cookie_retry.json")
