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
- The `--sleep-requests` yt-dlp flag does NOT help `tools/importQmgChannel.js` — it resolves upload dates with a
  separate yt-dlp invocation **per video**, and a per-process flag cannot space requests across processes. It DOES
  help `whiteboard_worker.py catalog`, which is a **single** invocation over the channel URL. Two different
  "catalog refresh" tools, opposite behaviour — check which one you are running before reaching for the flag.

### Catalog worker: a partial run is kept

`whiteboard_worker.py catalog` parses yt-dlp's stdout **before** it looks at yt-dlp's exit code, so a per-video
failure does not throw away the rows that succeeded. A full Qullamaggie catalog is ~700 metadata requests and
~3.5 h; checking the exit code first cost one such run entirely (a DNS blip near the end, 3 h 23 min, no rows
kept). The summary reports `status: "ok"` or `"partial"` plus `yt_dlp_returncode`; a run that produced no rows
at all still fails, and reports yt-dlp's own error. Regression-tested in
`test/whiteboardWorkerCatalog.test.js` with a fake yt-dlp — no network required.

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
- **Pass `--parallel 4`** to the orchestrator. Worker pool is already implemented at `scanAllGtVideos.js:134-148` (`runWithConcurrency`). Default `--parallel 1` is ~6.7 h wall for a 40-video sweep.
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
| `downloads_hires/` | 720p | Mixed: 126 revere + 26 qullamaggie per SQLite (152 rows, all present on disk) + ~14 `.mp4` with no `videos` row (verify via SQLite before deleting) |
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

262 tests, all passing (as of 2026-10-26).

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

**Disk space is a live constraint.** `data/video_pipeline/downloads_1080p` holds ~20 GB right now
(49 `.mp4` = 9.5 GiB plus 39 partial `.part` downloads) and
`data/video_scan_test/_rerun` grows by ~400 MB per video. The `frames/` subdirectory of each
run tag holds regenerable intermediate PNGs and is the cheapest thing to reclaim — but it is
not covered by `tools/prune_old_probes.js` (which only handles `data/video_ocr_probe/`).

Batch files: `data/qmg_alt_batch.json` (alt). The baseline's `data/video_scan_batch_remaining.json`
and its results file `data/video_scan_batch_remaining_results.json` have been deleted and are no
longer in the tree.
Results: `data/qmg_alt_batch_results.json`.

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

# Fill in the upload_date of videos the catalog could not resolve
node tools/runWhiteboardWorker.js fill-dates --channel revere \
  --input data/catalog_flat/revere_needs_date.tsv --jobs 6

# Second pass for the stragglers: same command, slower fallback clients.
# Videos that already have a date are skipped, so only the failures are fetched.
node tools/runWhiteboardWorker.js fill-dates --channel revere \
  --input data/catalog_flat/revere_needs_date.tsv --jobs 6 \
  --extractor-args "youtube:player_client=ios,android,web"

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

### The catalog's real scale, and `fill-dates`

The channel sizes, measured 2026-10-25 with a flat listing (one channel-page
crawl, no per-video work, ~0 CPU):

| channel | videos | notes |
|---|---|---|
| Qullamaggie | 588 | newest upload 2023-12-15 — the channel is dormant |
| Revere | 1,811 | uploads daily |

**A full catalog resolves one video at a time, at ~22 s each** (network wait,
~0.001 s of CPU). Revere is therefore an ~11 h job, and Qullamaggie ~3.5 h.
That is not a mistake in the tool; it is what per-video metadata costs.

Three facts that decide how you run it:

- **The client set matters more than anything else.** Measured on the same
  videos, per video: `mweb` **4.2 s**, `mweb,ios,android,web` **8.5 s**,
  `ios,android,web` **123 s** (on the 181-video Qullamaggie list). yt-dlp
  queries **every** client in the list, so a longer list costs time on every
  video — not only on the ones that fail. `mweb` alone is the fast path.
  `web` alone returns **nothing** (exit 1), and `web_safari,web` returns
  nothing either — `web_safari` is bot-blocked. The catalog's default set is
  `ios,android,web_safari,web`, so every video pays a full *failed*
  `web_safari` attempt before `web` succeeds. Dropping it is ~2× faster.
  `mweb` needs a GVS PO Token for *streaming formats* only; metadata is fine.
- **A partial run is kept.** The worker parses stdout before it looks at the
  exit code, so a run that fails on video 600 keeps videos 1..599. Killing
  the yt-dlp child mid-run is therefore safe and imports what it printed —
  pinned by a test.
- **`fill-dates` does the rest.** The videos the catalog could not resolve are
  left in the DB with an empty `upload_date`. `fill-dates` takes a
  `video_id<TAB>title` TSV and resolves it directly, in `--jobs` parallel
  batches, then upserts through the same `upsert_catalog_rows` (so `status` and
  `download_path` are never touched). It reports `still_missing` so a second
  pass can pick up what failed.

`fill-dates` has three properties that make a long run safe:

- **It saves per batch, not at the end.** `--batch-size` (default 25) sets how
  many videos one yt-dlp invocation covers, and each batch is written as it
  lands. A run can be interrupted at any point and the work already done
  survives — the same guarantee `catalog` has.
- **It skips videos that already have a date.** So a second pass over the same
  list only fetches the stragglers, which is what makes the slow fallback
  client affordable: run the fast client over everything, then re-run with
  `--extractor-args youtube:player_client=ios,android,web` for the failures.
- **It prints progress per batch** to stderr, so a long run is not a black
  box.

### The channel slug is NOT the YouTube handle — they do not round-trip

`videos.channel` holds a **logical** name (`revere`, `qullamaggie`). The
YouTube handle is a different string, and for Revere the two are **not
interchangeable**:

| logical channel | handle | |
|---|---|---|
| `revere` | `@revereasset` | the Revere channel |
| `revere` | `@revere` | a **different, unrelated** channel |
| `qullamaggie` | `@Qullamaggie` | (case does not matter here) |

`@revere` and `@revereasset` return **completely disjoint video IDs** — a
listing of one is not the other. So a `source_url` is never built by
interpolating the channel name. `tools/whiteboard_worker.py` looks the handle
up in `CHANNEL_SOURCE_URLS`, falls back to `--source-url`, and only for an
unknown channel reads the URL back from the rows the DB already holds.

This was a real bug: an early version of `fill-dates` built
`https://www.youtube.com/@revere/videos` and stamped it on 1,582 Revere rows
before the fix. The rows' dates and titles were right; only the channel
pointer was wrong, which is exactly the kind of error that a glance at the
data will not catch.

Build the work list from the channel listing and the DB — the flat listing
already carries every title, so only the date is missing:

```bash
py -3 -m yt_dlp --flat-playlist --skip-download --print "%(id)s\t%(title)s" \
  "https://www.youtube.com/@revereasset/videos" > data/catalog_flat/revere.tsv
```

Note the flat listing writes a **literal** `\t`, not a tab, when the template
is passed through a shell — split on `chr(92) + 't'` or pass the template
through Python, where `\t` is a real tab.

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
   - **X-coordinate gate** (`src/parse/parseChartStream.js`): **REMOVED** — there is no `dominantX < 1150` gate in the code any more (no `1150` threshold in `src/`, `test/`, `config/` or the top-level `tools/*.js`; the constant `X_POSITION_LIST_MIN` survives only in comments). The live gate is structural: a column counts as the position list only if it has ≥ 4 ticker-shaped words within half a column width of the dominant x, spread over ≥ 4 distinct rows, or is price-aligned with ≥ 2 price-aligned tickers. See § 'Column detection'.
   - **Blocklist** (`TICKER_BLOCKLIST`): `FREY` (clustered from chart annotations) and `ATR` (the indicator label at the bottom of every chart — it is a real ticker symbol but never a position on Qullamaggie's list, so it is deliberately blocked; see the comment in `src/parse/parseChartStream.js`). P, SPYM, BKR, BOIL are real tickers — do NOT blocklist them.

3. **Use scale=5 for EasyOCR, not the dual-scale 3+4 used for Tesseract.**
   EasyOCR is slow enough (~60s) that running it twice is wasteful; the bigger image produces cleaner OCR.

4. **The chart_stream prefilter picks intro/warmup frames by default.**
   The `midToneRatioTicker` signal fires on any chart content (candles, axis labels) in the bottom-right rectangle. The fix: added `multiColStripeCountWeight: 20` — counts columns with ≥2 row-top transitions; position list has 3 spread columns → ~3 stripes, intro has 1 concentrated column → ~1 stripe. Replaced the earlier `maxColRowDensityWeight: 25` which was measuring the wrong thing (max in ONE column rewards intro, not position list).

5. **The clusterer (`clusterRawOcrTokens`) creates false-positive ticker clusters from chart noise.**
   When the per-frame parser finds no price-aligned tickers (column filter fails), `clusterRawOcrTokens` runs on raw OCR text and clusters all ticker-shape words across frames. Chart-area tokens like DOOM/JOOM/QOOM get edit-distance-corrected to GOOG (dist=2 each), SSO (RISO/RSO dist=2), QS (S/S0/S0M all dist=2). The fix: in `scanVideoWithOcr.js`, snapshot mode (QMG chart-stream) feeds `position_list` (column-filtered tickers) to the clusterer instead of raw OCR text, eliminating chart-area bleed. Additionally, edit-distance-corrected canonicals are accepted only when at least one cluster member is within distance 1 of the canonical, which eliminates chart-noise clusters while keeping real corrections (INA→TNA dist=1).

6. **The clusterer repairs against the OBSERVED lexicon, not the seed lexicon.**
   `loadSeedLexiconSync()` (233 tickers) is the whole-panel parser's allowlist and it is
   missing 26 tickers Qullamaggie actually held (UPST, NRGU, MOS, DWAC, SWN, ...). A
   holding the seed does not know is either dropped from its cluster or rewritten to a
   neighbouring seed ticker — on 20220218 that turned NRGU into NUGI and lost UPST
   outright. Snapshot mode therefore passes `loadDecodeLexiconSync()` (seed + observed =
   259) to the clusterer; the whiteboard branch keeps the seed allowlist as a filter,
   because there the clusterer reads raw OCR text where chart ink IS present.

7. **Filter A counts DISTINCT FRAMES, so it needs two frames to have anything to agree
   on.** With one legacy frame left the filter would empty the consensus and leave that
   frame with no repair at all — the opposite of what the per-frame table bypass
   promises. The scan tool therefore relaxes `minFrequency` to 1 when only one frame
   contributes.

### Pipeline stages for chart-stream

```text
ffmpeg -ss <ts> -i <video>  →  ffmpeg crop+scale to 1345px (crop=…,scale=…), PNG (no grayscale/negate for EasyOCR)
                             →  EasyOCR (Python subprocess, ~60s/frame)
                             →  parseChartStreamPositionList (lexicon + price-nearby + column filter)
                             →  pickTopDistinctCandidates (dedup by phash + frame gap)
                             →  clusterRawOcrTokens (raw OCR token clustering across frames)
```

Note the order of the last two: capture selection happens **first**, and the clusterer runs on
the already-selected candidates (`tools/scanVideoWithOcr.js:1595` and `:1727`). Note also that
on the EasyOCR path **ffmpeg** does both the crop and the upscale — `sharp` is used only on the
Tesseract path, where it extracts from the 1280-wide OCR-resolution frame at scale 3/4
(`src/ocr/ocrImage.js:118-120`).

### Column detection

`identifyPositionListColumn` in `src/parse/parseChartStream.js` locates the position-list column
and rejects chart-area columns. There are two ways it finds that column:

1. **Price-aligned** (strong): tickers on rows that have a price to their right. The median
   x of those tickers is the column.
2. **Densest bucket** (fallback): the x-bucket with the most ticker-shaped words.

**The x-coordinate gate this section used to describe no longer exists in the code.**
`X_POSITION_LIST_MIN` survives only in comments (`src/ocr/ocrImage.js:277`, `:371`,
`src/ocr/easyocrAdapter.js:246`) — there is no such constant in `src/parse/parseChartStream.js`.
`identifyPositionListColumn` still takes `cropWidth` and `engine` arguments
(`src/parse/parseChartStream.js:248`) but never reads them, so neither the crop width nor the
engine reaches the gate today.

The live gate is **structural** (`src/parse/parseChartStream.js:453-460`): a column counts as a
real position list only if it has **≥ 4 ticker-shaped words within half a column width of the
dominant x, spread over ≥ 4 distinct rows**, or if it is price-aligned with **≥ 2**
price-aligned tickers. Otherwise the filter returns no tickers at all
(`inListTickers: new Set()`, `dominantColumnX: null`), which is the tell in the log
(`column_filter: null`).

Two dead ends are worth remembering, because the shape test replaced both of them:

- **An absolute x threshold cannot work.** The position-list column's x position varies
  between videos (measured in a 1345px EasyOCR crop: 20220218 → x≈710, 20220606 → x≈444). Gating
  an absolute threshold on a correctly-detected, price-validated column silently dropped
  *every* ticker on 20220606 while the detector was working perfectly. That bug cut 20220606
  recall from 75% to 12.5%.
- **A threshold scaled by crop width cannot work either.** The panel moved between video eras
  *and* the crop width changed with it, so no fixed px value survives both ends of the corpus.

**Engine detection** used the OCR result's `_engine` field, not the crop width: a 720p EasyOCR
crop is 895px, which the `cropWidth > 1000` heuristic misclassified as Tesseract. That
heuristic lived in `src/parse/parseChartStream.js` and is in no file under `src/` or `tools/`
now — `grep -rn "cropWidth > 1000" src/ tools/` finds nothing. Treat it as history.

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
- `merged_position_list` — the VIDEO-level holdings list. For a chart_stream scan it is
  the multi-frame clusterer's consensus (the only reading repaired across frames); for a
  position_table scan the table captures contribute their own decoded holdings. A
  capture keeps what its OWN frame showed — `captures[n].tickers` and
  `captures[n].chart_stream.position_list` are the same list for a chart_stream capture,
  and the aggregator reads the latter.
- `merged_raw_token_clusters` — per-cluster diagnostics: `{canonical, members, frequency}`.
  The clusterer computes a per-cluster `frameCount` (`src/parse/parseChartStream.js:1230`) but the
  emitter does not write it (`tools/scanVideoWithOcr.js:1814-1818`), so it never appears in the logs.

### Known limitations and next steps (as of 2026-10-25)

**Measured on the curated GT benchmark** (`test/qmgGroundTruth.test.js`, 4 captures,
EasyOCR, single frame each — not a multi-frame consensus run), at commit `8070601`:

| case | date | recall | FP |
|---|---|---|---|
| trade_ideas | 20220218[1] | 88.9% (8/9) | 2 |
| sparse | 20221104[0] | 100% (1/1) | 3 |
| normal_2022 | 20220606[1] | 87.5% (7/8) | 3 |
| dense_2023 | 20230609[0] | 46.2% (6/13) | 3 |

Overall mean recall 80.6%. These numbers were previously meaningless — the benchmark was
resolving 640×360 prefilter frames, so every case scored 0%.

**The benchmark is deterministic, not noisy.** Two consecutive runs (2026-10-25, 512 s and
461 s) produced byte-identical per-case numbers, hits and FP counts. So a change in this
table means the *code* or the *input frames* changed — not that the measurement drifted.

**The input frames are not pinned.** `resolveSnapshotPath` scans `SNAPSHOT_ROOTS` plus every
`data/video_scan_test/_rerun/<run-tag>/snapshots/` directory and keeps the **widest** file
named `qmg_<date>[_<n>].png`. A new re-run directory can therefore change which frame a case
is scored on — the same "a frame's identity is its FILE, not its label" trap as elsewhere.
Re-measure and re-read the table together; they are only valid as a pair.

The frames the 80.6% measurement above was taken on, all 1920 px:

| case | frame |
|---|---|
| trade_ideas | `data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220218_2.png` |
| sparse | `data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20221104.png` |
| normal_2022 | `data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606_2.png` |
| dense_2023 | `data/video_scan_test/_rerun/qmg-easyocr-20261012/snapshots/qmg_20230609.png` |

Two of the four live under the **gitignored** `data/video_scan_test/` tree, so a clean clone
cannot reproduce the benchmark at all. The earlier 73.9% figure was not measured against a
named frame set, which is why it cannot be reconciled with 80.6% from the record alone.

**Precision floor**: 2–3 false positives per capture. Remaining FP sources:
`TQQQ`→`TOCA` (OCR misread of a real ticker), chart-area tokens that happen to be in the
seed lexicon (`ISYM`, `MEL`, `CON`), and one-letter tokens (`ON`, `X`).

**Recall floor**: `20220606` now misses only `TNA` (GOVX and NFLX are found); `20230609`
misses 7 of 13 — `IOT`, `AI`, `PLTR`, `GTLB`, `GSIT`, `APLD`, `MNDY` — and is the case
that holds the mean down. The
`meanLumaFloor=30` penalty on historical dark streams (Dec 2021–Feb 2022) likely contributes
to the prefilter missing frames entirely.


**PaddleOCR PP-OCRv6**: the packages ARE installed — `tools/paddle311_env` (Python 3.11.9) has
paddleocr 2.7.3 + paddlepaddle 2.6.2, and `tools/paddle312_env` / `tools/paddle_env`
(Python 3.12.14) have the same. What fails is the **MODEL download**, not the install:
`tools/paddle312_status.txt` records "PaddleOCR blocked: Baidu CDN
(paddleocr.bj.bcebos.com) unreachable; packages install but model download fails. Use
--easyocr-python tools/paddle311_env/Scripts/python.exe when network available." The adapter
`tools/_paddleocr_ocr.py` **does not exist yet** — it still has to be written, with the same
schema as `_easyocr_ocr.py` — `{text, lines, words[{text,left,top,width,height,conf,line}],_engine,_image,_detection_count}`. Would run at ~7× EasyOCR speed (PP-OCRv6 on CPU with OpenVINO).

**Ground truth accuracy**: The `data/qmg_ground_truth.json` must be verified per video — 20220510 GT was actually TSLA+VRM (not LABU/TNA as previously assumed). Always verify GT against the actual video content before trusting recall numbers.

---

## Positions-TABLE reader (`position_table` profile)

The Qullamaggie position list is a **TradingView GUI table**, not a chart overlay. Two
layouts exist and the legacy crop reader only ever saw the first:

| layout | ticker column (of 1920) | y range |
|---|---|---|
| 2022-era floating panel, bottom-right | x 1795–1820 | lower third |
| 2023-era right sidebar | x 1606–1648 or 1697–1739 | y 617–937 |

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
- **The frame budget is uniform, so the best frame is swapped in.**
  `selectFramesForOcr` reserves a uniform sample across the timeline, and its stride
  heuristic makes that reserve the WHOLE budget for a long video — which starves the
  only branch that consults `--prefilter-threshold`. So in table mode the best-scoring
  prefilter frame replaces the uniform frame **nearest** it (not the last one: the
  nearest is the one the capture dedup would drop anyway). The swap does not happen in
  batch mode, where the selected rows are replaced wholesale, and the best frame has
  to pass the threshold — otherwise `--prefilter-threshold` would do nothing at all.
- **The title discriminator is the literal substring `"POS"`.** "A - Positions" is
  truncated by the panel width to `APOSI` / `APOSIS` / `AUPOSS` / `POSOS` — all contain
  `POS`. Every measured near-miss of `POS` at edit distance 1 was a **false positive**
  (`RPISLVE`, `RPISLU`, `ROSIM`). There is no digit folding: `interpretColumnStrip`
  strips every non-`A-Z` character before the title check, so a digit-obscured title
  can never reach the title rule. When the title does **not** overlap the ticker
  column the tie-break is that the positions table is the **bottom-most** table in
  the region — that is the `bottom_most` discriminator, not a title match.
- **A table is published when it was identified and it decoded something.**
  `publishTableHoldings` publishes only a reading that is `found` **and** `verified` **and**
  produced tickers; anything else falls back to the legacy crop reader. `title` is a positive
  identification. `bottom_most` is only a **positional tie-break** — the lowest table in the
  right-hand region — and is granted `verified` with no title evidence
  (`src/video/positionTableScan.js:465`); it does require at least two table-shaped candidates
  and picks the bottom-most of them. So a `bottom_most` publication is a prior, not an
  identification, and it can carry false positives: at the pre-fix `a15f66a` the 20220606 c1
  frame (`93514908`) had only **two** candidates — a 4-row chart-area column at y 100–161 and a
  3-row one at y 376–436 — and `bottom_most` took the lower of the two, publishing one junk cell
  that happened to hit the two-letter lexicon ticker `SE` — 0/8, 1 FP. `sole_candidate`
  requires a positively-identified watchlist vetoed **and** the survivor below it; a lone
  untitled table with nothing vetoed is *located* but not published, while a lone table
  **below** a vetoed watchlist **is** published.
- **Table-likeness** needs ≥2 ticker-shaped rows (`tickerishRows >= 2`). A `Sym`
  header alone is not enough. "Ticker-shaped" is loose — a **one-character** row counts
  (`src/video/positionTableScan.js:330-335`, which rejects only `letters.length > 5`) — so a
  column of 1–2 letter junk can qualify as a table.
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
- **The glyph-merge rule must be ASYMMETRIC.** `extractWords`
  (`src/video/positionColumn.js`) chains row runs into glyphs. The chaining test is
  `overlap / shorter > 0.4` **plus** `overlap / longer >= MIN_MERGE_SUPPORT` (3 %).
  The second test is not optional: `shorter` alone is symmetric, so a 1 px panel
  border wholly inside a 51 px header rule merges with it — the fused glyph spanned
  the whole 2023 sidebar (y 687–884) and `extractWords`'s consume step then deleted
  the ticker of every row in between. The floor sits in a narrow window: below the
  1-in-20 ratio a letter's stem has inside a 20 px bar (0.05, must keep merging) and
  above the 1-in-51 ratio the border has under the rule (0.02, must not).
  `test/positionColumnMerge.test.js` pins both sides.
- **The seed lexicon contains OCR VARIANTS, and they publish verbatim.** Nine rows of
  `config/ticker_lexicon_seed.csv` (`AROQ`, `ARCQ`, `OBTS`, `GSII`, `IOI`, `PLIR`,
  `NUGI`, `GSlT`, `MNOY`) are not tickers but the *shape* a ticker takes when
  it is misread. An exact lexicon hit short-circuits the decoder at cost 0, so `PLIR`
  publishes as `PLIR` at 0.000 and never competes with `PLTR` (whose repair would
  cost 0.375 — `I>T` at count 3 of a model max of 4). That is where 4 of the 7
  measured false positives came from. The tenth variant row, `~09r3`
  (`config/ticker_lexicon_seed.csv:246`), is the exception: it **cannot** publish
  anything, because the decoder strips every non-A-Z character out of the read before
  the lookup (`src/normalize/tickerDecode.js:157`), so the read arrives as `R` and
  never matches the key `~09R3`; `GSlT` publishes uppercased, as `GSLT`. Deleting the
  variant rows would let `PLIR` decode to `PLTR` and nothing else would be lost —
  `URNM` is itself a seeded row (`config/ticker_lexicon_seed.csv:200`) and decodes at
  cost 0 either way — but it has not been done.
- **A frame's identity is its FILE, not its label.** Four **source-width** files are named
  `qmg_20230609.png` in four run directories and hold three distinct images (the tree also
  holds two 640×360 prefilter renders under that name), so two
  measurements labelled "20230609 c0" can disagree without either being wrong. Always
  name the run directory, the file and its md5. `tools/buildPositionCorpus.js` used to
  pick the canonical frame by the first three path segments of the run directory, which
  every run under `data/video_scan_test/_rerun/` shares — the winner was decided by
  directory-walk order, i.e. by accident. It now uses the whole run path with the
  directory's mtime as the "later run" signal.

### Running it

```bash
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/<file>.mp4 --date 20220222 \
  --prefilter-profile position_table --output-kind snapshot \
  --basename qmg
```

`--prefilter-profile position_table` REQUIRES `--output-kind snapshot` — the combination is
refused otherwise — and forces the source-resolution OCR frame and EasyOCR. There is no
`--native-ocr-frame` flag: the source frame is implied by the profile. It costs two
EasyOCR batches per frame; the per-image timeout is derived from
`--table-frame-budget-ms` (default 900000) rather than fixed, so the cost scales with
the number of candidates rather than multiplying it.

**Wall clock**: on an idle machine a frame costs **162–257 s** — the right order of
magnitude, not a floor; EasyOCR swings by 2× on the same file between runs. The
profile's 3 prefilter frames make a video **8–13 minutes**. That does not fit the
300 s per-video kill timer in § 'Scan orchestration safety', so a table-mode run needs
a timer of its own or fewer frames.

### Diagnostics

`position_table` in the probe log: `discriminator` (`title` / `bottom_most` /
`sole_candidate`), `title_text`, `header_text`, `rows`, `column`, `variants`,
`candidate_scores`, `decoded`, and `verified` (whether the table was **positively
identified** — publication also needs a non-empty decode, see `publishTableHoldings`).

Full derivation and measurements: `docs/qmg-positions-layout-findings.md`.
