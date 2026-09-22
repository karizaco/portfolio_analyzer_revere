# CLAUDE.md — portfolio_analyzer_revere

## Project overview

OCR-powered pipeline that crawls YouTube channels (Revere, Qullamaggie), extracts
position/ticker data from video frames, normalizes tickers, and produces portfolio
analytics (CSVs, HTML report, timeline viewer).

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + Tesseract OCR + sharp + WebGL timeline.

---

## Critical rules

### Never infer resolution from filesize

**Filesize tells you nothing about actual video resolution.** A 10-minute FullHD video can easily be under 1 GB. A 2-hour 720p video can be 2 GB. **Always use ffprobe to check actual resolution:**

```bash
ffprobe -v quiet -print_format json -show_streams "path/to/video.mp4"
# Look for: width × height in the video stream
```

Never delete a video because it seems "too small to be FullHD" — this reasoning has caused data loss.

### The download directories are NOT channel-exclusive

The `downloads/`, `downloads_hires/`, `downloads_1080p/` directories have historically held mixed content. Before deleting from any of these directories, **always verify the actual video channel via SQLite** (`videos` table, `channel` column). The directory names describe the preferred resolution, not the channel.

### YouTube cookie sessions expire

YouTube session cookies in `youtube_cookies.txt` expire and become 0-byte files. When downloads fail with `"does not look like a Netscape format cookies file"`, re-export fresh cookies from Firefox Cookie-Editor and convert to Netscape format.

---

## Data folder policy

### Download subdirectories (`data/video_pipeline/`)

| Directory | Preferred Resolution | Notes |
|---|---|---|
| `downloads/` | 720p | Historically held mixed qullamaggie+revere; currently empty after cleanup |
| `downloads_hires/` | 720p | Mixed: ~98 revere + ~12 qullamaggie + ~19 unknown (verify via SQLite before deleting) |
| `downloads_1080p/` | 1080p | qullamaggie 1080p (format 137); verify via ffprobe before assuming resolution |

Verify channel via SQLite: `SELECT video_id, channel FROM videos WHERE video_id IN (...)`
Use ffprobe to verify actual resolution — never assume from directory name or filesize.

### Scan output directories (`data/video_scan_YYYYMMDD/`)

- **Run-tag** must be the `RUN_TAG` env var value used to invoke the scan.
- Re-runs with different parameters get a distinguishing suffix: `ocr-20260917-v2/`, `qmg-ocr-20260917-missing19/`.
- **Never** use `v2-fixN`, `testN`, or `fpsN` as run-tags — these make it impossible
  to tell which output is canonical without reading every directory.
- Use the `qmg-` prefix for qullamaggie channel scans to make intent unambiguous.
- Always archive or delete superseded runs before starting a new parallel run of the same video set.

### Probe directories (`data/video_ocr_probe/`)

Probes are temporary. Any probe subdirectory exceeding **10 MB** must be reviewed for cleanup
after the run completes. Use `node tools/prune_old_probes.js` to audit.

Canonical probe naming: `{channel}-{date}/` — e.g. `qmg-final-20260918/`.
Avoid `testN`, `frames`, `snap` suffixes on probe directories — they imply intermediate
artifacts that should not be persisted.

### One-time cleanup

Run `node tools/prune_old_probes.js` (dry-run first, then `--execute`) periodically
to prune old probe and scan subdirectories, keeping only the 3 most-recent per family.

---

## Codebase map

### Entry points
- `tools/whiteboard_worker.py` — catalog, screenshot, OCR worker (Python CLI)
- `tools/scanVideoWithOcr.js` — per-video OCR + capture (Node.js CLI)
- `tools/aggregateScanResults.js` — merge scan output into `analysis.json`
- `tools/aggregateOcrTimeline.js` — merge into `timeline.json`
- `tools/viewTimeline.html` — interactive timeline viewer

### OCR pipeline
- `src/ocr/ocrImage.js` — Tesseract wrapper; `chart-stream` profile crops overlay region
- `src/video/ocrScanLogic.js` — prefilter scoring, candidate building, screenshot logic
- `src/video/ocrScanArgs.js` — CLI argument parsing; `CHART_STREAM_REGION_FRACTION_DEFAULT`
- `src/parse/parseChartStream.js` — Qullamaggie position-list ticker extraction
- `src/parse/parseWhiteboardScreenshot.js` — GRO/TURBO/Revere whiteboard parser
- `src/video/imageHash.js` — full-frame pHash
- `src/video/imageHashRegion.js` — region-crop pHash (chart overlay)

### Normalization
- `src/normalize/tickerScan.js` — seed lexicon + strict ticker pattern
- `src/normalize/videoTypeClassifier.js` — whiteboard / chart_stream / DMI / tale_of_the_tape
- `src/normalize/repairHoldings.js` — Revere-only position repair

### Data
- `data/video_pipeline/state.sqlite` — canonical SQLite database
- `data/db/schema.sql` — schema source of truth
- `config/ticker_lexicon_seed.csv` — ticker allowlist (Revere + Qullamaggie)

---

## Common commands

```bash
# Catalog (adds new videos from a channel)
node tools/runWhiteboardWorker.js catalog --channel qullamaggie --source-url https://www.youtube.com/@Qullamaggie/videos

# Download hires
node tools/downloadHiresBatch.js --only-ids <ids> --height 720

# OCR scan (qullamaggie)
node tools/scanVideoWithOcr.js --video-dir data/video_pipeline/downloads_hires/ --file <video.mp4> \
  --prefilter-profile chart_stream --chart-stream-parser --basename qmg --output-kind snapshot

# Aggregate
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/

# Prune old probes
node tools/prune_old_probes.js           # dry-run
node tools/prune_old_probes.js --execute # actually delete
```
