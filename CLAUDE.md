# CLAUDE.md — portfolio_analyzer_revere

## Project overview

OCR-powered pipeline that crawls YouTube channels (Revere, Qullamaggie), extracts
position/ticker data from video frames, normalizes tickers, and produces portfolio
analytics (CSVs, HTML report, timeline viewer).

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + Tesseract OCR + EasyOCR + sharp + WebGL timeline.

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

### YouTube downloads: use `visios` client, not `tv`

Bot protection blocks the `tv` client even with valid cookies — it returns "Video unavailable" for ALL videos regardless of whether they exist. The `visios` (visionOS API) client bypasses this.

**Always use these flags together:**
```bash
--extractor-args "youtube:player_client=visios" --js-runtimes node
```

`--js-runtimes node` is required — without it, yt-dlp cannot execute the visios player extraction and falls back to storyboard-only (no video). The `tv` client does not need the JS runtime, which is why it seemed to work until the bot-block kicked in.

**What fails:**
- `tv` client → "Video unavailable" (bot protection)
- `android` client → SABR-only formats, no MP4 streams
- `web_safari` client → "Video unavailable" (bot protection)

**What works:** `visios` with `--js-runtimes node`

### Bot protection symptoms and diagnosis

| Symptom | yt-dlp message | Actual cause |
|---------|----------------|--------------|
| All videos return unavailable | `"Video unavailable"` | Bot protection on `tv` client — switch to `visios` |
| Page needs reload | `"The page needs to be reloaded."` | Heavy bot/captcha — try again later |
| SABR formats only | `"Some formats have been skipped"` + no MP4 URLs | `android` client — switch to `visios` |
| No JS runtime | `"No supported JavaScript runtime could be found"` | yt-dlp can't extract visios without `--js-runtimes node` |
| Cookie file error | `"does not look like a Netscape format"` | Cookie SID/`__Secure-3PSID` expired or malformed |
| Rate-limited | `"rate-limited by YouTube for up to an hour"` | Too many rapid requests — pause 30–60 min before retrying |

**Never assume a video is truly unavailable** just because yt-dlp returns "Video unavailable" — the `tv` client is almost always bot-blocked. Test with `visios` before concluding a video is gone.

### YouTube rate-limiting

Running too many yt-dlp requests in rapid succession (catalog refresh, batch downloads) triggers YouTube rate-limiting:
```
ERROR: [youtube] VIDEO_ID: This content isn't available, try again later.
The current session has been rate-limited by YouTube for up to an hour.
```
- **Catalog refresh** is the biggest offender — one yt-dlp invocation per video with no built-in delay.
- **Batch downloads** with `--limit 200` are safer because each download takes 20–60s, naturally spacing requests.
- If rate-limited: **stop all YouTube activity for 30–60 minutes** before retrying.
- Do NOT run catalog refresh and batch downloads concurrently — they compete for the same rate-limit budget.
- The `--sleep-requests` yt-dlp flag does NOT help for catalog refresh (it runs a separate invocation per video).

### YouTube throttling: "age restriction" and "format not available"

**"Age restriction" = fake = rate-limited.** When YouTube says "Sign in to confirm your age" or "This content is age-restricted", it means YOU HAVE BEEN RATE-LIMITED. This is not a real age gate. Fix: fresh cookies from Firefox Cookie-Editor (while logged in), wait 30-60 min.

**"Requested format is not available" = two different situations:**

| Situation | Cause | Action |
|---|---|---|
| On the 39 known 720p-only videos | Video genuinely has no 1080p upload | Download 720p (format 136) — these IDs are hardcoded |
| On any other video | YouTube THROTTLING — lying to block you | Do NOT download 720p. Leave in errored. Retry later with fresh cookies. |

**The 39 known 720p-only video IDs (NEVER add to this list dynamically):**
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

**Rule: NEVER add new IDs to the 39 list based on "format unavailable" errors.** That error on a new video = throttling, not a signal to download 720p.

**480p/360p = never, under any circumstance.**

### Always check the catalog before answering video questions

When the user asks about new/undownloaded videos, **always run a fresh catalog fetch first** — never trust the local SQLite as current. Steps:

```bash
# Check for new uploads
python tools/whiteboard_worker.py catalog --channel <name> --source-url <url> --limit 5

# Then query SQLite for undownloaded rows
SELECT video_id, upload_date, title FROM videos
WHERE channel='<name>' AND (download_path IS NULL OR download_path = '')
ORDER BY upload_date DESC
```

Local SQLite is a snapshot — it changes daily as new uploads appear on YouTube.

### FFmpeg path issues (Windows)

If OCR fails with `ffmpeg.exe ENOENT`: the Gyan FFmpeg symlink may be broken. Recreate it:

```bash
# Check if it exists:
ls -la tools/ffmpeg.exe
# Recreate symlink:
cd tools && mklink ffmpeg.exe "C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
```

### Video ID leading underscore bug

QMG video IDs can start with `_` (e.g. `_9o5_4iZ0zjI`). yt-dlp may truncate these. The download script handles this by using the full ID directly. If you see files named `_9o5_4iZ0zj` (truncated), rename with the full ID and update SQLite.

### Scan orchestration safety (Windows) — NEVER freeze the user's machine

Running `tools/scanAllGtVideos.js` or `tools/scanVideoWithOcr.js` against Quullamaggie chart-stream content without preparation has historically caused multi-hour freezes. The mechanism (root cause analysis in `enchanted-giggling-toucan.md` plan file):

1. `chart_stream` OCR pipeline does **24 Tesseract calls per video** (12 candidates × scale 3× + scale 4× in parallel), single shared worker → **8–15 min/video** on CPU.
2. The orchestrator's per-video kill timer is **300 s** — every video hits SIGTERM mid-OCR.
3. On Windows, `child.kill('SIGTERM')` does NOT reliably terminate the child's grandchildren (ffmpeg.exe + Tesseract WASM heap). They become **zombies**.
4. Parent moves to next video immediately; the new video's ffmpeg sample extraction stalls behind the zombie I/O. **No stdout appears for minutes → user-perceived "freeze" → user restarts their computer.**

**Hard rules before any sweep:**

- **Time ONE video first** with the exact flags the sweep will use. Confirm the log file appears at `data/video_scan_test/_rerun/<runTag>/ocr_probe/logs/<dateKey>_*.json` with non-empty captures. Only scale up after that.
- **Run in chunks of 5–10 videos**, never 40 in one shot. The user can monitor each chunk and abort if one hangs.
- **Pass `--parallel 4`** to the orchestrator. Worker pool is already implemented at `scanAllGtVideos.js:114-128`. Default `--parallel 1` is ~6.7 h wall for a 40-video sweep.
- **Flag budget vs timeout**: for the default 300 s timeout, use `--fps 0.25 --prefilter-max-frames 12 --max-captures 1`. `--fps 1` is 4× denser than default; `--max-captures 3` will NOT finish in 300 s on the chart-stream profile (Tesseract alone is ~6 min lower bound).
- **After any timeout**, check for orphans: `tasklist | findstr ffmpeg.exe` and `tasklist | findstr node.exe`. Kill them before continuing. Clean up half-written `frames/` dirs (often 100s of MB each).
- **Do NOT `ls` or `Read` `data/video_scan_test/_rerun/` directly** — those directories hold hundreds-to-thousands of PNGs each. Use `Glob` with a pattern or delegate to an Explore agent. Listing them bloats context.
- **Do NOT run `tools/retry_age_restricted.py` without explicit user confirmation** — 138 sequential `yt-dlp` subprocesses, ~3.5 h worst case.

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

---

## Chart-stream OCR (QMG position list extraction)

### OCR engines

The chart-stream pipeline supports two OCR engines via `--ocr-engine tesseract|easyocr`:

- **`tesseract`** (default): legacy, ~25% recall on 20220606. Use only when EasyOCR is unavailable or for very fast scans.
- **`easyocr`** (recommended): ~75% recall on 20220606, ~60s/frame. **3× recall improvement** justifies the cost for QMG chart-stream videos.

EasyOCR is a Python package; install via `pip install easyocr`. EasyOCR 1.7.2+ ships wheels for Python 3.9 through 3.14, so any modern interpreter works — the older "Python 3.11 required" guidance is outdated. The default interpreter lookup tries `C:/ProgramData/anaconda3/python.exe` first (recommended because anaconda usually has CUDA-enabled torch), then several common standalone install paths, and finally falls back to `python` on PATH. Override via `EASYOCR_PYTHON` env var or `--easyocr-python` CLI flag.

### Verified end-to-end result on 20220606 (commit d824431)

```
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 \
  --date 20220606 \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 1 --fps 0.25 --prefilter-max-frames 6 \
  --ocr-engine easyocr
```

→ Captured frame at 00:42:00: `[ALB, CBIO, COIN, GOVX, LABU, UCO, VLO, X]`
→ 6/8 GT tickers (75% recall: ALB, CBIO, GOVX, LABU, UCO, VLO)

### Why EasyOCR beats Tesseract for QMG position lists

| Engine     | Tesseract                                  | EasyOCR                                                |
|------------|--------------------------------------------|-------------------------------------------------------|
| Architecture | LSTM, document-trained                     | CNN (ResNet + LSTM + CTC), scene-text-trained         |
| Best for   | Document scans (printed text)              | UI overlays, small white text on dark panels          |
| QMG result | Many garbled forms (BGO, Tan, AAPL)         | Mostly correct (GOVX, LABU, UCO, ALB, CBIO, VLO)      |
| Speed      | ~2s/frame                                  | ~60s/frame                                            |

### Critical pipeline pitfalls (all hit + fixed in d824431)

1. **Crop from the ORIGINAL 1920px video, not the 1280px OCR-resolution frame.**
   EasyOCR's CNN is sensitive to anti-aliasing artifacts from the 1280→1345 downscale-then-upscale. The EasyOCR branch uses `ffmpeg -ss <ts> -i <videoPath>` (not `-i <ocr-resolution-frame>`) to avoid this.

2. **The parser's column detector (identifyPositionListColumn) picks the WRONG dominant_x for EasyOCR.**
   EasyOCR's word bounding boxes land at different x-centers than Tesseract's, so the bucket heuristic picks a chart-area column (~x=510) instead of the position-list column (~x=1218). The fix: column-gated acceptance was removed — the parser now accepts on `inLexicon || priceNearby` alone. Chart-area text ("SYM", "ARITH", "Cran") doesn't match the seed lexicon so it stays rejected.

3. **Use scale=5 for EasyOCR, not the dual-scale 3+4 used for Tesseract.**
   EasyOCR is slow enough (~60s) that running it twice is wasteful; the bigger image produces cleaner OCR.

4. **The chart_stream prefilter picks intro/warmup frames by default.**
   The `midToneRatioTicker` signal fires on any chart content (candles, axis labels) in the bottom-right rectangle. The fix: added `maxColRowDensityWeight: 25` (max-row-density in the column) so position-list frames (text transitions stacked in one column) score higher than intro frames (transitions scattered).

### Pipeline stages for chart-stream

```text
ffmpeg -ss <ts> -i <video>  →  ffmpeg crop=in_w*0.14:in_h*0.45:in_w*0.86:in_h*0.55,scale=1345:-1
                             →  EasyOCR (Python subprocess)
                             →  parseChartStreamPositionList (lexicon + price-nearby)
                             →  scoreChartStreamCandidate (with parse_status='ok' bonus)
                             →  pickTopDistinctCandidates (dedup + strongThreshold)
```

### Diagnostic fields exposed (since commit be9499a)

- `chart_stream.column_filter` — `dominant_x`, `column_width`, `in_list_token_count` (diagnostic only, not gated)
- `chart_stream.tickers_rejected_list` — first 30 rejected tokens (capped to keep probe logs small)
- `chart_stream.position_list` — accepted tickers after parse
- `merged_position_list` — multi-frame union (committed, not yet wired into scoring)
