---
name: youtube-download-rules-2026-09-24
description: "Critical rules for Qullamaggie YouTube downloads — 720p handling, throttling, age-gate interpretation"
metadata:
  node_type: memory
  type: project
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-24T02:06:34.259Z
---

# YouTube Qullamaggie Download Rules (2026-09-24)

## Resolution Rules

- **1080p = format 137** — primary target for all Qullamaggie videos
- **720p = format 136** — ONLY for the 39 known 720p-only videos (see below). NEVER auto-detected.
- **480p/360p = formats 135/134** — NEVER download under any circumstance.

## The 39 Known 720p-Only Videos

These videos have no 1080p upload on YouTube. Download at 720p (format 136) ONLY for these IDs:
```
0Ew3DImAZlw, 1QtMVbPrKUw, 1X0J9XbF7I4, 3328puCDrks, 3w5BmkbsJpo,
4UWLcS4-lbI, 6XgAT5LW9Ks, 8uyENUhiW1c, AAs9-ZO33eA, A_0Sj3Hi9Jw,
Ab6bXsSfweo, Ax5a_ouJMKU, B1TCCDizExQ, BqGwSzbGS10, D4pnSkaFVb8,
FN20YOH_XRM, FcXJZ3Y98YU, MFew0xR3iv0, MSVE_HaH0qo, NDCSRLjr1-g,
Nlc2r-uz6Gg, O333thFuU40, PvL5_kwE0fI, R7nACKgTydc, SZ0QELUoCJ4,
SrIGW4fvzFE, UG1vfP9hCH0, UmAdr1cM3RY, V5ETDZgbnOs, gqzntxo4DdI,
jtyYLDlgdbE, l2olCkDuHGo, n8SWEpUNylE, o3IoaGLCxz4, oRX7YeTLdRg,
pomzmadhQV0, sUU3mXKLgok, ttKgeB-cZbY, u84s3-ehrw4
```

## YouTube Throttling / Error Interpretation

### "Age restriction" = FAKE = Rate-limiting
When YouTube says "Sign in to confirm your age" or "This content is age-restricted", it means YOU HAVE BEEN RATE-LIMITED. This is NOT a real age gate. Solution: fresh cookies from Cookie-Editor (Firefox, while logged in). Wait 30-60 minutes.

### "Requested format is not available" — TWO DIFFERENT CASES

**Case A — On the 39 known 720p-only videos:** Video genuinely has no 1080p upload. This error is real. Download 720p (format 136) for these specific IDs only.

**Case B — On ANY other video:** YouTube is THROTTLING you and lying. "Format not available" is a fake error. Do NOT download 720p. Leave video in errored list. Try again later with fresh cookies. Do NOT add to the 39 list.

**Rule:** When "format unavailable" appears on a new video (not in the 39 list), treat it as throttling, NOT as a signal to download 720p.

### DNS / getaddrinfo failures
If `*.googlevideo.com` DNS resolution fails — this is a NETWORK issue on the machine, not YouTube throttling. Investigate DNS separately.

### WinError 32 (file locked)
Download completes but yt-dlp can't rename `.part` → `.mp4` on Windows because file is still held open. Retry will likely succeed.

### HTTP 500 / truncation
YouTube server errors. Retry will likely succeed.

## Verifying Downloaded Videos

NEVER use filesize to infer resolution. Always use ffprobe:
```bash
# Check metadata resolution
ffprobe -v quiet -print_format json -show_streams "video.mp4"
# Look for: width x height in the video stream

# Check actual frame resolution
ffmpeg -i "video.mp4" -vframes 1 -s 1920x1080 test.png 2>&1 | head -5
# If error: video is NOT that resolution
```

## Fresh Cookie Process

When rate-limiting/throttling is suspected:
1. Open Firefox
2. Go to youtube.com (ensure logged in)
3. Open Cookie-Editor extension
4. Export ALL cookies as JSON
5. Convert to Netscape format:
   - SID, __Secure-3PSID are critical (long-lived ~2 years)
   - Format: `domain flag path secure expires name value` (7 columns)
6. Save as `youtube_cookies.txt`
7. Retry with `--cookies youtube_cookies.txt`

**Why this works:** Rate-limiting is account-based. Fresh session cookies give you a clean rate-limit budget.
