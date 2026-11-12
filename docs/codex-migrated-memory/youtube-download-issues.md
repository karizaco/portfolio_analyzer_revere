---
name: youtube-download-issues
description: "YouTube download failure causes — bot detection, age restriction, SABR, and the correct client to use"
metadata:
  type: reference
  modified: 2026-09-23T06:34:53.931Z
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
---

# YouTube Download Issues — Updated 2026-09-23

## The ONE client that works: `visios`

**`visios` is the only client that bypasses bot protection consistently.**

```
py -3 -m yt_dlp --cookies youtube_cookies.txt \
  --extractor-args "youtube:player_client=visios" \
  --js-runtimes node \
  -f 137 \
  --no-playlist \
  -o "%(upload_date)s_%(id)s.%(ext)s" \
  "https://www.youtube.com/watch?v=VIDEO_ID"
```

**Requirements:**
1. `--js-runtimes node` — visios requires JS runtime; without it yt-dlp falls back to storyboard-only extraction
2. `--cookies youtube_cookies.txt` — Netscape-format cookie file with valid SID / __Secure-3PSID
3. `yt-dlp 2026.08.19` (pip install, NOT bundled Parabolic exe)

## Why other clients fail

| Client | Symptom | Cause |
|--------|---------|-------|
| `tv` | `"Video unavailable"` | Bot protection — YouTube returns unavailable even for existing videos |
| `android` | SABR-only formats available | YouTube serves only SABR manifest, no MP4 streams |
| `web_safari` | `"Video unavailable"` | Bot protection |
| `visios` | **Works** | visionOS API that bypasses bot detection |

**`visios` IS required** even with valid cookies — the `tv` client with valid SID still gets bot-blocked.

## Failure Types

### "Video unavailable" — Bot Detection (most common)
- YouTube returns this for ALL videos regardless of whether they exist
- Triggers even with valid cookies and correct video IDs
- Fix: switch to `visios` client

### "The page needs to be reloaded" — Heavy Bot Detection
- More aggressive captcha; even `visios` may fail temporarily
- Try again in a few minutes; not resolvable by script changes

### "Sign in to confirm your age" — Age Restriction
- Some Qullamaggie videos are age-gated
- `visios` bypasses this; if it doesn't, the video genuinely requires login

### SABR-only streaming
- YouTube serves only an encrypted SABR manifest, no direct MP4 URL
- `visios` client handles this correctly
- If you see `android` client formats missing URLs, switch to `visios`

## Download Script

`tools/downloadQmg1080p.js` — wraps yt-dlp for batch Qullamaggie 1080p downloads:

```bash
# Run the batch downloader (uses visios + --js-runtimes node internally)
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200

# If some errored due to bot protection, retry without clearing checkpoint:
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200 --retry-errored

# To force-clear checkpoint and re-attempt everything:
# Edit the checkpoint file to reset errored/blocked lists, keep 'done' list
```

## Cookie Refresh

SID and __Secure-3PSID cookies are long-lived (~2 years). SIDCC / __Secure-1PSIDTS expire same-day and are NOT needed for download — they only affect the YouTube webpage UI. The SID + __Secure-3PSID are what matter.

When cookies stop working:
1. Export from Firefox Cookie-Editor (F12 → Storage → Cookies → youtube.com)
2. Convert to Netscape format if needed
3. Replace `youtube_cookies.txt`

## DPAPI Note (Windows)
- Chrome/Edge cookies are DPAPI-encrypted and unreadable by yt-dlp
- Firefox works only if you're logged into YouTube
- Cookie-Editor export is the reliable path
