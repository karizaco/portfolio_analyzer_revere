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

Running `tools/scanAllGtVideos.js` or `tools/scanVideoWithOcr.js` against Qullamaggie chart-stream content without preparation has historically caused multi-hour freezes. The mechanism (root cause analysis in `enchanted-giggling-toucan.md` plan file):

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

### EasyOCR — ALWAYS use `--low-cpu`

EasyOCR uses PyTorch + OpenCV + NumPy, each spawning multi-threaded thread pools. **Without `--low-cpu`, parallel scans saturate all CPU cores**, causing 10× slowdown (60s/frame → 600s/frame) and system freeze.

**Every EasyOCR command MUST include `--low-cpu`:**

```bash
# Batch runner
node tools/runQmgOcrBatch.js --dates d1,d2,... --low-cpu --parallel 4

# Individual scan
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE \
  node tools/scanVideoWithOcr.js ... --ocr-engine easyocr
```

`--low-cpu` in `runQmgOcrBatch.js` enforces `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `KMP_DUPLICATE_LIB_OK=TRUE` and caps parallelism at `--parallel 2` max. There is no acceptable reason to omit it — the machine will freeze.

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

### Sparse checkout — the working tree is a sparse checkout

`.git/info/sparse-checkout` limits which tracked files are materialized. Two entries
are **not optional**:

```
/test/               ← without it the test suite cannot run at all
/data/video_pipeline/ ← without it, git removes the directory tree from disk
```

**`git sparse-checkout add <path>` can delete large amounts of untracked data.** Git's
`verify_absent()` path removes an excluded directory *recursively, including untracked
files inside it*. On 2026-10-21, `git sparse-checkout add test` removed
`data/video_pipeline/` — and with it ~215 GB of untracked `.mp4` files that git could
not restore, because they were never committed.

Rules:

- Before running any `git sparse-checkout` command, confirm `.git/info/sparse-checkout`
  lists `/data/video_pipeline/` and `/test/`.
- Prefer `git sparse-checkout reapply` (materializes only; removes nothing) over
  `add`/`set` when you only need to widen the pattern set.
- The downloaded videos are **not** in git. `data/video_pipeline/state.sqlite` is the
  only authoritative record of what should be on disk — it lists every video's
  channel, upload date and expected filename. If the media is lost, regenerate the
  inventory from it (see `tools/inventoryLostVideos.py`) rather than guessing.

---

## Testing

```bash
npm test        # node --test test/*.test.js
```

226 tests, all passing (as of 2026-10-24).

### Ground-truth benchmark fixtures — read before trusting a recall number

`test/qmgGroundTruth.test.js` is the curated recall/precision benchmark. Two rules:

- **A snapshot must be at OCR resolution (≥1280px wide).** Several snapshot sets under
  `data/video_scan_20260917/.../snapshots/` were saved at the *prefilter sample width*
  (640×360). Cropping the chart-stream region out of one of those leaves a ~90×79px patch
  that OCRs to nothing, so the benchmark reports 0% recall for every case and looks like a
  total pipeline failure. The test now skips sub-1280px snapshots and prefers the widest
  candidate it finds.
- **The snapshot filename index is `captureIndex + 1`** (`qmg_20220606_2.png` is capture
  index 1). The ground truth is keyed by capture index.

The test also calls `closeWorker()` when it finishes — `ocrImage()` leaves a Tesseract worker
running, which keeps the event loop alive and hangs the process.

---

## QMG OCR batch processing runbook

Use `tools/runQmgOcrBatch.js` to process multiple videos with EasyOCR. Each video gets
automatically-tuned `--temporal-decay` and `--phash-region-fraction` per date range.

### Run in chunks of 5 (never all at once — monitor each chunk before continuing)

```bash
# Sync videos + data from remote machine first, then:

# Chunk 1
node tools/runQmgOcrBatch.js --dates 20220414,20220418,20220419,20220421 --parallel 4

# Chunk 2
node tools/runQmgOcrBatch.js --dates 20220425,20220426,20220428,20220506 --parallel 4

# Chunk 3
node tools/runQmgOcrBatch.js --dates 20220510,20220517,20220606,20220614 --parallel 4

# Chunk 4
node tools/runQmgOcrBatch.js --dates 20220323,20220606,20220606b,20220606c,20221117,20230601 --parallel 4
```

After each chunk completes, check for orphans before continuing:
```bash
tasklist | findstr ffmpeg.exe
tasklist | findstr node.exe
# Kill any orphans before next chunk
```

Results go to `data/video_ocr_probe/qmg-easyocr-YYYYMMDD/`. Rsync back to this machine
for local scoring with `data/compile_results.js`.

### Dual-batch comparison run (2026-10-18/19)

**Baseline** (default settings):
```bash
node tools/qmg_ocr_batch_daemon.js remaining
# Output: data/video_scan_test/_rerun/qmg-batch-remaining/
# Flags: --max-captures 1 --fps 0.25 --prefilter-max-frames 6
# Results: 25/52 OK (25 not_found due to lowercase video ID mismatch)
```

**Alt** (2 captures instead of 1, low-CPU parallelism=2):
```bash
node tools/qmg_alt_batch_daemon.js alt
# Output: data/video_scan_test/_rerun/qmg-alt-alt/ + qmg-alt-timeout5/
# Flags: --max-captures 2 --fps 0.25 --prefilter-max-frames 6
# Results: 23/25 OK (2 io_error on 20220321/20220405)
```

**Known issue**: Windows Node.js `spawn()` throws `EFTYPE` when given a `.js` path directly as the command.
Fix: always use `spawn('node', ['path/to/script.js', ...args])` not `spawn('path/to/script.js', [...args])`.

**Daemon support module**: `tools/qmg_scan_daemon_support.js` provides the three guards every
scan daemon must use:

- `checkFreeSpace(dir)` — preflight disk check (default 20 GB free). A disk that fills mid-run
  kills ffmpeg with `No space left on device`, which surfaces as a misleading `io_error` on
  the affected videos rather than as a disk problem.
- `lowCpuEnv()` — `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `KMP_DUPLICATE_LIB_OK=TRUE`.
  Also enforced inside `src/ocr/easyocrAdapter.js`, so it applies even to ad-hoc invocations.
- `writeResults(file, payload, { keyOf, scored, mode: 'merge' })` — never-regressing results
  writing. A re-run whose leg failed keeps the previous success instead of overwriting it.
  Without this, a broken run silently destroyed a good results file (this happened to
  `data/qmg_comparison_results.json` on 2026-10-19).

**Disk space is a live constraint.** `data/video_pipeline/downloads_1080p` alone is ~215 GB and
`data/video_scan_test/_rerun` grows by ~400 MB per video. The `frames/` subdirectory of each
run tag holds regenerable intermediate PNGs and is the cheapest thing to reclaim — but it is
not covered by `tools/prune_old_probes.js` (which only handles `data/video_ocr_probe/`).

Batch files: `data/qmg_alt_batch.json` (alt) and `data/video_scan_batch_remaining.json` (baseline).
Results: `data/qmg_alt_batch_results.json` and `data/video_scan_batch_remaining_results.json`.

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
- `src/video/positionTableScan.js` — positions-TABLE reader (source-resolution, lexicon-constrained)
- `src/video/panelExtract.js` — source-resolution panel crops (shared ffmpeg/ffprobe resolver)
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

**Required env var**: `KMP_DUPLICATE_LIB_OK=TRUE` must be set when running EasyOCR — Intel OpenMP (used by EasyOCR's CPU backend) emits duplicate symbol warnings that crash the process without this flag.

### Current crop and EasyOCR defaults

The chart-stream pipeline uses a narrow crop targeting the position-list column in the bottom-right:

```
CHART_STREAM_REGION_FRACTION_DEFAULT = '0.86,0.62,0.14,0.22'   ← x,y,w,h (y = TOP edge)
```

This is defined in `src/video/ocrScanArgs.js` and is the default `phashRegionFraction` for the
`chart_stream` prefilter profile. The crop covers x ∈ [86%, 100%] and y ∈ [62%, 84%] of the frame.

**The crop region and the OCR crop width are different things.** The OCR engine receives a
*further* crop of that region, upscaled:

| Engine | Chart-stream region | Upscale | OCR input width (1080p source) |
|---|---|---|---|
| EasyOCR | x∈[0.86,1.0] of the frame | ×5 | round(0.14·1920)·5 = **1345px** |
| Tesseract | 250px-wide chart region | ×3 | 250·3 = **750px** |

The 1345px width is **resolution-dependent** — a 720p source gives round(0.14·1280)·5 = 895px.
Note the same video IDs exist in BOTH `downloads_1080p` (1920×1080) and `downloads_hires`
(1280×720), so a scan can legitimately run at either width.

This matters because `parseChartStream.js` scales its `X_POSITION_LIST_MIN` threshold by the
actual OCR crop width (see "Column detection" below). **Never hardcode the crop width** — it
is measured from the OCR input image at runtime (`_cropWidth` on the OCR result).

Defaults for a full EasyOCR scan:
```
node tools/scanVideoWithOcr.js \
  --video <path> --date <date> \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 1 --fps 0.25 --prefilter-max-frames 6 \
  --ocr-engine easyocr
```

`OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1` and `KMP_DUPLICATE_LIB_OK=TRUE` are set
automatically by `src/ocr/easyocrAdapter.js` at the Python spawn — the single choke point for
every EasyOCR invocation. Do not bypass it.

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
   EasyOCR's word bounding boxes land at different x-centers than Tesseract's, so the bucket heuristic picks a chart-area column (~x=490-510 in the 1345px EasyOCR crop) instead of the position-list column (~x=1218). Two fixes:
   - **X-coordinate gate** (`src/parse/parseChartStream.js`): when `identifyPositionListColumn` fallback fires (no price-aligned tickers), reject if `dominantX < 1150` in EasyOCR crop coords. ~86% of chart-area bleed gets blocked here.
   - **Blocklist** (`TICKER_BLOCKLIST`): `FREY` is the only confirmed persistent FP (clustered from chart annotations). P, SPYM, BKR, BOIL are real tickers — do NOT blocklist them.

3. **Use scale=5 for EasyOCR, not the dual-scale 3+4 used for Tesseract.**
   EasyOCR is slow enough (~60s) that running it twice is wasteful; the bigger image produces cleaner OCR.

4. **The chart_stream prefilter picks intro/warmup frames by default.**
   The `midToneRatioTicker` signal fires on any chart content (candles, axis labels) in the bottom-right rectangle. The fix: added `multiColStripeCountWeight: 20` — counts columns with ≥2 row-top transitions; position list has 3 spread columns → ~3 stripes, intro has 1 concentrated column → ~1 stripe. Replaced the earlier `maxColRowDensityWeight: 25` which was measuring the wrong thing (max in ONE column rewards intro, not position list).

5. **The clusterer (`clusterRawOcrTokens`) creates false-positive ticker clusters from chart noise.**
   When the per-frame parser finds no price-aligned tickers (column filter fails), `clusterRawOcrTokens` runs on raw OCR text and clusters all ticker-shape words across frames. Chart-area tokens like DOOM/JOOM/QOOM get edit-distance-corrected to GOOG (dist=2 each), SSO (RISO/RSO dist=2), QS (S/S0/S0M all dist=2). The fix: in `scanVideoWithOcr.js`, snapshot mode (QMG chart-stream) feeds `position_list` (column-filtered tickers) to the clusterer instead of raw OCR text, eliminating chart-area bleed. Additionally, edit-distance-corrected canonicals are accepted only when at least one cluster member is within distance 1 of the canonical, which eliminates chart-noise clusters while keeping real corrections (INA→TNA dist=1).

### Pipeline stages for chart-stream

```text
ffmpeg -ss <ts> -i <video>  →  sharp: extract crop region, upscale ×5, PNG (no grayscale/negate for EasyOCR)
                             →  EasyOCR (Python subprocess, ~60s/frame)
                             →  parseChartStreamPositionList (lexicon + price-nearby + column filter)
                             →  clusterRawOcrTokens (raw OCR token clustering across frames)
                             →  pickTopDistinctCandidates (dedup by phash + frame gap)
```

### Column detection (`X_POSITION_LIST_MIN`)

`identifyPositionListColumn` in `src/parse/parseChartStream.js` locates the position-list column
and rejects chart-area columns. There are two ways it finds that column:

1. **Price-aligned** (strong): tickers on rows that have a price to their right. The median
   x of those tickers is the column.
2. **Densest bucket** (fallback): the x-bucket with the most ticker-shaped words.

Only the **fallback** path is subject to the x-coordinate gate:

```
EasyOCR  (1344px reference crop): X_POSITION_LIST_MIN = 600
Tesseract (750px crop):           X_POSITION_LIST_MIN = 505
```

The EasyOCR threshold is scaled from its 1344px reference so 720p sources (895px crop) still
work: `round(600 * cropWidth / 1344)`. `cropWidth` comes from `_cropWidth` on the OCR result,
which `src/ocr/ocrImage.js` measures from the OCR input image at runtime — **never hardcode it**.

**The gate must NOT be applied to a price-aligned column.** The position-list column's x
position varies between videos (measured in a 1345px EasyOCR crop: 20220218 → x≈710,
20220606 → x≈444). Gating an absolute threshold on a correctly-detected, price-validated
column silently dropped *every* ticker on 20220606 while the detector was working perfectly.
That bug cut 20220606 recall from 75% to 12.5%.

**Engine detection** uses the OCR result's `_engine` field, not the crop width: a 720p EasyOCR
crop is 895px, which the old `cropWidth > 1000` heuristic misclassified as Tesseract.

Note the column filter is **diagnostic for EasyOCR**: the accept path uses lexicon +
price-nearby, and the column result only gates non-lexicon, non-price-nearby tickers
(see the `inListColumn` branch in `parseChartStreamPositionList`).

### Panel-boundary gate (positions / watchlist)

`findPanelBoundaries` locates the "POSITIONS" header line and the "Personal WatchList" header
line and uses them to restrict which rows may contain position-list tickers.

**The watchlist bound only applies when the watchlist header is BELOW the positions header.**
A stray `Watch…` token picked up above the panel (a chat overlay, a streamer name) would
otherwise act as a lower bound and reject *every* real row. Same rule applies inside
`identifyPositionListColumn`'s `lineIsInPanel` and to `panelGateActive`.

### Diagnostic fields exposed

- `chart_stream.column_filter` — `dominant_x`, `column_width`, `in_list_token_count` (diagnostic only, not gated)
- `chart_stream.tickers_rejected_list` — first 30 rejected tokens
- `chart_stream.position_list` — accepted tickers after per-frame parse
- `merged_position_list` — multi-frame clusterer output (dominant for EasyOCR runs)
- `merged_raw_token_clusters` — per-cluster diagnostics: `{canonical, members, frequency, frameCount}`

### Known limitations and next steps (as of 2026-10-21)

**Measured on the curated GT benchmark** (`test/qmgGroundTruth.test.js`, 4 captures,
EasyOCR, single frame each — not a multi-frame consensus run):

| case | date | recall | FP |
|---|---|---|---|
| trade_ideas | 20220218[1] | 66.7% (6/9) | 3 |
| sparse | 20221104[0] | 100% (1/1) | 3 |
| normal_2022 | 20220606[1] | 75.0% (6/8) | 4 |
| dense_2023 | 20230609[0] | 53.8% (7/13) | 1 |

Overall mean recall 73.9%. These numbers were previously meaningless — the benchmark was
resolving 640×360 prefilter frames, so every case scored 0%.

**Precision floor**: 1–4 false positives per capture. Remaining FP sources:
`TQQQ`→`TOCA` (OCR misread of a real ticker), chart-area tokens that happen to be in the
seed lexicon (`ISYM`, `MEL`, `CON`), and one-letter tokens (`ON`, `X`).

**Recall floor**: `20220606` still misses GOVX and NFLX; `20230609` misses 6 of 13. The
`meanLumaFloor=30` penalty on historical dark streams (Dec 2021–Feb 2022) likely contributes
to the prefilter missing frames entirely.


**PaddleOCR PP-OCRv6** (`tools/_paddleocr_ocr.py`): Could not install — Python 3.14 is installed; `paddlepaddle` has no cp314 wheel. Downgrade to Python 3.13 to benchmark. Interface is identical to `_easyocr_ocr.py` — schema is `{text, lines, words[{text,left,top,width,height,conf,line}],_engine,_image,_detection_count}`. Would run at ~7× EasyOCR speed (PP-OCRv6 on CPU with OpenVINO).

**Ground truth accuracy**: The `data/qmg_ground_truth.json` must be verified per video — 20220510 GT was actually TSLA+VRM (not LABU/TNA as previously assumed). Always verify GT against the actual video content before trusting recall numbers.

---

## Positions-TABLE reader (`position_table` profile)

The Qullamaggie position list is a **TradingView GUI table**, not a chart overlay. Two
layouts exist and the legacy crop reader only ever saw the first:

| layout | ticker column (of 1920) | y range |
|---|---|---|
| 2022-era floating panel, bottom-right | x ≈ 1793 | lower third |
| 2023-era right sidebar | x 1606–1648 or 1697–1739 | y 444–708 |

`src/video/positionTableScan.js` reads it. Two phases per frame:

1. **Wide title probe** — the ticker column plus 60 px to the left, first 8 ladder
   rows — to work out *which* table is the positions table.
2. **Narrow ticker-column read** at three strip variants; each variant's reading of a
   cell is one hypothesis, decoded against the lexicon (`decodeCell`).

### The rules that matter

- **Source resolution is mandatory.** The table's ticker glyphs are ~6.8 *source* px
  tall. A 1280-wide OCR frame renders them ~4.5 px and the panel reads as
  `US / D / WCU / W / KOCO` instead of `UPST / DVN / NRGU / MOS / TQQQ`. Frames below
  1600 px wide are refused (`MIN_SOURCE_WIDTH_PX`).
- **The title discriminator is the literal substring `"POS"`.** "A - Positions" is
  truncated by the panel width to `APOSI` / `APOSIS` / `AUPOSS` / `POSOS` — all contain
  `POS`. Every measured near-miss of `POS` at edit distance 1 was a **false positive**
  (`RPISLVE`, `RPISLU`, `ROSIM`). There is no digit folding: `interpretColumnStrip`
  strips every non-`A-Z` character before the title check, so a digit-obscured title
  can never reach the title rule. When the title does **not** overlap the ticker
  column the tie-break is that the positions table is the **bottom-most** table in
  the region — that is the `bottom_most` discriminator, not a title match.
- **A table is published only when positively identified** (`title`, `bottom_most`, or
  `sole_candidate` with a positively-identified watchlist vetoed) **and** it decoded
  something. A lone untitled table is *located* but not published.
- **Table-likeness** needs ≥2 ticker-shaped rows (`tickerishRows >= 2`). A `Sym`
  header alone is not enough.
- **A read that is a lexicon ticker is never the header.** `Sym` is within two edits
  of 17 real tickers (TSM, XOM, ARM, CRM, SOL, STX, VRM, NEM, SWN, SLB, SLV, SLY,
  TEM, TSEM, SGMO, SSO, SPYM), and the 2023-era table has no header row at all — so
  the header window reaches the first data rows and a holding can be eaten as the
  header and silently dropped.
- **A lone survivor has to be BELOW the vetoed watchlist.** The watchlist is docked
  above the positions table, so "whatever is left" only means the positions table
  when the frame agrees.
- **The clusterer is bypassed per FRAME, not per profile.** Each capture carries a
  `ticker_source`; a frame the table reader could not identify falls back to the
  legacy crop reader and still needs the clusterer's repair.

### Running it

```bash
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/<file>.mp4 --date 20220222 \
  --prefilter-profile position_table --output-kind snapshot \
  --basename qmg
```

`--prefilter-profile position_table` implies `--output-kind snapshot`, `--native-ocr-frame`
and EasyOCR. It costs two EasyOCR batches per frame (~54–65 s/frame); the per-image
timeout is derived from `--table-frame-budget-ms` (default 900000) rather than fixed,
so the cost scales with the number of candidates rather than multiplying it.

### Diagnostics

`position_table` in the probe log: `discriminator` (`title` / `bottom_most` /
`sole_candidate`), `title_text`, `header_text`, `rows`, `column`, `variants`,
`candidate_scores`, `decoded`, and `verified` (whether it was published).

Full derivation and measurements: `docs/qmg-positions-layout-findings.md`.
