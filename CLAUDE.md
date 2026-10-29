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
npm test              # everything except the OCR benchmark (471 tests, ~30 s)
npm run test:benchmark  # test/qmgGroundTruth.test.js alone (~23 min, EasyOCR)
npm run test:all        # everything, benchmark included -- FAILS under contention
```

471 tests, all passing (as of 2026-10-29).

**The benchmark has to run on its own.** `test/qmgGroundTruth.test.js` is a
23-minute EasyOCR benchmark, and `node --test` runs the test *files* in
parallel — against the rest of the suite it fails, because four EasyOCR
benchmarks plus a dozen other files do not fit in one machine's memory and CPU
at once. On its own it reproduces the table below exactly (88.9% / 100% /
87.5% / 46.2%, overall 80.6%). `npm test` therefore skips it, and says so on
the first line of its output.

**Re-verified 2026-10-29 against the pinned fixtures**: the same four numbers,
all four cases passing, in 864 s. The frames are now md5-pinned, so this
number is a property of (code, frame) and the two must be quoted together.

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

### The benchmark's frames are now tracked (fixed 2026-10-29)

**All four curated frames used to live under gitignored trees**, so a fresh clone
had none of them, and the only tracked copies were at the *prefilter sample width*
(640×360) — which the test's own `MIN_SNAPSHOT_WIDTH = 1280` filter rejects. The
hard `assert.equal(missingSnapshots.length, 0)` therefore **failed on every fresh
clone**.

The four 1920×1080 frames are now committed under `test/fixtures/qmg_benchmark/`,
with a `manifest.json` that records, per frame, the case, the capture index, the
snapshot file index, the pixel size, the **md5** and the path it was copied from:

| case | fixture | md5 | copied from |
|---|---|---|---|
| `trade_ideas` 20220218[1] | `trade_ideas_20220218_c1.png` | `d6a45e350aeacf16c704d324f0ed18a5` | `data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220218_2.png` |
| `sparse` 20221104[0] | `sparse_20221104_c0.png` | `7d766f71608427d09c8dbf0592b81445` | `data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20221104.png` |
| `normal_2022` 20220606[1] | `normal_2022_20220606_c1.png` | `e34b828300318085b07166a87aa50f98` | `data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606_2.png` |
| `dense_2023` 20230609[0] | `dense_2023_20230609_c0.png` | `d53cb5fab33eba46e73ba40a7477f91e` | `data/video_scan_test/_rerun/qmg-easyocr-20261012/snapshots/qmg_20230609.png` |

`resolveSnapshotPath` now **prefers the tracked fixture** and falls back to the old
widest-candidate search. It verifies the fixture's md5 and **throws** if the file
has changed, because replacing a frame silently would invalidate every recorded
number. A curated case whose frame cannot be found is now **skipped with a
warning** rather than failing the run — the benchmark degrades to "fewer cases",
not to "no answer".

`test/qmgBenchmarkFixtures.test.js` is the fast half of this check (seconds, no
OCR): every curated case has a tracked frame, every frame is at OCR resolution,
every frame's md5 matches the manifest, and the manifest records where each frame
came from.

**A frame's identity is its FILE, not its name.** Each benchmark filename
exists in several directories and the copies are *different images* — five
copies of `qmg_20220606_2.png`, three of them md5 `93514908`, which is the
frame CLAUDE.md's `position_table` section describes as the bad one (a junk
`SE` cell, 0/8). Before the fixtures were pinned, which frame the benchmark
scored depended on directory-walk order. Now it is pinned by md5. **Name the run
directory, the file and its md5 whenever a number is quoted** — and if a frame is
deliberately replaced, update `manifest.json` and the recorded numbers together.

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
- `tools/evalParserReplay.js` — replay the captured logs through the current parser and score it (see below)
- `tools/evalRevere.js` — score the Revere whiteboard path against `data/revere_ground_truth.json` (see below)
- `tools/aggregateScanResults.js` — merge scan output into `analysis.json`
- `tools/aggregateOcrTimeline.js` — merge into `timeline.json`
- `tools/viewTimeline.html` — interactive timeline viewer

### OCR pipeline
- `src/ocr/ocrImage.js` — Tesseract wrapper; `chart-stream` profile crops overlay region
- `src/video/ocrScanLogic.js` — prefilter scoring, candidate building, screenshot logic
- `src/video/ocrScanArgs.js` — CLI argument parsing; `CHART_STREAM_REGION_FRACTION_DEFAULT`
- `src/parse/parseChartStream.js` — Qullamaggie position-list ticker extraction
- `src/parse/parseWhiteboardScreenshot.js` — GRO/TURBO/Revere whiteboard parser
- `src/parse/parseWhiteboardScreenshotWithBoxes.js` — the Revere whiteboard's POSITIONAL parser (the one the scan tool runs)
- `src/video/positionTableScan.js` — positions-TABLE reader (source-resolution, lexicon-constrained)
- `src/video/panelExtract.js` — source-resolution panel crops (shared ffmpeg/ffprobe resolver)
- `src/video/imageHash.js` — full-frame pHash
- `src/video/imageHashRegion.js` — region-crop pHash (chart overlay)

### Normalization
- `src/normalize/tickerScan.js` — seed lexicon + strict ticker pattern
- `src/normalize/tickerFuzzyResolve.js` — the resolver: match lexicon vs allow list, ambiguity-aware correction, fused-token splitting (see below)
- `src/normalize/videoTypeClassifier.js` — whiteboard / chart_stream / DMI / tale_of_the_tape
- `src/normalize/repairHoldings.js` — Revere-only position repair

### Aggregation
- `src/video/captureTickers.js` — which field of a capture holds its holdings (see below)
- `src/video/probeLogDirs.js` — the three probe-log directory layouts (see below)
- `src/video/portablePaths.js` — makes the paths a probe log recorded portable for a committed artifact (see below)

### Download
- `src/video/downloadCandidates.js` — the 1080p candidate query + on-disk check + the JS half of the portable-path rule (see below)
- `src/video/videoStatus.js` — what each `videos.status` value means, who writes it, and the downloaders' work lists (see below)
- `tools/reportPartialDownloads.py` — reports the orphan `.part` files; never deletes (see below)
- `tools/reconcileCatalogStatus.js` — reconciles `videos.status` against the filesystem (see below)

### Catalog

- `tools/resolveUndatedDates.js` — dates the rows `fill-dates` could not, by reading the watch page and cross-checking it against the listing order (see below)

### Data

- `data/video_pipeline/state.sqlite` — canonical SQLite database, **tracked in git** (the catalog)
- `data/db/schema.sql` — schema source of truth
- `config/ticker_lexicon_seed.csv` — ticker allowlist (Revere + Qullamaggie)

---

## Aggregation and download plumbing (fixed 2026-10-29)

Five defects, all fixed together. Each is pinned by a test.

### Which field of a capture holds its holdings — `src/video/captureTickers.js`

The aggregator used to read `capture.tickers_from_bbox` for whiteboard captures.
**No writer emits that field at capture level**: across 677 probe logs / 1281
captures it is present in **zero**. The value the whiteboard parser actually
produces lives in `capture.parsed_observations[].tickers_from_bbox` — a strict
subset — and the full reading lives in `capture.tickers`.

Routing a capture's holdings by screen layout:

| layout | field | notes |
|---|---|---|
| `chart_stream` | `capture.chart_stream.position_list` | the column-filtered, per-frame reading |
| everything else | `capture.tickers` | the whiteboard/clusterer consensus |

The measured effect of getting this wrong: **269 captures with tickers / 52
unique tickers** → **271 / 56**. The four recovered tickers (`COPX`, `DVN`,
`MOS`, `NRGU`) are real Qullamaggie holdings, and two chart-stream captures
contribute at all for the first time. **Re-running the aggregator used to
regress the committed `data/analysis.json`** — that is what this fix stopped.

### The three probe-log directory layouts — `src/video/probeLogDirs.js`

A run tag's probe logs live under one of three layouts:

| layout | path | produced by |
|---|---|---|
| flat | `<date>/<tag>/ocr_probe/logs` | `scanVideoWithOcr.js` |
| doubled | `<date>/<tag>/<tag>/ocr_probe/logs` | `parallelOcrScan.py` |
| legacy root | `<date>/ocr_probe/logs` | the pre-Qullamaggie structure |

`tools/aggregateOcrTimeline.js` resolved only the flat layout, so it **could not
find the logs of any doubled-layout run** — every run with a committed
`timeline.json` uses the doubled layout, and the tool exited 1 with
"No probe logs found" before writing anything. Both aggregators now share one
list, in `src/video/probeLogDirs.js`, so they cannot drift apart again; the
first layout that exists wins.

### The 1080p candidate query — `src/video/downloadCandidates.js`

`tools/downloadQmg1080p.js` selected **47 of 588** Qullamaggie rows: its SQL
required `download_path NOT LIKE '%downloads_1080p%'`, which excluded every row
whose pointer mentioned that directory — including the rows that needed a
*second* 1080p copy. The query is now in `src/video/downloadCandidates.js` and
shared between the tool and the tests:

```sql
SELECT video_id, upload_date, title, download_path FROM videos
WHERE status IN ('pending','scanning')
AND channel = 'qullamaggie'
ORDER BY upload_date DESC, video_id ASC
```

**588 candidates, 49 already on disk, 539 still need a 1080p download.**
`findHiresOnDisk` checks the downloader's own name (`<date>_<id>.mp4`) and then
the catalog pointer, and only accepts a path inside `downloads_1080p` — a
720p copy in `downloads_hires` deliberately does **not** count.

### The recovery manifest — `tools/inventoryLostVideos.py`

The manifest listed every catalog row that had a `download_path` (716 of them)
and its note claimed they had all been deleted on 2026-10-21. That was wrong on
both counts: **179 are still on disk**, and **514 point at a filename under an
older naming scheme** (`downloads_1080p/<video_id>.mp4` instead of
`downloads_1080p/<upload_date>_<video_id>.mp4`), so those pointers never
resolved whatever happened to the media.

A pointer is not evidence that a file is missing, and not evidence that one is
present. The tool now asks the disk **two** questions for every row, because
there are two ways a row's media can be found: does the **pointer** resolve to
a real file, and does a file named **the way the downloader writes it**
(`<upload_date>_<video_id>.mp4`) exist in one of the download directories?

**The second question is the one a pointer-only inventory does not ask.** A
video can be on disk with no pointer naming it, and two rows in the shipped
catalog are in exactly that state — `bEidyFtV-lY` and `M0pV73RV2qo`, both
Revere, both with their media in `downloads_hires` under the downloader's own
name while their pointer names the `downloads/` directory that was emptied on
2026-10-21. Asking only about the pointer called them **missing** and put
them in the re-download list, which contradicts the tool's own stated
principle in the most literal way possible. The two-question rule is the one
`tools/reconcileCatalogStatus.js` and `src/video/downloadCandidates.js`
already use; the inventory now uses the same one.

The 716 pointer rows break down exactly:

| where the media is | naming scheme | missing | present |
|---|---|---|---|
| `downloads_1080p` | `<video_id>.mp4` (the older scheme) | **514** | 0 |
| `downloads_1080p` | `<upload_date>_<video_id>.mp4` (today's) | 0 | 27 |
| `downloads_hires` | — | 0 | 152 |
| `downloads_hires` | (pointer stale, media under the own name) | 0 | 2 |
| `downloads/` | — | **21** | 0 |
| **total** | | **535** | **181** |

So **every** missing row is one the current naming convention cannot reach: 514
because the pointer names the bare `<video_id>.mp4` and 21 because the whole
`downloads/` directory is gone.

The manifest has:

| key | meaning |
|---|---|
| `pointer_rows` | rows in the catalog with a pointer (716) |
| `present_count` / `present_videos` | how many of those are actually on disk (181) |
| `present_by_own_name_count` | how many were found by their own name, not by their pointer (2) |
| `total` / `videos` | the **missing** ones — the re-download list (535) |
| `qullamaggie_count` / `qullamaggie_present_count` | the QMG subset (514 missing, 53 present) |

Each entry carries `expected_filename` (the name the file has *today*) and
`pointer_uses_legacy_name` (why the pointer does not resolve). Each **present**
entry also carries `found_by` (`pointer` or `own_name`) and `media_path` (where
the file actually is — relative to the repository root when it is inside it,
absolute when it is not).

**A file can be on disk with no pointer naming it.** `downloads_1080p` holds 49
`.mp4`, and **all 49 are found by the downloader's own name** — the catalog
pointer resolves only 27 of them. The other 22 are the videos whose pointer is
empty or names the older scheme, so the pointer is the wrong way to ask
"is it already downloaded?".

**The 535 need nothing written for them.** 198 are `pending` and 316 are
`scanning`, and both downloaders' candidate lists already contain those two
statuses, so they will be fetched. What is *not* the case is a bulk pointer
repair: of the 535, only the two rows above have their media anywhere on disk,
and every other one is genuinely lost. Pointing a row at a `.part` file, or at
any file whose name merely *contains* the video id, would suppress 37 further
1080p downloads — `findHiresOnDisk`'s pointer branch has no size check.

---

## Catalog paths, migrations and the listing report (2026-10-29)

### A stored path is relative when it can be

The tracked catalog is read on other machines, so a path inside the repository
is stored **relative to the repository root**, and a path outside it keeps its
absolute form — there is no honest relative form for a path from another
machine. The rule, in one line:

```python
def portable_stored_path(value):
    """A path inside the repo becomes repo-relative; one outside stays absolute."""
    if not value: return value
    candidate = Path(str(value))
    if not candidate.is_absolute(): return str(value)
    return portable_path(candidate)
```

**Two implementations of this rule exist and must agree** — the column is
written from Python and from JavaScript:

| language | function | file |
|---|---|---|
| Python | `portable_stored_path()` | `tools/whiteboard_worker.py` |
| JavaScript | `toPortablePath()` | `src/video/downloadCandidates.js` |

`test/catalogPathPortability.test.js` pins the agreement: it asserts the two
produce the same string for the same input, that they round-trip through
`resolveCatalogPath()`, and that **every** relative pointer in the shipped
catalog resolves to a file that is actually there.

**Migration 3** rewrote the shipped catalog's pointers in place: **392**
absolute in-repo pointers became repo-relative, and **not one** of them changed
what they resolve to (each rewritten pointer was compared against its old
absolute path — 0 mismatches, 179 present / 537 missing before and after). A
pointer that points outside the repository is left alone.

### A path recorded on ANOTHER machine — `src/video/portablePaths.js`

The rule above answers "is this path inside the repository?" by comparing
against **the current** repository root, which works for a path this machine
wrote. The committed **probe logs** are a third case: they record the absolute
paths of the machine that ran the scan, and that machine is often not this one.

Measured on the committed `data/analysis.json` before the fix: **1,185**
absolute path values — 629 `top_rejected_candidates[].frame_path`, 416
`captures[].output_path` and 140 `video_path`. **1,175 of them pointed into
this repository**, and therefore had an honest relative form; the other **10**
pointed at `D:\courses_F\revere_asset\videos`, which is outside the
repository and stays absolute. So the committed artifact named one person's
home directory, and could not be regenerated from a fresh clone.

`src/video/portablePaths.js` applies the same rule to paths that come out of a
probe log, and answers "inside the repository?" by the repository's own
layout rather than by the current root: **everything inside the repository
lives under `data/`**, so a recorded path containing that segment is inside a
checkout of this repository, wherever that checkout was. Two guards keep it
honest:

| guard | why |
|---|---|
| the segment after `data/` must be a directory this repository has (or a `video_scan_YYYYMMDD`) | `D:\my\data\videos\x.mp4` is not in the repository, and truncating it would point at a file that does not exist |
| `data` must be a **whole** segment | `D:\mydata\videos\x.mp4` is not a marker |

`portabilizePaths()` rewrites **only** values under a key that names a path
(`output_path`, `video_path`, `frame_path`, `log_path`, `output_root`, …), so
OCR text that happens to contain something path-shaped is left exactly as the
OCR engine returned it.

**The raw probe logs keep their absolute paths.** They are machine output —
the record of what a run produced — and rewriting them would change the
evidence. The *derived* artifact is the thing a reader consumes, and that is
what is portable. `data/analysis.md`'s "Saved files" links are now relative
to the report, so they resolve in a clone; they were `C:\Users\admin\...`
before, which resolved nowhere else.

Pinned by `test/analysisArtifactPortability.test.js`: the unit behaviour, the
invariant on the committed artifact (**no absolute value may point into the
repository**), and a **fresh-clone reproduction** — a copy of the tracked
files is the only input available, so an untracked log or a hardcoded path
shows up as a difference.

**The aggregator is idempotent.** `writeIfChanged()` compares the rendered
artifact with the committed one *ignoring the generation timestamp*, so a
re-run over an unchanged corpus leaves the file byte-identical and says
`unchanged … (same content, so it was not rewritten)`. A verification run
used to dirty the working tree with a changed timestamp and nothing else,
which made "did the aggregator change anything?" impossible to answer with
`git diff`.

### The migrations are version-gated, and each one is additive

`_apply_migrations()` in `tools/whiteboard_worker.py` applies migrations in
order and records them in `schema_version`:

| version | what it does |
|---|---|
| 1 | adds `channel` to `videos` and `catalog_runs`, then backfills it |
| 2 | adds `catalog_runs.kind` (`live` / `fixture`) |
| 3 | rewrites absolute in-repo `videos.download_path` and path-shaped `worker_settings` rows to the portable form |
| 4 | adds `catalog_runs.not_listed_count` |
| 5 | adds `catalog_runs.listing_complete` |
| 6 | adds `catalog_runs.row_count_kind`, then reconstructs it for the old rows |

**`row_count` means two different things.** A catalog run counts the rows a
channel listing yielded; a `fill-dates` run counts the videos in its work
list. The two are not comparable, and the audit table did not say which was
which. `row_count_kind` now says it: `listing_rows` or `work_list_videos`,
and `''` for a run that made no such claim.

**The old rows are reconstructed, not guessed.** Version 6 reads each run's
`raw_output_path` and takes the artifact's file name: `catalog_*` is a
listing run, `listing_*` / `fill_dates_*` are work-list runs, and anything
else claims nothing. In the shipped catalog that is 27 `listing_rows` and 2
`work_list_videos`.

**Version 1 has to add the column before it backfills it.** It once ran
`UPDATE catalog_runs SET channel = …` unconditionally, which aborts with
"no such column: channel" on a database written before that column existed —
leaving the database unopenable rather than half-migrated. The `PRAGMA
table_info` guard that version 2 uses for `kind` now guards version 1 too.

**Versions 4 and 5 are two migrations, not one.** Adding `listing_complete` to
an existing version 4 was a mistake: the `catalog --playlist-items 1` run had
already applied and recorded version 4, so `current < 4` was false and the new
`ALTER TABLE` never ran. Splitting it into version 5 fixed it. The lesson is
general: **a migration version, once applied, is closed.**

### The catalog's rows a listing did not contain

`catalog` now reports which of the channel's catalog rows were **not** in the
listing the run fetched (`not_listed`, `not_listed_count`, and the ids
themselves), and records both that count and `listing_complete` in the
`catalog_runs` audit row.

**Absence from a `/videos` listing is an observation, not proof of deletion.**
A video that became a Short, a livestream or members-only content is not
listed there either. And `listing_complete` is 0 whenever the listing cannot
be trusted — a `--limit`, a `--playlist-items`, or any `ERROR` on stderr makes
a missing row prove nothing. (`--ignore-errors` makes yt-dlp exit 0 on a
per-video failure, so the exit code alone cannot prove a listing was complete;
the stderr `ERROR` lines are what matters.)

**The 2026-10-28 audit's "7 Revere rows are no longer returned by the channel"
does not reproduce.** Against a fresh listing of `@revereasset` taken 2026-10-29
(1,814 videos) against a catalog of 1,813 Revere rows, **zero** rows were
missing from the listing; the only difference was one brand-new upload
(`NqkkWLhHiL0`, 2026-10-28), which has since been added. The original claim came
from a listing that was itself stale.

The catalog now holds **2,402 videos** (1,814 Revere + 588 Qullamaggie), and
**zero** rows are missing from their channel's listing.

### The orphan `.part` files — `tools/reportPartialDownloads.py`

40 partial downloads, **10.15 GiB**, sit in the pipeline directories. A `.part`
file is yt-dlp's name for a download in progress; one that stopped growing
means the download was killed and left the file behind. The tool **reports and
never deletes** — a partial file may be the only copy of a download worth
resuming, so reclaiming the space is a separate, deliberate step.

| | |
|---|---|
| in the catalog | **40 of 40** |
| a completed copy exists (the partial file is redundant) | **1** |
| no completed copy exists (the partial file is all there is) | **39** |

All 40 are Qullamaggie, all dated 2026-09-22…24. The one redundant file is
`downloads_hires/20230601_1HFPeLD2zwc.mp4.part` (247.4 MB) — the completed
`downloads_1080p/20230601_1HFPeLD2zwc.mp4` exists. The other 39 are the only
copy of those downloads.

**Matching a `.part` file to a video needs both id forms.** A September 2026
download run named its files `<_id>.mp4.part`, with an underscore prepended to
the id — and some Qullamaggie ids start with an underscore themselves. So
`_Vn-EBl95hes.mp4.part` is the video `Vn-EBl95hes`, and `__2urSPdZVec.mp4.part`
is the video `_2urSPdZVec`. Without both forms, **37 of the 40 files look like
they are not in the catalog at all.**

One video was downloaded twice under both spellings:
`downloads_1080p/uTMK9uhQZCc.mp4.part` (1005.8 MB) and
`downloads_1080p/_uTMK9uhQZCc.mp4.part` (624.4 MB).

---

## Common commands

```bash
# Catalog (adds new videos from a channel)
node tools/runWhiteboardWorker.js catalog --channel qullamaggie --source-url https://www.youtube.com/@Qullamaggie/videos

# Fill in the upload_date of videos the catalog could not resolve.
# --build-listing fetches the channel listing first, so this needs nothing but
# the channel and the database -- it runs on a fresh clone.
node tools/runWhiteboardWorker.js fill-dates --channel revere --build-listing --jobs 6

# Second pass for the stragglers: same command, slower fallback clients.
# Videos that already have a date are skipped, so only the failures are fetched.
node tools/runWhiteboardWorker.js fill-dates --channel revere --build-listing --jobs 6 \
  --extractor-args "youtube:player_client=ios,android,web"

# Work list from an existing listing instead of fetching one
node tools/runWhiteboardWorker.js fill-dates --channel qullamaggie \
  --from-listing data/catalog_flat/qullamaggie.tsv --jobs 6

# Download hires
node tools/downloadHiresBatch.js --only-ids <ids> --height 720

# OCR scan (qullamaggie)
node tools/scanVideoWithOcr.js --video-dir data/video_pipeline/downloads_hires/ --file <video.mp4> \
  --prefilter-profile chart_stream --chart-stream-parser --basename qmg --output-kind snapshot

# Aggregate
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/

# Replay the captured logs through the current parser and score it.
# Prints a census of what it could and could not reach -- read it with the
# number, never without it.
node tools/evalParserReplay.js
node tools/evalParserReplay.js --json
node tools/evalParserReplay.js data/video_ocr_probe data/video_scan_test/_rerun

# Score the Revere whiteboard path against its ground truth.
# This scores the RECORDED probe logs, not a re-parse.
node tools/evalRevere.js
node tools/evalRevere.js --json

# Prune old probes
node tools/prune_old_probes.js           # dry-run
node tools/prune_old_probes.js --execute # actually delete

# Report the orphan .part files (REPORTS ONLY -- it never deletes)
py -3 tools/reportPartialDownloads.py
py -3 tools/reportPartialDownloads.py --json

# Reconcile the catalog's status column against the filesystem
node tools/reconcileCatalogStatus.js           # report only
node tools/reconcileCatalogStatus.js --execute # also reset the false claims
node tools/reconcileCatalogStatus.js --json

# Date the rows fill-dates could not (age-restricted uploads, which yt-dlp refuses)
node tools/resolveUndatedDates.js --listing data/catalog_flat/qullamaggie.tsv
node tools/resolveUndatedDates.js --listing data/catalog_flat/qullamaggie.tsv --execute
```

### The `status` column is not one thing — `src/video/videoStatus.js`

`videos.status` is one column with six writers, and the two that matter most
disagree about what `done` means. The state machine, as it actually behaves:

| status | means | written by |
|---|---|---|
| `pending` | the catalog row exists; the media has not been fetched | the catalog upsert |
| `downloading` | a download has been claimed and has not finished | `whiteboard_worker.py command_download` |
| `scanning` | **the media is on disk**; nothing has been scanned yet | **both downloaders**, `whiteboard_worker.py command_download` |
| `review` | the scan found something that needs a human | `whiteboard_worker.py command_scan` |
| `done` | an OCR pass finished — **or** a scan wrote an artifact | `runAllOcr.js`, `whiteboard_worker.py command_scan` |
| `no_match` | the scan found nothing | `whiteboard_worker.py command_scan` |
| `error` | the pass failed — **including "the media file is missing"** | `whiteboard_worker.py` |

The order matters. **`scanning` is the state a downloader leaves a video in
once the file is on disk**, and it is also the queue both OCR paths read — so
the downloaders and the OCR paths are not independent. Neither downloader ever
writes `done`; both write `scanning`.

So the column cannot answer "has this video been processed?" on its own, and it
certainly cannot answer "is this video downloaded?".

**Both downloaders exclude `done` from their work**, because a `done` row is
supposed to be finished:

```sql
WHERE status IN ('pending','scanning','error')   -- downloadHiresBatch.js
WHERE status IN ('pending','scanning')           -- downloadCandidates.js
```

But `done` records that a *pass* finished — it says nothing about the file. A
row that says `done` while its media has since been deleted is therefore
invisible to every downloader: it is neither re-fetched nor reported as missing.
**21 rows** were in that state on 2026-10-29 — all Revere, all pointing into the
`downloads/` directory the 2026-10-21 cleanup removed.

The asymmetry that makes this survivable for one path and not the other:
`whiteboard_worker.py command_scan` marks a row `error` when its media file is
missing, and `error` **is** a download candidate — so the worker heals itself on
the next pass. `runAllOcr.js` flips `scanning` → `done` without looking at the
filesystem, so nothing ever notices a file that vanished afterwards.

`tools/reconcileCatalogStatus.js` reports the reconciliation and, with
`--execute`, resets the false claims back to `pending` so the downloaders can
see them again. It resolves every pointer against the filesystem **and** looks
for the media under the name the downloader itself writes
(`<upload_date>_<video_id>.mp4`), because:

- a pointer is not evidence that a file is missing, and not evidence that one is
  present — 179 of 716 pointers resolve, 537 point at files that are gone;
- a file can be on disk with **no pointer naming it** — 36 such files on
  2026-10-29, 22 of them 1080p copies of Qullamaggie videos whose pointer names
  the 720p copy instead.

That second point is why the reset is 21 and not 23: `bEidyFtV-lY` and
`M0pV73RV2qo` have stale pointers, but their media **is** on disk under the
downloader's own name, so their `done` claim legitimately holds.

**A file name can mean several video ids.** `idForms()` tries `<date>_<id>`,
`<id>`, and the `-1080p` suffix, and strips a leading underscore — a September
2026 download run prepended one, and some Qullamaggie ids start with one
themselves, so `_Vn-EBl95hes.mp4` is the video `Vn-EBl95hes` and
`__2urSPdZVec.mp4` is the video `_2urSPdZVec`. Without both spellings, 37 of the
40 orphan `.part` files look like they belong to nothing.

**The reset is safe for the OCR pipeline.** `runAllOcr.js` selects
`status='scanning'`, so a reset row only re-enters the OCR pipeline after a
downloader has fetched it again and set it back to `scanning`.

**The four artifact columns are empty.** `output_path`, `review_reason`,
`selected_timestamp` and `selected_score` are written **only** by
`whiteboard_worker.py command_scan`, which has never run against this catalog
— the Revere OCR goes through `runAllOcr.js`, which writes a probe log instead.
So `status='done'` points at **no artifact through the database**; the artifact
path lives in the probe log, and the probe directories are pruned (3 most
recent per family) while the catalog is permanent.

**The work lists come from one place.** `src/video/videoStatus.js` holds the
meanings, the writers and the candidate status lists; both downloaders build
their SQL filter from it, so they cannot drift apart.
`test/catalogStatusContract.test.js` pins the contract: the schema's CHECK
constraint against the module's list, the downloaders' filters against the
module's, and the invariant that a `scanning` or `done` row has a
`download_path`.

Pinned by `test/reconcileCatalogStatus.test.js`. Its shipped-catalog test needs
the filesystem, so it **skips on a fresh clone** — the media is not in git,
only `state.sqlite` is.

### `fill-dates --refresh`

`fill-dates` normally **skips** the videos that already have a date, which is
what makes a second pass over the same list cheap. But a date resolved wrongly
once was then permanent. `--refresh` re-reads the rows that already have a
date, so a wrong date can be corrected:

```bash
node tools/runWhiteboardWorker.js fill-dates --channel revere --build-listing --refresh
```

The upsert already overwrote `upload_date` with a freshly resolved one, so the
flag's only job is to stop the work-list filter from dropping the row before it
got there. The report gains `refresh` and `dates_changed` (how many dates
actually moved).

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
  left in the DB with an empty `upload_date`. `fill-dates` resolves them
  directly, in `--jobs` parallel batches, then upserts through the same
  `upsert_catalog_rows` (so `status` and `download_path` are never touched).
  It reports `still_missing` so a second pass can pick up what failed.

`fill-dates` has four properties that make a long run safe:

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
- **It records itself in `catalog_runs`.** The campaign that built the catalog
  left no run row, so the audit table described a run that was not the one
  that did the work.

### `fill-dates` builds its own work list

The work list used to be a file that only existed on the machine that made it
— the script that built it lived in the temp directory, not in the repository
— so `fill-dates --input` was a dead end for anyone else. It is now derived
from the two inputs that are actually reproducible:

```bash
# Fetch the channel listing, diff it against the DB, resolve what is missing.
# Needs nothing but the channel and the database, so it runs on a fresh clone.
node tools/runWhiteboardWorker.js fill-dates --channel revere --build-listing

# Or use a listing you already have.
node tools/runWhiteboardWorker.js fill-dates --channel revere \
  --from-listing data/catalog_flat/revere.tsv
```

`--input` still works and takes precedence when given.

Two details the reader handles that bit the old path:

- **The separator may be a literal `\t`, not a tab.** The listing in the
  snippet below is produced through a shell, and the shell hands yt-dlp the
  two characters backslash-t, which yt-dlp prints verbatim. Splitting on a
  real tab yields one field per line, so the whole line — id *and* title —
  becomes the `video_id`. The separator is detected once per file, and a
  literal-`\t` listing is read correctly.
- **The bytes may not be UTF-8.** yt-dlp's stdout passes through the console
  codepage on Windows, so a title with an em-dash lands as cp1252. Decoding it
  as UTF-8 mangles every such title in the file. The reader decodes as UTF-8
  first and falls back to cp1252.

A video whose date could not be resolved is still a video, and its title is
known from the listing, so **`fill-dates` stores that title** rather than
throwing it away. An age-restricted upload is the case that matters: nothing
else can ever resolve it, so if the title is not stored it exists only in a
scratch file. An existing title is never overwritten — the listing is a lossy
copy of the titles (the console codepage drops emoji).

### The rows `fill-dates` could not date — `tools/resolveUndatedDates.js`

An **age-restricted** upload is refused by yt-dlp before its metadata is
read, so `fill-dates` cannot date it and the row stays undated forever. An
undated row falls out of every date-keyed layout the pipeline has, so this is
not cosmetic: it is a video the pipeline cannot place in time.

**The watch page carries the date anyway.** Its embedded JSON holds

```json
"uploadDate":"2022-03-03T06:59:31-08:00"
```

and YouTube serves it to a logged-out client even when the video itself is
age-gated. Measured on 2026-10-29: the watch page agreed with the
yt-dlp-resolved date for **12 of 12** Qullamaggie videos whose dates were
already known.

**But a date read out of a web page is not trusted on its own.** The channel
listing is newest-first, so an undated video's date has to fall *between* its
dated neighbours — and that bound comes from a completely different source.
Two independent methods have to agree before anything is written:

```text
older < target <= newer
```

where `newer` is the nearest dated video **above** the target in the listing
and `older` the nearest dated video **below** it. The newer end is inclusive
(two videos can share a day); the older end is exclusive (the listing is
strictly ordered).

The tool refuses, rather than writes, when:

| condition | why |
|---|---|
| the watch page carries no date | nothing to write |
| no listing was supplied | nothing to cross-check against |
| the video is not in the listing | its neighbours are unknown |
| the listing offers **no dated neighbour** | a bound with nothing on either side constrains nothing, so every date would satisfy it — accepting one would mean trusting the page alone |
| the date falls outside the bound | the two methods disagree |
| the page could not be fetched | one unreachable page must not abandon the run |

The last two rules are the ones that matter. A bound that constrains nothing
is not a check, and a run that accepts a date it cannot corroborate is
worse than a run that leaves the row undated.

```bash
node tools/resolveUndatedDates.js --listing data/catalog_flat/qullamaggie.tsv
node tools/resolveUndatedDates.js --listing data/catalog_flat/qullamaggie.tsv --execute
node tools/resolveUndatedDates.js --json
```

Dry-run by default, `--execute` to write. It records a `catalog_runs` row
with `row_count_kind='work_list_videos'` and points `raw_output_path` at a
run snapshot (`data/video_pipeline/catalog/resolve_undated_*.tsv`) that says
**why** each row was or was not dated — the database records the counts, not
the reasons. `listing_complete` is 1 only when every catalog row for the
channel appears in the listing, which is the same test the worker uses.

**On 2026-10-29 this closed the last three undated rows** in the catalog
(all Qullamaggie, all age-restricted): `te9tmNOA38I` → 20220303,
`xNL-i3acbVk` → 20220216, `fhH3wxpQxxE` → 20191029. The catalog now has
**zero** undated rows. The dates were cross-checked against bounds derived
independently from the listing order, and the bounds the tool computed match
those derived bounds exactly.

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
through Python, where `\t` is a real tab. `fill-dates` reads both, so the
listing can be handed to it directly.

### What is in the repo, and what is only local

| artifact | in git? | notes |
|---|---|---|
| `data/video_pipeline/state.sqlite` | **yes** | the catalog: 2,402 videos, plus the `catalog_runs` audit table. The **only** tracked file under `data/video_pipeline/` (`.gitignore:4-5` ignore the directory and re-include this file) |
| `data/catalog_flat/*.tsv` | no | a **cache**, regenerated in ~4.5 min of metadata-only network time. It carries no `upload_date` — the one field the catalog exists to capture — and it is lossy (cp1252, emoji dropped) |
| `data/catalog_flat/*_needs_date.tsv`, `*_missing.tsv` | no | stale work lists from a completed gap-fill. `fill-dates` derives its own now |
| `data/video_pipeline/catalog/catalog_*.tsv` | no | run snapshots, strictly worse than the DB |
| `data/video_pipeline/catalog/resolve_undated_*.tsv` | no | the run snapshots `tools/resolveUndatedDates.js` points `catalog_runs.raw_output_path` at — they say **why** each row was or was not dated |
| `data/qmg_video_recovery_manifest.json` | **yes** | re-download manifest: the videos whose media is **missing** (535), plus the ones still on disk (181), regenerated from the DB and the filesystem by `tools/inventoryLostVideos.py` — see § 'The recovery manifest' |

The flat listings are **not** worth committing: they are reproducible, they go
stale daily, they hold no dates, and 99.99% of their content is already in
the DB. The three titles they uniquely held — for the age-restricted Qullamaggie
videos — are now in the DB, so nothing is lost by leaving them out.

Four things that were wrong in the committed data and are now fixed:

- **`catalog_runs.raw_output_path` was an absolute Windows path**, so it pointed
  at nothing on another machine. It is now relative to the repository root
  whenever the file it names is inside the repository (`portable_path()`), and
  stays absolute when it is not — there is no honest relative form for a path
  from another machine. `status` resolves it back to an openable path.
- **`catalog_runs` did not say which rows were real.** The worker's own test
  fixtures point at `example.com/mock-playlist`; they were self-labelling, but
  they still made up four of the twenty-eight rows in the audit table and a
  reader had to know that to discount them. The `kind` column now says `live`
  or `fixture`.
- **`missing_upload_dates` counts the rows yt-dlp printed**, not the videos the
  channel has, so every run reports 0 while 3 videos are undated. `fill-dates`
  records the honest number.
- **Two mock rows leaked into the committed DB** — `abc123` / `def456`, the IDs
  from `test/fixtures/mockYtDlpCatalog.py`, carrying `status='done'` and
  `download_path` values for files that do not exist. They reached the tracked
  recovery manifest as re-download targets. Removed on 2026-10-26.

Both changes to `catalog_runs` ship as **migration version 2**
(`_apply_migrations` in `tools/whiteboard_worker.py`), so an existing database
is repaired in place when it is next opened. A fresh database gets the columns
from `data/db/schema.sql` directly.

`data/db/schema.sql` now describes the **`videos` and `catalog_runs` tables
exactly as the shipped catalog has them** — same columns, same order, same
CHECK constraint on `videos.status`. A fresh clone and the shipped database
therefore have the same table shape. Nothing reads the table positionally, so
this is a consistency constraint rather than a functional requirement — but the
two being interchangeable is worth the ordering.

### The gap-fill runs from a fresh clone

`test/catalogFreshClone.test.js` is the proof. It copies the **tracked** files
into a scratch directory — nothing else, no untracked file, nothing left over
from an earlier run — and runs `fill-dates --build-listing` there against a
fake yt-dlp. If the gap-fill ever needs a file that is not in git, that test
fails.

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

### Known limitations and next steps (as of 2026-10-29)

**Measured on the curated GT benchmark** (`test/qmgGroundTruth.test.js`, 4 captures,
EasyOCR, single frame each — not a multi-frame consensus run), at commit `8070601` and
**re-verified 2026-10-29 against the md5-pinned fixture frames** (864 s, all four cases
passing, identical numbers):

| case | date | recall | FP |
|---|---|---|---|
| trade_ideas | 20220218[1] | 88.9% (8/9) | 2 |
| sparse | 20221104[0] | 100% (1/1) | 3 |
| normal_2022 | 20220606[1] | 87.5% (7/8) | 3 |
| dense_2023 | 20230609[0] | 46.2% (6/13) | 3 |

Overall mean recall 80.6%. These numbers were previously meaningless — the benchmark was
resolving 640×360 prefilter frames, so every case scored 0%.

**The benchmark is deterministic, not noisy.** Two consecutive runs (2026-10-25, 512 s and
461 s) produced byte-identical per-case numbers, hits and FP counts, and the 2026-10-29
run against the pinned frames reproduced the table exactly. So a change in this table
means the *code* or the *input frames* changed — not that the measurement drifted.

**The input frames ARE pinned (since 2026-10-29).** `resolveSnapshotPath` now prefers the
tracked fixture in `test/fixtures/qmg_benchmark/` and verifies its md5; only if there is no
fixture does it fall back to scanning `SNAPSHOT_ROOTS` plus every
`data/video_scan_test/_rerun/<run-tag>/snapshots/` directory and keeping the **widest** file
named `qmg_<date>[_<n>].png`. A new re-run directory can therefore no longer change which
frame a case is scored on. The earlier 73.9% figure was not measured against a named frame
set, which is why it cannot be reconciled with 80.6% from the record alone.

The frames the 80.6% measurement above was taken on, all 1920 px — now tracked as fixtures
(see § 'The benchmark's frames are now tracked'):

| case | frame | md5 |
|---|---|---|
| trade_ideas | `test/fixtures/qmg_benchmark/trade_ideas_20220218_c1.png` | `d6a45e350aeacf16c704d324f0ed18a5` |
| sparse | `test/fixtures/qmg_benchmark/sparse_20221104_c0.png` | `7d766f71608427d09c8dbf0592b81445` |
| normal_2022 | `test/fixtures/qmg_benchmark/normal_2022_20220606_c1.png` | `e34b828300318085b07166a87aa50f98` |
| dense_2023 | `test/fixtures/qmg_benchmark/dense_2023_20230609_c0.png` | `d53cb5fab33eba46e73ba40a7477f91e` |

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

## The replay tool is a surviving sample — `tools/evalParserReplay.js`

`node tools/evalParserReplay.js` replays the captured probe logs through the
**current** parser and scores it against `data/qmg_ground_truth.json`. It is the
offline counterpart to a re-scan: parser changes are measured in seconds
instead of ~12 min/video of EasyOCR.

**Its number is a SURVIVING SAMPLE, not a corpus-wide figure, and the tool now
says so on every run.** Three defects were fixed on 2026-10-29; before them the
number was quietly wrong.

| defect | what it did | fix |
|---|---|---|
| the ground truth was read by a local reimplementation | it only understood the array form, so the four dates whose GT is the object form `{tickers, crop}` — `20220323`, `20220427`, `20220428`, `20220510` — were **silently dropped**, 19 logs with real ground truth invisible | read it with `src/qmg/qmgGroundTruth.js`, the canonical reader |
| the ground truth was counted **once per log file** | a date with five logs contributed its tickers five times: the denominator was **2.17×** the truth, and "dates scored" was a count of log rows | count it **once per date**; pool the date's predictions across its logs |
| nothing reported how much of the corpus was reachable | 172 of 207 ground-truth logs (83%) never reached the scorer, and nothing said so | the tool prints a census, and prints the dates it could not measure |

**Why the missing logs cannot simply be included.** The probe logs only carry
per-word geometry (`ocr_words`) from commit `02e481f` (2026-10-18) onwards.
Without word positions the parser's column gate, panel gate, Filter B and its
in-column repair pass are all skipped, and it falls back to the legacy
lexicon + price-nearby path — a **different, weaker parser**. Measured on the
same word-bearing logs, forcing `words` to `[]` takes precision from
**89.4 % to 27.8 %**. So a wordless log is excluded, not scored on `ocr_text`
alone. Re-OCRing the **191 surviving snapshot PNGs** (covering 35 ground-truth
dates) is the only sound way to widen the sample; only `20230601` has neither
words nor a surviving snapshot.

**The surviving sample is not random.** It is the post-2026-10-18 crop
profile: 0 of 205 September logs carry `ocr_words`, 36 of 124 October ones do.
Any statistic derived from it describes the later crop/tuning era only.

The current figures:

| root set | dates scored | recall | precision |
|---|---|---|---|
| default (8 probe roots) | 8 | **59.6 %** (53/89) | **93.0 %** (53/57) |
| `data/video_ocr_probe` + `data/video_scan_test/_rerun` | 17 | **62.9 %** (107/170) | **80.5 %** (107/133) |

`test/evalParserReplay.test.js` pins the *methodology* on synthetic fixtures —
the real corpus is untracked, so a test asserting the real numbers would fail
on a fresh clone.

**Do not quote the replay number without its census.** `node
tools/evalParserReplay.js --json` prints it in machine-readable form.

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
- **The seed lexicon used to contain OCR VARIANTS, and they published verbatim.**
  Eleven rows of `config/ticker_lexicon_seed.csv` were not tickers but the *shape* a
  ticker takes when it is misread: `AROQ`, `ARCQ`, `OBTS`, `GSII`, `IOI`, `PLIR`,
  `NUGI`, `JNUG`, `~09r3`, `GSlT`, `MNOY`. An exact lexicon hit short-circuits the
  decoder at cost 0, so `PLIR` published as `PLIR` at 0.000 and never competed with
  `PLTR` (whose repair would cost 0.375 — `I>T` at count 3 of a model max of 4).
  That is where 4 of the 7 measured false positives came from. (`~09r3` was the
  exception: it could publish nothing, because the decoder strips every non-A-Z
  character out of the read before the lookup
  (`src/normalize/tickerDecode.js:157`), so the read arrived as `R` and never matched
  the key. `GSlT` published uppercased, as `GSLT`.)
  **All eleven rows were deleted on 2026-10-29.** The measured effect, via the
  no-OCR replay (`node tools/evalParserReplay.js`) on its default roots:
  recall **58.4 % → 59.6 %** (52/89 → 53/89) and precision
  **91.2 % → 93.0 %** (52/57 → 53/57) — the `OBTS` false positive in 20230523
  is gone and one more real ticker is found. On the wider corpus
  (`node tools/evalParserReplay.js data/video_ocr_probe data/video_scan_test/_rerun`)
  the effect is larger: recall **60.0 % → 62.9 %** (102/170 → 107/170) and
  precision **76.7 % → 80.5 %** (102/133 → 107/133). *(These numbers were
  re-measured on 2026-10-29 after the replay tool's own defects were fixed —
  see § 'The replay tool is a surviving sample'. The figures quoted before
  that — recall 56.3 % (71/126), precision 92.2 % → 93.4 % (71/77) — came
  from the biased instrument and are withdrawn.)* The misreads now decode to
  the real ticker: `PLIR` → `PLTR`, `NUGI` → `NRGU`, `MNOY` → `MNDY`,
  `GSLT` → `GSIT`. `test/lexiconVariants.test.js` pins the outcome.
  - The **`JNUG` in the seed list at line 201 is a real ticker** (a seeded Qullamaggie
    chart ETF, junior gold miners 2×) and was **kept**. The deleted `JNUG` at line 245
    was a redundant duplicate of it.
  - Two of the misreads are recorded as **alias rows** in
    `config/ticker_ocr_confusions.csv` instead (`MNOY→MNDY`, `GSLT→GSIT`), which is
    where a chart-stream misread belongs: that file applies to in-column tokens only,
    and only when the column gate is active.
  - The **`O,D` row added to `config/ticker_char_confusion.csv`** is strictly
    additive: over the 3,549 O-containing single-substitution reads in the corpus it
    changes **0** existing decodes, loses **0**, and gains **38** correct repairs
    (`MNOY→MNDY@0.625`, `AMO→AMD@0.625`). `test/lexiconVariants.test.js` pins
    gained=38, changed=0, lost=0.
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

---

## The Revere whiteboard parser

`src/parse/parseWhiteboardScreenshotWithBoxes.js` is the **positional** parser
for Revere's whiteboard — the screen with two portfolios, `GRO` and `TURBO`,
each with a `HOLDINGS:` list and an action line. It is a different parser
from `src/parse/parseWhiteboardScreenshot.js` (the whole-panel one), and it
is the one `tools/scanVideoWithOcr.js` runs for Revere.

The screen's geometry comes from the **pixels**, not the OCR: the whiteboard
window is detected by `detectWhiteboardWindow()` (per-row bright counts →
contiguous bright ranges → a dark-border scan), and the holdings list is
bounded by it. A frame that yields no window yields no holdings at all.

### Two lexicons, two jobs — `src/normalize/tickerFuzzyResolve.js`

The single most important distinction in this parser:

| lexicon | what it answers | source |
|---|---|---|
| **match** | what a token MAY **be** | seed + observed (249) |
| **allow** | what may be **REPORTED** | seed only (223) |

`loadSeedLexiconSync()` is the allow list. `loadDecodeLexiconSync()` (seed +
observed) is the match lexicon. **SPXL is match-only**: the parser resolves it
to *itself* rather than to a neighbouring seed ticker (SOXL), and then drops
it because the allow list does not have it. That is the intended behaviour,
not a bug — but see § 'SPXL' below.

A correction must be the **unique** candidate at the minimum edit distance.
`IBT` is one edit from both `IBIT` and `IOT`; `SPO` from both `SPOT` and
`SSO`. Neither is guessed — a wrong holding in a portfolio report is worse
than a missing one. `MAX_OCR_EDIT_DISTANCE = 2`.

### The rules that matter

- **A misread portfolio label costs the WHOLE portfolio.** Tesseract reads
  `TURBO` as `TURBG` (20260924). A label that matches exactly is never found,
  and the section filter **fails open** when it cannot find a section — so
  the action line's tickers (DELL, SMTC) come in as holdings. The label now
  matches at one edit (`matchesPortfolioLabel`), and only for a word long
  enough to *be* the label: `GR` (what `GRO` becomes when the O is lost) is
  not accepted.

- **The action line must not bleed in.** The section ends at the portfolio's
  **own labelled action line** (`GRO RVAB/REBAR:`), not at the next `* `.
  The action line does not always start with `* ` — the OCR often reads it
  as a quote — so the labelled header is the reliable end.

- **A correction is only safe inside a LIST of holdings.** The chart is drawn
  beside the holdings list, on the same OCR lines, and its annotations are
  one edit away from real tickers (`wal”` → HAL, `by` → BE, `rang` → FANG).
  Correcting an isolated word invents holdings out of the chart. So:
  - a **merged group** (comma or slash) *is* the evidence — every part may be
    corrected;
  - a **standalone word** needs the **capitals** to stand in for that
    evidence. The holdings list is set in capitals; the chart's ink is not.
    `isUpperCaseWord()` is therefore the case rule, and it gates the
    *correction* only — a ticker the lexicon knows is accepted whatever case
    the OCR gave it.

- **The section filter runs on the RAW text.** A corrected ticker (`TGQQ` →
  `TQQQ`) is not in the OCR text at all, so filtering on the corrected form
  would have it rejected by every section. Each candidate carries the raw
  text it came from.

- **A lost separator fuses two holdings.** Tesseract drops the comma between
  two holdings and renders the loss as nothing (`TQQNCLD`, `TGQQ`) or as a
  period (`LITE.OOCN`). `splitFusedTicker()` walks 2–5 character partitions
  and requires **every** part to resolve. Two rules keep it honest:
  - a token shorter than 5 characters is never split (`UP.` is not `U`+`P`;
    the screen really says `MU,P`), and
  - a **two-character** part must be an **exact** ticker — `SP` cannot be
    "corrected" into `SPY`.

- **The expansion runs before the shape test.** A word that is not
  ticker-shaped is still worth expanding when it holds two holdings the OCR
  ran together. The word is dropped only when nothing in it resolves.

### The measurement, and what it is a measurement of

`data/revere_ground_truth.json` holds the holdings for 20260922–20260928.
`test/parseWhiteboardHoldings.test.js` drives the parser over **three real
frames** with both the pixels and the OCR result frozen:

| | readings hit | recall |
|---|---|---|
| before the fix | 79 / 95 | 83.2 % |
| after the fix | **90 / 95** | **94.7 %** |

Precision is 100 % on both — the parser invents nothing. The five readings
still missing are **OCR losses**, not parser decisions, and they were verified
against the pixels: `MU,P` was read as `UP.` (the M is gone; P cannot be
recovered from what is left), `IBIT` as `IBT` (ambiguous), `SPCX` as `SPO`
(ambiguous), and `,P,` was dropped whole.

**The fixtures keep the pixels as well as the OCR.** The OCR is frozen
because a Tesseract upgrade would move the numbers and the test would stop
meaning anything. The pixels are kept because the window is detected by pixel
analysis and the holdings list is bounded by it — a fixture with only the OCR
would not exercise the geometry at all.

A frame's identity is its **file + md5**, not its label: see
`test/fixtures/revere_whiteboard/manifest.json`.

### `tools/evalRevere.js` scores the RECORDED output

The Revere counterpart of `tools/evalParserReplay.js`. It finds the probe
logs that captured each ground-truth frame, pools the readings of the runs
that captured it, and scores them.

Two properties worth knowing before quoting its number:

- **It scores what the pipeline recorded, not a re-parse.** A parser fix is
  therefore invisible here until the videos are re-scanned — the numbers that
  move immediately come from the fixture test.
- **Consensus across runs is an INTERSECTION, not a union.** When two runs
  captured the same frame and one read a ticker the other did not, the ticker
  is not in the consensus: the frame does not show it, so one of the two
  readings is wrong, and the honest reading is the one both agree on.

### `--replay` closes the loop

```bash
node tools/evalRevere.js --replay
node tools/evalRevere.js --replay --ocr-cache data/revere_ocr_cache.json
```

`--replay` re-extracts the frames the corpus captured, re-OCRs them and
re-runs the **current** parser, so a parser change is measurable in seconds
instead of after an 8–13 minute re-scan. The replayed readings replace the
recorded ones for the captures it could replay; everything else is left as
recorded, and the census says how many were replayed — so the number never
mixes two eras silently. Measured over the four ground-truth dates:
**94.4 % recall (135/143), 100 % precision**, against the recorded
88.1 % / 98.4 %.

The replay extracts at the same width the scan tool does
(`--ocr-frame-width`, default 1280), so it measures the pipeline and not a
different frame size.

**Tesseract is not deterministic**, so a replayed number moves slightly
between runs — that is what the OCR cache is for: two parser versions over
the *same* cached OCR is the only comparison that can attribute a difference
to the parser. The repeatable number is the fixture test's.

### SPXL — a known gap, reported not fixed

`SPXL` is in the **match** lexicon but not in the **allow** list, so the
parser resolves it and drops it. It is also missing from **every** TURBO
holdings list in `data/revere_ground_truth.json`, although the screen shows
it on all four dates and 20260924's own note reads "ADD to SPXL". Neither the
ground truth nor `config/ticker_lexicon_seed.csv` was changed: the ground
truth is a record of what the screen showed, and the allow list is the
project's decision about what may be reported. **This needs the user's
decision, not a silent fix.**
