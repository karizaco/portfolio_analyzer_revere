---
name: yt-dlp-client-set-speed
description: "yt-dlp client sets for YouTube metadata - mweb alone is 30x faster than ios,android,web, and listing extra clients costs time on every video"
metadata:
  node_type: memory
  type: reference
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-10-26T11:26:49.869Z
---

The yt-dlp `--extractor-args youtube:player_client=` set is the single biggest
lever on how long a YouTube metadata job takes.

**Measured per video on the same lists (2026-10-26):**

| client set | per video |
|---|---|
| `mweb` alone | **4.2 s** |
| `mweb,ios,android,web` | 8.5 s |
| `ios,android,web` | 123 s (on the 181-video Qullamaggie list) |

**The rule that explains it:** yt-dlp queries **every** client in the list, not
just the first that works. So adding a fallback client costs time on *every*
video, not only on the ones that fail. A longer list is a slower list.

**What works for metadata:**
- `mweb` — fast, works. Needs a GVS PO Token for *streaming formats* only;
  metadata is fine without it.
- `ios,android,web` — works, slow.
- `web` alone — returns nothing (exit 1).
- `web_safari,web` — returns nothing; `web_safari` is bot-blocked.

**How to use a fallback without paying for it on every video:** run the fast
client over the whole list first, then run the slow set over the *same* list
second — `tools/whiteboard_worker.py fill-dates` skips videos that already
have an `upload_date`, so the second pass only fetches the stragglers.

**`mweb` is NOT a substitute for `visios` for downloads.** For downloading
video bytes the rule in CLAUDE.md still holds: `--extractor-args
"youtube:player_client=visios" --js-runtimes node`. `visios` is for the
*streaming formats*; `mweb` is a *metadata* fast path. `mweb` warns that
"some https formats have been skipped" — that is expected and harmless for
metadata.

**"Sign in to confirm your age" on a few videos only** = a genuine age
restriction on those videos, not a throttle. (A throttle hits every video.)
Those need a fresh cookie from Firefox Cookie-Editor.

Related: [[always-catalog-first]], [[youtube-download-issues]]
