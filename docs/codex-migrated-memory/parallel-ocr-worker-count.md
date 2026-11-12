---
name: parallel-ocr-worker-count
description: "For OCR batches of N > ~5 videos, run parallelOcrScan.py with --workers N/2 (default 4) instead of --workers 1"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-17T09:49:47.772Z
---

When scanning batches of more than ~5 videos through `tools/parallelOcrScan.py`, use the default 4 workers (omit the positional `workers` arg) rather than passing `--workers 1` (or `parallelOcrScan.py 1`).

**Why:** A 19-video Qullamaggie scan was launched with `parallelOcrScan.py 1` and would have taken ~95 minutes serial. The user explicitly noticed the stuck-arm slowness and asked to intervene. With 4 workers it's ~25 minutes — a 3-4x wall-clock save. Captured after running a re-scan in 2026-09-17 session.

**How to apply:**
- Default: omit the positional `workers` arg (defaults to 4). Equivalent to `parallelOcrScan.py 4`.
- For >10 videos, consider `--workers` equal to available cores minus 1.
- Single-worker is only justified when system memory / ffmpeg contention is a concern; otherwise default to 4.
- The script is idempotent — already-completed videos (probe-log already present in own output dir) are auto-skipped, so a re-run is safe.
- Captions fetch is similar — when fetching for many videos, consider running parallel per channel rather than sequentially per the prior agent's prompt.
