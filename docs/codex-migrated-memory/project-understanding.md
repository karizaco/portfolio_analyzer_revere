---
name: project-understanding
description: "Full project overview — channels, OCR types, download pipeline, YouTube gotchas, output structure"
metadata:
  node_type: memory
  type: project
  originSessionId: 0e51feae-906c-425a-988a-f2ef09fd994d
  modified: 2026-09-29T03:21:28.651Z
---

# Portfolio Analyzer — Project Understanding

## What it does
OCR-powered pipeline that crawls YouTube channels (Qullamaggie, Revere), extracts position/ticker data from video frames, normalizes tickers, and produces portfolio analytics (CSVs, HTML reports, timeline viewer).

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + Tesseract OCR + sharp + WebGL timeline.

---

## Two channels, two OCR modes

### Qullamaggie (qullamaggie) — chart_stream
- Live trading sessions show a **position-list overlay** in bottom-right corner (small table: ticker + price/percent)
- Parser: `src/parse/parseChartStream.js` — extracts tickers via lexicon membership + price-nearby signal
- **Must use 1080p** — 720p is marginal, 360p completely unusable
- Crop region: `{x:0.70, y:0.60, w:0.30, h:0.40}` (bottom-right 30%×40%)
- OCR preprocessing: negate() (dark→white), upsample 3× lanczos3, normalize, sharpen, linear(1.8,−64)
- Ground truth test set: 6 videos with human-verified tickers in `tools/buildQmgReviewPage.js`

### Revere — whiteboard
- Structured whiteboard slides (GRO/TURBO portfolios, DMI, Tale of the Tape)
- Parser: `src/parse/parseWhiteboardScreenshot.js`
- **720p recommended** — marginal gain at 1080p (+2pp OCR confidence)
- Video type classification: `daily` / `weekend_review` / `feature` / `live_update`

---

## YouTube download (CRITICAL)

### Client choice
- `visios` + `--js-runtimes node` is the ONLY reliable client
- `tv` → bot-blocked "Video unavailable" for ALL videos
- `android` → SABR-only formats, no MP4
- `web_safari` → bot-blocked

### Cookie refresh
SID and __Secure-3PSID are long-lived (~2 years). SIDCC/__Secure-1PSIDTS expire same-day. When downloads fail with "does not look like a Netscape format", re-export fresh cookies.

### Rate-limiting
- Catalog refresh is the biggest offender (one yt-dlp invocation per video, no delay)
- Batch downloads with `--limit 200` naturally space requests (20-60s each)
- If rate-limited: stop ALL YouTube activity for 30-60 min
- "Age restriction" = fake = rate-limited (not a real age gate)
- "Format not available" on unknown video = throttling (NOT a signal to use 720p)

### 39 known 720p-only videos
Hardcoded list in `downloadQmg1080p.js`. NEVER add new IDs dynamically — "format unavailable" on a new video = throttling.

### Qullamaggie video IDs with leading underscore
IDs like `_9o5_4iZ0zjI` get truncated by yt-dlp. Scripts handle this by using the full ID. If files appear truncated, rename + update SQLite.

---

## Data folder policy

| Directory | Preferred Resolution | Notes |
|---|---|---|
| `downloads/` | 720p | Mixed qullamaggie+revere, empty after cleanup |
| `downloads_hires/` | 720p | ~98 revere + ~12 qullamaggie + ~19 unknown |
| `downloads_1080p/` | 1080p | Qullamaggie 1080p (format 137); verify with ffprobe |

**Never infer resolution from filesize.** Always use `ffprobe`.

Scan output: `data/video_scan_YYYYMMDD/` — run-tag from `RUN_TAG` env var.
Probe dirs: `data/video_ocr_probe/` — temporary, prune if >10 MB. Use `node tools/prune_old_probes.js`.

---

## Canonical outputs
- `data/portfolio_snapshots.csv` — extracted snapshot rows
- `data/review_queue.csv` — flagged for manual review
- `data/portfolio_actions.csv` — BUY/ADD/SELL/TRIM rows
- `data/position_events.csv` — entry/exit events by portfolio and day
- `data/portfolio_performance_summary.csv` — per-portfolio summary
- `data/portfolio_performance_timeseries.csv` — portfolio timeline

---

## Key entry points
- `tools/whiteboard_worker.py` — catalog, screenshot, OCR worker (Python CLI)
- `tools/scanVideoWithOcr.js` — per-video OCR + capture (Node.js CLI)
- `tools/aggregateScanResults.js` — merge scan output into `analysis.json`
- `tools/aggregateOcrTimeline.js` — merge into `timeline.json`
- `tools/viewTimeline.html` — interactive timeline viewer
- `tools/downloadQmg1080p.js` — Qullamaggie 1080p batch download
- `tools/downloadHiresBatch.js` — Revere 720p batch download
- `tools/buildQmgReviewPage.js` — rebuild Qullamaggie ground truth review page

---

## Current uncommitted changes (as of 2026-09-29)
- `CLAUDE.md` — major expansion with YouTube bot protection/rate-limiting/720p-only rules
- `README.md` — condensed to ~270 lines, reorganized around visios client + Qullamaggie chart-stream
- `tools/video_status.html` — updated stats (406 files, 153 GB), Qullamaggie IDs with leading `_` displayed without `_` (cosmetic bug in display)
- `tools/buildQmgReviewPage.js`, `tools/downloadHiresBatch.js`, `tools/downloadQmg1080p.js`, `tools/qmg_snapshot_review.html` — minor changes

## Recent commits
- `37a5dfc` feat(qullamaggie): chart_stream prefilter uses mid-tone density in ticker rectangle
- `dffd5fb` feat(qullamaggie): add --batch-time override for batch snapshots
- `656fb9e` feat(qullamaggie): integrate --batch-snapshots mode into scan pipeline
- `6e6fb2a` feat(qullamaggie): batch snapshot script + batch OCR results
- `b0b3e3b` fix(qullamaggie): remove multi-frame merge from HTML page (was misleading)
