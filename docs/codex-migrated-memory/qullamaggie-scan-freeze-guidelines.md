---
name: qullamaggie-scan-freeze-guidelines
description: Hard-learned rules for not freezing when running scanVideoWithOcr.js / scanAllGtVideos.js — what caused the September 2026 freeze incidents and the patterns to follow to avoid them
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-29T04:22:18.044Z
---

# Quullamaggie scan freeze — root cause + safety rules

## What happened (Sep 2026)

User reported the assistant was "freezing for very long periods" during Quullamaggie re-scan work. Had to restart their computer. Root cause analysis (full version in `enchanted-giggling-toucan.md` plan file):

1. `tools/scanAllGtVideos.js` runs serially by default (`--parallel 1`). 40 videos × 5–15 min wall each = ~6.7 hours.
2. Per-video kill timer is **300 s (5 min)** but real chart-stream OCR is **8–15 min/video** (24 Tesseract calls per video: 12 frames × scale 3× + scale 4× in parallel). Every video hits SIGTERM mid-scan.
3. On Windows, `child.kill('SIGTERM')` does NOT reliably terminate the child's grandchildren (ffmpeg.exe + Tesseract WASM heap). They become zombies.
4. Parent moves to next video immediately. Video N+1's ffmpeg sample extraction is I/O-bound and stalls behind zombie ffmpeg/Tesseract from video N. No stdout for minutes → user-perceived "freeze".
5. VSCode pause button in Claude extension can't help — it's trying to pause the Node parent, but the actual CPU/disk consumers are ffmpeg/Tesseract grandchildren.

**8 of 13 `_rerun/` directories from the failed sweep were killed mid-scan** — hundreds of MB of sample frames left behind, no log file written. Three runs on the same day completed cleanly (cleared their `frames/` dirs via `finally`).

## Why this matters

This isn't just a perf issue — the "freeze" is invisible to the user. There's no progress indicator, no error, no obvious way to abort. The user restarts their computer to recover.

## How to apply

**Before running ANY scanAllGtVideos.js sweep:**

1. **Time one video first** — pick a known GT video (e.g. `20220218`), run with the exact flags the sweep will use, confirm wall time AND that the log file appears at `data/video_scan_test/_rerun/<runTag>/ocr_probe/logs/<dateKey>_*.json` with non-empty captures. Never scale up without this.
2. **Chunk in 5–10 videos** — not 40 in one shot. User can monitor each chunk and abort if one hangs.
3. **Use `--parallel 4`** — the worker pool is already implemented at `scanAllGtVideos.js:114-128`. 4 workers cuts wall time from 6.7 h → ~100 min on a 4-core box. Do NOT use default `--parallel 1`.
4. **Pick flags that match the timeout** — for 300 s timeout, use `--fps 0.25 --prefilter-max-frames 12 --max-captures 1`. `--fps 1` is 4× denser than default; `--max-captures 3` may not finish in 5 min on chart-stream profile. The 6 min lower-bound on Tesseract alone (24 × 15 s) means `--max-captures 3` will NOT finish in 300 s.
5. **After any timeout, check for orphans** — `tasklist | findstr ffmpeg.exe` and `tasklist | findstr node.exe`. If zombies exist, kill them before continuing. Clean up half-written `frames/` dirs (100s of MB).
6. **Don't ls huge output dirs into context** — `data/video_scan_test/_rerun/` has hundreds-to-thousands of PNGs per subdirectory. Use `Glob` with a pattern or delegate to an Explore agent. Listing them bloats context and slows subsequent tool calls.
7. **Don't run `tools/retry_age_restricted.py` without explicit user confirmation** — does up to 138 sequential `yt-dlp` subprocesses with 90 s timeout each (~3.5 h worst case). Not part of any auto-pipeline.

## Related notes

- [[qullamaggie-prefilter-improvement]] — the prefilter change that triggered the rerun; the prefilter itself is correct and not the cause of the freeze.
- See `enchanted-giggling-toucan.md` plan file for full analysis with concrete numbers per video (ffmpeg spawns, sharp() calls, Tesseract calls).
