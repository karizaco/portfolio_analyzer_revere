---
name: download-findings-20260921
description: YouTube download blocking findings — yt-dlp rate limits, geo-blocks, DPAPI cookie issue, and resolutions
metadata:
  type: reference
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-21T10:23:25.242Z
---

# YouTube Download Findings — 2026-09-21

## YouTube Blocking Mechanisms

### "The page needs to be reloaded" — Bot detection (not rate limit)
- YouTube serves a captcha challenge page instead of the player
- Happens when YouTube detects non-browser traffic patterns
- **NOT resolved by**: new IP, VPN, different player_client (tv, mediaconnect, web)
- **RESOLVED by**: authenticated YouTube session (real cookies)

### DPAPI Cookie Problem (Windows)
- Chrome/Edge cookies on Windows are encrypted with DPAPI (Windows Data Protection API)
- yt-dlp's `--cookies-from-browser chrome/edge` fails with `DPAPI decrypt failed`
- Firefox cookies are NOT encrypted but user wasn't logged into YouTube in Firefox
- browser-cookie3 Python library also fails on DPAPI
- **Workaround**: `--cookies /path/to/netscape.txt` with a manually exported cookie file

### Cookie Export Approaches Tried
1. `--cookies-from-browser chrome` → DPAPI failure
2. `--cookies-from-browser edge` → DPAPI failure
3. `--cookies-from-browser firefox` → No YouTube cookies (user not logged in)
4. Playwright fresh browser → anonymous cookies only (no auth)
5. CDP connect to Chrome → requires Chrome running with `--remote-debugging-port=9222`
6. **RECOMMENDED**: Manual cookie export via browser extension or CDP

### Number-prefixed YouTube IDs
- IDs like `7H7ZLP7D0PA`, `3w5BmkbsJpo` (starting with digit) are consistently blocked
- These may be legacy/short-form IDs with stricter bot detection
- ~50 consecutive IDs with digit prefixes all fail

## Resolution Differences
- 1080p (format 137) is the target for Qullamaggie
- Lower resolutions may have fewer restrictions but we always use 1080p for OCR quality
- No evidence that 720p vs 1080p changes geo-blocking behavior

## Script Changes Made
- `tools/downloadQmg1080p.js`: Added `--cookies` flag for Netscape cookie file
- Added `blocked` array to checkpoint to permanently skip consistently-failing IDs
- `tools/export_youtube_cookies.js`: New script using Playwright CDP to export cookies

## Recommendations for Remaining Blocked Videos
1. **VPN** for geo-blocked content
2. **Manual download** of specific blocked IDs using browser
3. **CDP method**: Launch Chrome with `--remote-debugging-port=9222`, log into YouTube, then use `export_youtube_cookies.js` via CDP
4. **Browser extension**: EditThisCookie Chrome extension → export as Netscape format

## Download Stats (2026-09-21)
- 84 videos checkpoint-done
- ~99 MP4 files on disk
- ~140 permanently blocked (bot-detected IDs)
- ~500 pending in catalog
