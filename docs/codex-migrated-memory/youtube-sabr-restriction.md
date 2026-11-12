---
name: youtube-sabr-restriction
description: YouTube SABR-only streaming blocks yt-dlp downloads on many Qullamaggie videos
metadata: 
  node_type: memory
  type: reference
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-22T10:36:43.092Z
---

# YouTube SABR-only Restriction

**Date discovered:** 2026-09-22

## The Problem

Many Qullamaggie videos (138 flagged as "age-restricted") are NOT age-gated — they're restricted by YouTube's **SABR** (Secure Adaptive Bitrate) streaming protocol. yt-dlp error:

```
WARNING: [youtube] VIDEO_ID: Some android client https formats have been skipped as they are missing a URL.
YouTube may have enabled the SABR-only
```

This means YouTube has disabled direct HLS/DASH manifest URLs for these videos — only SABR works, and SABR requires YouTube authentication to extract stream URLs.

## What Works vs What Doesn't

| Method | Status |
|---|---|
| `yt-dlp -f 137` (default) | Fails with HTTP 403 or 500 |
| `yt-dlp --extractor-args youtube:player_client=android` | SABR-only on most; works on some older videos |
| `yt-dlp --extractor-args youtube:player_client=visionos` | May work on some |
| `yt-dlp --cookies-from-browser firefox` | Would work if user is logged into YouTube in Firefox |
| `yt-dlp --cookies-from-browser chrome` | DPAPI-encrypted, cannot extract |

## True Age-Restricted (2 found so far)

- `te9tmNOA38I` — title: "Fuck Putin" (truly age-gated)
- `xNL-i3acbVk` — truly age-gated

## Solution: Cookie-Editor Export from Firefox Private Mode

If Cookie-Editor extension is installed in Firefox private mode, it can export cookies from memory even in private browsing. Works for SABR-blocked videos.

**Tested workflow (2026-09-22):**
1. With Firefox private window open to youtube.com and logged in
2. Cookie-Editor → Export → Copy JSON
3. Convert to Netscape format and save to `youtube_cookies.txt`
4. `yt-dlp --cookies youtube_cookies.txt -f 137 URL` — SABR block bypassed, 1080p download works

**Cookie file format:** Netscape (Mozilla) format:
```
# Netscape HTTP Cookie File
.youtube.com  TRUE  /  TRUE  1824631008  SID  <value>
.youtube.com  TRUE  /  TRUE  1824631008  __Secure-3PSID  <value>
...
```

**Tested cookies needed (minimum set):**
- `SID` — main session cookie
- `__Secure-3PSID` — secure variant
- `SIDCC` — configuration cookie
- `__Secure-1PSIDTS` — timestamp token
- `VISITOR_PRIVACY_METADATA` — privacy signal
- `GPS`, `YSC`, `CONSISTENCY` — various YouTube tokens

**Why Firefox works:** Firefox stores cookies unencrypted in SQLite. Chrome/Edge use DPAPI to lock cookies to the browser process.

## Background

SABR appears to be YouTube's response to automated downloading — it replaces the extractable HLS manifests with an encrypted stream that only YouTube's official clients can decrypt. This is separate from age-restriction.
