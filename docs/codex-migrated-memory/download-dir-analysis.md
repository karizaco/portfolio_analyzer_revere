---
name: download-directory-analysis
description: Qullamaggie 1080p download plan and download directory state
metadata: 
  node_type: memory
  type: project
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-19T16:19:13.931Z
---

## Download directory state (as of 2026-09-19)

| Directory | Files | Channel mix | SQLite-tracked |
|---|---|---|---|
| `data/video_pipeline/downloads/` | 230 | ~194 qullamaggie, ~36 revere | **0 rows** (download_path NOT written) |
| `data/video_pipeline/downloads_hires/` | 131 | ~98 revere, ~14 qullamaggie | 110 rows |

- **downloads/** files were NOT tracked in SQLite by downloadHiresBatch.js (different process)
- The 19 overlapping files are all Qullamaggie (14 had copies in downloads_hires/)
- Real overlap is minimal (19 files) — not a wholesale duplication

## Qullamaggie 1080p plan (approved 2026-09-19)

Owner: karizaco

### Step 1: SQLite backfill
One-time Python script sets `download_path` for all 230 files in `downloads/` so SQLite reflects reality.

### Step 2: Qullamaggie 1080p download script (NEW)
- Script: `tools/downloadQmg1080p.js`
- Target directory: `data/video_pipeline/downloads_1080p/`
- Fetches at format 137 (1080p) for qullamaggie channel only
- Respects existing checkpoint file pattern
- Existing 720p Qullamaggie files in `downloads/` stay as fallback

### Step 3: Delete 720p Qullamaggie fallbacks after 1080p confirmed
After representative 1080p downloads are confirmed working with good OCR tickers, the 720p Qullamaggie files in `downloads/` can be deleted.

## Future bloat prevention (in CLAUDE.md already)
- `downloads/` = qullamaggie channel only (720p)
- `downloads_hires/` = revere channel only (720p)
- `downloads_1080p/` = qullamaggie channel only (1080p)
- Never mix channels in the same download directory
