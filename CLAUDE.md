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
2. The orchestrator's per-video kill timer **was 300 s** — every video hit SIGTERM mid-OCR. `scanAllGtVideos.js` now gives EasyOCR 40 minutes (the batch runner's budget) and keeps 300 s only for Tesseract. `superviseChild` kills the process tree, which is what stops the grandchildren; a timer that is shorter than the OCR still turns a sweep into a string of timeouts.
3. On Windows, `child.kill('SIGTERM')` does NOT reliably terminate the child's grandchildren (ffmpeg.exe + Tesseract WASM heap). They become **zombies**.
4. Parent moves to next video immediately; the new video's ffmpeg sample extraction stalls behind the zombie I/O. **No stdout appears for minutes → user-perceived "freeze" → user restarts their computer.**

**Hard rules before any sweep:**

- **Time ONE video first** with the exact flags the sweep will use. Confirm the log file appears at `data/video_scan_test/_rerun/<runTag>/ocr_probe/logs/<dateKey>_*.json` with non-empty captures. Only scale up after that.
- **Run in chunks of 5–10 videos**, never 40 in one shot. The user can monitor each chunk and abort if one hangs.
- **Pass `--parallel 4`** to the orchestrator. The worker pool is `runWithConcurrency` in `tools/scanAllGtVideos.js`. Default `--parallel 1` is ~6.7 h wall for a 40-video sweep.
- **Flag budget vs timeout**: EasyOCR at the default 12-frame budget does not fit 300 s (~60 s/frame). `scanAllGtVideos.js` gives EasyOCR 40 minutes and Tesseract 300 s. `--fps 1` is 4× denser than the tool's default 0.25; `--max-captures 3` will not finish in the Tesseract budget (Tesseract alone is ~6 min lower bound on the old dual-scale path).
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
npm test              # everything except the OCR benchmark (599 tests, ~50 s)
npm run test:benchmark  # test/qmgGroundTruth.test.js alone (EasyOCR; ~2-25 min, see below)
npm run test:all        # everything, benchmark included -- FAILS under contention
```

599 tests, all passing (as of 2026-11-03).

**A third suite exists, and it is MANUAL.** `test/manual/qmgEraPrefilterScan.test.js`
is the era-conditional crop and the era-conditional prefilter rectangle, run
through the **real production scanner** against the **real videos** — an EasyOCR
scan, 12–18 minutes per video. It lives in `test/manual/`, which the suite's
glob does not reach (`tools/runTests.js` reads the top level of `test/` only,
and `npm run test:all` globs `test/*.test.js`), so it never runs by accident:

```bash
node --test test/manual/qmgEraPrefilterScan.test.js
```

Its configuration is `test/manual/qmgEraPrefilterScan.config.json` (the
environment overrides it). It scores **two** readings per date — the merged
video-level consensus and the best single capture — because CLAUDE.md records
those two disagreeing, and a capture-level metric would never have caught it.
Its assertions are **structural** (every date produced a log and a non-empty
reading); the recall numbers are **reported**, not asserted, because EasyOCR is
not deterministic and a test that fails on a bad OCR run is a test people learn
to ignore.

**The benchmark has to run on its own.** `test/qmgGroundTruth.test.js` is an
EasyOCR benchmark, and `node --test` runs the test *files* in
parallel — against the rest of the suite it fails, because four EasyOCR
benchmarks plus a dozen other files do not fit in one machine's memory and CPU
at once. On its own it reproduces the table below exactly (88.9% / 100% /
87.5% / 46.2%, overall 80.6%). `npm test` therefore skips it, and says so on
the first line of its output.

**Re-verified 2026-10-29 against the pinned fixtures**: the same four numbers,
all four cases passing, in 864 s. The frames are now md5-pinned, so this
number is a property of (code, frame) and the two must be quoted together.

**The wall clock is not the number.** The same four frames have been scored in
864 s, 40,053 s, 305 s and 151 s — EasyOCR swings by orders of magnitude on
the same file. Quote the per-case recall, not a duration.

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
- `tools/scoreCurrentParser.js` — score the CURRENT parser against the Qullamaggie ground truth using the recorded OCR words of the newest log per date (no OCR runs)
- `tools/reparseCaptures.js` — re-parse a run’s recorded captures with the current parser and print each capture’s own reading (the per-capture view under the per-date one)
- `tools/aggregateScanResults.js` — merge scan output into `analysis.json`
- `tools/aggregateOcrTimeline.js` — merge into `timeline.json`
- `tools/viewTimeline.html` — interactive timeline viewer
- `tools/fetchSevcikTranscripts.js` — fetch Sevcik transcripts (captions → Deepgram) (see below)
- `tools/extractSevcikSignals.js` — run the signal extractor over the stored transcripts (see below)
- `tools/aggregateSevcikSignals.js` — write the Sevcik CSVs, JSON and dashboard (see below)

### OCR pipeline
- `src/ocr/ocrImage.js` — Tesseract wrapper; `chart-stream` profile crops overlay region
- `src/video/ocrScanLogic.js` — prefilter scoring, candidate building, screenshot logic
- `src/video/ocrScanArgs.js` — CLI argument parsing; the chart-stream crop is ERA-CONDITIONAL and lives in `src/video/chartStreamCrop.js`
- `src/video/chartStreamCrop.js` — the era rule itself: the crop rectangle, the prefilter's measurement rectangle, and `chartStreamEraForDate()` — the single answer to "which layout era is this date"
- `tools/measurePrefilterRegion.js` — NO-OCR instrument: scores a video's frames under the legacy and the era prefilter rectangles and reports the labelled frames' ranks
- `src/parse/parseChartStream.js` — Qullamaggie position-list ticker extraction
- `src/parse/parseWhiteboardScreenshot.js` — GRO/TURBO/Revere whiteboard parser
- `src/parse/parseWhiteboardScreenshotWithBoxes.js` — the Revere whiteboard's POSITIONAL parser (the one the scan tool runs)
- `src/parse/parseScreenshot.js` — the LEGACY screenshot parser (`GRO`/`TURBO` rows + a `BOTTOM LINE:`), used by the screenshot pipeline in `src/index.js` and by the scan tool's non-whiteboard branch. It is **not** the whiteboard scan path. Its issue codes are `MISSING_*` / `LOW_OCR_CONFIDENCE` / `BOTTOM_LINE_CONFLICT` — the last one fires when the main-line `BOTTOM LINE:` and the `ocr.bottomText` fallback both produce a value and they disagree; the main line still wins, but the disagreement is no longer silent.
- `src/video/positionTableScan.js` — positions-TABLE reader (source-resolution, lexicon-constrained)
- `src/video/panelExtract.js` — source-resolution panel crops (shared ffmpeg/ffprobe resolver)
- `src/video/imageHash.js` — full-frame pHash
- `src/video/imageHashRegion.js` — region-crop pHash (chart overlay)

### Normalization
- `src/normalize/tickerScan.js` — seed lexicon + strict ticker pattern
- `src/normalize/tickerFuzzyResolve.js` — the resolver: match lexicon vs allow list, ambiguity-aware correction, fused-token splitting (see below)
- `src/normalize/videoTypeClassifier.js` — whiteboard / chart_stream / DMI / tale_of_the_tape
- `src/normalize/repairHoldings.js` — Revere-only position repair

### Sevcik (transcript source)
- `src/sevcik/channel.js` — the channel's identity: logical name `davidsevcik`, handle `@davidsevcik-sved4697`, streams URL
- `src/sevcik/signalPatterns.js` — the whole vocabulary: directions, actions, confidence, horizons, price roles (see below)
- `src/sevcik/signalExtractor.js` — the deterministic extractor (see below)
- `src/transcript/transcriptNormalize.js` — provider-agnostic segment shape, provider inference, timing-independent checksum
- `src/transcript/deepgramClient.js` — ffmpeg audio extraction + Deepgram `nova-2` upload
- `src/report/sevcikReport.js` — the self-contained HTML dashboard

### T3Live (English transcript source — see § 'The T3Live source')
- `src/t3live/channel.js` — logical name `t3live`, handle `@t3live`, both listing URLs (`/streams`, `/videos`)
- `src/t3live/contentFilter.js` — show/host classification from the title. Current series: `actionable_swings`, `630club` (including the older `6:30 Club` spelling), `options_in_play`, `morning_call`, `daily_recap`. Older formats are series too: `market_wrap`, `how_to`, `watch_list`, `pro_desk`, `half_time`, `mid_day`, `red_dog`, `black_room`, `marketcast`, `situation_report`, `core_fx`, `conversations`, `morning_game_plan`, `wall_report`, `weekly_update`. A one-off title stays `other`.
- `src/t3live/englishNames.js` — English name finder, people/acronym stoplists, index phrases → ETF. Adjacent pairs are matched as ONE name, so "Goldman Sachs" is the company and not two unrelated words.
- `tools/extractT3liveSignals.js` / `tools/aggregateT3liveSignals.js` / `tools/analyzeT3liveOutcomes.js` — extract (parser `t3live-signals-3`), aggregate per show, score vs SPY
- `src/report/t3liveReport.js` — the dashboard (`data/t3live_report.html`), written by the aggregator; reads `t3live_outcome_summary.json` when it exists
- `tools/fetchTranscriptChunks.js` — serial, chunked, captions-only fetch over an id list; stops on a 429, and does not mistake a chunk of quarantined videos for one
- `tools/fetchDeepgramBatch.js` — chunked Deepgram runner over an id list, for the videos with no captions; resumable (skips ids with a transcript on disk), deletes the audio after each transcript, stops when a whole chunk lands nothing
- `tools/importFlatListing.js` — imports a flat `id<TAB>title` listing (no dates) into `videos`
- `tools/surveyT3liveNames.js` — reports which spoken names resolve and which do not; writes `data/t3live_name_candidates.csv`. The rows the confirmed table has to grow.

### AsymTrading (Substack source, article text — see § 'The AsymTrading source')
- `src/asym/channel.js` — the publication's identity: logical name `asymtrading`, host `asymtrading.substack.com`, numeric publication id `1534424`, and the `asym_<post_id>` catalog id. The post id is NUMERIC, not the slug: every post is titled "Market Pulse", and the slug suffix repeats across series.
- `src/asym/contentFilter.js` — the access gate (free / paywalled / teaser / empty) and the series taxonomy: `market_pulse`, `momentum_movers`, `market_monitor`, `focus_list`, `post_mortem`, `market_dashboard`, `swing_trading_course`, `trader_profile`, `essay`, `prelaunch`, `copy`.
- `src/asym/substackClient.js` — the API client. The pagination is a CURSOR, not an offset (`?offset=20` is HTTP 400), and the two list endpoints differ: `/api/v1/archive` returns an empty body for every post while `/api/v1/posts` returns the real body for free ones.
- `src/asym/articleParse.js` — parses the Market Pulse report. It switches on the LABELS, not on a date, because the format changed three times between 2024 and 2026.
- `tools/catalogAsymSubstack.js` — walks the archive, records EVERY post (free and paid) in `asym_posts`, parses the free ones into `asym_articles`, and records a `catalog_runs` row.
- `src/asym/mediaStore.js` — the media layer: where a post's video lives on disk, the ffprobe resolution gate (at least 1280x720), the free-space check, and the `asym_media` download state.
- `src/asym/claims.js` — one claim per (post, ticker). A post that is bullish AND bearish on the same name is NOT scored; it is reported as conflicting.
- `tools/downloadAsymVideos.js` — downloads the MP4 from Substack's Mux CDN. The signed URL is resolved at download time and never stored, because it expires in about 24 hours.
- `tools/fetchAsymTranscripts.js` — Deepgram (`language: en`) -> transcript JSON + `video_transcripts` rows + segments. Deepgram is mandatory here, not a fallback: Mux assets carry `CLOSED-CAPTIONS=NONE`.
- `tools/extractAsymSignals.js` — transcript -> `trade_signals`, using the shared engine with the ENGLISH name finder (Sevcik's drops sentence-initial capitals, which English needs).
- `tools/aggregateAsymSignals.js` — the signals AND the parsed written readings -> CSV / JSON / HTML.
- `tools/analyzeAsymOutcomes.js` — scores the calls against what the price did, against SPY, reusing `src/sevcik/outcomeAnalysis.js`.
- `src/report/asymReport.js` — the self-contained HTML dashboard. It leads with the WRITTEN readings and shows the coverage, because the publication is mostly paywalled.

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

### Ground truth

- `tools/buildGroundTruthFixtures.js` — cuts the panel crops from the corpus and writes the fixture manifest (see below)
- `tools/checkGroundTruthConsistency.js` — checks `data/qmg_ground_truth.json` against the pinned pixels, the panel counts and the footers (see below)

### Data

- `data/video_pipeline/state.sqlite` — canonical SQLite database, **tracked in git** (the catalog)
- `data/db/schema.sql` — schema source of truth
- `config/ticker_lexicon_seed.csv` — ticker allowlist (Revere + Qullamaggie)
- `data/qmg_ground_truth.json` — the Qullamaggie ground truth; **verified against its pixels**, and checked by `tools/checkGroundTruthConsistency.js` (see below)
- `STATUS.md` — the measured current state (catalog counts, media on disk, the outstanding work) and the September 2026 OCR campaign history. Its numbers are a snapshot; § *Re-measuring* there has the commands that regenerate them.

### Tests

- `test/videoResolution.test.js` — the **mechanical ffprobe check**: every video the pipeline reads is at least 720p tall, and every file in `downloads_1080p` really is 1920×1080. It applies the rule CLAUDE.md states as a hand-applied rule, and it prints the census it found.
- `test/chartStreamPanelCount.test.js` — the panel's own footer count, and the two traps in reading it
- `test/chartStreamPrefilterRegion.test.js` — the prefilter measures the pixels the OCR will read
- `test/chartStreamCropCoverage.test.js` — the era rule, against the measured panel geometry
- `test/manual/qmgEraPrefilterScan.test.js` — the **manual** end-to-end suite: the real scanner, the real videos, the real EasyOCR pass (see § 'Testing')
- `test/manual/prefilterResolutionScan.test.js` — the prefilter's ranking at three working resolutions, against frames whose holdings are known (no OCR)
- `test/manual/productionCropRender.test.js` — renders **exactly** the image EasyOCR was shown, from the source video at a capture's timestamp
- `test/manual/panelFooterInCrop.test.js` — the production crop against the panel's own footer, cut out of the tracked fixture
- `test/sevcikSignalExtractor.test.js` — the Sevcik extractor's rules, each worded as the claim it makes
- `test/sevcikEndToEnd.test.js` — the Sevcik **chain** (transcript → segments → signals → database → dashboard) on a synthetic Czech-stream transcript
- `test/sevcikTranscriptNormalize.test.js` — provider-agnostic normalization, provider inference, the timing-independent checksum
- `test/sevcikPipeline.test.js` — the three Sevcik tools against a scratch database
- `test/sevcikReport.test.js` — the dashboard's HTML and its numbers

---

## The 2026-11-05 production rescan

Every ground-truth date that still had only an October reading was rescanned
with the current parser, the era crop, and `--timeout-minutes 90`. Several
2022-era videos exceed the batch runner's 40-minute default at the full
12-frame budget; a smaller budget reads worse, so the timeout is a flag and
the default is unchanged.

Scored only on logs that used the shipped era crop:

| era | dates | hit / ground truth | recall | false positives |
|---|---|---|---|---|
| floating panel (2022) | 30 | 239/254 | 94.1% | 24 |
| right sidebar (2023) | 10 | 104/106 | 98.1% | 1 |
| **total** | **40** | **343/360** | **95.3%** | **25** |

The dates that moved the 2022 number were the ones whose only reading was an
October log on the old crop: `20220517` 0/8 to 8/8, `20220331` 2/9 to 9/9,
`20220614` 0/3 to 3/3.

**The remaining errors are capture-level, not merge-level.** The attestation
gate already drops a consensus ticker no selected capture touched. On all 17
dates that are not exact, every false positive is in a capture's own
`position_list`. They are real seed tickers read off the wrong cell or off
chart ink: `ERX`, `GUSH`, `LI`, `LMT`, `DNA`, `NFU` recur. `NFLX` and `TNA`
are missed together on `20220606`, `20220607` and `20220608`.

**The campaign finished at 96.7 % on what production published, against the
extended ground truth.** Every ground-truth date has been rescanned with the
current parser. The logs' own merged lists — the artifact the portfolio
report reads — score **359/371 (96.8 %) with 9 false positives** over 40
dates. Before the five missing moments were added to the union, the same
logs scored 347/360 (96.4 %) with 21 false positives: more than half of
those "false positives" were the holdings the union did not yet carry.

| level | hit / ground truth | recall | false positives |
| --- | --- | --- | --- |
| the logs' own merged list (what production published) | 359/371 | **96.8 %** | 9 |
| the current parser rebuilt over the same captures | 344/371 | 92.7 % | 4 |

The two levels differ because production clusters **every** OCR'd candidate
frame while a rebuild has only the selected captures. Both are reported by
`test/manual/qmgCurrentParserScore.test.js`, and the difference is the same
one CLAUDE.md records in § *The log does NOT carry the clusterer's input*.

**Six more alias rows, all pixel-verified, and the alias tables are worth
+7 hits and −8 false positives.** Measured over the 40-date corpus with the
same parser on both sides, after the union extension:

| | hit / gt | recall | false positives |
| --- | --- | --- | --- |
| without the alias tables | 337/371 | 90.8 % | 12 |
| **with them** | **344/371** | **92.7 %** | **4** |

| garbled | canonical | the misread | dates |
|---|---|---|---|
| `INA` | `TNA` | T rendered as I | 20220606/07/08, 20230126 |
| `TQ` | `TQQQ` | the three-glyph cell read as two | 20220608 |
| `UNA` | `TNA` | T rendered as U | 20220608 |
| `NF` | `NFLX` | the cell read as two glyphs | 20220607 |

**`NFU` and `NF` are date-scoped, not shared.** `NFU` is a real seed ticker,
so a shared row would rewrite a genuine holding — the alias table's own
invariant forbids it. But the pixel-verified floating-panel captures on
`20220606`–`20220608` all show `NFLX` in the cell EasyOCR reads as `NFU`, and
`NF` is one edit from `NFU`, so the distance-1 repair would otherwise publish
`NFU` — a real ticker, and the wrong holding. So the rescue lives in its own
table, `config/ticker_ocr_confusions_floating_panel_nfu.csv`, and applies
**only to those three upload dates**, selected by
`layoutAliasEraForDate()` returning `floating_panel_nfu_20220606_08`.

**A false positive is not always a false positive: the ground truth is pinned
to October's frames.** The rescan captured *different moments* than the
October run the ground truth is pinned to. `20220607` was captured at
ts 0 / 296 / 2368 s in November and at ts 672 / 2744 / 2660 s in October, and
the positions panel changed between them. Where the two runs disagree, a
"false positive" can be a real holding the ground truth never saw. The panel
footer is what settles it: the November `20220607` frame counts **9** items
and the ground truth's frame counts **7**, and the pixels show both lists —
`WEAT` and `TQQQ` are the two rows the ground truth does not carry. Measured
over the twelve ground-truth dates whose newest log carries a footer count,
**six have a different row count than the ground truth's frame**:
`20220330` +2, `20220412` +1, `20220418` −1, `20220606` −1,
`20220607` +2, `20220608` −1. So the false-positive count is an upper
bound on wrong holdings, not a precision measurement, and it is not evidence
of a defect until the two runs capture the same frame.

**The dates that are still not exact, and why.** Fourteen dates remain, and
the errors are now almost entirely *capture-level* — a frame that read a real
ticker off the wrong cell, or a holding the OCR never produced often enough:

| class | dates | what it is |
| --- | --- | --- |
| a holding read in too few frames | `20230522`, `20230518` (`LI`); `20230608` (`TQQQ`); `20220405` (`CWEB`, `KWEB`, `X`) | the collapsed-glyph cases the one-glyph rule and the alias table cover only in the layout where the misread was recorded |
| a wrong cell read as a real ticker | `20220330` (`ERX`), `20220412`/`20220413` (`GUSH`), `20231215` (`AI`), `20220218` (`UVXY`) | chart ink that happens to be a seed ticker |
| the list changed inside the session | `20220418`, `20220429`, `20220406`, `20220427`, `20220428`, `20220331`, `20221117` (`FREY`), `20220606` (`BOIL`, `SIGA`), `20220607` (`TQQQ`) | the union denominator counts a moment the capture did not show |

**`20220606`'s two misses are the union's, not the parser's.** The panel at
the captured moment holds nine rows and the reading has nine — `BOIL` and
`SIGA` are real holdings at *other* moments of that video, which the union
denominator counts but that frame never showed. `20220607`'s `TQQQ` is the
same shape: the panel shows it, the captured frame did not.

The panel count remains a diagnostic for all of these — never a licence to
guess, because a count misread low would truncate a correct reading.

**The panel footer is now readable, and it is reported, never acted on.**
The footer sits below the crop, so `panel_count` was null in every production
log. A dedicated strip, read by Tesseract (EasyOCR collapses "3 of 9" into
"30" on the same pixels), scanned in five tight bands, reports a count only
when two bands agree. Measured on 40 fixture dates: 31/40 correct, zero wrong.
`20230126` read 2 for an eight-row panel in one band and was rejected.
`tools/measurePanelFooter.js` is the instrument. The scan tool writes
`panel_row_count` on the selected capture.

**THE FOOTER IS THE ONLY INDEPENDENT CHECK THERE IS, and it settles what the
union score cannot.** The ground truth's denominator is the UNION over a
date's captures, and the list CHANGES inside the session — so the union score
cannot say whether a reading is right, only whether it matches every moment
ever seen. The panel's own count can: it says how many rows are on screen
RIGHT NOW.

**THE PER-FRAME CHECK IS NOW VALIDATED IN PRODUCTION.** The 2026-11-06
rescan of the three June dates is the first run that carries the date-scoped
`NFU`/`NF` alias table, and every one of its first captures agrees with the
panel's own count:

| date | panel | the first capture's reading | agrees |
| --- | --- | --- | --- |
| `20220606` | 9 | ALB, CBIO, COIN, GOVX, LABU, NFLX, TNA, UCO, VLO | yes |
| `20220607` | 9 | ALB, BOIL, LTHM, NFLX, TNA, TQQQ, UCO, VLO, WEAT | yes |
| `20220608` | 11 | AERC, ALB, BOIL, COIN, LTHM, NFLX, RBLX, SIGA, TNA, UCO, VLO | yes |

`NFU` appears in NONE of them — the date-scoped rescue replaced it with
`NFLX`, and `NFU` is a real seed ticker that must not be rewritten on any
other date. The published lists for those dates went from **6/11, 6/9 and
9/12 with three false positives each** to **8/11, 8/9 and 11/12 with none**.

**`20230523`'s collapsed `LI` is recovered too.** The sidebar alias table
turns the collapsed `U` cell into `LI`, and the 2026-11-06 rescan publishes
the ground truth's **eleven** tickers exactly — `AI, APLD, CVNA, DNA, FTCH,
IMGN, LI, MNDY, PLTR, QBTS, SOUN` — with no false positive, where the
earlier scan scored 10/11. The panel's own count says eleven, and the
reading has eleven.

**A SCAN IS NOT SLOW BECAUSE OF THE SCAN.** The 2026-11-06 batch took
**2834 s** on `20220606`; the identical scan had taken **642 s** hours
earlier on the same machine, with the same flags. The difference was that
another agent's Sevcik transcript backfill was running at the same time
(`data/video_pipeline/transcripts/` gaining a file every 1-2 minutes), and
the two competed for cores. So a 4.4x slowdown in a scan is a signal to
LOOK AT THE MACHINE, not to shorten the scan's budget. **Do not react to a
slow scan by reducing `--max-frames`** — that reads worse (the 2026-11-05
reduced-budget retry of `20220405` scored 8/11 against the full budget's
9/11, and its five false positives were the chart ink a smaller sample
admitted).

**The union score's disagreements are mostly NOT errors — they are exact
readings of a moment the union does not cover.** Measured on the 2026-11-05
rescan, **10 of the 12 first captures whose footer was read agree with it
exactly**, and the five dates whose unions were extended for it gained **+13
hits and −12 false positives** between them. Verified against the pixels:

| date | the union score says | the panel says | what is true |
| --- | --- | --- | --- |
| `20220412` | `GUSH` is a false positive | **12 rows**, footer "12 of 12 Items" | the panel reads REGN, LMT, X, LHX, COPX, URA, URNM, FCX, NUGT, WEAT, JNUG, **GUSH**. GUSH is a real holding at that moment |
| `20220330` | `JNUG`, `MU` are false positives | **10 rows**, footer "10 Items" | the panel reads NFLX, REGN, KWEB, LABU, COPX, X, FCX, NUGT, **MU**, **JNUG**. Both are real holdings at that moment |
| `20220606` | `COIN` is a false positive | **9 rows**, footer "9 Items" | the panel reads GOVX, LABU, **COIN**, UCO, ALB, CBIO, VLO, TNA, NFLX. COIN is real |
| `20220607` | `TQQQ`, `WEAT` are false positives | **9 rows**, footer "9 Items" | the panel reads BOIL, LTHM, **WEAT**, ALB, VLO, TNA, NFLX, UCO, **TQQQ**. Both are real |
| `20220413` | `GUSH`, `LI` are false positives | **11 rows**, footer "11 Items" | the panel reads WEAT, LHX, REGN, LMT, X, FCX, COPX, NUGT, JNUG, URA, URNM. Neither GUSH nor LI is there — **these two ARE errors** |

**So the ground truth's union is INCOMPLETE for four dates**, and the
2026-11-04 note on `20220412` already suspected it: *"A twelve-row frame
carrying GUSH exists at t=936 s of the same video, but it is a later moment
and is not the frame this capture was read from."* That reasoning holds for
the ANCHOR — a capture's reading must be the frame it was read from — but
the UNION is over a date's captures, so a later moment is a MISSING CAPTURE,
not a wrong reading. The wave-2 audit added captures 1 and 2 to `20220608`
for exactly this reason.

**The new moments are now their own captures.** The fixture rebuild was
idempotent (`--check` matched the committed manifest byte for byte), so the
case table was extended and the crops regenerated:

| date | new capture | rows | what the union gained |
| --- | --- | --- | --- |
| `20220330` | 1 | 10, "10 Items" | `MU`, `JNUG` |
| `20220412` | 1 | 12, "1 of 12 Items" | `GUSH` |
| `20220606` | 12 | 9, "9 Items" | `COIN` |
| `20220607` | 3 | 9, "3 of 9 Items" | `WEAT`, `TQQQ` |
| `20220405` | 1 | 14, "14 of 14 Items" | `ERX`, `LHX`, `LMT`, `URA`, `URNM` |

Each crop is md5-pinned under `test/fixtures/qmg_ground_truth/`, and the
checker agrees. `20220413`'s `GUSH` and `LI` stay false positives: that
panel's eleven rows do not contain them.

**`20220405` is the fifth, and its five "false positives" are all real.** The
scan's three frames — clock 15:45, 16:04 and 16:08 — all show the SAME
fourteen-row panel: `GGPI, REGN, COPX, FCX, TAN, NEM, LMT, X, LHX, JNUG,
NUGT, ERX, URNM, URA`, footer "14 of 14 Items in Personal WatchList". The
ground truth's union is the eleven rows of an EARLIER moment (clock 15:29:
`CWEB, REGN, KWEB, JNUG, GGPI, TAN, NEM, COPX, FCX, NUGT, X`), so `ERX`,
`LHX`, `LMT`, `URA` and `URNM` are real holdings the union never saw. The
reading published **13 of the panel's 14** — it dropped `X`, the one-glyph
row — and scored 8/11 with five false positives that were all true.

So the pattern is now five dates, and the diagnosis is one thing: **the
union is a union over the captures the ground truth was ANCHORED to, and the
rescan captured other moments.** The panel's own count is what proves it —
a reading whose length matches the panel is a complete reading of THAT panel,
whatever the union says.

**The scan tool now publishes the per-frame check.** `panel_row_count_matches`
is true when the FIRST capture's reading has as many tickers as the panel says
are on screen. It is a DIAGNOSTIC and is never acted on: a count misread low
would truncate a correct reading, and a count read from a different frame
would judge the wrong reading.

## A failed caption fetch is NOT a video with no captions (2026-11-10)

The pipeline keeps a **caption-less list** per channel
(`data/catalog_flat/<channel>_no_captions.txt`) so a video with no caption
track is not re-requested on every pass. That list is a **BLACKLIST**: the
chunk runner filters it out of its pending set and never asks for the video
again.

**A wrong entry is therefore permanent, and it is expensive.** A video the
list wrongly excludes is not merely delayed — a later Deepgram pass sends it
to a PAID transcription API for audio that YouTube will transcribe for free.

That is what happened to T3Live. Of **237** entries in
`data/catalog_flat/t3live_no_captions.txt`, **119 were wrong** — those
videos do have auto-captions and were fetched once during a bad window.
The tool reported every failure as "no captions", so the run's bad luck
became a permanent fact about the video.

**Two defects made it happen, and both are fixed:**

1. **The verdict was read from the wrong stream.** yt-dlp prints
   `[info] There are no subtitles for the requested languages` on
   **stdout**, and only its warnings on stderr. Reading stderr alone
   therefore classifies *every* genuinely absent caption track as a failed
   fetch — and, once the two were collapsed into one message, every failed
   fetch as an absent track.
2. **`--write-auto-subs` alone misses manual captions.** A video with
   hand-uploaded subtitles looks caption-less to a run that only asks for
   the automatic ones. Both flags are now passed.

**The rule, and it is the one that matters:** a video may be blacklisted
only on YouTube's own answer. `classifyMissingCaptions()`
(`tools/fetchSevcikTranscripts.js`) reports three things, and only the
first one is permanent:

| verdict | what it means | what to do |
|---|---|---|
| `no captions` | yt-dlp said the track is absent | blacklist it |
| `caption fetch failed (…)` | the REQUEST failed — bot check, cookie, network | retry, never blacklist |
| `rate limited (HTTP 429)` | the endpoint is throttling this IP | wait 30–60 min |

The blacklist entry now carries **the verdict that justified it**
(`id<TAB>reason`), so a reader can tell a video YouTube said has none from
one a run merely failed to fetch.

Pinned by `test/fetchCaptionClassification.test.js` — the verdicts, the
**stdout** reading (the case the first fix would have got backwards again),
and the fact that a failure's detail text can itself contain the phrase
"no captions" and must still not blacklist. `test/fetchTranscriptChunks.test.js`
pins the runner side: a failed fetch is never blacklisted, and an entry
carries its reason.

**Before trusting any caption-less list again, audit it.** The check is
cheap and it is the whole fix:

```bash
node -e "const fs=require('fs');const ids=[...new Set(fs.readFileSync('data/catalog_flat/t3live_no_captions.txt','utf8').split(/?
/).map(s=>s.split('	')[0].trim()).filter(Boolean))];
let cap=0,dg=0,none=0;for(const id of ids){const f='data/video_pipeline/transcripts/'+id+'.json';
if(!fs.existsSync(f)){none++;continue;}try{const d=JSON.parse(fs.readFileSync(f,'utf8'));d.provider==='deepgram'?dg++:cap++;}catch(e){none++;}}
console.log({unique:ids.length,nowHaveCaptions:cap,deepgram:dg,nothing:none});"
```

`nowHaveCaptions` above zero means the list holds entries the tool got
wrong.

## The Sevcik source — a TRANSCRIPT source, not an OCR source (2026-11-04)

> **The 2026-11-05 update below supersedes two claims in this section.** The
> channel is read as **Czech**, not as a machine-translated English track, and
> the vocabulary is Czech rather than English. Read the section that follows
> this one first.

## The Sevcik source — a TRANSCRIPT source, not an OCR source (2026-11-04)

`https://www.youtube.com/@davidsevcik-sved4697/streams` — daily ~1 h streams of
spoken trade commentary. This is the project's **fourth** data source and the
**first** one that is not an OCR source: there is no whiteboard and no chart
overlay, only a person talking about tickers and prices.

**It reuses the catalog, `state.sqlite` and the `videos` table, and it touches
none of the OCR code.** The pipeline is four stages, and each is a separate
tool so a stage can be re-run without re-doing the ones before it:

```text
catalog (existing)  →  transcripts  →  signals  →  aggregation
                       (fetch)        (extract)     (CSV + JSON + HTML)
```

| stage | tool | writes |
|---|---|---|
| transcripts | `tools/fetchSevcikTranscripts.js` | `data/video_pipeline/transcripts/<video_id>.json`, `video_transcripts`, `transcript_segments` |
| signals | `tools/extractSevcikSignals.js` | `trade_signals` |
| aggregation | `tools/aggregateSevcikSignals.js` | `data/sevcik_signals.csv`, `data/sevcik_daily_summary.csv`, `data/sevcik_ticker_summary.csv`, `data/sevcik_signals.json`, `data/sevcik_report.html` |

```bash
node tools/runWhiteboardWorker.js catalog --channel davidsevcik \
  --source-url https://www.youtube.com/@davidsevcik-sved4697/streams

node tools/fetchSevcikTranscripts.js --limit 3
node tools/extractSevcikSignals.js
node tools/aggregateSevcikSignals.js
```
### The corpus, as of 2026-11-06 — the channel is FULLY READ

Every catalogued stream has a transcript, and every transcript has been through
the extractor. Measured, not estimated:

| stage | count |
|---|---|
| catalogued `davidsevcik` videos | 497 (2020-08-13 → 2026-11-04) |
| transcripts on disk | 491 |
| transcripts ingested (`video_transcripts`) | 491 (698,450 segments) |
| signals (`trade_signals`) | 1012 across 340 videos, 26 tickers |
| setups (`sevcik_setups`) | 2009 across 406 videos, 32 setup tickers |
| TA claims scored | 1279 |

The six streams with no transcript are the **quarantined non-market series**
(the "14 dní" challenge streams and similar). `src/sevcik/contentFilter.js`
drops them on purpose, and the fetch, the extractor and the aggregator all
apply the same filter, so they never enter the corpus.

**The stage order is outcomes → aggregate → ta, not aggregate → ta.**
The aggregate reads `data/sevcik_outcomes.json` and embeds it in the payload,
and the TA tool then re-embeds its summary and rebuilds the report. Run in the
wrong order the report keeps the PREVIOUS run's outcomes — which is what
happened on 2026-11-05: the panel said "Not scored yet" while the database held
68 outcome rows from an older, smaller corpus.

```bash
node tools/analyzeSevcikOutcomes.js    # prices, cached under data/price_cache/yahoo
node tools/aggregateSevcikSignals.js
node tools/analyzeSevcikTa.js
```

**What the claims actually score.** Over the 1,279 claims: **hit rate 1w 52.2 %**
(95 % CI 49.5–54.9 %), **hit rate 1m 54.6 %**, against a **SPY baseline of
58.4 %** on the same window — so the tool's own verdict is
`assess: no_clear_edge`, with 3 claims missing prices. The TA pass scores the
same 1279 claims at 53.3 % (primary bucket 54.0 %), and its 48 walk-forward
folds select an allow-bucket in only 4 of them. **The honest reading is that
this source is not yet shown to beat the index**, and the corpus is now large
enough (491 transcripts, 2020–2026) to say so rather than to hope for it.

### A completed trade is not a live call (2026-11-09)

The T3Live test runs published this as a **bearish TSLA**:

> "I'm still in Tesla. Tesla did not give me a reason to get out of it. Tesla
> was a great trade. ... I used my tier system. I sold some."

The speaker was long, bullish about the name, and describing a tiered exit.
The direction came from "sold some" — a trade that was already over.

**"I sold some" and "I'm selling some" are different claims.** The first is
history and says nothing about where the price goes next. The second is a
call. The action patterns deliberately match both, because the report wants
to know what the speaker did with the name; but a completed trade cannot
carry a direction.

Measured on the T3Live corpus (3,190 signals): **258** had a past-tense sale
as their only direction evidence, and **144** of those were published as
forward claims and scored as predictions.

The fix splits the English action patterns on tense and marks the past ones
`completed: true`. `actionBias(action, completed)` and
`actionImpliesDirection(action, completed)` return `''` and `false` for a
completed action, so the window needs a live statement to be a call.

T3Live's signal count went **3,190 → 2,912**. **Sevcik is unchanged at 1,444**:
the change is English-only, and the Czech action patterns are a separate list
that was not touched. That asymmetry is the point — a fix to the shared
engine that moved one corpus and not the other has to say which one and why.

Pinned by `test/sevcikSignalExtractor.test.js` — four tests: a completed sale
is not a call, the action is still recorded, a live sale still is, and a
completed trade does not override a live direction.

### The confirmed spoken-names table had no English names (2026-11-09)

The table was grown from the **Czech** corpus, so an English stream resolved
almost nothing. Measured across **811 T3Live transcripts**: only **19**
tickers came back, and **1,357** spoken names were reported as candidates and
dropped. The Options In Play series produced almost no signals for exactly
this reason — the names were being **found and thrown away**, not missed.

Two defects, both fixed:

1. **Two words are one name.** "Goldman Sachs" read as two words matches
   several registrants and neither word identifies the company. Adjacent
   pairs are now tried first and the pair wins only when it resolves and the
   single words do not, so a pair never shadows a name that already works.
2. **The candidates were not confirmed.** The table now carries the English
   names, each row checked against its transcript context. Two of them
   resolved to the WRONG ticker through the SEC list — "morgan stanley" →
   EDD, "chase" → WHLT, "baba" → BABB — and the confirmed row is what
   overrides that.

`tools/surveyT3liveNames.js` writes `data/t3live_name_candidates.csv` with
the frequency and the sentences each name was said in, so the table is grown
from what the corpus says rather than from what someone assumed. The noise
words — Red, Dog, Trader, China, Team, Well, Good, Make, Take — are
deliberately NOT confirmed; each one is a real ticker in some registrant's
name and none of them is a company here.

The 25-video sample went from **12** resolved names to **23**.

### The confirmed spoken-names table grew on 2026-11-06

The matcher drops trailing vowels so "Applu" reaches "apple", but the
Czech endings that end in a **consonant** do not: "Amazonem" (instrumental),
"Trumpovi" (locative), "Teslech" (genitive plural), "AMDcko" (the Czech
shortening). The survey of the full corpus found 14 such forms, each checked
against the segment it came from, and each was added to
`config/ticker_names_confirmed.csv`.

Measured after the re-extract of the 66 affected videos:

| | before | after |
|---|---|---|
| signals | 1012 | **1015** (+3: DJT, SOFI, AMZN) |
| setups | 2009 | **2013** (+4 net) |

The gain is small because the extractor needs a DIRECTION next to the name,
and most of the new forms appear in descriptive contexts ("s Amazonem, ktery
investuje do Antropicu") rather than in trade-shaped sentences. The table is
still the right place for them: a future setup/signal that *does* name them
will now resolve.

Pinned by `test/sevcikCzechNames.test.js` -- "the case endings the first
stemmer missed also resolve".

### The vocabulary bugs, and what they cost (2026-11-06)

The vocabulary was built on a 12-stream corpus. On the full 491-transcript
corpus **150 of 491 videos produced ZERO signals**, and that was not because
the videos were quiet -- they are 30-60 minutes of chart commentary each.
Four defects explained it:

1. **`\w` does not match Czech diacritics.** `\w` is ASCII-only even under
   the `/u` flag, so `poklesov\w*` stopped before the `ý` in "poklesový" and
   **the whole pattern never fired**. "máme poklesový kanál" -- the way the
   speaker states a bearish call -- matched nothing. Every Czech word tail
   that ends in a diacritic was dead: `poklesov`, `klesajíc`, `rostouc`,
   `stoupajíc`, `shortov`, `longov`, `odmítnut`.
2. **The falling channel was in the BULLISH list.** "poklesový kanál" is a
   falling channel, and it was sitting in `BULLISH_PATTERNS`. So even once
   the `\w` bug was fixed, a falling channel read as a BULLISH call.
3. **The ASR drops the `g`.** "do Longu" is written "do Lon" in the
   transcript, and the pattern required the `g`. The single most common
   construction in the corpus did not match.
4. **There were no Czech BUY verbs.** The action table had the setup verbs
   ("do Longu" as an action) but not "kupuje" / "dokupuje" / "kupovat" /
   "sázím na", which is how he actually states a buy. "Berkshire masivně
   dokupuje Alphabet" and "jestli kupovat Google" produced nothing.

The fix, and the measured result over the whole corpus:

| | before | after |
|---|---|---|
| signals | 1012 | **1487** (+475) |
| tickers | 26 | **32** |
| videos with signals | 340 | **387** |
| videos with ZERO signals | **150** | **104** (-46) |
| TA claims scored | 1279 | **1734** |

**The hit rate went DOWN, and that is the honest result.** 1w 52.2 % ->
50.8 % (CI 48.4-53.1 %), 1m 54.6 % -> 53.8 %, against a SPY baseline of
57.9 %. The recovered claims are the descriptive ones -- "Berkshire dokupuje
Alphabet" is a statement about what Berkshire did, not a call on Alphabet --
so recovering them dilutes the average. A larger corpus that scores lower is
a more honest corpus than a small one that scored well by missing half the
channel.

The parser version moved `sevcik-signals-3` -> `sevcik-signals-4`, so every
row says which vocabulary produced it. Pinned by `test/sevcikSignalExtractor.test.js`
-- four new tests: the `\p{L}` tails, "do Lon", the Czech buy verbs, and a
Czech stream end to end.

### The transcripts are versioned; the interpretations are not

The transcript TEXT is static: the same video always yields the same words.
So it is in git, and it is the only thing in this pipeline that is:

| in git | not in git |
|---|---|
| `data/video_pipeline/transcripts/*.json` (646 files) -- the normalised transcript | `data/sevcik_signals.csv`, `data/sevcik_setups.csv`, the daily/ticker summaries |
| `data/video_pipeline/transcripts/*.vtt` (503 files) -- the raw YouTube caption tracks | `data/sevcik_signals.json`, `data/sevcik_ta_features.*`, `data/sevcik_outcomes.*` |
| `data/video_pipeline/state.sqlite` -- the catalog | `data/sevcik_report.html` |

The split is the point. The VTTs are YouTube's own captions, so the Czech
source text is recoverable from the repository alone, and a re-parse is
reproducible on any machine. The signals, the setups, the TA evaluation and
the dashboard are **interpretations**: they change when the vocabulary
changes, and this file records that they changed (a parser version per row,
a table of numbers per change). Committing them would put every
interpreter's output in the history as if it were a fact about the video.
The videos themselves are never committed -- they are large and always
available on YouTube.




### The channel is CZECH — and that changes the strategy

This is the first thing to know about the source, and it is not visible from
the URL. The channel is in **Czech**, and YouTube publishes **two** caption
tracks for it:

| track | what it is |
|---|---|
| `cs-orig` | the original Czech audio |
| `en` | YouTube's **machine translation** of it |

**`cs-orig` is tried FIRST.** It used to be the other way round, on the
reasoning that the signal extractor reads **English trading vocabulary** —
"bullish", "target", "stop loss", "going to buy" — and that a machine
translation preserves the **TICKERS and the NUMBERS** (which is what a
signal is about) while putting them into the words the extractor
understands. **That reasoning expired when the extractor was taught Czech.**

Measured over the same 12 videos, the English patterns matched **nothing**:
0 bias segments, 0 horizon segments, 2 signals from 12 videos. The Czech
patterns matched 160 bias segments and 147 horizon segments.

The machine translation is also the **worse record of what was said**. It
keeps the tickers and the numbers, but it **rewrites the certainty words** —
and his hedging and his conviction live in the wording, not in the numbers.
A prediction that came true is worthless without knowing whether he called
it as a certainty or as a coin-flip.

The order is `--sub-lang cs-orig,en` and it is a flag, not a constant —
`--sub-lang en` reads the machine translation.

### The transcript providers, in order

1. **YouTube auto-captions** — free, no key, no upload, and the audio never
   leaves the machine.
2. **Deepgram** (`nova-2`) — needs `DEEPGRAM_API_KEY`, uploads audio, costs
   money, and is the **only** way to reach the older videos, which carry no
   captions at all.

Captions are tried first **even when a Deepgram key is configured**, because
they are free and instant. Deepgram is the fallback, not the default. The
provider is recorded in `video_transcripts.provider`, because the two are not
equally trustworthy and a later reader has to know which one a signal came
from.

**The Deepgram key is never logged.** Error bodies are redacted before they
are printed, because an error body can echo the request headers.

### The Deepgram `language` is a MODEL choice, not a hint — and it is read too late

**`language` selects the ACOUSTIC MODEL.** Pointing the wrong one at Czech
audio does not produce a worse transcript — it produces **no transcript**.
Measured on one real 50-minute stream (2026-11-04, `UX1IRkmxIUo`):

| `language` | result |
|---|---|
| `en` | **15 segments** of isolated words ("Earnings", "Netflix") |
| `cs` | **881 segments** of full sentences |

The English run was not "less accurate Czech". It was the English acoustic
model failing to find any speech in the audio, so it emitted the handful of
words it could recognise as English. **Every downstream measurement would
have been made on that.**

Two defects, both of which made the shipped catalog lie about what it
contains:

**1. The request ignored `.env`.** `REQUEST_PARAMS` was a module-level
`const`, so it froze at require time — and the caller requires
`deepgramClient` on line 51 and calls `loadEnv()` on line **56**. So the
environment was not loaded yet when the parameters were captured, and a
`DEEPGRAM_LANGUAGE` in `.env` never reached the request. The parameters are
now built **per call** (`requestParams()`).

**2. Every transcript row claimed to be English.** The row's language was
defaulted to `en` for any Deepgram transcript, whatever the request did. All
**15** rows of the shipped catalog said `en` for Czech audio. The rows now
carry the language the request used, and the 15 stale rows have been
corrected to `cs`.

**The rule: a row never claims a language the provider did not report.** An
empty string is honest; a wrong one is not.

Pinned by `test/sevcikDeepgramLanguage.test.js` — the default is Czech, the
parameters are read at call time, and the request asks for the shapes the
normalizer needs.

**The subtitle endpoint and the video endpoint throttle separately.** The
caption path answers **429** on its own, and a 429 on the subtitle endpoint
says nothing about the video endpoint. Captions are worth fetching later:
they are free, and Deepgram is not.

### The extraction model — a RUN, not a window

The extractor is **rule-based on purpose**. Every rule is a claim about
English trading language that can be read, argued with, and measured, and the
same transcript always produces the same signals. A model-based extractor
would be better at some sentences and worse at others and nothing in the
output would say which — so a reading could not be checked against its
evidence. The evidence text is stored with every signal precisely so that a
human can disagree with a rule and see exactly what the rule saw.

**The transcript is cut into RUNS, one per ticker, and a run owns the speech
that follows the name until the next name.**

```text
"Let's talk about Tesla, TSLA. I am going to buy TSLA at 240, my target
 is 280. The stop loss is 225. Now for Nvidia, NVDA. I am bearish on it.
 The target is 120."

TSLA  "Let's talk about Tesla, TSLA. I am going to buy TSLA at 240,
       my target is 280. The stop loss is 225."
NVDA  "Now for Nvidia, NVDA. I am bearish on it. The target is 120."
```

**A window around each mention was tried first, and it was WRONG.** A window
of ±2 segments spans the move from one name to the next, and it blended two
calls into one. The measured damage on a 10-segment synthetic transcript:

| defect | what the window produced |
|---|---|
| the TSLA row carried NVDA's price | `stop_price` 225 on TSLA, and NVDA got TSLA's stop |
| the TSLA **stop** was labelled a **target** | `target_price_low` 280 AND 225 — one of them wrong |
| `short` (NVDA's) bled onto AAPL | AAPL published as `action=short, bias=bearish` when the text said "I am watching it" |
| one call produced three rows | TSLA emitted 3× with growing evidence, so the aggregate said TSLA was called three times |

**A wrong price on a real holding is worse than a missing one**, so the
window was replaced by the run model. A run is built by a single linear scan:
the first ticker of a segment owns the run-up to it ("I am going to buy TSLA
at 240" — the verb introduces TSLA), and every other ticker owns the text
from itself to the next one.

### A run is SPLIT where the speaker changed his mind

A run can hold two calls about one name: "I am bullish on TSLA" and "actually
I am going to short TSLA". Those are two calls at two moments, and publishing
them as one "mixed" row loses the timeline.

So the run is split at a segment whose **direction conflicts** with the
direction already established. A segment that adds no direction of its own
("the stop loss is 225") does **not** split the run — it belongs to the call
before it. A reversal therefore produces two rows, and a run that keeps
talking about one name produces one.

### The rules the extractor makes

All of them live in `src/sevcik/signalPatterns.js`, so they can be read and
argued with in one place.

- **A signal needs a TICKER.** "I am bullish" says nothing about what to
  buy, so it is not a signal.
- **A price needs a ROLE.** "$45" next to a ticker is not an entry level
  unless something said "entry", "buy at" or "target". A price with no role
  is **not recorded** — guessing a role puts a wrong number in a report.
- **The role keyword CLOSEST to the price wins.** The roles are tried in the
  order they are declared, but that order is **not** the order they appear in
  the text: "I am going to buy TSLA at 240, my target is 280. The stop loss
  is 225" has "target" before "stop", so a first-match-wins search labelled
  the STOP price 225 a target. Every role's match position is compared and
  the nearest one wins.
- **A common English word is not a ticker unless it is written in CAPS.** ON,
  BE, ARM, NET and TAN are real tickers AND words a speaker uses constantly.
- **A negation reverses the direction.** "Not bullish" is bearish.
- **A target implies bullish when no current price is known.** "The first
  target is around 78" is an upside claim, because a target is by definition
  a price the price is expected to move *toward*, and nobody states a
  downside level as "my target".
- **History and disclaimers are not calls.** "I was bullish on X" is history.
- **The horizon is the MOST SPECIFIC one, not the first one.** "Let's talk
  about Tesla today … this is a swing trade" states "today" first and means a
  swing; the patterns carry a `specificity` weight for exactly this.

### The confidence score

The score is the **strength of the language**, not a model's opinion:

```text
conviction = max(direction_strength, action_strength)
score      = conviction * 0.8 + 0.1 (has a price)
```

and a **stated confidence CAPS** the score (low → ≤ 0.45, high → +0.15).

**Adding the direction and the stated confidence together was rejected.** They
are both statements of how strong the speaker believes the call is, so they
are combined by taking the **stronger** of them. Adding them would let "maybe
I am bullish" score higher than "I am bullish", because "maybe" is both a
low-confidence marker and a direction word.

### The three tables

| table | holds |
|---|---|
| `video_transcripts` | one row per video: provider, language, path, segment count, checksum |
| `transcript_segments` | the normalized segments: `start_sec`, `end_sec`, `text`, `confidence` |
| `trade_signals` | the signals: ticker, action, bias, confidence, entry/target/stop, **evidence_text** |

**`evidence_text` is NOT NULL, and that is the point.** A signal without its
evidence is not checkable, and a portfolio report of unchecked claims is worth
nothing. Every row can be read against the words it came from.

The checksum (`transcriptChecksum`) **ignores timing**, so the same audio
produces the same checksum even when the caption timings shift — which is
what makes "has this transcript changed?" a meaningful question.

### The extractor writes a `parser_version` on every row

`sevcik-signals-1` is on every signal row, so a re-run with a changed parser
can be told apart from the previous one. A re-run **replaces** the signals of
the videos it processed and only those — it never deletes the signals of
videos it did not reach, so a partial run cannot lose work.

### The current state, and what is NOT done

| | |
|---|---|
| catalog | **15 real Sevcik streams** cataloged (2026-11-05) |
| schema + code | complete, **719 tests passing** |
| end-to-end | verified on a **synthetic** transcript — see below |
| real transcripts | **BLOCKED** — the YouTube *subtitle* endpoint returns `HTTP 429` for this IP |
| Deepgram | **not configured** — `DEEPGRAM_API_KEY` is not set |
| older caption-less videos | unreachable until a Deepgram key exists |

**The real-video smoke test the user asked for is still outstanding**, and it
is blocked on two things that were measured separately:

#### 1. The subtitle endpoint is throttled; the video endpoint is NOT

This is the important distinction, and it is easy to get wrong because
yt-dlp reports both as one failed command.

| operation | endpoint | measured 2026-11-04 |
|---|---|---|
| video metadata (`--print`) | the watch page | **works** — 2998 s, title, dates all read |
| caption LIST (`--list-subs`) | the watch page | **works** — `cs-orig`, `cs` and `en` all listed |
| the caption **URL** | `api/timedtext` | **HTTP 429**, with any user-agent |
| the caption download | `api/timedtext` | **HTTP 429** |
| the **AUDIO** download | the video endpoint | **works** — 42.4 MiB in 13 s at 3.1 MiB/s |

So the channel's captions **exist** (`cs-orig` is the original and `en` is
YouTube's machine translation), the metadata endpoint reads them fine, and
only the `timedtext` fetch is refused. The refusal is an IP-level Google
throttle: the response body is *"your computer or network may be sending
automated queries"*, and a browser user-agent does not change it.

**Cookies would probably fix it** — the project's own rule is that a
throttled YouTube session is fixed with fresh cookies from Firefox
Cookie-Editor. There is **no `youtube_cookies.txt`** on this machine and
no `YOUTUBE_COOKIES` in the environment, and the fetch tool passes
`--cookies` when `YOUTUBE_COOKIES` is set.

The project's rate-limit rule applies: **30–60 minutes of quiet** before
retrying. The backoff is `--rate-limit-attempts` (default 3) /
`--rate-limit-wait` (default 90 s).

#### 2. `DEEPGRAM_API_KEY` is not set

This needs the user. And the good news is that **only the API call is
missing** — the rest of the Deepgram path was measured end to end:

```text
yt-dlp -f bestaudio/best        →  42.4 MiB webm      ✓ works
ffmpeg -vn -ac 1 -ar 16000      →  18.0 MB mp3       ✓ works
POST api.deepgram.com/v1/listen →                     ✗ needs the key
```

So the moment a key exists, the older caption-less videos are reachable
without any further code work.

### What was verified instead, and what it does and does not prove

`test/sevcikEndToEnd.test.js` runs the whole chain — transcript file →
segments → signals → database → dashboard — on a **synthetic** transcript
written to look like what YouTube's machine translation of a Czech trading
stream produces. It exercises the chain and the output shape, and **it is
what found the four defects** the run model fixed (see § *The extraction
model*).

**It does not prove the extractor reads real Czech stream commentary**,
because no real transcript has been fetched yet.

### The extractor is deterministic, so a change to it is a change to the numbers

Every rule is in `signalPatterns.js`, and `parser_version` records which
version produced each row. A signal that changes without anyone noticing is a
wrong holding in a portfolio report, so the rules that matter are pinned by
`test/sevcikSignalExtractor.test.js` — **39 tests**, each worded as the claim
it makes, not as an implementation detail.

**And the CHAIN is pinned too**, by `test/sevcikEndToEnd.test.js` — **5
tests**. The chain is worth pinning separately because the individual stages
can each be right and the chain still wrong: all four defects above were
found by the chain and by **none** of the stage-level tests.

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

**The 535 need nothing written for them.** 219 are `pending` and 316 are
`scanning`, and both downloaders' candidate lists already contain those two
statuses, so they will be fetched. (The split by channel is 198 Qullamaggie
`pending` + 21 Revere `pending` + 316 Qullamaggie `scanning`; the 198/316
figures are the Qullamaggie subset alone.) What is *not* the case is a bulk
pointer repair: of the 535, only the two rows above have their media anywhere on disk,
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

# Measure what the curated-alias rows are worth, WITHOUT editing the shared
# config file -- the modified table is built in a temporary file.
node tools/evalParserReplay.js --drop-aliases A,AL
node tools/evalParserReplay.js --confusion-csv path/to/table.csv

# Check the Qullamaggie ground truth against the pixels it describes.
# Run this BEFORE quoting any Qullamaggie recall number.
node tools/checkGroundTruthConsistency.js
node tools/checkGroundTruthConsistency.js --json
node --test test/qmgGroundTruthProvenance.test.js

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

### The audit table is a log of RUNS, not of videos

`catalog_runs` holds **one row per command invocation**, not one row per
video. The per-video counts live *inside* the row (`inserted_count`,
`updated_count`), so the table's own size has nothing to do with the
catalog's size — and a reader who sums `inserted_count` and compares it with
`COUNT(*) FROM videos` is comparing two different quantities.

Measured on the shipped catalog (2026-10-29): `sum(inserted_count)` = **303**,
`sum(updated_count)` = **897**, against **2,402** video rows. The gap had
three separate causes, and only one of them was a defect:

| cause | rows it explains | a defect? |
|---|---|---|
| the table counts runs, not videos | the whole shape of it | no |
| `tools/importQmgChannel.js` writes `videos` and **never** writes `catalog_runs` | 539 Qullamaggie rows (2026-09-19) | yes — a second writer with no audit |
| `fill-dates` wrote its audit row only at the very end | 1,582 Revere rows (2026-10-26) | yes — the audit was lost with the run |

**The third was the big one, and it is fixed.** `fill-dates` saved its data
**per batch** (`upsert_catalog_rows` commits at every batch) but wrote its
`catalog_runs` row **after the whole `ThreadPoolExecutor` block finished**. A
run that was cut short therefore kept every row it had written and lost its
record entirely — the work survived and its provenance did not. The 2026-10-26
gap-fill is the visible symptom: the first batch (77 rows at
`2026-10-26T09:40:58`) is `catalog_runs` row 26, and the other **1,582 rows
across 65 batches are accounted for by no audit row at all**. The catalog's
largest population event was invisible in the table that exists to record it.

The fix moves the audit row to the **start** of the run and keeps its counters
in step with the data:

| what | where |
|---|---|
| `record_catalog_run()` returns the new `run_id` | `tools/whiteboard_worker.py` |
| `update_catalog_run()` refreshes the counters of an already-recorded run | `tools/whiteboard_worker.py` |
| the snapshot file and the audit row are written **before** the thread pool starts | `command_fill_dates` |
| `update_catalog_run()` is called **after every batch** | `command_fill_dates` |
| `persist_missing_titles()` returns `(written, inserted)` — the rows it INSERTs count toward `inserted_count` | `tools/whiteboard_worker.py` |

The rule this encodes: **an interrupted run must still leave a row, and that
row must report what it DID, not what it was asked to do.** `row_count` stays
the size of the work list it was given; `inserted_count`/`updated_count` are
what it actually managed. Pinned by
`test/whiteboardWorkerCatalog.test.js` → *"an interrupted fill-dates run still
leaves an audit row"*, which hangs the fake yt-dlp, kills the worker, and
asserts the row is still there with `inserted_count` = the rows that landed.

The second cause is still open: `tools/importQmgChannel.js` is a second writer
of `videos` with no audit row at all. It is a one-off import script for the
Qullamaggie channel, so the rows it wrote are real and the campaign is
recoverable — but nothing records that it happened.

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

**The chart-stream crop is ERA-CONDITIONAL.** It is not one rectangle, because Qullamaggie
changed the layout of his position list between 2023-01-26 and 2023-05-18 — before the change it
was a floating panel in the bottom-right corner, after it a table docked to the RIGHT edge of the
screen. The two layouts do not share a column.

The rectangles live in **`src/video/chartStreamCrop.js`** (which holds NO dependency on the OCR
stack, so `src/video/ocrScanArgs.js` can require it without pulling a subprocess-spawning module
into every CLI parse):

```js
CHART_STREAM_CROP_FLOATING_PANEL = '0.86,0.60,0.14,0.28'   // ← x,y,w,h (y = TOP edge)
CHART_STREAM_CROP_RIGHT_SIDEBAR  = '0.82,0.60,0.18,0.32'
CHART_STREAM_RIGHT_SIDEBAR_FROM  = '20230518'
```

`chartStreamCropFractionForDate(dateKey)` picks between them. The crop is the default
`phashRegionFraction` for the `chart_stream` prefilter profile.

**The crop region and the OCR crop width are different things.** The OCR engine receives a
*further* crop of that region, upscaled:

| Engine | Chart-stream region (2022 era) | Upscale | OCR input width (1080p source) |
|---|---|---|---|
| EasyOCR | x∈[0.86,1.0] of the frame | ×5 | round(0.14·1920)·5 = **1345px** |
| Tesseract | 250px-wide chart region | ×3 | 250·3 = **750px** |

The 1345px width is **resolution-dependent** — a 720p source gives round(0.14·1280)·5 = 895px.
Note the same video IDs exist in BOTH `downloads_1080p` (1920×1080) and `downloads_hires`
(1280×720), so a scan can legitimately run at either width.

**Never hardcode the crop width** — it is measured from the OCR input image at runtime
(`_cropWidth` on the OCR result). See "Column detection" below.

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

### The curated-alias rescue (added 2026-10-29)

A garbled ticker in the position list is lost **before** the repair pass can ever see it,
and the reason is structural.

`inListTickers` is the **price-aligned subset** of the detected column. A row whose price
is garbled (`$lO5.OO` for `$105.00`) is therefore *not* in `inListTickers`, so the column
gate rejects it:

```js
if (columnGateActive && !inListColumn && !(inLexicon && inListTickers.size >= 6)) { … }
```

That gate is exactly what keeps chart-area ink out of the list, so the garbled ticker never
reaches the "Post-pass: repair garbled in-column tickers" block — it is simply **missing**
from the reading.

The rescue substitutes the canonical from `config/ticker_ocr_confusions.csv` for a token
that is **spatially inside the column**, whether or not the gate accepted it. Three rules
keep it honest:

| rule | why |
|---|---|
| the token is inside the column (`\|left − dominant_left\| ≤ column_width / 2`, **or** `\|center − dominant_x\| ≤ column_width / 2`) | the column is the evidence that the token is a holding |
| the token is **below** the positions header and **above** the watchlist header | the panel's *own* bounds, not the caller's `impliedBottomLine` |
| the canonical is in the lexicon | the table is a curated list, not a generator |

**The rescue runs AFTER the repair pass, and it replaces in place.** An earlier attempt
pushed the canonical in *before* the repair pass; that pass's `!accepted.includes(aliased)`
guard then failed, so the raw survived as a **duplicate false positive**, and the extra
entries shifted Filter B's median y and evicted real holdings (`GTLB`, `DNA`, `APLD`,
`UPST`). Precision fell from 93.0 % to 86.2 %. Replacing in place means a garble the
repair pass already corrected is never joined by its canonical.

**Two designs were tried and rejected — both are worth remembering:**

- **A y-range gate on the rescued token.** The range is computed from the *accepted* set —
  which excludes exactly the rows worth rescuing, because a garbled price is *why* they
  were excluded. It rejected all eight rescuable holdings (OBTS 17 px above the range,
  GSI1 19 px below).
- **`impliedBottomLine`.** That is the caller's *heuristic* guess at where the list ends
  (`positionsLine + round(15 · 52 / medianRowHeight)`), and the parser never applies it to
  the accepted set. The real lists in the corpus are longer than 15 rows. Using it as a
  bound blocked the remaining rescues (DIA, PLIR, GSII, GSI1, GS11).

**Measured** with `node tools/evalParserReplay.js --json` on its default 8 roots. Census:
42 files, 42 logs, 11 logs with words, 99 captures in ground-truth logs, **12 captures
with words**, 40 ground-truth dates, 33 dates with a log, **8 dates scored**, 25 lost to
missing words, 7 never seen. *(This is a surviving sample, not a corpus-wide figure — see
§ 'The replay tool is a surviving sample'.)*

| | baseline | after the rescue | after + `TTOCQ→TQQQ` |
|---|---|---|---|
| hit / gt / pred | 53 / 89 / 57 | 59 / 89 / 63 | **59 / 89 / 62** |
| micro recall | 59.6 % | 66.3 % | **66.3 %** |
| micro precision | 93.0 % | 93.7 % | **95.2 %** |

A **corpus-wide audit** — baseline vs fixed over every word-bearing capture in the corpus,
not only the scored ones — found **10 additions, every one of them in the ground truth,
and no removals at all**: DNA ×1, GSIT ×3, PLTR ×1, QBTS ×2, RGTI ×2, TQQQ ×1.

**`TTOCQ→TQQQ` was added to the confusion table** (2026-10-29): it is a recorded misread of
`TQQQ` with no lexicon ticker within edit distance 1, so it published verbatim as a false
positive.

> **A ticker's text comes from the OCR, and `hasPriceNear` interpolates it into a
> `RegExp`.** Interpolated raw, an unbalanced `(` produced `SyntaxError: Unterminated
> group` and took down the **whole parse** — the whiteboard path reaches it through
> `acceptCandidates`, where the candidate token is *not* shape-constrained (`"1.02(-0.20"`
> is a real reading from a whiteboard frame). The ticker is now escaped
> (`escapeRegExp`), and the whiteboard call site runs the cheap shape test before building
> the pattern. Escaping also makes a dotted ticker literal: `BRK.B` no longer matches
> `BRKXB`.

### Nine more curated aliases (added 2026-10-31)

The 2026-10-29 rescue used aliases that were already recorded misreads of **2022-era**
holdings. The **2023-era** captures had their own set. Nine rows were added:

| garbled | canonical | the misread |
|---|---|---|
| `INGN` | `IMGN` | G rendered as N |
| `KOT` | `IOT` | leading I dropped, T rendered as O |
| `AQQ` | `ARQQ` | R rendered as Q |
| `GS0T` | `GSIT` | I rendered as 0 |
| `RLI` | `RGTI` | G and T rendered as L and dropped |
| `QBIS` | `QBTS` | T rendered as S |
| `ATR` | `PLTR` | P and L rendered as A and dropped |
| `A` | `AI` | single-letter read of the two-letter ticker |
| `AL` | `AI` | I rendered as L |

**Not all nine buy a hit, and this table says which do — measured, per group.**
`tools/evalParserReplay.js --drop-aliases A,B` re-scores the corpus with those rows
removed (see § 'Measuring the alias table without editing it'), so every row's worth is a
number rather than an argument. Baseline is **71/89/74** on the default roots and
**117/170/140** on the wide corpus.

*(Every number in this section is a **2026-10-31 snapshot**, taken with that day's
parser and that day's ground truth. The current figures — and the attribution of
every change since — are in § 'Filter B — the position-aware vertical bound'.)*

| rows dropped | default roots | wide corpus | what the rows are worth |
|---|---|---|---|
| *(nothing — baseline)* | 71/89/74 | 117/170/140 | — |
| `INGN`, `AQQ`, `GS0T`, `ATR` | 64/89/67 | 114/170/137 | **7 hits** / **3 hits** — four holdings recovered |
| `A`, `AL` | 66/89/69 | 113/170/136 | **5 hits** / **4 hits** — the `AI` rows, and they fire only after the left-edge column fix (see § 'The column test' below) |
| `QBIS` | 71/89/74 | 117/170/141 | **0 hits, 1 false positive** on the wide corpus — it rewrites the false positive `NBIS` into the real holding `QBTS` |
| `TTOCQ` | 71/89/**75** | 117/170/**141** | **0 hits, 1 false positive** on both — it is the `TQQQ` misread |
| `KOT`, `RLI` | 71/89/74 | 117/170/140 | **nothing at all** — the canonicals of `KOT` and `RLI` are already hits on the dates where the garbled forms occur |
| all six of the above | **59/89/62** | — | the whole gain, and it reproduces the documented "before the nine rows" figure exactly |

So **five** of the nine rows are worth a hit or a false positive today (`INGN`, `AQQ`,
`GS0T`, `ATR`, `A`, `AL`, `QBIS`, `TTOCQ` — six that move the number, and `KOT`/`RLI`
that do not). The two dead rows are kept because the misreads are real and recorded — a
row that does not fire today can fire on the next frame that reads that way.

**`A` and `AL` could not fire until the column fix, and the reason was the column test,
not the table** — § 'The column test' below has the measurement.

**Measured** with `node tools/evalParserReplay.js` (no OCR — it replays the captured probe
logs through the current parser). The baseline was reproduced by swapping the pre-change
file back in, so every column comes from the same corpus and the same command. The three
columns are cumulative: the nine rows alone, and then the left-edge column fix on top
(§ 'The column test' below):

| | before | after the nine rows | after the column fix |
|---|---|---|---|
| default roots — hit / gt / pred | 59 / 89 / 62 | **66 / 89 / 69** | **71 / 89 / 74** |
| default roots — micro recall | 66.3 % | **74.2 %** | **79.8 %** |
| default roots — micro precision | 95.2 % | **95.7 %** | **95.9 %** |
| wide corpus — hit / gt / pred | 110 / 170 / 134 | **113 / 170 / 136** | **117 / 170 / 140** |
| wide corpus — micro recall | 64.7 % | **66.5 %** | **68.8 %** |
| wide corpus — micro precision | 82.1 % | **83.1 %** | **83.6 %** |

**The default corpus gained seven hits and NOT ONE new false positive** (3 FP before, 3
after — the precision rise is the denominator growing, not the FP count falling). The wide
corpus gained three hits and **lost** one false positive. The column fix then added
**five more hits** (all `AI`), again with **no false positive added** on either corpus.

**Per date, on the default roots** — the baseline was reproduced by swapping the pre-change
file back in, so both columns come from the same corpus and the same command:

| date | before | after | what the rows recovered |
|---|---|---|---|
| `20230609` | 9/13 | **11/13** | `IMGN`, `PLTR` |
| `20230605` | 6/11 | **10/11** | `ARQQ`, `GSIT`, `IMGN`, `PLTR` |
| `20230602` | 8/12 | **9/12** | `PLTR` |
| `20230608`, `20220218`, `20230522`, `20230523`, `20220301` | unchanged | unchanged | — |

`QBTS` is **not** among the `20230602` recoveries: that date's `QBTS` was already a hit
from another capture, so the `QBIS → QBTS` row changes nothing there. These per-date
figures are for the nine rows **alone**; the column fix adds `AI` on top of them.

On the wide corpus the same rows take `20230609` from 10/13 to **12/13** and `20230602`
from 9/12 to **10/12**, and they remove one false positive (`NBIS`, on `20230608`).

**Two of the nine rows could not fire until 2026-10-31, and the reason was the column
test, not the table.** `A → AI` and `AL → AI` are recorded misreads — the captured frames
show a one- and a two-character glyph in the ticker column where the `AI` row belongs —
but the rescue never reached them. It asks whether a token is inside the column by
comparing the token's **centre** with the column's median centre, within a hardcoded
±25 px (`columnWidth = 50`, `parseChartStream.js`), and a position list is a
**left-aligned** table, so a four-character ticker's centre sits ~64 px right of a
one-character glyph's centre even though both start at the same x.

Measured on `20230609`: every ticker in the column starts at x 515–518, and the `A` glyph
starts at x 518 too — but its centre is 545 while the column's median centre is 581.5, so
`|545 − 581.5| = 36.5 > 25` and the token is rejected before the alias is ever
consulted. The same holds for `Al` on `20230608` (centre 87, median centre 125.5).

**The column test now compares LEFT edges**, and the two rows fire. See § 'The column
test' below for the fix and its measurement.

**`ATR→PLTR` is the row that depends on the order of operations.** `ATR` is on
`TICKER_BLOCKLIST` — it is the chart's own indicator label, and it is a real ticker symbol
(Aptar Group) that is never a Qullamaggie position. On the 2023-era table the row that
reads `ATR` **is** the `PLTR` row. The blocklist filter at `parseChartStream.js:1022` would
have deleted it, but the alias pass runs **before** the blocklist, so the row is rescued
instead of dropped. Removing `ATR` from the blocklist instead would publish `ATR` as a
false positive on every 2022-era layout, where the label is genuinely the indicator.

**`A` and `AL` are real-world tickers** (Agilent, Alcoa) that this project does not hold,
and neither is in the seed or the decode lexicon. So the alias cannot shadow a legitimate
reading *here* — but that is a property of the lexicons, not of the table, and it would
have to be re-checked if either lexicon ever grew a one- or two-letter ticker.

**The curated benchmark moves, and it moves twice.** A fresh EasyOCR run over the four
md5-pinned fixtures, with the **pre-alias** confusion table in place, reproduces the
documented per-case numbers **exactly** — 8/9 (2 FP), 1/1 (3 FP), 7/8 (3 FP), 7/13
(3 FP), overall **82.6 %**. The nine rows then take `dense_2023` from 7/13 to **8/13** —
the `ATR → PLTR` row fires on that frame, because a fresh EasyOCR read of it produces the
garbled `ATR` — and the column fix takes it to **9/13**, because the same read produces a
one-character glyph where the `AI` row belongs. `GSIT` and `IOT` are still **misses** on
that frame: the fresh read produces neither `GS0T` nor `KOT` there.

| | per-case | `dense_2023` | overall |
|---|---|---|---|
| before the nine rows | 8/9 (2 FP), 1/1 (3 FP), 7/8 (3 FP), 7/13 (3 FP) | 53.8 % | 82.6 % |
| after the nine rows | 8/9 (2 FP), 1/1 (3 FP), 7/8 (3 FP), **8/13** (3 FP) | 61.5 % | 84.5 % |
| after the column fix | 8/9 (2 FP), 1/1 (3 FP), 7/8 (3 FP), **9/13** (3 FP) | **69.2 %** | **86.4 %** |

**No false positive was added at any step** — the per-case false positives are 2, 3, 3
and 3 throughout.

**The table's invariants are now pinned** by `test/ocrConfusionAliases.test.js`, over
**every** row and not only the new ones:

| invariant | why |
|---|---|
| no garbled form is in the seed or the decode lexicon | an alias must not rewrite a real holding |
| every canonical is in the seed lexicon | the seed is the ALLOW list — a canonical outside it is resolved and then discarded |
| no duplicate key, no chain | the table must not resolve one read two ways, nor rescue a canonical again |

The same file pins the **behaviour**: each of the nine is rescued into its canonical when
it sits in the column, and is **not** rescued when it sits in the chart area or below the
Personal WatchList header. The two boundary assertions carry a control alias (`DIA→DNA`,
in the column in every frame) so that "the canonical is absent" cannot pass for the wrong
reason.

### Four more curated aliases, and the two lexicons (2026-11-01)

**Four more alias rows**, all from the 2022-era captures the ground-truth audit
pinned:

| garbled | canonical | the misread | date |
|---|---|---|---|
| `TCOQ` | `TQQQ` | C rendered as Q | 20220331 |
| `KVEB` | `KWEB` | W rendered as V | 20220331 |
| `KLVEB` | `KWEB` | W rendered as LV | 20220405 |
| `GGP1` | `GGPI` | I rendered as 1 | 20220405 |

Each garbled form occurs **exactly once** in the corpus, **in the position-list
column**, on a date whose pixel-verified ground truth holds the canonical and
not the garbled form; and all three of the table's invariants hold (no garbled
form is in the seed or the decode lexicon, every canonical is in the seed, no
duplicate key and no chain). The table is **32 data rows**.

**Measured, with the same replay and the same corpus as everything else:**

| | default roots | wide corpus |
|---|---|---|
| without the four rows | 75/85/76 — 88.2 % / 98.7 % | 123/168/143 — 73.2 % / 86.0 % |
| with them | 75/85/76 — 88.2 % / 98.7 % | **127/168/145 — 75.6 % / 87.6 %** |

**Four hits on the wide corpus and nothing on the default roots** — the four
garbled forms live on dates the default sample does not reach. The hit count
rises by four and the prediction count by two, so two of the four rows publish
a canonical that was already a hit on another capture of the same date.

**The seed lexicon grew by 16 pixel-verified Qullamaggie holdings.** The seed
is the **allow** list for the whiteboard path and the **match** list for the
chart-stream path, so a holding the seed does not know is either dropped or
repaired to a neighbour. The audit read 94 pinned panel crops off their
pixels, and the tickers they show had to be added:

```text
AGQ  AR  DWAC  ERX  FNGU  GGPI  GUSH  KOLD
LAC  LMT  MOS  NRGU  RSX  SWN  UPST  VERU
```

224 → 240 rows, each carrying the date it was read from and the note
"position-list pixels verified 2026-11-01". `PSX` was **kept** deliberately —
it is a real ticker (Phillips 66) and a real reading, and it is one of the
readings the 20220323 capture publishes; that capture is a garbage Tesseract
read whose false-positive set is a separate problem, recorded above.

**Measured, in isolation** (new parser, new alias rows, the old seed):

| | default roots | wide corpus |
|---|---|---|
| old seed | 78/85/80 — 91.8 % / 97.5 % | 130/168/149 — 77.4 % / 87.2 % |
| new seed | **80/85/81 — 94.1 % / 98.8 %** | **132/168/151 — 78.6 % / 87.4 %** |

**The observed list lost nine rows the audit discredited.**
`config/ticker_lexicon_observed.csv` is the "seen in a position list" list, and
it is the second half of the decode lexicon (seed + observed). Nine of its
rows were wrong, and they were wrong in two different ways:

| ticker | why it went |
|---|---|
| `CRH`, `IBKR`, `KRE`, `XLV`, `EDV` | read off the **upper watchlist widget**, not the positions table — index/ETF symbols that were never Qullamaggie positions |
| `DIDI` | a **watchlist** entry in the upper widget of the 20220318 capture (`27 of 30 Items in WatchList`) |
| `DCX` | a **misread** of `FCX` — every sibling capture of that video read `FCX` |
| `NDGU` | a **misread** of `NRGU` |
| `NUZE` | in **no** positions panel in the corpus at all |

26 → 17 rows. **Every remaining observed ticker is now also in the seed**,
which is the property the two lists exist to express: a ticker that was seen in
a position list and is not allow-listed is resolved and then **discarded** —
exactly how `SPXL` was lost for a week, and how a chart-stream reading is
repaired to a neighbouring seed ticker instead of to itself.
`test/tickerFuzzyResolve.test.js` now pins that property in place of the old
`decode.length > seed.length` assertion, which the cleanup made false.

**The blast radius was measured, and it is different for the two paths.** The
chart-stream parser reads the **seed** only (`parseChartStream.js`), so the
observed removals do not touch it at all. The whiteboard path reads seed +
observed, and its replay is **unchanged**: `node tools/evalRevere.js --replay`
still reports **94.0 % recall (140/149), 100 % precision**. The one place the
removal *helps* is the decoder: five of the repairs the `O→D` confusion row
used to make were repairs **into discredited tickers** (`DCX ← OCX`,
`NDGU ← NOGU`, and three reads targeting `DIDI`/`EDV`), so the row's gain
count fell from 38 to 33 — and the five it lost were exactly the wrong ones.
`test/lexiconVariants.test.js` no longer asserts a count that moves with the
lexicon; it asserts the property instead — that **every** gain the row adds is
a read with one of its O's read as a D.

### Two more curated aliases (added 2026-11-02)

Two rows, both **pixel-verified** before they were measured, and both found by the
same method: a garbled token in a captured frame is located on the source pixels
**before** an alias is proposed for it. The table is **34 data rows**.

| garbled | canonical | the misread | date | measured worth |
|---|---|---|---|---|
| `WHX` | `LHX` | W rendered as H | 20220412 | **+1 hit** (wide corpus), 0 FP |
| `CBO` | `CBIO` | I dropped | 20220606 | **neutral** — see below |

**`WHX → LHX` is worth a hit.** The marked token box sits precisely on the **LHX**
glyphs in the Sym column's first row of the pinned crop
`test/fixtures/qmg_ground_truth/20220412_c0.png` (panel rows LHX, LMT, URA, URNM,
WEAT, X, COPX, FCX, REGN, NUGT, JNUG; footer "11 Items in Personal WatchList").
It occurs **exactly once** in the corpus, and only `20220412` moves when it is
dropped (hit 9 → 10, missed `["LHX","LMT"]` → `["LMT"]`, false positives `[]` →
`[]`).

**`CBO → CBIO` is pixel-verified but earns nothing today — and the reason is
instructive.** The 20220606 diag capture's slot-4 token is a **genuine `I`-dropped
`CBIO`**: its glyph profile has cosine similarity **0.9990** against batch1's `CBIO`
row, against 0.73–0.81 for every other row of the same panel. It occurs exactly
once in the corpus, in the Sym column, on a date whose pixel-verified ground truth
holds `CBIO`.

**It cannot fire, because the column detector latched onto the wrong column.** On
that capture the detector reported

```jsonc
{ "column_width": 50, "dominant_x": 770, "dominant_left": 684, "in_list_token_count": 4 }
```

— the **`% Change`** column at x 684, not the Sym column at x 450 — so `CBO` was
never inside the detected column, and the alias rescue's spatial test rejected it
before the table was consulted. The capture's own reading was
`position_list = ["AI","CF","COIN","CUSS"]`.

**The row is kept anyway, on the 2026-10-31 precedent**: a recorded misread that does
not fire today can fire on the next frame that reads that way, and the misread is
real and verified. The alternative — a row that is only kept when it earns a hit —
would have discarded `KOT` and `RLI` too (§ 'Nine more curated aliases'), which are
also recorded misreads that earn nothing today.

**Measured, with the same replay and the same corpus as everything else:**

| alias table | default roots | wide corpus |
|---|---|---|
| 32 rows (before) | 80/85/81 — 94.1 % / 98.8 % | 132/168/151 — 78.6 % / 87.4 % |
| **34 rows (shipped)** | **80/85/81 — 94.1 % / 98.8 %** | **133/168/152 — 79.2 % / 87.5 %** |

The default roots do not move (neither date is in that set). The wide corpus gains
the one `WHX` hit.

**Three candidates were REJECTED, and pixel inspection is what rejected them.** Each
looked like a plausible misread from the OCR text alone:

| candidate | what it really was | how that was established |
|---|---|---|
| `CO → UCO` | a **% Change cell** read as `+0,43%` | the token sits at x 682, in the % Change column of the VLO row — not on `UCO` at all |
| `REIGN → REGN` | **chart-area ink** | the box lands near the 24.00/23.00 price labels, far from the Sym column |
| `IMG → IMGN` | the **Sym header band** | the box sits just under the "Sym" header, above the PLTR row; the IMGN row is far below in the 2023-era sidebar |

**The general lesson: the crop geometry must come from the log, and it must be
validated.** Two errors produced wrong verdicts before the geometry was right:

- **The crop region is not always the default.** `log.phash_region_fraction` records
  the region the run actually used; the 20220606 diag log used
  `{"x":0.86,"y":0.55,"w":0.14,"h":0.45}`, **not** the `0.86,0.62,0.14,0.22`
  chart-stream default. Rendering the default produced an 1187 px image against the
  log's max word bottom of 2433 — a mismatch that says the geometry is wrong.
- **The OCR image width is not `log.ocr_frame_width`.** The EasyOCR crop width is
  **1345** (fixed), whatever the source frame's width. Using the log's
  `ocr_frame_width` (1280) rendered 2314 px against a max bottom of 2419.

Both are caught by one check: **the rendered height must equal the log's max word
bottom.** With the right region and the right width the two agree to within ~1 %
(2432 vs 2419, 2435 vs 2433). A wrong geometry does not merely mis-render — it
**refutes a real misread**, which is the worst possible failure for a check whose
whole purpose is to reject false candidates.

**A 7.6 px glyph cannot be read by eye, so the `CBIO`/`CBO` question went to
arithmetic.** The CBO cell is 15.9 × 7.6 source px; a 4-glyph `CBIO` and a 3-glyph
`CBO` are indistinguishable by inspection. The **column-intensity cosine similarity**
of the two glyph profiles settles it: 0.9990 for `CBIO` against 0.73–0.81 for every
other row in the same panel. **A pixel-identity test beats a human reading of a
7.6 px glyph** — and it is the only way that row could be verified at all.

**The row-band detector needed its threshold lowered.** A first attempt at locating
the `CBIO` row used `s/29 > 60` and found only 4 row bands, so it compared
*different rows* in the two frames — batch1's `CBIO` at y 802–809 against the diag
frame's `CBO` at y 783–791 — and produced spuriously similar profiles. Lowering the
threshold to `mx*0.35` over x 1739–1769 found all 10 row bands in both frames, and
the comparison at the correct y values gave 0.9990.

### The LI row, and three more aliases (added 2026-11-02)

`LI` is the holding the corpus misreads most often. It is read as three different
things on three 2023-era dates, and **two** of the three are recoverable. The table
is **37 data rows**.

| garbled | canonical | the misread | date | measured worth |
|---|---|---|---|---|
| `V` | `LI` | L and I merged into one V glyph | 20230523 | **+1 hit** (both corpora), 1 FP removed |
| `NCH` | `FTCH` | FT rendered as N and C | 20230523 | **+1 hit** (both corpora), 1 FP removed |
| `N` | `AI` | L dropped and I read as N | 20230605 | **+1 hit** (both corpora) |

**All three rows were pixel-verified before they were proposed.** The corpus frame
`data/video_ocr_probe/batch15-v2/snapshots/revere_20230523.png` reads, in the
ticker column, `QBTS, FTCH, DNA, AI, SOUN, PLTR, APLD, IMGN, MNDY, LI, CVNA`
with the footer "11 Items in Personal WatchList". The OCR read the **LI** row as
`V` (left 97, top 1537, conf 0.108) and the **FTCH** row as `Nch`.

The third row comes from `data/video_ocr_probe/qmg-easyocr-20261017/snapshots/
qmg_20230605.png`, whose "A - Positions" panel reads, top to bottom:

```text
IMGN, ARQQ, CVNA, IOT, PLTR, GSIT, MNDY, APLD, AI, QBTS, DNA
```

The OCR read that column as `INGN, AQQ, CVNA, IOT, ATR, GS0T, MNDY, APLD, N,
OBTS, DNA` — the **AI** row came through as a bare `N`. The repair pass cannot
reach it: it skips tokens shorter than two characters, and the single letters it
does accept are the seed's own `U`, `X` and `P`. `N` is in neither lexicon, `AI`
is in the seed, and the table has no row keyed `N` and no canonical `N` — so the
row is legal on every invariant.

**`AI` is now the canonical of three rows** — `A → AI`, `AL → AI` and `N → AI`.
The 2023-era sidebar's two-character tickers lose their first glyph in three
different ways, and each row is a recorded misread against a real frame.

**`U → LI` was rejected, and the invariant is why.** The 20230522 capture reads the
same LI row as a plain `U` — and `U` is a **seed ticker** (`config/ticker_lexicon_seed.csv`
row 85) and a **genuine holding on 20221117**, in all three of that date's captures.
An alias row whose garbled form is in the lexicon rewrites a real holding, which is
exactly what the table's "no confusion row shadows a real ticker" invariant forbids.
So the misread has two spellings in the corpus (`V` and `U`) and **only one of them
may be rescued**. `NCH` is in neither lexicon and `FTCH` is in the seed, so that row
is legal.

**Measured, with the same replay and the same corpus as everything else:**

| alias table | default roots | wide corpus |
|---|---|---|
| 34 rows (before) | 80/85/81 — 94.1 % / 98.8 % | 133/168/152 — 79.2 % / 87.5 % |
| 36 rows (`V`, `NCH`) | 82/85/82 — 96.5 % / 100 % | 135/168/153 — 80.4 % / 88.2 % |
| **37 rows** | **83/85/83 — 97.6 % / 100 %** | **136/168/154 — 81.0 % / 88.3 %** |

Only **20230523** and **20230605** move: 9 of 11 with one false positive becomes
**11 of 11 with none**, and 10 of 11 becomes **11 of 11**. The default roots reach
**100 % precision** for the first time. No false positive was added on either corpus.

**The table is now 39 rows**, and the parser has changed since — the column gate
now admits a row on the list's own row stack, not only on price-alignment. The
current figures, and the attribution of both, are in § *The column gate —
price-alignment was the wrong evidence*. The 39th row came out of a production
scan rather than the replay corpus — see § *The 2023-era production smoke scan*.

**The two LI readings that stay missed are OCR losses, and they are not reachable by
any alias row.** 20230522 reads the LI row as a plain `U` (the invariant above), and
20230518 — a garbage Tesseract read whose ticker column reads `PTR, ~u, ~~, SHOP,
MNO, IMG, [TT]` — reads the LI row as `~u`, which the rescue strips to `U` before it
looks the table up, so it is the same forbidden row. Reaching either one would need a
**different mechanism** (a layout-scoped table, or a lexicon-constrained single-letter
rule that can tell the 2022-era `U` holding from the 2023-era `LI`), not another row.
A wrong holding in a portfolio report is worse than a missing one, so both stay missed.

### The 2023-era production smoke scan (2026-11-02)

Everything before this was a **crop A/B on pinned frames** (§ *The chart-stream crop
— MEASURED off the pixels, and ERA-CONDITIONAL*) and a **no-OCR replay** (§ *The
replay tool is a surviving sample*). This is the first time the era-conditional
crop ran in the **real pipeline**, end to end.

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE \
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20230609_VdQSDGZBLQE.mp4 \
  --date 20230609 \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 1 --fps 0.25 --prefilter-max-frames 6 \
  --ocr-engine easyocr --run-tag qmg-crop-20261102-smoke \
  --output-root data/video_scan_test/_rerun
```

The source is **1920×1080** (by ffprobe, not by filesize). The log's
`phash_region_fraction` is `{"x":0.82,"y":0.6,"w":0.18,"h":0.32}` — the 2023-era
sidebar rectangle — **chosen from the upload date inside the scan tool**, with no
crop flag on the command line. That is the crop rule working as designed.

**The crop works, and the reading is exact.** The capture at t=1944 carries a
`position_list` of **13** tickers, and the ground truth for `20230609` is **13**
tickers — **the same set, with zero false positives**. The old fixed crop
`0.86,0.62,0.14,0.22` read **zero** holdings on this date, because its x window
(source x 1651) starts to the **right** of the sidebar's Sym column (source x
1586–1712). The frame's own OCR shows the alias table firing **in production**:
`INGN`→IMGN, `AROQ`→ARQQ, `A`→AI, `ATR`→PLTR, `GllB`→GTLB, `GSI`→GSIT,
`Apld`→APLD, `MNDy`→MNDY.

**And the scan found exactly one thing wrong.** The merged list carried **`REGN`**
— a real ticker, and a genuine Qullamaggie holding on thirteen 2022-era dates —
where the panel showed `RGTI`. `REGN` is in none of `20230609`'s ground truth.

#### The root cause: a garble that happens to BE a valid ticker

The panel's **first** row is `RGTI`, and EasyOCR read that row as `Rgn` / `RGn`
in two of the six OCR'd frames. Normalised, that is `RGN` — **one edit away from
`REGN`**, which is a **seed ticker** (`config/ticker_lexicon_seed.csv:125`).
So the distance-1 repair pass did exactly what it is built to do: it corrected
`RGN` to the nearest seed ticker, and published a **wrong holding** in a
portfolio report. The same failure shape as `AROQ`→ARQQ and `IOI`→IOT, and the
same class as the `OI`→`LMT` row added earlier the same day.

**Pixel-verified.** The five panel frames the scan OCR'd (t = 0, 972, 1944, 2916,
3888) all read **`RGTI` in the first row of the Sym column**. `RGN` is in neither
lexicon, `RGTI` is in the seed, and the table has no row keyed `RGN` and no
canonical `RGN` — so the row is legal on **every** invariant. A corpus-wide
search of **283 probe logs** found **zero** `RGN` tokens, so the row shadows
nothing that has already been measured.

#### The fix, and what it is worth

```csv
RGN,RGTI,T rendered as N and I dropped (20230609)
```

Measured by **re-parsing the recorded `ocr_words`** of the production frames
through the current parser — no OCR, so the numbers are the parser's, on the
real frames:

| frame | before the row | after the row |
|---|---|---|
| ts 1944 | 13 — the exact GT set | 13 — the exact GT set |
| ts 972 | 12 (`GSIT` missing) | 12 (`GSIT` missing) |
| ts 3888 | 12 + **`REGN`**, `RGTI` lost | 12 + **`RGTI`** |
| ts 2916 | 12 | 12 |
| ts 0 | 7 (a garbage frame) + **`REGN`** | 7 (the same garbage frame) + **`RGTI`** |
| **merged** | **14 — the 13 holdings plus `REGN`** | **13 — exactly the GT set, 0 FP** |

**On the replay corpora the row changes nothing, and that is the point.**
`RGN` does not occur in either corpus:

| corpus | with the row (39) | without it (`--drop-aliases RGN`) |
|---|---|---|
| default (8 roots) | 83/85 — 97.6 % / 100 % | **identical** |
| wide (17 dates) | 148/168 — 88.1 % / 89.2 % | **identical** |

**The corpus could not have found this row, and no corpus ever could.** The
replay corpus is a *surviving sample* of the post-2026-10-18 crop profile; this
misread is a property of the **new** 2023-era crop, and only a production scan
of a 2023-era video exercises it. That is the second class of defect the
surviving-sample caveat predicts: a change can be **correct** (the corpus
numbers are unmoved) and still **not** be covered by it.

#### The end-to-end confirmation — a fresh scan, not a replay

The table above is a **re-parse of recorded words**. To confirm the fix in the
real path, the video was **scanned again** with the new table — EasyOCR re-ran
from the video, so this is an independent OCR pass, not the old one replayed:

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE \
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20230609_VdQSDGZBLQE.mp4 \
  --date 20230609 \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 1 --fps 0.25 --prefilter-max-frames 6 \
  --ocr-engine easyocr --run-tag qmg-crop-20261102-smoke-v2
```

| | run 1 (`…-smoke`) | run 2 (`…-smoke-v2`) |
|---|---|---|
| `phash_region_fraction` | `0.82,0.60,0.18,0.32` | the same — the era rule, from the date |
| capture | ts 1944, score **33.02** | ts 1944, score **33.02** |
| `bbox_filter` | `list_rows`, 13 rows, pitch 90 | the same |
| the capture's own `position_list` | 13 — the ground truth, 0 FP | 13 — the ground truth, 0 FP |
| **`merged_position_list`** | **14** (13 + **`REGN`**) | **13 — the ground truth, 0 FP** |

**The production path now reads `20230609` exactly.** Not "13 of 13" — the
**same thirteen tickers**, in the ground truth's own set, with nothing else.

**The capture was already right in run 1; the MERGE was not.** The selected
frame (t=1944) read the 13 holdings cleanly in **both** runs — run 1's capture
`position_list` is the exact ground-truth set, `REGN` and all. `REGN` came from
the **other five frames** the scan OCR'd, two of which read the `RGTI` row as
`Rgn`/`RGn` — and the **clusterer's consensus** over the six frames is what
published the wrong holding.

**So which artifact carried the defect matters.** The aggregator reads
`capture.chart_stream.position_list` (`src/video/captureTickers.js:47-48`), and
that reading was **clean in both runs**. The `merged_position_list` — the
**video-level** consensus, which is what `tools/runQmgOcrBatch.js:143` and
`tools/runQmgCuratedBenchmark.js:179` consume — carried the extra holding. **A
capture-level metric would never have caught it**, and the two consumers of the
same scan disagreed with each other. That is the argument for scoring the
**merged** list and not only the capture.

Note the **output root**: the tool's default is `data/video_ocr_probe/`
(`src/video/ocrScanArgs.js:17`), so run 2 landed in
`data/video_ocr_probe/qmg-crop-20261102-smoke-v2/`. Run 1 was launched with
`--output-root data/video_scan_test/_rerun`. Both layouts are the **flat** one
`src/video/probeLogDirs.js` knows, so the aggregators find either.

#### What the scan validated besides the crop

- The **era rule fires from the date**, with no flag — and the capture's own
  `bbox_filter.rule` is `list_rows` with **13 rows** at pitch 90, so Filter B is
  keeping the whole list on the 2023-era sidebar.
- The **alias table fires in the real pipeline**, on eight separate garbles in
  one frame — not only on the frames the replay corpus happens to hold.
- The scan tool's **clusterer consensus** and the **per-frame reading** agree
  once the alias row is in place.
- **A fresh OCR pass reproduces the frame.** The capture landed on the same
  timestamp (t=1944) with the same score (33.02) and the same `bbox_filter`
  geometry — and the two runs' **snapshots are byte-identical**
  (md5 `01a88225bf091391cfc0085201bc2391` in both). So the two runs are the same
  frame read twice, and the difference between them is the table, not the luck of
  the OCR.

Pinned by `test/ocrConfusionAliases.test.js` (the row is in `NEW_ALIASES`, so
the three behaviour tests cover it: rescued in the column, not rescued in the
chart area, not rescued below the Personal WatchList header).

### The 2023-era production scan, four more dates (2026-11-02)

The 20230609 smoke scan above was one video, launched by hand. The **second**
production run scanned six 2023-era dates through `tools/runQmgOcrBatch.js`
itself:

```bash
node tools/runQmgOcrBatch.js --dates 20230522,20230523,20230602,20230605,20230608,20230609 \
  --low-cpu --parallel 2 --run-tag qmg-easyocr-20261102-era-prefilter
```

All four logs that landed record `phash_region_fraction` =
**`{"x":0.82,"y":0.60,"w":0.18,"h":0.32}`** — the 2023-era sidebar rectangle,
chosen from the upload date inside the scan tool, with no crop flag on the
command line — and every capture's `bbox_filter.rule` is **`list_rows`**, with
10–14 rows. **The era rule and Filter B both fire in production.**

Scored against the pixel-verified ground truth (`data/qmg_ground_truth.json`),
on the **merged** list — the video-level consensus, which is what
`tools/runQmgOcrBatch.js:143` consumes:

| date | hits / ground truth | false positives |
|---|---|---|
| `20230522` | **6 / 7** | none |
| `20230523` | **10 / 11** | `U` |
| `20230602` | **12 / 12** | `IOT` |
| `20230605` | **11 / 11** | `AAPL` |
| **total** | **39 / 41** | **3** |

Recall **95.1 %**, precision **92.9 %** — on four dates the replay corpus
reaches only as a surviving sample, on the layout the era crop was written for.

**The missed holding is `LI`, on every date, and it was lost in two different
ways.** § 'The column gate' has already recorded that the collapsed LI cell
stays missed: `U` is a **seed ticker** (a real holding on 20221117), so the
alias table's invariant forbids a row that would rewrite it, and the one-glyph
rule only drops a one-glyph read when the **column** holds *another* one-glyph
read. On `20230522` the column had two — one per capture — so `U` was dropped.
On `20230523` it had **one**, so `U` was published as a false positive
instead (cluster frequency 4).

**On `20230523` the OCR read `LI` correctly, and the clusterer threw it away.**
The log's own cluster table says it:

```jsonc
{ "canonical": "AI", "members": ["AI", "LI"], "frequency": 7 }
```

`LI` and `AI` are **one edit apart**, so the clusterer merged them and the
canonical was `AI`. The `LI` holding was in the raw tokens, and it was lost at
the consensus step, not at the OCR step.

#### The clusterer's canonical choice can invent a holding AND destroy one

`AAPL` on `20230605` is the same failure in the other direction:

```jsonc
{ "canonical": "AAPL", "members": ["AACO", "ARCO"], "frequency": 2 }
```

`ARCO` **is** in a capture's own `position_list` — it is chart ink the
per-frame parser admitted. `AAPL` is in **no** capture's reading at all: the
whole log contains it three times, and all three are the merged list, the raw
token list and the cluster's canonical. So the per-frame reading was garbage,
the clusterer renamed it to a **seed ticker**, and the merged list published a
holding **no frame of the video ever showed**. Filter A's threshold (2) let
the cluster through at exactly its minimum.

So the merged list has **two** distinct defects, in opposite directions, and
both are invisible to a capture-level metric:

| defect | example | what a capture-level metric sees |
|---|---|---|
| a real holding **absorbed** by a one-edit neighbour | `LI` → `AI` | `LI` absent, `AI` present — looks like a plain miss |
| a garbage reading **promoted** to a seed ticker | `ARCO` → `AAPL` | `AAPL` absent — the false positive is invisible |

**This is the third time the merged list and the capture list have disagreed**
(the first was `REGN` above, the second `U`), and it is the reason the two
consumers of the same scan — `tools/runQmgOcrBatch.js:143` and
`tools/aggregateScanResults.js` — cannot both be right unless the merged list
is scored too.

**The three false positives are three different mechanisms**, and only one of
them is the frame's own fault:

| ticker | date | where it was born |
|---|---|---|
| `U` | `20230523` | a **capture** read the collapsed LI cell, and the column held only that one glyph |
| `IOT` | `20230602` | a **capture** read it — it is in that capture's own `position_list`, not only in the consensus |
| `AAPL` | `20230605` | **the clusterer only** — in no capture's reading |

`IOT` is a **real** holding on `20230605` (the ground truth has it) and a
false positive on `20230602` — the same token, the same glyph, two different
answers, which is what a reading of the wrong cell looks like.

### The 2022-era production scan, four more dates (2026-11-03)

The 2023-era production scan above is the first end-to-end run of the
era-conditional crop on the **sidebar**. This is the same thing for the
**2022-era floating panel** — four dates, low-CPU, `--cluster-rule
corroborated`:

```bash
node tools/runQmgOcrBatch.js --dates 20220414,20220418,20220419,20220421 \
  --low-cpu --parallel 4 --run-tag qmg-easyocr-20261103-era2022-next \
  --cluster-rule corroborated
```

| date | merged list vs the GT union | FP | the panel's own count | the reading |
|---|---|---|---|---|
| `20220414` | **11/11 (100 %)** | none | 11 | **exact** |
| `20220418` | 11/12 (92 %) | none | 11 | **exact for the moment** |
| `20220419` | **14/14 (100 %)** | none | 14 | **exact** |
| `20220421` | 14/16 (88 %) | none | 14 | **one ticker is wrong** |
| **total** | **50/53 (94 %)** | **0** | | |

Two of the four are exact 1:1 with the panel's rows. The third is exact for
the moment it captured. **The fourth is the interesting one, and the score
hides it.**

#### The union score and the panel's rows answer different questions

The ground truth's denominator is the **union over a date's captures** — the
anchor frame's rows plus every other capture's rows. The panel's rows are
what the screen showed at the **captured instant**. A reading is scored
against the first and checked against the second, and the two disagree on
these two dates.

**`20220418` — the one "miss" is a TEMPORAL difference, not a defect.** The
ground truth's anchor (15:57) holds twelve rows including `VERU`; the tracked
fixture crop `test/fixtures/qmg_ground_truth/20220418_c0.png` shows them and
its footer reads "12 Items in Personal WatchList". Today's capture is at
**15:28**, and the panel holds **eleven**: `VERU` had been closed and sits in
the upper watchlist widget ("US Common Stk…"), which the crop never sees. The
reading has all eleven. **A score against the union penalises a reading that
is exact for the moment it captured** — and the union's denominator is the
right one for the replay tool, whose input is a set of moments.

**`20220421` — the score says 0 false positives, and one of the fourteen
published tickers is wrong.** The panel holds fourteen rows; the reading
publishes fourteen tickers; and they are not the same fourteen:

```text
panel : FCX NUGT JNUG VERU WEAT COPX X URNM URA REGN GUSH LAC TSLA BOIL
reading: FCX NUGT JNUG VERU WEAT COPX X URNM URA REGN GUSH UCO TSLA BOIL
                                                   ^^^
```

EasyOCR read the `LAC` cell as **`UC`**, and the distance-1 repair pass turned
`UC` into **`UCO`** — one insertion, and `UCO` is a seed ticker. So the
reading published a holding the panel does not show.

#### A garble that collides with a holding from another moment is invisible to the union score

`UCO` **is** in the date's ground-truth union: at 15:57, thirty minutes after
the captured frame, `UCO` was *also* a position — the anchor fixture
`test/fixtures/qmg_ground_truth/20220421_c0.png` shows **sixteen** rows with
both `LAC` and `UCO` among them ("16 of 16 Items in Personal WatchList"), and
`UCO` is opened later in the session.

So the wrong holding scored as a **hit**, and the two holdings the panel
really held at 15:26 (`LAC`) and 15:57 (`UCO`, `FTNT`) counted as misses. The
union score cannot see this class at all: **it can only see a wrong holding
that the video never held, at any moment.**

**Neither count catches it either.** The panel's own row count is 14 and the
reading has 14, so a row-count check passes. The only check that catches it is
the panel's **identity**, and the project's identity check is the curated
alias table.

#### The row: `UC → LAC`

| | |
|---|---|
| the garbled token | `UC`, EasyOCR conf 0.839, at the Sym column's left edge (left 736 against the column's `dominant_left` 734) |
| where it is | row 11 of 14 — the OCR read **fourteen** column words and they map **1:1** onto the panel's fourteen rows, in order |
| the width says so | the box is **94** crop px against **96** for `FCX` (three glyphs) and **135** for `NUGT` (four) — the read spans the whole three-glyph cell |
| the misread | `LA` merged into one `U` glyph, `C` read alone — the same merge the 2023-era `LI` → `V` row records |
| the invariants | `UC` is in **neither** the seed nor the decode lexicon; `LAC` **is** in the seed; no duplicate key, no chain |
| the corpus | `UC` occurs **nowhere else**: `"text": "UC"` over every probe log finds it in the 20220421 logs and nowhere else |

**The row was shipped on 2026-11-04 (table is now 45 data rows).** The default-roots replay is unchanged at 97.6 % / 100.0 % (83/85), because 20220421 is not in the default 8-root set. The wide corpus effect is a per-frame `LAC` hit on the capture that reads `UC` — a holding the union score could not see, because `UCO` was already in the GT union and masked the garble. Pinned by `test/ocrConfusionAliases.test.js`.

### The panel's footer is BELOW the crop — the count check cannot fire (2026-11-02)

`readPanelRowCount` reports the panel's own row count in every probe log, and
that count is the project's only **independent** check on a reading: a reading
with a different number of tickers has provably dropped a row or invented one.

**In production it reports `null`.** Every capture of all four 2023-era logs
above records `panel_count: null`, `panel_count_delta: null` and
`panel_count_footer: null`.

The reason is the pixels, not the reader. The panel's footer sits at source
y ≈ **1020–1026**; the 2023-era crop's bottom edge is source y **994**
(`0.82,0.60,0.18,0.32`) and the 2022-era crop's is **950**
(`0.86,0.60,0.14,0.28`). **The OCR engine is never shown the line.**

Two harnesses measure it, and neither needs OCR:

```bash
node --test test/manual/productionCropRender.test.js   # the exact image EasyOCR was shown
node --test test/manual/panelFooterInCrop.test.js       # the production crop out of the fixture
```

The first renders the scan tool's own filter
(`crop=in_w*0.18:in_h*0.32:in_w*0.82:in_h*0.60,scale=1728:-1`) from the **source
video** at a capture's timestamp, so the PNG is the pixels the engine saw. On
`20230523` at t=1800 it shows all eleven rows legibly — and **not** the footer.
What IS at the top of that image is the **upper** widget's footer ("9 Items in
WatchList"), which `readPanelRowCount`'s line-bound gate correctly rejects,
because it sits above the positions header.

**The fix is not a taller crop.** The crop is also the capture-dedup pHash
rectangle, and a taller crop is downscaled more by EasyOCR — the measured
mechanism behind the `trade_ideas` 9/9 → 7/9 regression. The cheap fix is a
**dedicated footer strip**, read **once per video** on the selected capture:
source y ≈ 1000–1040, upscaled, with the panel's own bound still applied (the
count belongs to the positions table only if the footer is BELOW the "A -
Positions" header). Until that exists the count stays **reported, never acted
on** — a count misread low would truncate a correct reading.

### The scan writes its log and does not exit (2026-11-02)

**Every one of the four production scans above was reported as a TIMEOUT by the
batch, and every one of them had already succeeded.** The probe log is written
with `status: "done"` and the full `merged_position_list`, and then the process
hangs until the batch's 2400 s kill timer fires:

```text
[20230522] Starting 20230522_8Pa6cllRZNw.mp4 (1080p)
[20230523] Starting 20230523_2UgJ5CvVVK4.mp4 (1080p)
[20230522] TIMEOUT after 2400s — killing
[20230523] TIMEOUT after 2400s — killing
```

So **every video burns the full 40-minute budget**, and a results file in
which successes are failures.

**The mechanism is the batch's undrained stdout pipe.** The scan tool's last
statement in the `try` is

```js
const logPath = await writeScanLog(logsDirectory, probeKey, result);
result.log_path = logPath;
console.log(JSON.stringify(result, null, 2));      // tools/scanVideoWithOcr.js:1913
```

— the **whole result object**, pretty-printed, to stdout. The batch spawns the
child with `stdio: ['ignore', 'pipe', 'pipe']` and drains **stderr only**
(`tools/runQmgOcrBatch.js:235`); **stdout is never read**
(`tools/runQmgOcrBatch.js:221`). A Windows pipe holds about **64 KB**, and the
dumped object is the same object the probe log holds — the four logs are
**5 589, 7 102, 7 809 and 6 559 lines**, i.e. hundreds of kilobytes. The
child's `console.log` therefore blocks **forever**, after the log is written
and before the `finally` block.

**Three independent pieces of evidence agree with that account, and they rule
the alternative out:**

1. **The log is complete.** `status: "done"`, the full `merged_position_list`,
   every capture's summary — the object was serialized, so the write happened.
2. **The `finally` block never ran.** `safeDeleteDirectory(frameRoot)`
   (`tools/scanVideoWithOcr.js:1929`) is the first thing in it, and
   `ocr_probe/frames/<probeKey>/` is **still on disk** — thousands of PNGs that
   the cleanup would have removed (`frameRoot` is
   `path.join(probeRoot, 'frames', probeKey)`, `tools/scanVideoWithOcr.js:1389`).
   So the process is hung **before** the `finally`, which is exactly where a
   blocked `console.log` sits — and which rules out a wedged `closeWorker()`,
   because `closeWorker()` is *inside* the `finally`.
3. **The batch's own code path.** `child.on('close')` never fires, so the
   `killTimer` fires instead, and the result is recorded as `TIMEOUT`.

**The fix is in the batch, not the scan tool:** drain the child's stdout (and
log it, or write it to a file). The scan tool's behaviour — printing its
result — is correct, and a tool that cannot be supervised is a tool that
cannot be run in a batch. **Until this is fixed, a chart-stream batch's
`TIMEOUT` says nothing about whether the video was read.**

**The fix is shipped (2026-11-02, second commit).** `superviseChild()` in
`tools/qmg_scan_daemon_support.js` drains stdout and keeps a bounded rolling
tail (`STDOUT_TAIL_CHARS = 16 KB`) for diagnostics; the probe log on disk
remains the authoritative record. The function is exported and `main()` now
runs only under `require.main === module`, so a test can drive it. Pinned by
`test/qmgBatchStdout.test.js` — seven tests, and **two of them fail against
the pre-fix code**: a child that writes more than a pipe holds to stdout comes
back `TIMEOUT` instead of `OK`, which is exactly the production failure.

**A supervisor that reports TIMEOUT has to be distinguishable from one that
reports OK.** The pre-fix code recorded the status but kept no stdout, so a
failure report had nothing to show for it. The `stdoutTail` is now carried on
the result, so a failed video can be diagnosed without re-running it.

### The deadlock belongs to every consumer of the scan tool, not to the batch (2026-11-02)

**The batch fix was correct but LOCAL, and the same defect was sitting in three
sibling daemons.** The deadlock is a property of the **scan tool's stdout
volume** — it prints its whole result object, hundreds of kilobytes, at the
very end — so **every** consumer that spawns it with a piped stdout inherits
it, whether or not that consumer drains stderr.

The fix therefore moved into **`tools/qmg_scan_daemon_support.js`**, the module
CLAUDE.md already designates as the shared-guard home, and it is now the
module's **fourth** guard:

| # | the daemon bug | the guard |
|---|---|---|
| 1 | a full disk killed videos mid-run with a bare ffmpeg error | `checkFreeSpace()` |
| 2 | a daemon overwrote a good results file with a mostly-failed run | `writeResults()` |
| 3 | a daemon spawned EasyOCR without the low-CPU thread caps | `lowCpuEnv()` |
| 4 | **a daemon piped the scan tool's stdout and drained stderr only** | **`superviseChild()`** |

**Nine tools now share the one supervisor**, so they cannot drift apart:

| tool | before | after |
|---|---|---|
| `tools/runQmgOcrBatch.js` | local `superviseChild` | imports the shared one, re-exports it |
| `tools/qmg_comparison_daemon.js` | **piped, stderr-only** | shared `superviseChild` |
| `tools/qmg_alt_batch_daemon.js` | **piped, stderr-only** | shared `superviseChild` |
| `tools/qmg_ocr_batch_daemon.js` | **piped, stderr-only** | shared `superviseChild` |
| `tools/qmg_ocr_batch.js` | drained, but killed only the direct child | shared `superviseChild` |
| `tools/scanAllGtVideos.js` | drained, but killed only the direct child | shared `superviseChild` |
| `tools/_revere_scan.js` | drained, but killed only the direct child | shared `superviseChild` |
| `tools/runQmgCuratedBenchmark.js` | **no timeout at all** | shared `superviseChild` |
| `tools/qmg_scan_daemon_support.js` | — | **the implementation** |

**Two things came with the consolidation that were not in the batch's fix.**

1. **The timeout now kills the PROCESS TREE** (`taskkill /PID <pid> /T /F` on
   Windows). Killing the direct child leaves the scan tool's **ffmpeg and
   EasyOCR grandchildren** running as zombies — CLAUDE.md's *Scan
   orchestration safety (Windows)* names exactly that mechanism as the cause of
   the perceived "freeze": the next video's frame extraction stalls behind
   their I/O. Six tools that killed only the direct child now do not.
2. **`runQmgCuratedBenchmark.js` had no timeout at all.** With the deadlock it
   would have waited forever. It now has a 40-minute one, which required
   adding a `cwd` option to the shared helper (that tool's original spawn ran
   the child with `cwd: path.resolve(__dirname, '..')`).

**Each tool's public contract was preserved, deliberately.** The result-status
vocabularies are written into results files that are compared across runs, so
they were kept **identical**: `ok` / `timeout` / `error` in the comparison and
alt daemons, `ok` / `timeout` / `exit_<code>` / `error_<msg>` in the batch
daemon, and `status: -1` for a timeout in `scanAllGtVideos.js` (its caller
tests `r.status !== 0`, so a timeout must not report the child's exit code).

**One tool could not use the stdout tail to decide success, and that is worth
knowing.** `tools/_revere_scan.js` decided a scan had worked by grepping the
child's stdout for `"status": "done"`. In the result object **`status` sits
AFTER the huge `captures` array** (`tools/scanVideoWithOcr.js:1849-1871`), so a
bounded 16 KB tail can truncate it — the check would have started reporting
false failures. It now reads the **probe log on disk**, which is the
authoritative record anyway and is written *before* the tool's final
`console.log`, so it exists even on the run that used to hang.

**The five tools that spawn the scan tool and were NOT converted are safe for a
different reason: they hand the child the parent's own stdout**
(`stdio: 'inherit'`), so there is no pipe to fill.

| tool | how it spawns |
|---|---|
| `tools/rerunScanForCompare.js` | `spawnSync(..., { stdio: 'inherit' })` |
| `tools/rescanAllVideos.js` | `spawnSync(..., { stdio: 'inherit' })` |
| `tools/reocrAtResolution.js` | `spawnSync(..., { stdio: 'inherit' })` |
| `tools/runAllOcr.js` | `spawnSync(..., { stdio: 'inherit' })` |
| `tools/runOcrProfiles.js` | `spawnSync(..., { stdio: 'inherit' })` |

**The invariant is now pinned statically**, so a tool added later with a piped,
undrained stdout is caught before it burns a 40-minute budget per video.
`test/qmgBatchStdout.test.js` surveys every file in `tools/` (comments
stripped, so a file that only *names* the scan tool in prose is not counted) and
asserts that each one that spawns it either calls `superviseChild(` or uses
`stdio: 'inherit'`.

### Two things that were measured and rejected (2026-11-02)

Both were plausible repairs to defects the replay exposed. Both were measured on both
corpora and **both are negative results** — recorded here so they are not re-attempted.

**1. A uniqueness rule in the edit-distance repair pass — REJECTED.** The repair
pass picks the first distance-1 lexicon match it finds, preferring the longer
candidate on a tie. A uniqueness rule would only correct a read whose distance-1
candidate is **unique**.

| | default roots | wide corpus |
|---|---|---|
| hits, shipped rule (34-row table) | 80 | 133 |
| hits, uniqueness rule (same 34-row table) | **80 — unchanged** | **133 — unchanged** |
| false positives | **+1** (`FX`, 20220218) | **+1** |

The candidate sets explain the whole result. **`CA → CF` is unique** — nothing else in
the seed is one edit away — so uniqueness cannot stop the 20220606 capture's
invention of `CF` from the wrong (% Change) column. And **`FX → FCX`** and
**`MO → MOS`** are *ambiguous*, so uniqueness **destroys two real corrections**. The
rule converts the 20220606 inventions into raw garbles (`AI` → `AE`, `COIN` → `CON`)
rather than preventing them. **Keep the shipped first-found/longest-wins rule.**

**2. A column-selection change — REJECTED.** On the 20220606 capture the column
detector latches onto the **`% Change`** column (`dominant_x 770`,
`dominant_left 684`) instead of the Sym column at x 448–454, which is why that
capture reads `["AI","CF","COIN","CUSS"]` instead of its eight holdings. Two
variants were tried: requiring **three** price-aligned tickers before the
price-aligned path wins, and adding **left-edge bucketing** to the fallback.

Both change **nothing** on either corpus, because the capture has **12**
price-aligned tickers spread over four columns — so the price-aligned path still
wins, and it still picks the % Change column. The Sym column would need a left-edge
rule to win, and that capture is a garbage Tesseract read whose Sym column reads
`am, Cct, WEJ, U0, Cbo, Mo, T, Gn` — at most two or three recoverable holdings.
A column change would affect every frame in the corpus to buy that. **Do not change
column detection.**

### Measuring the alias table without editing it (2026-10-31)

`config/ticker_ocr_confusions.csv` is **shared** — every tool in the tree reads it — and
it was measured by *editing it*: delete the row, run the replay, put the row back. Two
measurements in the same working tree therefore raced each other, the table flipped
between its 20-line and 29-line forms mid-measurement, and a wrong "before" column was
reported once as a result. A reviewer working the same way reported that the `A → AI`
and `AL → AI` rows "never fire" — a conclusion that was true of the parser as it was
**before** the left-edge column fix and false of the parser as it is now.

The alias table is now selected by **path** (`setOcrConfusionCsvPath()` in
`src/parse/parseChartStream.js`), and the module-level cache is keyed by the **resolved
path**, so two tables can be used in one process in either order.

```bash
# Score the corpus with the shipped table (the default).
node tools/evalParserReplay.js

# Score it with some rows removed -- nothing on disk is touched.
node tools/evalParserReplay.js --drop-aliases A,AL
node tools/evalParserReplay.js --drop-aliases INGN,AQQ,GS0T,ATR

# Score it against a table of your own.
node tools/evalParserReplay.js --confusion-csv path/to/table.csv
```

`--drop-aliases` builds the modified table in a **temporary file** and points the parser
at it; `config/ticker_ocr_confusions.csv` is never edited, so two measurements cannot
race each other any more. Every run prints the row count it used and what it dropped:

```text
alias table      : 28 rows from ...\config\ticker_ocr_confusions.csv
alias table      : 26 rows from ...\config\ticker_ocr_confusions.csv  (dropped: A AL)
```

An unknown `--flag` is a **usage error** (exit code 2), not a silent root. Pinned by
`test/aliasTableOverride.test.js` — the shipped table is what the parser uses by
default, a dropped row stops rescuing, the shared config file is **byte-identical**
after an override, restoring brings the rescue back, and an arbitrary table can be
selected by path. The measured *effect* of the rows is not pinned there: the replay
corpus is untracked, so a fresh clone has no probe logs to score.

### The column test

The curated-alias rescue asks one question: **is this token inside the position-list
column?** It used to ask it by comparing the token's **centre** with the column's
**median centre**, within a hardcoded ±25 px (`columnWidth = 50`).

**That test is wrong for a left-aligned table.** Every ticker in a position list starts
at the same x no matter how many characters it has, so a short ticker's *centre* drifts
left of the column's median centre even though its *left edge* is identical. Measured
on the real `20230609` capture: every ticker in the column starts at x 515–518, and the
one-character `A` starts at x 518 too — but its centre is 545 against a median centre
of 581.5. `|545 − 581.5| = 36.5 > 25`, so the token was rejected **before the alias was
ever consulted**. The same holds for `Al` on `20230608` (centre 87, median centre
125.5). That is why the `A → AI` and `AL → AI` rows could not fire.

**The fix compares LEFT edges.** `identifyPositionListColumn` now also reports
`dominantColumnLeft` — the median left of the column's *own* members — and the rescue
accepts a token when

```js
Math.abs(tokenLeft - dominantColumnLeft) <= columnWidth / 2
  || Math.abs(center - dominantColumnX) <= columnWidth / 2
```

The centre test is kept as an **alternative, not a replacement**. These tables are
left-aligned, but a right-aligned or centred layout is judged by its centres, and the
union of the two tests cannot reject a token the old gate accepted. The two rows fire
on the first clause.

**Measured over the replay corpus** (`node tools/evalParserReplay.js`, no OCR):

| corpus | before | after | predictions | false positives |
|---|---|---|---|---|
| default (8 roots) | 66 / 89 — 74.2 % | **71 / 89 — 79.8 %** | 69 → 74 | **3 → 3** |
| wide | 113 / 170 — 66.5 % | **117 / 170 — 68.8 %** | 136 → 140 | **23 → 23** |

Every gain is `AI`. **No date lost a holding, and no false positive was added** on
either corpus — the precision rise (95.7 % → 95.9 %, 83.1 % → 83.6 %) is the
denominator growing, not the FP count falling.

**Three ways to test "is this token in the column", and they are not the same test.**
Measured on both corpora, with the parser recompiled for each variant and the same
command:

| the test | default roots | wide corpus |
|---|---|---|
| left edge vs the column's **median left** (shipped) | **71 / 89 — 79.8 %** | **117 / 170 — 68.8 %** |
| the token's **box overlaps** the column's x-window | 71 / 89 — 79.8 % | 117 / 170 — 68.8 % |
| left edge vs the column's **median centre** | 57 / 89 — 64.0 % | 111 / 170 — 65.3 % |

The first two are **indistinguishable** on this corpus — a token's left edge in the
column's left edge is the same statement as its box overlapping the column's window,
for a table whose rows all start at the same x. The **third** is the one that looks
like "the left-edge test" but is not the same thing: it compares the token's left edge
against the column's median **centre**, which is off by half a token's width and
therefore rejects real holdings. **Do not substitute it for the shipped test.**

The shipped test is the **narrower** of the two equivalent ones (it does not admit a
token whose box merely grazes the column's right-hand edge), which matters because
`A` and `AL` are bare strings a chart annotation could plausibly produce and neither
is in the seed lexicon — so there is no lexicon shadowing to stop a stray `A` from
becoming `AI`. The corpus's `A`/`Al` tokens are chart ink, none of them in the
position-list column, so no firing occurs today; **re-run the false-positive audit
whenever the corpus grows or the column detector changes.**

The corpus is untracked, so those numbers cannot be asserted by a test. What *is*
assertable is the parser's behaviour on the geometry, and that is what
`test/chartStreamColumnTest.test.js` pins: the one-character token **is** rescued into
`AI` and its garbled form is not published; the column reports `dominant_left`; and a
short token in the **chart area** or **below the Personal WatchList header** is still
not rescued.

**One thing the replay cannot measure.** The alias output feeds the **frame-selection
score** (`src/ocr/ocrImage.js` → `chartStream.position_list.length` →
`tools/scanVideoWithOcr.js`), so a rescued alias can also change *which* frame the
prefilter picks. The replay re-parses captured logs and never re-runs the prefilter,
so that effect is invisible to it. It is a real effect, and it is the reason a
re-scan can score differently from a replay of the same video.

### Filter B — the position-aware vertical bound (2026-11-01)

Filter B is the filter that decides **which of the accepted tickers are actually
positions**, as opposed to chart ink that happens to be a lexicon ticker.

**The defect it replaces was a unit error.** The old rule was a window around the
median of the accepted tickers' bbox centres:

```js
yMin = yMedian - 8 * lineHeight;   // lineHeight = the median word HEIGHT
yMax = yMedian + 8 * lineHeight;
```

The intent was **eight ROWS** either side of the median, but `lineHeight` is the
median word **height** — ~54 px in the 5×-scaled EasyOCR crop — where a row is
~90 px. So the window spanned only ~4.8 rows either side, and it **clipped the
first and last row of any list longer than about nine rows**. Measured
corpus-wide, that window dropped **50 ground-truth holdings**.

**The rule now is the list's OWN ROWS.** A position list is a contiguous vertical
stack of rows at a constant pitch, and that stack — not a window around a median
— is what a position-aware filter has to be built on. `selectPositionListRun()`
(`src/parse/parseChartStream.js`) finds it:

1. group the column's candidate words into **rows** by their OCR `line` — two
   words on one line are one row (a ticker and its price), and counting them
   as two rows halves the pitch estimate;
2. estimate the **pitch** as the *quartile* of the inter-row gaps, not their
   median — one wide separation (the gap between two panels) drags a short gap
   list's median into the space *between* the two clusters;
3. split the rows into **runs** wherever the gap exceeds `pitch ×
   POSITION_LIST_ROW_GAP_LIMIT`;
4. take the **longest run** as the list, breaking a tie by the number of
   price-aligned rows it contains.

A ticker is then a holding when **one of its OCR occurrences** sits on one of
the run's rows. "One of" matters: `tickerWordsMap` keeps **every** occurrence
of a token, where `tickerWordMap` keeps only the **first**. A ticker read both
on its own row and again in a widget above it is a holding — the first
occurrence alone would lose it, and the "first occurrence" variant also
resurrected the `TT` false positive on 20230518.

**The panel's own upper bound is the second half of the rule.** Nothing above the
"A - Positions" header is a position, whatever the run says. A token **every one
of whose occurrences** is above the header is rejected — which is what separates
a scanner panel sitting above the list (`TAN` on 20230523, `BABA` and `HAL` on
20230602) from the list itself. The bound is applied to **every** token, not
only to the ones the run rejected; the measured corpus totals are identical
either way, and the stronger statement is the simpler one.

**`POSITION_LIST_ROW_GAP_LIMIT = 3.5` and not 2.5.** Measured on the corpus: a
list row the OCR read as a bare digit (a row read as "4") leaves a **272 px
hole = three pitches**, and a 2.5-pitch limit split the run there and dropped
the real holding `PLTR` above the hole. The 3.5-pitch limit keeps the run
whole. The limit is safe because the Positions header is an **independent**
upper bound — a token every one of whose occurrences is above that header is
rejected whatever the run says — and the measured corpus totals are identical
at 2.5 and at 3.5.

**The legacy window survives only as the fallback.** A frame whose column could
not be identified has no rows to test against, and the old `yMedian ±
8·lineHeight` window is all that is left. The diagnostic says which rule
applied: `bbox_filter.rule` is `list_rows` or `y_window`.

**One alternative was measured and rejected.** Letting the filter fall back to
the legacy window for a token that is *off* the column scored 130/168 (77.4 %)
on the wide corpus, against 128/168 for the shipped rule — but at **85.0 %
precision against 85.9 %**. It reintroduces the y-window's known defect and
admits chart-area ink, so it was rejected on principle rather than on the
totals.

**Measured with the no-OCR replay** (`node tools/evalParserReplay.js`; hit /
ground-truth / predicted, then micro recall and precision). **Both columns use
the same config files**, so the difference is the rule and nothing else:

| corpus | legacy window | the list's own rows |
|---|---|---|
| default (8 roots) | 75/85/76 — 88.2 % / 98.7 % | **80/85/81 — 94.1 % / 98.8 %** |
| wide (17 dates) | 123/168/143 — 73.2 % / 86.0 % | **128/168/149 — 76.2 % / 85.9 %** |

**The whole change set, attributed.** Every row below is a measured replay of
the same corpus; the configs differ only where the column says so:

| config | default roots | wide corpus |
|---|---|---|
| `HEAD` — everything as committed | 72/85/74 — 84.7 % / 97.3 % | 120/168/140 — 71.4 % / 85.7 % |
| HEAD parser + the new lexicons and alias rows | 75/85/76 — 88.2 % / 98.7 % | 127/168/145 — 75.6 % / 87.6 % |
| HEAD parser + the new lexicons, alias rows **dropped** | 75/85/76 — 88.2 % / 98.7 % | 123/168/143 — 73.2 % / 86.0 % |
| **new parser** + the new lexicons, alias rows dropped | **80/85/81 — 94.1 % / 98.8 %** | **128/168/149 — 76.2 % / 85.9 %** |
| new parser + the **old** seed, new observed + alias rows | 78/85/80 — 91.8 % / 97.5 % | 130/168/149 — 77.4 % / 87.2 % |
| new parser, new lexicons, alias rows up to 2026-11-01 | 80/85/81 — 94.1 % / 98.8 % | 132/168/151 — 78.6 % / 87.4 % |
| **shipped** — plus the two 2026-11-02 alias rows | **80/85/81 — 94.1 % / 98.8 %** | **133/168/152 — 79.2 % / 87.5 %** |
| **shipped** — plus the two 2026-11-02 `LI`/`FTCH` rows | **82/85/82 — 96.5 % / 100 %** | **135/168/153 — 80.4 % / 88.2 %** |
| **shipped** — plus the 2026-11-02 `N → AI` row | **83/85/83 — 97.6 % / 100 %** | **136/168/154 — 81.0 % / 88.3 %** |
| **shipped** — plus the column gate's row-stack evidence and the one-glyph rule | **83/85/83 — 97.6 % / 100 %** | **148/168/166 — 88.1 % / 89.2 %** |

So the three changes are separable and each one earns its place:

| change | default roots | wide corpus |
|---|---|---|
| **Filter B** (row 4 vs row 3) | **+5 hits** | **+5 hits** |
| the **four alias rows** (row 2 vs row 3) | nothing | **+4 hits** |
| the **16 seed rows** (shipped vs row 5) | **+2 hits** | **+2 hits** |
| the two 2026-11-02 `LI`/`FTCH` rows | **+2 hits** | **+2 hits** |
| the 2026-11-02 `N → AI` row | **+1 hit** | **+1 hit** |

**Per date, with the rule in isolation** (the legacy window against the list's
own rows, the same config files on both sides):

| corpus | date | before | after | what moved |
|---|---|---|---|---|
| default | 20230523 | 7 hits | **9 hits** | `CVNA`, `DNA` recovered |
| default | 20230602 | 10 hits | **12 hits** | `CVNA`, `QBTS` recovered |
| default | 20230609 | 12 hits | **13 hits** | `MNDY` recovered |
| wide | 20230523 | 7 hits | **9 hits** | `CVNA`, `DNA` recovered |
| wide | 20230602 | 11 hits | **12 hits** | `CVNA` recovered |
| wide | 20220412 | 7 hits | **9 hits** | `URA`, `X` recovered |
| wide | 20220330 | 2 hits | 3 hits | `FCX` recovered |
| wide | 20220405 | 7 hits | 8 hits | `CWEB` recovered |
| wide | **20220323** | 6 hits | **4 hits** | **loses `URNM` and `X`** — the column detector latched onto the **wrong column** in a garbage Tesseract capture, and swaps the false positives `BE`/`MN` for `PSX`/`THERA` |
| wide | **20230518** | 7 hits | 7 hits | **gains the false positive `TT`** — a misread row of a real holding on a garbled capture |

**Two regressions, both recorded rather than hidden.** `20220323` is the one
date the rule costs: the capture is a garbage Tesseract read, the column
detector latches onto the wrong column, and the run that is found is the
wrong stack. `20230518` gains one false positive and no holding — the `TT` is
a misread row of a real holding.

**The diagnostic** is `bbox_filter`:

```jsonc
{ "rule": "list_rows",                       // or "y_window"
  "list_rows": { "rows": 13, "members": 13, "top": 715, "bottom": 931,
                 "pitch": 18, "runs": 1, "positions_header_y": 690 },
  "y_median": 823, "line_height": 30, "y_min": 583, "y_max": 1063,
  "rejected_count": 2, "rejected_tickers": ["NVDA"] }
```

**The env switches are gone.** `CHART_STREAM_FILTER_B` and
`CHART_STREAM_RUN_SPLIT` existed only while the rule was being measured; both
are removed, and the temporary `colx` branch with them. The rule is now the
only behaviour.

**Pinned by `test/chartStreamFilterB.test.js`** — five tests on the geometry: a
twelve-row list keeps its first and last row; a chart-area token on the list's
own lines is rejected; a ticker above the Positions header is rejected; the
filter reports `rule: 'list_rows'` and the run's row count and pitch; and a
frame with no identifiable column falls back to `rule: 'y_window'`. **Three of
the five fail against the legacy parser**, so the test has teeth. The corpus is
untracked, so the replay numbers cannot be asserted there — only the parser's
behaviour on the geometry can.

### The column gate — price-alignment was the wrong evidence (2026-11-02)

The gate that decides "is this token a position?" was using **price-alignment**
as its membership test: a token belonged to the column if some row of the
column had a **readable price** beside it. That is a **proxy** for column
membership, and it is wrong whenever the price cell is garbled — which is
exactly when the ticker cell is *most* likely to be read perfectly.

Measured on the 20220330 capture: NFLX, REGN, COPX and NUGT are read
perfectly (conf 0.92, 0.96, 0.51, 0.50) and sit at x 711-714, exactly where
every other ticker in the column sits — but their price cells read `"0s63
~0383"`, `"C00 08re"`, `"~00r ~0229"` and `"30.1933| ~0583"`, none of which
passes the strict price-word filter. So the four left the price-aligned
subset, the gate rejected them, and the holding was lost **before Filter B** —
which tests row-stack membership and would have kept all four — ever saw them.

**The row stack is the better evidence, and the parser already computes it.**
Filter B asks exactly this question of the accepted set; the gate asks it
first, so the answer has to exist first. The gate's membership is now the
**union** of the two:

| evidence | what it is | what it misses |
|---|---|---|
| price-aligned column members | the column's rows with a readable price | every row whose price cell was garbled |
| the list's own rows | `listRun` — the position list's contiguous row stack | nothing; it is the list itself |

**The union is used for the GATE only.** The accept-as-read branch stays on
the price-aligned set, because a row-stack member can be a header word rather
than a holding — the 20220330 run contains the "Sym" header, and admitting it
verbatim would publish a false positive.

**A run-only member has to be vouched for by the LEXICON.** `hasPriceNear`
scans the **entire flattened OCR text**, so a ticker at the end of one line
happily matches a price at the start of the next — it fires on nearly every
token, and it says nothing at all about a row whose price cell was garbled.
Left to itself it published `OI` on 20220412: a 0.076-confidence garbage read
of the LMT row. The curated rescue cannot fix that one, because `OI` is not a
recorded misread of anything. So a token the row stack admitted and
price-alignment did not is accepted only if the **lexicon** knows it.

**The curated rescue still reaches the cells the gate drops.** It works on the
words themselves, so the run-only members it should reach — `WHX` on 20220412
and `A` on 20230522, neither in the lexicon — are rescued after the loop.

**`OI` is now a recorded misread.** The three-glyph LMT cell of 20220412 was
read as two glyphs; the token sits exactly in the Sym column (`OI@719+100`,
against `WHX@718`, `URA@720`, `URNM@720`, `WEAT@718`, `X@719`, `COPX@717`),
the panel's second row is `LMT`, and `OI` occurs **exactly once** in the
corpus. The table was **38 data rows** at that point; it is **39** now — see
§ *The 2023-era production smoke scan*.

#### The one-glyph column rule

A one-glyph cell is ambiguous: it is either a genuine one-letter ticker or a
multi-glyph cell the OCR collapsed into one glyph. **The shape cannot tell the
two apart** — `X` (a real holding on 20220301, 20220323 and 20220412) and `U`
(the LI row of 20230522) are both one glyph about 42 px wide, at the same left
edge of the Sym column, and `X` reads at conf 0.98 while `U` reads at 0.62.

**The column settles it, by its own consistency.** Only four US tickers have a
single letter (F, T, V, X), so a position list holding **two** of them is far
less likely than a panel that collapses two cells — and a panel that collapses
one cell is likely to collapse another. **A column with a second one-glyph
read has demonstrated that it collapses cells, and none of its one-glyph reads
can be taken at face value.**

Measured on the replay corpus, the one-glyph run-only class is **five**
readings:

| token | date | conf | one-glyph members of its column | verdict |
|---|---|---|---|---|
| `X` | 20220301 | 0.980 | 1 | hit |
| `X` | 20220323 | 0.963 | 1 | hit |
| `X` | 20220412 | 0.914 | 1 | hit |
| `U` | 20230522 (two captures) | 0.616 / 0.743 | **2** | false positive |

The rule keeps the three `X`s and drops the two `U`s. **Confidence cannot do
this job**: `U` reads at 0.616 on one capture and 0.743 on the other, so any
threshold low enough to catch it also catches the 0.534-confidence `QBTS` hit
on 20230602 — and the corpus mixes OCR engines, whose confidence scales are
not comparable anyway.

**There is no price-aligned escape hatch, and it is worth saying why.** The
column detector measures a cell's **centre**, and in a left-aligned table a
one-glyph cell's centre sits ~44 px left of a four-glyph cell's — outside the
detector's ±25 px column window. **A one-glyph token can never be
price-aligned**, so the row stack is the *only* evidence that admits it, and
this rule is the only thing that decides its fate.

**The curated rescue still reaches the cells the rule rejects**, because it
works on the words: the collapsed AI row of 20230522 (`A`) is still rescued to
`AI` after the loop. What it cannot reach is the collapsed LI row (`U`),
because `U` is a genuine ticker — a holding on 20221117 — and the alias
table's invariant forbids a row that would rewrite it. **That row stays
missed**, which is the project's own preference: a wrong holding in a
portfolio report is worse than a missing one.

#### Measured

Same corpus, same command, the same configs on both sides — the difference is
the parser and the one alias row. The three rows are cumulative.

| | default roots | wide corpus |
|---|---|---|
| **before** — `HEAD` plus the alias rows | 83/85/83 — 97.6 % / 100 % | 136/168/154 — 81.0 % / 88.3 % |
| **the gate's row-stack evidence** | 83/85/84 — 97.6 % / 98.8 % | 148/168/167 — 88.1 % / 88.6 % |
| **after the one-glyph rule** | **83/85/83 — 97.6 % / 100 %** | **148/168/166 — 88.1 % / 89.2 %** |

**+12 hits on the wide corpus, +1 net false positive, and not one date
regressed.** The four dates that moved: `20220323` 4 → 9 hits, `20220330`
3 → 7, `20220406` 4 → 6, `20220412` 10 → **11 of 11**.

The gate change brought **two** false positives with its twelve hits: `OI` on
20220412 and `U` on 20230522. `OI` was removed by the lexicon-vouching rule
and the `OI → LMT` alias row; `U` by the one-glyph rule. The one-glyph rule
moved **the whole corpus by exactly one row** — the `U` came off 20230522 and
nothing else changed, on either corpus (a JSON diff of the two replays, not an
estimate).

Pinned by `test/chartStreamOneGlyphColumn.test.js` — five tests: a lone
one-glyph holding is published; a one-glyph read is dropped when the column
holds another one-glyph read; the curated rescue still reaches the cell the
rule dropped; the rule is the column's **count** and not the token's
**confidence** (a 0.05-confidence read in a one-one-glyph column is published,
a 0.99-confidence read in a two-one-glyph column is not); and a one-glyph
read is never price-aligned, so the rule is its only guard.

### The panel counts its own rows

The positions panel prints its **own row count** in its footer:

```text
N Items in Personal WatchList          the whole list
1 Item in Personal WatchList           singular when the total is one
K of N Items in Personal WatchList     a row is selected; K is that row's
                                       INDEX, not a scroll range
```

**N is the number of rows ON SCREEN.** The panel is not scrolled, so all N rows
are visible at once — which makes N an **independent check** on a reading: a
reading with a different number of tickers has provably dropped a row or
invented one. The ground-truth audit had to discover this by hand, reading
every pinned crop and comparing it with its footer; as a parser diagnostic, it
travels with every capture instead.

Two rules keep the check honest, and both are traps the audit paid for:

- **N is the digit immediately before "Item(s)"** — so "5 of 7 Items" gives
  **7**, the total, and not 5, the selected row's index. The singular form
  ("1 Item") is read too.
- **The footer must be BELOW the positions header.** "Personal WatchList" does
  **NOT** identify the panel: the 2022-era frame carries three right-hand
  widgets and **two** of them print that wording, and the plain
  "N Items in WatchList" form belongs to the middle screener. The "A - Positions"
  header is the only thing that tells them apart — the wording cannot.

**The count is REPORTED, never acted on.** `readPanelRowCount()`
(`src/parse/parseChartStream.js`) returns it, the parser publishes
`panel_count` / `panel_count_delta` / `panel_count_footer`, and the scan tool
propagates them into the probe log. Nothing truncates a reading to fit it —
because a count misread **low** would truncate a correct reading, and that is
exactly the case where acting on it would do the most damage. A wrong holding
in a portfolio report is worse than a missing one, and so is a missing holding
caused by a bad count.

Pinned by `test/chartStreamPanelCount.test.js` — ten tests on the rules above,
including the two traps (the "K of N" form and the footer above the header).

### Diagnostic fields exposed

- `chart_stream.column_filter` — `dominant_x`, `dominant_left`, `column_width`, `in_list_token_count` (diagnostic only, not gated)
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
- `chart_stream.panel_count` — the panel's OWN row count, read from its footer.
  `panel_count_delta` is the difference against the reading's own length, and
  `panel_count_footer` is the footer text verbatim. **Reported, never acted on** — see
  § 'The panel counts its own rows'.

### Known limitations and next steps (as of 2026-11-02)

**Measured on the curated GT benchmark** (`test/qmgGroundTruth.test.js`, 4 captures,
EasyOCR, single frame each — not a multi-frame consensus run), at commit `8070601`,
**re-verified 2026-10-29 against the md5-pinned fixture frames** (864 s, all four cases
passing, identical numbers), **re-measured 2026-10-31 after the nine 2023-era
curated aliases and the left-edge column fix**, **re-measured 2026-11-01 after the
ground-truth audit** (305 s, all four cases passing), **re-measured again after the
Filter B rewrite**, and **re-measured 2026-11-02 after the era-conditional crop**
(151 s, all four cases passing):

| case | date | recall | FP |
|---|---|---|---|
| trade_ideas | 20220218[1] | 77.8% (7/9) | 3 |
| sparse | 20221104[0] | 100% (1/1) | 3 |
| normal_2022 | 20220606[1] | **100% (8/8)** | 2 |
| dense_2023 | 20230609[0] | **100% (13/13)** | **0** |

Overall mean recall **94.4%** (was **91.1%** before the crop change, **89.2%** after
the ground-truth audit, **86.4%** after the 2026-10-31 aliases and the column
fix, **82.6%** after the 2026-10-29 curated-alias rescue, and **80.6%** before it).

**The crop change moved two cases in opposite directions, and the total rose.** The
2023-era crop now reaches x 1586, so `dense_2023` went 10/13 → **13/13 with zero false
positives** — the two rows CLAUDE.md had already recorded as "outside the crop" (`APLD`
and `MNDY`) are inside it now. `normal_2022` recovered `TNA` (7/8 → 8/8) and **lost a
false positive** (3 → 2). But `trade_ideas` **regressed 9/9 → 7/9**, and the two misses
are `TQQQ` and `TSLA`.

**That regression is real and it is recorded rather than hidden.** The 2022-era crop
moved from `0.86,0.62,0.14,0.22` to `0.86,0.60,0.14,0.28`: the same x, a taller y. The
extra height is what buys `20220421`'s bottom rows (11/16 → 14/16) — and it is also
what costs `trade_ideas` its two tickers, because **a taller crop is downscaled more by
EasyOCR** (which resizes the detection image to height 736 preserving aspect), so the
glyphs get smaller and two faint rows stop being readable. The 2022-era crop trades a
benchmark flagship for the corpus: over the nine pinned 2022-era frames it is
**+4 hits at unchanged precision** (74/85 fp18 → 78/85 fp19), and `20220218` c1 is one
frame of that nine.

**No false positive was added at any step** in the 2023-era column — `dense_2023` went
from 3 to **0**. These numbers were previously meaningless — the benchmark was
resolving 640×360 prefilter frames, so every case scored 0%.

**The last step is the same mechanism the replay measures.** The `dense_2023` frame's
panel holds **13** rows, and both the legacy y-window and the old crop clipped the
bottom of a list that long; Filter B uses the list's own rows, so once the crop carries
them the parser keeps them.

**The benchmark is deterministic, not noisy.** Two consecutive runs (2026-10-25, 512 s and
461 s) produced byte-identical per-case numbers, hits and FP counts, and the 2026-10-29
run against the pinned frames reproduced the table exactly. So a change in this table
means the *code* or the *input frames* changed — not that the measurement drifted.

**The wall clock is not the number.** The 82.6 % run took **134 s**, the 80.6 % run 864 s,
the 89.2 % run 305 s, the 91.1 % run **40,053 s**, and the 94.4 % run 151 s — the same
frames, the same engine,
no OCR cache (`ocrImage()` runs
EasyOCR for real every time). EasyOCR swings by 2× on the same file between runs, and by
orders of magnitude when the machine is busy; the
per-case numbers are what is stable. **Quote the recall, not a duration.**

**The input frames ARE pinned (since 2026-10-29).** `resolveSnapshotPath` now prefers the
tracked fixture in `test/fixtures/qmg_benchmark/` and verifies its md5; only if there is no
fixture does it fall back to scanning `SNAPSHOT_ROOTS` plus every
`data/video_scan_test/_rerun/<run-tag>/snapshots/` directory and keeping the **widest** file
named `qmg_<date>[_<n>].png`. A new re-run directory can therefore no longer change which
frame a case is scored on. The earlier 73.9% figure was not measured against a named frame
set, which is why it cannot be reconciled with 80.6% from the record alone.

The frames the 82.6% measurement above was taken on, all 1920 px — now tracked as fixtures
(see § 'The benchmark's frames are now tracked'):

| case | frame | md5 |
|---|---|---|
| trade_ideas | `test/fixtures/qmg_benchmark/trade_ideas_20220218_c1.png` | `d6a45e350aeacf16c704d324f0ed18a5` |
| sparse | `test/fixtures/qmg_benchmark/sparse_20221104_c0.png` | `7d766f71608427d09c8dbf0592b81445` |
| normal_2022 | `test/fixtures/qmg_benchmark/normal_2022_20220606_c1.png` | `e34b828300318085b07166a87aa50f98` |
| dense_2023 | `test/fixtures/qmg_benchmark/dense_2023_20230609_c0.png` | `d53cb5fab33eba46e73ba40a7477f91e` |

**Precision floor**: 0–3 false positives per capture. Remaining FP sources:
`TQQQ`→`TOCA` (OCR misread of a real ticker), chart-area tokens that happen to be in the
seed lexicon (`ISYM`, `MEL`, `CON`), and one-letter tokens (`ON`, `X`).

**Recall floor**: `20220606` and `20230609` now miss **nothing** (8/8 and 13/13). The
remaining miss is `trade_ideas` 20220218[1], which lost `TQQQ` and `TSLA` when the
2022-era crop grew taller — a taller crop is downscaled more by EasyOCR, so two faint
rows stop being readable. (`AI` and `PLTR` are no longer among the misses: the first
came back with the left-edge column fix, the second with the `ATR → PLTR` alias row,
and `GSIT` with the Filter B rewrite.)

**The two rows that were "outside the crop" are inside it now.** On the md5-pinned
`dense_2023_20230609_c0.png` the 2023-era sidebar's ticker column (x 1690–1750) carries
**13** data rows at y 715, 733, 751, 769, 787, 805, 823, 841, 859, 877, 895, **913, 931**.
The old crop `0.86,0.62,0.14,0.22` covered y **670–907**, so the last two rows —
**`APLD` and `MNDY`** — were outside the pixels the OCR engine was ever shown. The
2023-era crop `0.82,0.60,0.18,0.32` covers y **648–994** and x **1574–1920**, so all
thirteen rows are inside it, and `20230609` now reads **13/13 with zero false
positives**.

**The `meanLumaFloor=30` hypothesis was tested and is NOT the cause.** Measured over the
prefilter's own frames: on 20220218 the median frame luma is **15.1** and on 20220222 it
is **15.3**, so **100 %** of frames sit below the floor and every one of them takes the
same −6 penalty. The floor is a *constant*, not a filter — the profile comment ("chart
frames have mean luma 50-90, so the floor is dropped to 30") is 3–5× off the measurement.
The real cause of missed frames is the **starved seed branch** of `selectFramesForOcr`:
`uniformReserve == maxFrames` for every real video, so `seedBudget == 0` and the only
part of the selector that consults `--prefilter-threshold` never runs. Measured across 12
videos: **12/12** selected frames below the profile's own dynamic threshold on 20220218,
and the best-scoring frame was **never** selected on any of the twelve.

### The prefilter, measured the way the pipeline measures it (2026-10-31)

The starvation finding above was re-measured independently, and the re-measurement turned
up a **methodology trap that silently changes the numbers**.

**The prefilter's frames are PNG at 640 px.** `src/video/ocrScanArgs.js:145` sets
`sampleWidth: 640`, and `tools/scanVideoWithOcr.js:282` extracts with
`fps=<fps>,scale=640:-2` into `frame_%06d.png`. A measurement that samples **JPEG at
1280 px** does not reproduce the pipeline's scores: JPEG's artefacts move the pixel
statistics the prefilter reads, and a wider sample changes the `midToneRatioTicker`
measurement. The first version of this measurement was JPEG-at-1280 and reported the best
frame on 20220218 as index 32 / t=128 s / score 22.24. Re-extracted as PNG at 640 px, the
pipeline's own numbers come out — and the real scan confirms them:

| | 20220218 | 20220222 |
|---|---|---|
| frames sampled (fps 0.25) | 689 | 452 |
| best frame | **index 10, t=40 s, score 29.15** | **index 147, t=588 s, score 25.63** |
| the scan's own log line | `best prefilter 29.15 at 00:00:40` | — |
| dynamic threshold | 27.15 | 23.63 |
| frames passing it | **16 of 689**, all in t = 40…200 s | **9 of 452**, all in t = 300…612 s |
| the 12 frames the selector picks | 0 of 12 pass | 0 of 12 pass |
| best selected frame | 20.62 (t=0) — **8.53 below the global best** | 23.26 (t=1184) — 2.37 below |

**"0 of 12" is expected, not a finding.** The dynamic threshold is `bestScore − 2` — a
**relative near-best** criterion, so on any video whose score rises steeply in one place
almost nothing passes it. It says the spread frames are *not the best*, which is not the
same as saying they are unreadable, and the recorded captures prove the difference: the
20220218 frames at t=684 and t=912 are recorded with 10 and 12 tickers. What the
measurement does show is the defect itself: **the prefilter score has no effect at all on
which chart-stream frames get OCR'd**, and the best-scoring frame is never among them.

**What the score is actually made of.** Decomposing the chart-stream score term by term:

| term | best frame (20220218) | mean share of a positive score |
|---|---|---|
| **midTone** | **25.00** (weight 30, ratio 0.833) | dominant |
| temporal | 5.87 | **18.7 %** (20220218), **27.8 %** (20220222) |
| bright / edge / stdDev / snapshotEdge | 3.74 / 1.87 / 2.62 / 2.00 | minor |
| rowDensity / stripes / chartLikeness | 0.20 / 0.00 / −0.14 | negligible |
| meanLuma floor / darkRatio ceiling | −6.00 / −6.00 | constant |

The temporal bonus is **not** what drives the score, and the score is **not** an
early-frame bias: the mean time-rank of the score-ordered frames is **344 of 689**
(20220218) and **226 of 452** (20220222) — the midpoint, not the front. What the top
frames share is `midTone`, and they cluster in a **contiguous window** (t = 40…200 s and
t = 300…612 s): the ticker rectangle is densest for a stretch of the video, and a uniform
12-point stride across 2,756 s is very unlikely to land in it.

**The position list changes WITHIN a video, so the uniform spread is a coverage
mechanism, not a bug.** `data/qmg_ground_truth.json` is keyed by **capture index**, not by
timestamp — 20220218's entry is `{"0": [...], "1": [...], "2": [...]}` with three different
readings — because the list changes as the video goes on. A blind stride is a
legitimate way to cover that. That is why the fix below **adds** a frame and does not
**replace** one.

### The chart-stream best-frame swap (2026-10-31)

`swapInBestPrefilterFrame()` (`src/video/ocrScanLogic.js`), wired into
`tools/scanVideoWithOcr.js` after the table profile's own swap:

- the best-scoring prefilter frame **takes the slot of the LOWEST-scoring selected
  frame**, so the swap is **cost-neutral** — 12 frames in, 12 out;
- it is gated by the profile's threshold with the same **60 % relaxation**
  `selectFramesForOcr` applies, so a dim video still swaps;
- it is **skipped in batch mode**, where the selected rows are replaced wholesale
  around the best frame's timestamp anyway.

**The eviction rule is "lowest score", NOT the table profile's "nearest frame", and the
difference is deliberate.** The table profile's budget is 3 frames taken *seconds* apart,
so its nearest uniform frame is redundant with the best one; the chart-stream frames are
*minutes* apart, so no selected frame is redundant with another and the nearest one may
be a good frame. The lowest-scoring frame is the one that costs least to lose — on
20220218 that is t=2280 (score −7.57), which the corpus records with **one** ticker,
while the best-scoring frame (t=40) is recorded with **seven**.

**But the best-scoring frame is NOT demonstrably the frame that reads the most
holdings.** On 20220218 the best-scoring frame (t=40, score 29.15) is recorded with **7**
tickers, while two *lower*-scoring frames — t=684 (score 15.45) and t=912 (score 11.75)
— are recorded with **10** and **12**. Those readings come from different pipeline eras
(`fix-verify-2022` vs `qmg-easyocr-20261018`), so it is not a controlled comparison — but
the project's own code already says the same thing. `tools/scanVideoWithOcr.js:1440`:

> `--batch-time` overrides the center timestamp. This is needed when the prefilter's
> best-scoring frame is not where the position list is actually visible (e.g. user
> navigated away from the chart platform — only the chart-area overlay remains).

So the swap is justified as **removing a real defect** (the score has no effect on the
selection) at **zero cost** (one frame in, one frame out), **not** as "OCR the best
frame". **Its effect on holdings recovered is UNMEASURED** — a chart-stream re-scan costs
8–13 minutes of EasyOCR per video, so the number only comes from a sweep, and no sweep
has been run. Pinned by `test/prefilterBestFrameSwap.test.js` (the rule, not the recall).

**The swap is far safer than it looks, because the final capture is NOT chosen by the
prefilter.** The prefilter chooses the *candidate* set; the OCR score
(`chartStream.position_list.length`) chooses the *capture* among the candidates. So
widening the pool cannot displace a frame the OCR would have preferred — it only adds an
option. A smoke scan of 20220218 (Tesseract, `--max-captures 1`) shows both halves:

```text
[scan:snapshot] chart-stream mode: swapped in the best prefilter frame (29.15 at 00:00:40)
                in place of the least legible selected frame (-7.57 at 00:38:00)
[scan:snapshot] prefilter kept 12/689 frame(s) for OCR; best prefilter 29.15 at 00:00:40
[scan:snapshot] OCR 12/12 frames (100.0%) ... best score 26.85 at 00:15:12 (ocr 32.0)
```

The prefilter's best frame (t=40) went into the pool, and the capture was still
**t=912** — the frame the OCR prefers. The swap lost nothing, which is the property that
matters: the only way it can lose is if the **evicted** frame would have won the OCR
score, and by construction that is the lowest-prefilter-scoring frame in the set.

**What is still open.** The seed branch's starvation is fixed *locally*, in the scan
tool, deliberately: `selectFramesForOcr` is shared with the whiteboard profile, and its
comment says changing it would move already-measured chart_stream and whiteboard
results. A change there — giving the seed branch a budget, or making the stride reserve
leave room — would fix the defect at its source and would need its own measurement.

### The chart-stream crop — MEASURED off the pixels, and ERA-CONDITIONAL

**The crop is not one rectangle, and the reason is a fact about Qullamaggie, not about
the code.** He changed the layout of his position list between 2023-01-26 and 2023-05-18:
before the change it was a **floating panel** in the bottom-right corner of the chart
frame; after it, a table **docked to the RIGHT edge** of the screen. The two layouts do
not share a column.

**The panel geometry, measured off the pixels of the pinned ground-truth frames.** The
OCR word boxes in the crop cache carry `left/top/width/height` in the ×5-upscaled crop,
so `source_x = region.x·1920 + left/5` and `source_y = region.y·1080 + top/5` recover the
panel's true position **without any new OCR**:

| layout | Sym column (source x of 1920) | rows (source y of 1080) | dates |
|---|---|---|---|
| floating panel | 1795 – 1812 | 660 – 940 | 20220218 … 20230126 |
| right sidebar B | 1706 – 1712 | 661 – 934 | 20230609, 20231201 |
| right sidebar A | 1617 – 1628 | 661 – 934 | 20230518, 20230523, 20230605, 20230608 |
| right sidebar A′ | 1585 – 1613 | 736 – 934 | 20231215 |

**The shipped default had TWO separate defects**, and both were measured:

- **x started to the RIGHT of the sidebar column** — `0.86` is source x 1651, and the
  sidebar column runs 1585–1712. A sidebar-era frame therefore read **zero** holdings
  under it, under *every* y variant of x=0.86 (0/13 on 20230608, 0/11 on 20230523).
- **y clipped the first and last row of a long list in BOTH eras** — `0.62`–`0.84` is
  source y 670–907, and 20220421's panel runs down to y 934: **11 of 16 rows**.

**The era boundary sits inside the catalog's own gap.** Qullamaggie published **nothing
at all** between 2023-01-26 and 2023-05-18 (verified against `state.sqlite`), so no
video can be mis-assigned by the threshold. Pinned by
`test/chartStreamCropCoverage.test.js`.

**The shipped rectangles** (`src/video/chartStreamCrop.js`):

```js
CHART_STREAM_CROP_FLOATING_PANEL = '0.86,0.60,0.14,0.28'   // source x 1651-1920, y 648-950
CHART_STREAM_CROP_RIGHT_SIDEBAR  = '0.82,0.60,0.18,0.32'   // source x 1574-1920, y 648-994
CHART_STREAM_RIGHT_SIDEBAR_FROM  = '20230518'
```

Both are the **tightest** rectangle that still covers the measured panel rows, so
neither admits chart ink the panel does not need.

**x = 0.82 is required, not a preference.** 20231215's ticker column begins at source x
1586–1587, and a crop starting at 1594 (x=0.83) shaves the first glyph off *every*
ticker: proved on the pixels, `0.83` reads `TX/MND/TLB/KNG/ME/INS/DD/KX/DOG/MCI/LT/IM`
where `0.82` reads the correct `BITX/UND/GILB/DKNG/GME/MNS/PDD/VKIX/DDOG/SMCI/ALT`.

**Measured with a fresh EasyOCR pass** over the pinned ground-truth frames (nine
2022-era frames / 85 holdings; seven 2023-era frames / 75 holdings):

| crop | era | hits/gt | recall | fp | precision |
|---|---|---|---|---|---|
| `0.86,0.62,0.14,0.22` (old default) | 2022 | 74/85 | 87.1 % | 18 | 80.4 % |
| **`0.86,0.60,0.14,0.28`** (shipped) | 2022 | **78/85** | **91.8 %** | 19 | 80.4 % |
| `0.86,0.60,0.14,0.32` | 2022 | 80/85 | 94.1 % | 24 | 76.9 % |
| `0.86,0.55,0.14,0.45` | 2022 | 80/85 | 94.1 % | 26 | 75.5 % |
| `0.83,0.60,0.17,0.32` | 2022 | 76/85 | 89.4 % | 23 | 76.8 % |
| `0.86,0.62,0.14,0.22` (old default) | 2023 | 27/56 | 48.2 % | 10 | 73.0 % |
| **`0.82,0.60,0.18,0.32`** (shipped) | 2023 | **69/75** | **92.0 %** | **8** | **89.6 %** |
| `0.82,0.60,0.18,0.28` | 2023 | 69/75 | 92.0 % | 8 | 89.6 % |
| `0.83,0.60,0.17,0.32` | 2023 | 70/75 | 93.3 % | 9 | 88.6 % |
| `0.82,0.55,0.18,0.36` | 2023 | 62/68 | 91.2 % | 15 | 80.5 % |

The 2022-era rectangle is the tightest crop that still covers the measured rows
(660–940): it is the only candidate that **improves recall (+4) at unchanged precision**.
`wide` and `wide45` buy two more hits for five to eight extra false positives. The
2023-era rectangle is the one that has to reach x 1586, and its taller bottom (994)
buys margin over the measured rows (661–934) at no measured cost — it also ties the
best dedup of every candidate.

**The crop is also the capture-DEDUP rectangle**, so a rectangle that is too generous
makes two *different* position lists look alike and the second capture is thrown away.
`pickTopDistinctCandidates` (`tools/scanVideoWithOcr.js:74`) skips a candidate whose
overlay pHash is within Hamming 6 of an already-picked one, and
`tools/runQmgOcrBatch.js`'s `DEFAULT_FLAGS` use `--max-captures 3`, so the dedup matters
in production. Measured over the 70 distinct-ground-truth capture pairs in the pinned
manifest:

| crop | collapsed pairs | min Hamming |
|---|---|---|
| `0.86,0.62,0.14,0.22` (old default) | 0 | 14 |
| `0.86,0.60,0.14,0.28` (2022-era, shipped) | 1 | 4 |
| `0.86,0.60,0.14,0.32` | 4 | 4 |
| `0.83,0.60,0.17,0.32` | 1 | 6 |
| **`0.82,0.60,0.18,0.32` (2023-era, shipped)** | **0** | **8** |

**The corpus's own natural experiment corroborates the split.** The 2023-era
production region `0.83,0.55,0.17,0.45` appears in **26** probe logs; the old shipped
default appears in only **4** logs, covering one or two dates of 49. The default was
essentially never used in production — every 2023-era scan had to override it by hand,
which is exactly what `tools/runQmgOcrBatch.js`'s `WIDE_CROP_DATES` list was: 29 dates
with the rectangle `0.83,0.55,0.17,0.45`. **That list missed 20231201 and 20231215**,
whose column starts further left still. The override has been removed; the crop is now
derived from the upload date inside the scan tool itself, so the era rule lives in one
place and a date cannot be mis-classified by a stale list.

**An unknown date falls back to the SIDEBAR crop, and the reason is asymmetric.** The
sidebar crop (x 1574–1920) still *contains* the 2022-era floating panel (x 1795–1812),
so it reads that panel — just with more chart ink beside it. The floating-panel crop
(x 1651–1920) does **not** contain the sidebar column at all, so it reads a sidebar
frame as EMPTY. The safer fallback is the sidebar crop.

**The crop change and the parser change interact, and only measuring them together
shows which one is doing the work.** The 2023-era sidebar's 13 data rows run down to
y 931 of 1080; the old crop covered y 670–907, so the last two rows — **`APLD` and
`MNDY`** — were outside the pixels the OCR engine was ever shown. CLAUDE.md had already
recorded that those two were "not OCR failures" (§ 'Known limitations'). The pre-Filter-B
parser could not exploit a taller crop because its `yMedian ± 8·lineHeight` window
clipped the bottom of a long list anyway; Filter B uses the list's own rows, so once the
crop carries them the parser keeps them.

**The lesson: a measurement taken against a parser that has since changed is a
measurement of that parser.** The four-frame tables that drove this section (2026-10-31
and 2026-11-02) were not wrong when they were taken; they were read as statements about
the *crop* when they were statements about the crop **and** the parser of the day. The
rule that governed the whole thing — *the default stays where it is until a wider
measurement says otherwise* — was right, and it is what produced the 94-capture
measurement this section is based on.

### The prefilter's rectangle — the crop's rectangle, era-conditionally (2026-11-02)

**The crop was fixed; the prefilter that DECIDES WHICH FRAMES GET OCR'D was still
measuring the wrong rectangle.** The two are different questions, and only the first
was answered.

The prefilter measures a **bottom-right-anchored** rectangle (`summarizeLumaBuffer`,
`src/video/ocrScanLogic.js:371-372`): `left` is the LEFT edge, `top` the TOP edge, and
the rectangle runs to the frame's right and bottom edges. The `chart_stream` profile
carried no `tickerRegion` of its own, so **every** chart-stream frame was measured
against the hard-coded fallback `{left: 0.85, top: 0.55}` — source **x 1632, y 594**.

**That rectangle excluded the ticker column of two of the three measured sidebar
layouts**, because the sidebar's column starts to the LEFT of 1632:

| layout | dates | Sym column (source x) | inside the fallback? |
|---|---|---|---|
| right sidebar B | 20230609, 20231201 | 1706 – 1712 | **yes** |
| right sidebar A | 20230518, 20230523, 20230605, 20230608 | 1617 – 1628 | **no** |
| right sidebar A′ | 20231215 | 1585 – 1613 | **no** |

So the prefilter was scoring the **price and %-Change columns** of a panel whose
tickers it could not see — for every date except 20230609, the one date that happened
to be scanned first, and the one date whose layout the defect happened to spare.

**What the production smoke scan recorded.** The 2026-11-02 scan of 20230609 OCR'd six
candidates; the prefilter's ranking and the OCR's reading disagree completely:

| ts | prefilter score | OCR score | holdings read |
|---|---|---|---|
| 1944 | **−3.36** | **33.02** | **13 — the exact ground truth** |
| 972 | 0.68 | 31.77 | 12 |
| 3888 | 2.32 | 31.52 | 12 |
| 2916 | −3.51 | 31.02 | 12 |
| 0 | 9.94 | 19.76 | 7 (a garbage frame) |
| 3100 | **25.9** | **0.26** | **0** |

**The prefilter's best frame read ZERO holdings.** Its score was 29 points above the
frame that read the date exactly. The capture is still chosen by the OCR score, so this
did not lose the frame on that scan — but it is the prefilter that decides the
**candidate pool**, and a ranking that is inverted is a ranking that will lose frames
as soon as the budget tightens.

**The fix: the prefilter measures the CROP's rectangle.** The rectangle it scores is now
the pixels the OCR engine will read, chosen by the same era rule as the crop:

```js
chartStreamPrefilterRegionForDate(dateKey) → { left: crop.x, top: crop.y }
```

threaded from `tools/scanVideoWithOcr.js` into `prefilterFrames` as a
`tickerRegionOverride`, for the `chart_stream` profile only. The invariant — *the
prefilter measures the pixels the OCR will read* — is pinned by
`test/chartStreamPrefilterRegion.test.js`, together with the defect itself (the legacy
fallback's x 1632 against the two columns at 1617 and 1585).

**The era decision is now in ONE place.** `chartStreamEraForDate()` is the single answer
to "which layout era is this date", and the crop, the prefilter rectangle and the
per-date scan flags all derive from it. They used to disagree: the crop fell back to
the **sidebar** rectangle for an unknown date while `isRightSidebarDate` said
"not the sidebar era", so an unknown date could be scanned with the sidebar crop and the
floating-panel flags at once. **An unknown date is the sidebar era for both**, because
that fallback is asymmetric — the sidebar rectangle still contains the 2022-era floating
panel, while the floating-panel rectangle does not contain the sidebar column at all.

**The fix is NECESSARY but it is not SUFFICIENT, and the honest reason is the
prefilter's resolution.** `PREFILTER_WIDTH`/`PREFILTER_HEIGHT` are **160×90**
(`src/video/ocrScanLogic.js:7-8`), and the frame is resized into that with
`fit: 'contain'` before the luma summary. At that scale:

- **`midToneRatioTicker` is degenerate.** Its denominator is the number of mid-tone
  pixels in the ticker rectangle, which at 160×90 is **7** on five of the six frames
  above and **17** on the sixth — so the ratio is 2/7 on frames reading 13, 12, 12, 12
  and **0** tickers, and 6/17 only on the frame that reads **zero**. The signal that is
  supposed to say "there is text here" is noise.
- **`rowDensity` and `multiColStripeCount` are INVERTED in the sidebar era.** The frame
  that reads 13 holdings has `rowDensity 3` and `multiColStripeCount 0`; the frame that
  reads **zero** has `rowDensity 12` and `multiColStripeCount 3` — the full 20-point
  stripe term.

Fixing the rectangle changes **which** pixels are averaged. It does not change the
160×90 down-sample that averages the text away, and it does not re-tune
`rowDensityTarget: 150` or `multiColStripeCountTarget: 3`. **So the expected effect of
the rectangle fix alone is to make the prefilter measure the right region — not to make
the ranking correct.** Raising the prefilter's resolution changes the scale of every
tuned constant in `scoreFramePrefilter`, and therefore needs its own wide measurement
before it is shipped.

`tools/measurePrefilterRegion.js` is the instrument for that measurement, and it does
**no OCR** — it extracts frames with the pipeline's exact ffmpeg filter, scores every
frame under both the legacy fallback rectangle and the era rectangle, and reports the
labelled frames' ranks and scores under each:

```bash
node tools/measurePrefilterRegion.js --video data/video_pipeline/downloads_1080p/20230609_VdQSDGZBLQE.mp4 \
  --date 20230609 --labels "1944:13,972:12,3888:12,2916:12,0:7,3100:0"
```

### The prefilter's RESOLUTION — 640×360 is the first one that works (2026-11-02)

**The rectangle fix is necessary but not sufficient, and the reason is the working
resolution.** `PREFILTER_WIDTH`/`PREFILTER_HEIGHT` are **160×90**
(`src/video/ocrScanLogic.js:7-8`): the whole frame is resized into 160×90 before
`summarizeLumaBuffer` reads it. The 2023-era ticker rectangle is 18 % of the frame's
width and 32 % of its height — **29×29 prefilter pixels**. Every tuned constant in
`scoreFramePrefilter` was fitted at that scale, so raising it changes the scale of all
of them, and CLAUDE.md's own rule applies: **the default stays where it is until a
wider measurement says otherwise.**

**The measurement.** `analyzeFrameBeforeOcr(framePath, region, options)` now takes an
optional `{width, height}` override, and `tools/measurePrefilterRegion.js` takes
`--resolutions "160x90,320x180,640x360"` and `--stride n`. **The pipeline calls it
with no options**, so nothing in production changed. `test/ocrScanLogic.test.js` pins
that the default is unchanged and that a nonsense override falls back to it.

Measured on the 20230609 control video (the one with six labelled frames — the six
candidates of the 2026-11-02 production scan, with the holdings each actually read),
**stride 8 → 188 scored frames**. The verdict is reported **per resolution AND per
region**: a resolution block holds two rankings (the legacy fallback rectangle and
the era rectangle), and comparing one region's most-holding frame against the other
region's zero-holding frame would report a verdict for a comparison that was never
made.

| resolution | region | the TOP pick reads | most-holding frame | zero-holding frame | verdict |
|---|---|---|---|---|---|
| 160×90 | fallback | **0** | ts=1944 (13) rank 104/188 | ts=3100 rank **1**/188 | INVERTED |
| 160×90 | era | **0** | ts=1944 (13) rank 137/188 | ts=3100 rank **1**/188 | INVERTED |
| 320×180 | fallback | **0** | ts=1944 (13) rank 151/188 | ts=3100 rank **17**/188 | INVERTED |
| 320×180 | era | **0** | ts=1944 (13) rank 90/188 | ts=3100 rank **9**/188 | INVERTED |
| **640×360** | fallback | **12** | ts=1944 (13) rank 104/188 | ts=3100 rank 115/188 | **OK** |
| **640×360** | era | **12** | ts=1944 (13) rank 53/188 | ts=3100 rank 32/188 | INVERTED (4 of 5) |

**"The TOP pick reads N holdings" is the decision-relevant column**, and it is the one
that moved: at 160×90 and 320×180 the prefilter's **best-scoring frame reads ZERO
holdings** in **both** rectangles; at 640×360 it reads **12** (ts=3888, which holds 12
of the ground truth's 13) in **both**.

**The strict pair test is not the whole story, and the difference is instructive.** At
640×360 in the **era** rectangle the 13-holding frame (ts=1944, rank 53) still ranks
below the zero-holding frame (ts=3100, rank 32) — but the 12-holding frame (ts=3888)
is rank **12**, so the zero-holding frame now outranks **four of five** holding frames
instead of five of five. The ranking is *nearly* right, not exactly right; and the
one frame it loses to is the one frame whose reading is best-but-one, not the one that
reads the date exactly.

**The mechanism, term by term.** The stripe term is what does the damage at the low
resolutions, and it is a **saturation** effect:

| | ts=3888 (12 holdings) | ts=3100 (0 holdings) |
|---|---|---|
| 160×90 era — stripes | 1 → 1/3 of the 20 points (**6.67**) | 4 → **20.0** (saturated) |
| 160×90 era — rowDensity | 8 → 8/150 of the 10 points (**0.53**) | 17 → 17/150 (**1.13**) |
| 160×90 era — midTone | 0.5714 × 30 = **17.14** | 0.4783 × 30 = 14.35 |
| 640×360 era — stripes | 24 → **20.0** (saturated) | 29 → **20.0** (saturated) |
| 640×360 era — rowDensity | 112 → **7.47** | 110 → **7.33** |
| 640×360 era — midTone | 0.3088 × 30 = **9.26** | 0.1571 × 30 = **4.71** |

At 160×90 the junk frame's stripes **saturate the 20-point term** while the good
frame's do not — a **13.3-point swing the wrong way** — and no other term can make it
up. At 640×360 both saturate, so the stripe term stops discriminating and the
**mid-tone term decides**, and at that resolution it decides correctly.

**So the resolution change is not a tuning change — it changes which term wins.** That
is also why `rowDensityTarget: 150` and `multiColStripeCountTarget: 3` are
**scale-bound** and would have to be re-tuned: at 640×360 the measured rowDensity is
**65–117** against a target of 150 and the measured stripe count is **10–29** against
a target of 3. Both terms are then permanently saturated or permanently short, and the
profile is measuring something other than what its constants say.

**A second negative result, and it is about a signal this project already added.** The
`midToneRatioTickerRegion` diagnostic — the region-wide mid-tone ratio, which is the
quantity the field NAME describes — is **anti-correlated with holdings at 640×360**:

| | ts=3888 (12 holdings) | ts=3100 (0 holdings) |
|---|---|---|
| 640×360 era — `midToneRatioTicker` (the one the score uses) | 0.3088, rank **4**/188 | 0.1571, rank **186**/188 |
| 640×360 era — `midToneRatioTickerRegion` (the corrected one) | 0.1144, rank 56/188 | 0.2062, rank **3**/188 |

**The corrected signal picks the zero-holding frame; the existing signal does not.**
The existing `midToneRatioTicker` is "of the bright pixels in the ticker region, how
many are merely bright" — a ratio whose denominator is *the region's bright pixels*,
not the region's area — and at a resolution where the region has **16 704** pixels it
is the **better** discriminator. **Do not promote `midToneRatioTickerRegion` to
scoring.** It stays a diagnostic. The "fix the misleading name" hypothesis is
**measured and rejected**.

**Nothing is shipped.** The pipeline still runs the prefilter at 160×90, and the
override exists so that the alternative can be measured. Shipping 640×360 requires:

1. a **wide** measurement — one video, six labelled frames, is not enough, and the
   2022-era floating panel has a different geometry from the 2023-era sidebar, so the
   two eras have to be measured separately;
2. a **re-tune** of `rowDensityTarget` and `multiColStripeCountTarget`, which are
   scale-bound (65–117 vs 150; 10–29 vs 3) and whose current values are what makes
   the stripe term saturate on the junk frame;
3. a decision on the **stripe term itself** — the measurement says the term is
   *actively harmful* in the sidebar era at any resolution where it can saturate on one
   frame and not another.

**The instrument** is `test/manual/prefilterResolutionScan.test.js` (manual: it needs
the real video, and the media is not in git). It asserts **structurally** — the tool
ran, every resolution reported, every labelled frame found — and **reports** the
rankings, because a resolution that does not help is a finding, not a failure.

```bash
node --test test/manual/prefilterResolutionScan.test.js
```

#### Final candidate-pool sweep (2026-11-04)

The wide measurement is complete. The instrument was
`tools/sweepPrefilterResolution.js`, driven by
`test/manual/prefilterResolutionSweep.test.js`, with labels from
`tools/extractPrefilterLabels.js`. It compared 160×90 (production), 320×180 and
640×360, under both the era rectangle and the legacy fallback rectangle, with
both the era's production temporal decay and no temporal decay.

**The label set is the retained OCR CANDIDATE POOL** — `captures` +
`top_candidates` + `top_rejected_candidates` — not the selected captures alone.
Selected captures are frames the scanner already chose after OCR and are therefore
biased toward frames that read holdings. The sweep used production extraction
(`fps=0.25`, sample width 640) and `stride=100000`: every labelled candidate was
scored, plus frame 0. This measures how the prefilter orders the retained pool;
it is **not** a full-video recall measurement, because discarded frames have no
OCR labels.

Two rules changed the measurement and are part of the result:

- **Labels are keyed by MEDIA, not by date.** 20220606 covers three uploads, so a
  date alone cannot address a frame. The extractor resolves the media by the
  log's exact recorded basename first, then by the recorded video id against the
  downloader's own-name convention, and only then by a date-only match **when
  exactly one** `.mp4` matches. The sweep filters labels to the media it scores.
- **Spearman ranks BOTH series** (`rankValues()` + `spearman()` in
  `src/video/ocrScanLogic.js`, also imported by
  `tools/measurePrefilterRegion.js`). Feeding raw holding counts to a
  rank-difference formula produced impossible values such as `-21.5`.

The result files are `data/prefilter_resolution_sweep_2022.json` (32 dates) and
`data/prefilter_resolution_sweep_2023.json` (9 dates). The 2023 set is the
measurable sidebar-era set requested; 20230601 had no usable aligned label/media
pair and was not silently treated as a zero.

### 2022 floating-panel era — production temporal decay

| region | resolution | PARTIAL | INVERTED | NO_ZERO_FRAME | mean Spearman | mean best-labelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| era | 160×90 | 9 | 5 | 18 | -0.073 | 5.53 |
| era | 320×180 | 10 | 4 | 18 | -0.058 | 3.44 |
| era | 640×360 | 10 | 4 | 18 | **-0.088** | 4.19 |
| fallback | 160×90 | 9 | 5 | 18 | -0.063 | 5.31 |
| fallback | 320×180 | 10 | 4 | 18 | -0.044 | 3.34 |
| fallback | 640×360 | 10 | 4 | 18 | -0.044 | 4.13 |

The 32-date candidate pool had 582 labelled frames: 516 read holdings, 66 read
nothing, and 146 read at most one ticker. Fourteen dates contained at least one
zero-holding label. The 640×360 era rectangle has the most negative mean
Spearman, but it does not reduce the inverted-date count and selects fewer
holdings on average than 160×90. That is not evidence to change production.

### 2023 right-sidebar era — production temporal decay is 0

| region | resolution | PARTIAL | INVERTED | NO_ZERO_FRAME | mean Spearman | mean best-labelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| era | 160×90 | 0 | 3 | 6 | **+0.221** | 6.00 |
| era | 320×180 | 0 | 3 | 6 | +0.046 | 4.78 |
| era | 640×360 | 2 | 1 | 6 | +0.135 | **6.11** |
| fallback | 160×90 | 0 | 3 | 6 | +0.275 | 5.33 |
| fallback | 320×180 | 1 | 2 | 6 | +0.152 | 6.44 |
| fallback | 640×360 | 2 | 1 | 6 | +0.177 | 6.11 |

The nine-date candidate pool had 110 labelled frames: 97 read holdings, 13 read
nothing, and 18 read at most one ticker. Only three dates contained a
zero-holding label, so most sidebar-era verdicts are `NO_ZERO_FRAME` and cannot
test whether the prefilter avoided junk. At 640×360 the era rectangle improves
the verdict mix from three inverted dates to two partial plus one inverted, but
it still has no `OK` dates and its positive Spearman remains the wrong direction.
This is a useful signal for further tuning, not a production-resolution decision.

**The zero-frame count is a LOWER BOUND.** When two runs read the same frame
differently, the larger reading wins ("the frame DID hold positions"), so a frame
read as zero by one run and as holding by another is counted as holding. The
conflict counts are retained in both result files. A date with no zero-holding
frame cannot say that a resolution avoided junk; the pool the prefilter kept is,
by construction, biased toward frames that read something.

**Decision: nothing has shipped.** No tested resolution is cleanly superior in
both layout eras. The pipeline still calls `analyzeFrameBeforeOcr` with no
resolution override, and `rowDensityTarget` / `multiColStripeCountTarget` remain
the 160×90-scale values. Shipping 320×180 or 640×360 would require a separate
re-tuning of those scale-bound constants and a measurement of the stripe term,
plus OCR validation on frames currently discarded by the prefilter.

**PaddleOCR PP-OCRv6**: the packages ARE installed — `tools/paddle311_env` (Python 3.11.9) has
paddleocr 2.7.3 + paddlepaddle 2.6.2, and `tools/paddle312_env` / `tools/paddle_env`
(Python 3.12.14) have the same. What fails is the **MODEL download**, not the install:
`tools/paddle312_status.txt` records "PaddleOCR blocked: Baidu CDN
(paddleocr.bj.bcebos.com) unreachable; packages install but model download fails. Use
--easyocr-python tools/paddle311_env/Scripts/python.exe when network available." The adapter
`tools/_paddleocr_ocr.py` **does not exist yet** — it still has to be written, with the same
schema as `_easyocr_ocr.py` — `{text, lines, words[{text,left,top,width,height,conf,line}],_engine,_image,_detection_count}`. Would run at ~7× EasyOCR speed (PP-OCRv6 on CPU with OpenVINO).

**Ground truth accuracy**: The `data/qmg_ground_truth.json` must be verified per video — 20220510 GT was actually TSLA+VRM (not LABU/TNA as previously assumed). Always verify GT against the actual video content before trusting recall numbers. **The 2026-11-01 audit did exactly that for 48 captures across 14 of the 42 dates, and found eight classes of defect — see § 'The Qullamaggie ground truth, verified against its pixels'. Run `node tools/checkGroundTruthConsistency.js` before quoting a Qullamaggie recall number.**

---

## The Qullamaggie ground truth, verified against its pixels (2026-11-01)

`data/qmg_ground_truth.json` was a HAND-MADE reading of a TradingView positions
panel. For months nothing compared it to the images it was read from, so eight
classes of defect survived:

| class | what it is |
|---|---|
| a **misread ticker** | one ticker read as another while every sibling capture of the same video read it correctly |
| a **missing capture** | the frame exists and was never recorded |
| a **wrong anchor** | a capture index that names a different frame in a different run |
| a **wrong widget** | a reading taken off the *watchlist* instead of the positions table |
| a **duplicate top-level key** | a date present twice in the file, where `JSON.parse` silently keeps one copy |
| a **copied column** | one capture's reading copied across every capture of the date, so a list that really changed inside the video is invisible |
| a **partial reading** | the OCR's output for a *crop*, recorded as if it were the panel's rows |
| a **dropped row** | the panel's first ticker left out — the count invariant only sees it once the panel's own footer has been read independently |

This section records the invariant that makes those detectable, the tooling that
enforces it, and what the corrections did to the numbers.

**The audit was done in three passes.** The first covered 26 captures across 10 of
the 42 dates; the second widened it to **48 captures across 14 dates**; the
third (the *wave-2* pass) widened it again to **94 captures across 40 dates**.
The second pass found three classes the first one could not, and overturned one of
the first pass's conclusions, because the first pass had only read the captures
whose panels were *consistent* — a copied column and a partial reading are both
perfectly self-consistent, and only a sibling capture that says otherwise
exposes them. The third pass found two more — a copied column and a
**mis-anchored capture** — and **reverted three of its own tentative
corrections** once the anchoring rule below was applied to them.

### The panel prints its own row count

The positions panel's footer reads one of three forms:

```text
N Items in Personal WatchList          the whole list
1 Item in Personal WatchList           singular when the total is one
K of N Items in Personal WatchList     a row is selected; K is that row's
                                       INDEX, not a scroll range
```

**N is the number of rows ON SCREEN.** The panel is not scrolled — all N rows
are visible at once. The invariant is therefore:

```text
panel_count == number of visible rows == |tickers|
```

A capture listing more tickers than the panel counts is wrong; one listing
fewer is missing a holding. The footer text is recorded verbatim in the
manifest and the count is parsed back out of it, so a typo in either field is
caught.

**The plural follows the TOTAL, not the selected row.** `"1 of 1 Item in
Personal WatchList"` is singular because the total is one.

### "Personal WatchList" does NOT identify the positions table

This is the trap, and it cost the ground truth two dates.

The 2022-era frame carries **three** right-hand widgets, and **two** of them
print "Personal WatchList":

| widget | title | footer | rows (20220301 c0) |
|---|---|---|---|
| top | `1 - WL` | `8 Items in Personal WatchList` | LI, TSLA, SQ, DWAC, GOLD, SOXL, RSX, SBRCY |
| middle | `S - A Scan` | `3 Items in WatchList` | OSH, LPSN, NVAX |
| bottom | `A - Positions` | `5 of 7 Items in Personal WatchList` | GUSH, ERX, NUGT, COPX, FCX, X, MP |

The plain `N Items in WatchList` form (no "Personal") belongs to the **middle**
screener panel. The **upper** widget says "Personal WatchList" as well, with its
own count — so the footer's wording cannot say which panel a reading came from.

**The positions table is identified by its TITLE** (`A - Positions` — and the
`position_table` reader's `POS` discriminator) **and by being the bottom
widget.**

**And the count invariant does not catch a wrong-widget reading.** The wrong
widget prints its own count just as faithfully as the right one, so a reading
taken off the watchlist satisfies `panel_count == |tickers|` perfectly. The
panel has to be identified by eye — so every manifest case now records the
widget it was read from (`panel: "positions"`), and the checker enforces it.

### A capture index is RUN-RELATIVE

`qmg_<date>_<n>.png` holds a **different image in every run directory** — the
same file name in `qmg-easyocr-20261011` and in `qmg-1080p-batch2` is a
different frame. A capture index identifies a frame only together with the run
directory, so the manifest carries both (`run` and `source`).

Three dates were anchored wrongly, in three different ways:

- **20220218** — captures 0 and 1 were **swapped**. The ground truth had the
  ROKU-first frame as capture 1 and the UPST-first frame as capture 0; the
  pixels say the opposite.
- **20220406** — the ground truth's capture order is the **reverse** of the
  1011 run's file order: the eight-row frame that carries `LMT` is capture 0 in
  that run and capture 2 in the ground truth. The ticker lists were right; only
  the anchoring was ambiguous.
- **20220429** — the three captures span **two runs**. Capture 2's five rows
  exist only in the 1017 run (the batch2 run's capture 2 shows `SWN`, not `X`).

### A date key can cover MORE THAN ONE VIDEO

`20220606` is not one recording. The `qmg-1080p-batch1` run holds **three**
probe logs for that date, under three different YouTube ids
(`aaIlqb7HUJQ`, `Axs8VyUKFRk`, `ST8lvpOVjeM`), and the snapshot directory
holds **twelve** files for it — of which the three logs reference nine, and
three (`_4`, `_5`, `_6`) are in the directory with no log pointing at them.

The twelve captures show **three different position lists**, not one:

| panel | rows | captures | footer |
|---|---|---|---|
| `GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX` | 8 | 0, 1, 2, 3, 6, 9 | "8 Items in Personal WatchList" |
| `BOIL, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX` | 8 | 4, 7, 10 | "4 of 8 Items in Personal WatchList" |
| `LABU, TNA, NFLX, VLO, CBIO, UCO, SIGA` | 7 | 5, 8, 11 | "2 of 7 Items in Personal WatchList" |

The ground truth had given **all twelve** the first list.

**The panels repeat with period three**, so a capture index counted *flat over
the file names* and one counted *per upload* name the same panel — they differ
only in which FILE an index points at. The manifest asserts the flat mapping,
because the GT's capture keys are flat.

**A date's ground truth is the UNION over its captures**, and the union is what
the replay tool scores against. So the union of 20220606 is ten holdings, not
eight — and a date key that covers several videos still has one union.

### The position list changes DURING the session

`20220427` grows while the video runs. The timestamps are monotonic inside each
upload, and the row count rises with them:

| time | rows | holdings |
|---|---|---|
| 15:26–15:27 | 4 | `TSLA, BOIL, WEAT, KOLD` |
| 15:32–15:35 | 4 | `TSLA, BOIL, WEAT, KOLD` (+ `KWEB` at 15:35) |
| 15:36–15:37 | 5–6 | `TSLA, BOIL, WEAT, KOLD, KWEB, CWEB` |

So the day's union is **six** holdings, and no single frame shows more than six.
The same file name in two runs is also two different images here: the batch2
run's `qmg_20220427.png` (md5 `95ad5b82`) and the 1011 run's file of the same
name (md5 `b6951857`) are four-row panels from different moments.

### Where the reading came from

The ground truth was transcribed by hand from a **review page**, and the review
page is where the defects entered:

- `data/video_ocr_probe/crops-for-review/review.html` — the original hand
  reading. **Untracked** (the whole `data/video_ocr_probe/` tree is gitignored),
  so it is local-only evidence and cannot be re-read on a fresh clone.
- `tools/qmg_snapshot_review.html` — **tracked**, and it carries a `gtTickers`
  column. For 20220606 that column holds three *different* readings
  (`GOVX…`, then `BOIL…SIGA`, then `BOIL…`) repeated once per upload — so the
  **difference was already visible in the review page**, and the ground-truth
  file flattened it into one list for all twelve captures.

That distinction matters, because the review page's own `_2` reading for
20220606 (`BOIL, LABU, UCO, ALB, CBIO, TNA, NFLX, SIGA`) is a **mixture** of two
of the three real panels — a hand reading that mixed two moments. Reading the
pixels is the only thing that settles it.

### What the audit changed

Every pinned capture was read off its crop and compared against the panel's own
footer. The figures below are the date-level GT **unions** — the denominator
the replay tool scores against.

**First pass — eight dates moved:**

| date | before | after | what moved |
|---|---|---|---|
| `20220218` | 11 | 10 | `DCX` was a misread of `FCX`; captures 0 and 1 were swapped |
| `20220222` | 8 | 7 | `NDGU` was a misread of `NRGU` |
| `20220301` | 11 | 8 | the reading was **not the positions table** (below) |
| `20220302` | 7 | 8 | ditto — `EDV` out, `GUSH` and `RSX` in |
| `20220406` | 8 | 8 | re-anchored to the runs that hold the frames; the lists never changed |
| `20220429` | 5 | 6 | `UCO` was missing from every capture |
| `20220606` | 9 | 8 | `BOIL` was a misread of `GOVX` — **and this was wrong; see the second pass** |
| `20221104` | 1 | 1 | capture 1 was **absent**, though the snapshot exists |
| `20230518` | 7 | 8 | `CVNA` was missing |

**20220301 is the one that matters most**, because its old reading was not a
miscount — it was **a different panel**. The old capture listed 11 tickers:
`IBKR, CRH, XLV, KRE, MP, NUGT, EDV, RSX, FCX, VLO, COPX`. The positions table
for that video holds `{GUSH, ERX, NUGT, COPX, FCX, X, MP, RSX}` — so six of the
old tickers (`IBKR`, `CRH`, `XLV`, `KRE`, `EDV`, `VLO`) are in **no** positions
reading, and three (`GUSH`, `ERX`, `X`) were missing from the ground truth.
`IBKR`, `CRH`, `XLV`, `KRE`, `EDV` and `VLO` are index/ETF symbols — watchlist
entries, not Qullamaggie positions.

**No frame in the corpus holds an 11-row widget**, so the old capture cannot be
re-examined here. That is why the fix anchored the date to the three verified
positions frames rather than to the old one.

**Second pass — five more dates, and one first-pass conclusion overturned:**

| date | before | after | what moved |
|---|---|---|---|
| `20220318` | 7 | 8 | the panel's **first row, `X`, was dropped**; captures 1 and 2 were never recorded |
| `20220321` | 8 | 11 | `DIDI` and `NUZE` are in **no** positions panel; `KWEB`, `WEAT`, `NEM`, `JNUG`, `URA` were missing |
| `20220427` | 4 | 6 | the list **grew** during the session (`KWEB`, then `CWEB`) |
| `20220606` | 9 | 10 | the first pass was **wrong**: `BOIL` and `SIGA` are real holdings on their own captures |
| `20220614` | 3 | 3 | the union never moved — capture `2` had dropped its first row, `UVXY` |

**The first pass's `20220606` conclusion was wrong, and the second pass is what
shows it.** The first pass found one capture whose first ticker read `BOIL`
where the other eleven read `GOVX`, and corrected it to `GOVX` — the
substitution signature. But the substitution signature only means "a misread"
when the differing capture is an **outlier**. The pixels show the readings are
**six / three / three**, not eleven / one: so the odd ones out are a *panel*,
not a mistake. Reading the frames settled it — the date shows three different
position lists.

**That is the general lesson, and it is the reason the audit was widened.** A
ground truth checked only against itself proves nothing; it has to be checked
against **a sibling capture that disagrees**. Widening the audit from 26 to 48
captures is what turned "one capture looks odd" into "nine captures look odd,
and they agree with each other in two groups".

**A dropped row and a partial reading both hide behind a correct-looking
count.** `20220318`'s capture 0 held 7 tickers against a panel that counts 8,
and `20220427`'s captures 8 and 9 held ONE ticker each — because they recorded
what the **OCR returned for a crop** ("Only BOIL in crop", "Only KOLD in crop"
in the original review notes), not what the panel showed. The count invariant
catches the first only because the panel's own footer was read independently;
it catches the second not at all, because a one-ticker reading of an eight-row
panel is a *consistent* misreading of the crop.

**The phantom tickers have a provenance.** `DIDI` and `NUZE` are in **no**
positions panel in the corpus — and `DIDI` *is* a real symbol in the corpus: it
sits in the **upper watchlist** widget of the 20220318 capture (`27 of 30 Items
in WatchList`), a watchlist entry rather than a position. So it is a reading of
something real taken from the wrong widget; `NUZE` is not in any reading at all.

**Third pass (the wave-2 pass) — 39 more captures, 21 more dates, three dates
moved:**

| date | union before | union after | what moved |
|---|---|---|---|
| `20220331` | 8 | **9** | `NEM` was dropped from the reading; the panel counts nine |
| `20220517` | 7 | **8** | `AVGO` was dropped; three frames of the video read eight rows |
| `20220608` | 9 | **12** | the date was a **copied column** — captures 1 and 2 really hold eleven rows |

`20220421` moved too, but only its **capture 2**: the ground truth gave it
capture 1's fifteen rows, and the anchor frame reads fourteen. The date's union
did not move, because `FTNT` is still in capture 1.

### The anchoring rule — where a capture's reading comes from

A capture's ground truth is **anchored to the frame the hand reading was taken
from**, and that frame is recorded in the tracked review page
`tools/qmg_snapshot_review.html`, whose rows carry the run, the file, the
capture's timestamp and the reading. Every wave-2 correction was checked
against that anchor:

```text
the ground truth's value for capture N must equal the reading of the
frame the review page names for capture N
```

A value that matches **exactly one** available frame is right. A value that
matches **no** available frame is a misreading. A value that matches several
frames is only as good as the anchor's run, because the list changes inside the
session.

**This rule reverted three of the audit's own tentative corrections.** Each was
a real difference from the frame that happened to be nearest to hand, and each
was wrong:

| tentative correction | why it was reverted |
|---|---|
| add `GUSH` to `20220412` | the anchor is the `qmg-lowcpu-test` run's only frame (clock 15:19), which reads the ground truth's eleven rows exactly. A twelve-row frame carrying `GUSH` exists at t=936 s of the same video, but that is a **later** moment (15:34) |
| remove `KOLD` from `20220419` | the anchor is `qmg-1080p-batch1` at t=288 s (clock 15:33), which reads fourteen rows **including** `KOLD`. The list changed twice during the session — thirteen rows without `KOLD` at 15:39, fourteen with it again at 15:55 |
| drop `AERC` from `20220608` c0 | the anchor is `qmg-1080p-batch1`'s `.png` (clock 15:32), which reads nine rows including `AERC`; its `_2` and `_3` (16:04 and 16:14) read the eleven-row list |

**The batch1 run is the anchor for the 2022-era dates**, and its frames are
recoverable: the timestamps in the review page index the 1080p videos directly,
so any anchor frame can be re-extracted with ffmpeg and read again. The
corpus snapshots are a *corroboration* of the anchor, not the anchor itself —
which is why a corpus snapshot that disagrees with the anchor loses.

### The copied column, found a second time — `20220608`

The wave-1 audit found a related class on `20220606` (three different panels under
one list). The wave-2 pass found the **copied column proper** in `20220608`:
the hand reading had given **all three captures the same nine rows**, and the
panel's own footer says the second and third frames hold **eleven**.

| capture | anchor | clock | rows |
|---|---|---|---|
| 0 | `qmg-1080p-batch1` `.png` | 15:32 | 9 — `SIGA, TNA, VLO, UCO, NFLX, ALB, BOIL, LTHM, AERC` |
| 1 | `qmg-1080p-batch1` `_2` | 16:04 | 11 — `RBLX, COIN, BOIL, NFLX, LTHM, TQQQ, UCO, ALB, VLO, TNA, AERC` |
| 2 | `qmg-1080p-batch1` `_3` | 16:14 | 11 — the same eleven |

`SIGA` was closed and `RBLX`, `COIN` and `TQQQ` were opened during the
session. Two frames of the same moment agree on the eleven rows, so capture 2
is not a copy of capture 0 either — which is what makes a *copy* provable:
one repeated column, three different readings.

**The count invariant is what exposed it, and only the count invariant can.**
Every one of the three readings is internally consistent and each one satisfies
`panel_count == |tickers|` — but the hand reading satisfied it for the wrong
frame. The footer is the only part of the panel that says how many rows there
are, and it says it per frame.

### The count invariant is PER-CAPTURE, not per-date

The position list changes **during** the session, so a date's captures can hold
different numbers of rows, and the count check applies to each capture
separately. Measured in wave 2:

| date | capture 0 | capture 1 | capture 2 |
|---|---|---|---|
| `20220421` | 16 rows (15:57) | 15 rows (15:32) | 14 rows (15:27) |
| `20220419` | 14 rows (15:33) | 13 rows (15:39) | 14 rows (15:55) |
| `20220428` | 4 rows | 4 rows | 4 rows |
| `20220608` | 9 rows | 11 rows | 11 rows |

`20220421` is the clearest case: the list **grew** during the session — fourteen
rows at 15:27, fifteen at 15:32 (`FTNT` opened), sixteen at 15:57 (`UCO`
opened) — so a fifteen-row frame is evidence about capture 1 and not about
capture 2. And the capture **indices run backwards in wall-clock time** for
this date: capture 0 is the latest frame and capture 2 the earliest, because
the index counts the run's snapshot files, not the session.

### The table is sorted by % Change, so the ORDER is not the reading

The 2023-era right-sidebar table sorts its rows by `% Change`, and the sort
**re-orders as the day moves**. Measured on `20230523`: three of the six
available frames carry the same eleven holdings in a different order, and the
panel counts eleven in every one of them.

```text
frame 0   QBTS LI SOUN IMGN FTCH MNDY APLD PLTR DNA AI  CVNA
frame 3   QBTS FTCH DNA AI  SOUN PLTR APLD IMGN MNDY LI  CVNA
```

The **set** is identical. So the check compares holdings as **sets**, and a
hand reading that happens to preserve the panel's row order is not more
correct than one that does not — the row order is a property of the sort, not
of the portfolio.

That is also why `20230608`'s ground truth was correct with its thirteen
holdings in a different order than the frame's, and why the checker's
`sameTickers()` compares sorted sets.

### "Personal" in the footer does NOT identify the table (confirmed again)

The wave-2 pass hit the same trap in a new place. The `20221117` capture 2
frame carries an **upper** widget that reads `0 Items in Personal WatchList`
while the positions table below it reads `2 of 6 Items in Personal WatchList`.
Both widgets say "Personal WatchList"; the upper one is the watchlist.

So the count invariant cannot say *which* widget a reading came from — the
wrong widget prints its own count just as faithfully. The positions table is
identified by its **title** (`A - Positions`, often clipped to `A - Positio`,
`A - Posit` or `A -`) and by being the **bottom-most** table in the region.
Every manifest case records the widget it was read from (`panel: "positions"`),
and the checker enforces it.

### The tooling

| file | what it does |
|---|---|
| `tools/buildGroundTruthFixtures.js` | cuts the fixture crops from the corpus and writes the manifest |
| `tools/checkGroundTruthConsistency.js` | checks the ground truth against the manifest, the panel counts and the footers |
| `test/qmgGroundTruthProvenance.test.js` | pins the checker, and proves it has teeth |

The fixture set is **135 crops** of the panel — showing the ticker column AND
the footer — md5-pinned in `test/fixtures/qmg_ground_truth/manifest.json`, with
each source snapshot's own md5 recorded so a changed corpus frame is caught.
(It was 94 when this section was written; the count below is the wave-2
figure, and the current one is whatever the checker prints.)

```bash
node tools/checkGroundTruthConsistency.js
node tools/checkGroundTruthConsistency.js --json
node --test test/qmgGroundTruthProvenance.test.js
```

**94 of 104 captures across 40 of 42 dates are pinned.** Every date the replay
tool can score is now pinned — the **10** captures still unpinned are the two
*annotated duplicate* keys, which no probe log can match and which carry the
same readings as the dates they are labelled with.

The wave-2 cases are **generated from a table** (`C:/tmp/spxl/gen_cases.js`
during the session) rather than hand-written, so a reading, its panel count and
its footer text cannot drift apart: the generator emits all three into
`tools/buildGroundTruthFixtures.js` from one row.

**The set is now 135 crops across 52 of 56 dates (2026-11-06).** Twelve
dates were added that had never been scanned at all — the January and
February 2022 uploads, downloaded and scanned the same day. The numbers
in this section's tables are the wave-2 figures; the current count is
whatever `node tools/checkGroundTruthConsistency.js` prints.

#### A date whose panel is EMPTY is a reading, not a gap (2026-11-06)

`20220128` is the corpus's first date with **no holdings at all**: the
"A - Positions" panel shows its header row — Flag, Sym, % Change, Pre
Buzz — and no data rows, in all three captures, with the footer
**"0 Items in Personal WatchList"**. `20220131` is the next smallest, one
row (`TQQQ`) with **"1 Item in Personal WatchList"** — the singular
follows the total — and its earliest frame is empty too.

**These are worth pinning precisely because they are empty.** A date with
no holdings is the only kind of date on which **every** published ticker
is provably a false positive, so it is the sharpest possible test of the
chart-ink filters. The scan published `SYM` and `X` on `20220128` and
`MDB`, `U` and `X` on `20220131`; all of them are chart ink or rows of
the watchlist widget above the table.

**But the replay cannot score such a date.** Its ground truth is the
empty union, so its denominator is zero and `tools/evalParserReplay.js`
omits it from the per-date table entirely — a date that contributes
nothing to the numerator *or* the denominator cannot move a micro
average. Its value is therefore in the **pinned fixture and the
checker**, not in the recall number, and a reader who expects an empty
date to show up as `0/0` in the replay output will not find it.

#### Reading the PUBLISHED list names the wrong mechanism — read the OCR WORDS

`20220211` published `TSM`, a seed ticker Qullamaggie has never held, at
the row the panel shows as `TSLA`. The obvious reading of that is the one
§ *The LI row* already records: a garbled form that is **itself a real
ticker** cannot go in the shared table, so this needs a **date-scoped**
table like `U -> LI` or `NFU -> NFLX`.

**That reading is wrong, and the log says so.** The raw OCR token is not
`TSM` — it is **`TSU`**, the `LA` of `TSLA` merged into one `U` glyph, at
left 714 against the column's `dominant_left` 715, conf 0.988 and 0.960
on the two captures. `TSM` is what the **distance-1 repair** made of it:

| | |
|---|---|
| `d(TSU, TSM)` | **1** — and `TSM` is in the seed, so the repair took it |
| `d(TSU, TSLA)` | **2** — so the repair could never have reached the truth |

`TSU` is in **neither** lexicon, so `TSU -> TSLA` is a legal **shared**
row: no new era key, no new CSV, no new date window. The scoped-table
reasoning was about `TSM`, which is not the key.

**The general rule: a false positive names the REPAIR's output, not the
read.** Before proposing an alias row for a wrong holding, find the token
in `ocr_words` — the row that must be keyed is the one the engine
actually produced. `NOS -> MOS` came out of the same inspection: `"NOs"`
sits dead on the column (left 713–716 against `dominant_left` 713–716) on
**eight** dates, and `MOS` is a ground-truth holding on every one of
them; its price cell did not parse, so it fell out of the price-aligned
subset and the column gate rejected it **before** the repair pass could
see it. The curated rescue is the only path that reaches that cell.

#### A missing lexicon row publishes a WRONG holding, not a miss

Three holdings on these dates were in no lexicon, and only one of them
cost anything — which is the measurement, not an argument:

| ticker | what it is | what its absence cost |
|---|---|---|
| `XOP` | SPDR oil & gas exploration ETF | **a wrong holding**: `XOP` is one edit from `XOM`, which IS a seed ticker, so the repair published `XOM` on `20220204`, `20220207` and `20220208`. `XOM` is in **no** ground-truth capture anywhere in the corpus |
| `KRBN` | KraneShares Global Carbon ETF | **nothing** — it is price-aligned inside the column, so the accept path already took it verbatim |
| `DCFC` | Tritium DCFC Ltd (NASDAQ 2022-01-14 → the 2024 delisting, then OTC as `DCFCQ`) | **nothing**, same reason |

`DCFC` is worth a note of its own: **no provider returns an exact `DCFC`
today**, because the company was delisted and moved to `DCFCQ`. Yahoo,
TradingView and Stocktwits all return only `DCFCQ`/`DCFBS`. A ticker that
cannot be resolved against a present-day provider is **not** evidence
that the panel is misread — the corpus is 2022, and the panel is the
primary source.

All three were seeded anyway, because the seed is the **ALLOW** list: an
unseeded holding is one repair away from being published as a neighbour,
which is exactly what `XOP` was. Measured over the wide corpus the three
rows are **+3 hits and −3 false positives**, all of them `XOM → XOP`.

The checker has seven teeth, each tested by perturbing a copy of the inputs: a
misread ticker in the ground truth (`gt-disagrees`), a wrong panel count
(`footer-disagrees`), a replaced fixture (`fixture-md5`), a missing capture
(`gt-missing`), a reading off the wrong widget (`wrong-panel`), a duplicate
top-level key (`duplicate-key`), and a ground truth that is not valid JSON at
all (`gt-unparsable` — the checker reports it rather than throwing).

### The file shipped with 24 duplicate top-level keys

The ground truth as committed had **69 top-level key lines for 45 distinct
keys** (43 dates, `_notes` and `_meta`): **24 of those keys appeared twice**, in
two blocks appended in different styles.

**`JSON.parse` does not treat a duplicate key as an error.** It keeps the last
occurrence and says nothing, so every reader of the file — the replay tool, the
checker, any ad-hoc script — saw exactly one value, and the other copy was
invisible to all of them.

The two copies of each duplicated date **happened to carry identical parsed
values** (verified by parsing each occurrence's raw block and comparing the
results, not by comparing text — the two styles differ in formatting, so a
text comparison reports 24 false differences). So nothing was ever silently
overridden, and the before/after attribution in this section stands.

**It was luck, not design.** The next append need not have agreed, and a
quarter of the corpus being one append away from being silently replaced is
not a state worth keeping. The current file has **45 key lines, 45 distinct
keys and zero duplicates**, and the checker enforces it by reading the **raw
text** — the duplicate-key rule is the one check `JSON.parse` cannot perform.

### Two annotated duplicate keys

The ground truth carries two keys that are **not dates**:

```text
"20220323 (batch t=1020s)"
"20220428 (batch t=1300s)"
```

They are the same captures of the same video under a label. No probe log can
match them — the log date keys are `YYYYMMDD` — so they are inert, and the
replay tool's census filter (`/^\d{8}$/`) already excludes them. The checker
counts and reports them separately rather than quietly dropping them.

These are **not** duplicates in the JSON sense — they are two distinct keys,
each of which occurs once. They are a *different* problem from the 24 real
duplicates above, and the two are counted separately on purpose.

### What the corrections did to the numbers

| ground truth | default roots | wide corpus |
|---|---|---|
| before the audit | 79.8 % (71/89) / 95.9 % | 68.8 % (117/170) / 83.6 % |
| after the first pass | 84.7 % (72/85) / 97.3 % | 72.1 % (119/165) / 85.0 % |
| after the second pass | 84.7 % (72/85) / 97.3 % | 71.3 % (119/167) / 85.0 % |
| after the third pass (wave 2) | **84.7 % (72/85) / 97.3 %** | **71.4 % (120/168) / 85.7 %** |

**A corrected ground truth moves the denominator in both directions**, and the
precision rise is the denominator growing, not the false-positive count
falling: the audit removed phantom holdings (`BOIL`, `NDGU`, `DCX`, and six
watchlist symbols) and added real ones (`CVNA`, `UCO`, `GUSH`, `ERX`, `X`,
`RSX`, and the 20221104 capture).

The last two first-pass fixes — `BOIL` → `GOVX` and the missing 20221104
capture — moved the wide corpus from **119/166 = 71.7 %** to **119/165 =
72.1 %** with the hit count unchanged: the phantom `BOIL` had been in the
denominator, and could have been "hit" by a `BOIL` prediction. No prediction
ever produced one.

**The second pass moved the wide corpus's denominator UP by two and its hit
count not at all** — 119/165 → 119/167. The two new denominator entries are
`BOIL` and `SIGA` on 20220606, and 20220606's own logs score **0 of 10** on
that date (a pre-existing weakness in those logs, not a regression). The
second pass also added `DIDI`/`NUZE`'s replacement holdings — `KWEB`, `WEAT`,
`NEM`, `JNUG`, `URA` on 20220321 and `KWEB`, `CWEB` on 20220427 — and those
dates are not in the wide corpus's scored set either.

**None of the five corrected dates is in the default 8-root set**, which is why
that number did not move at all. A ground-truth correction that touches only
dates outside the sample is invisible in the sample's score — which is exactly
why the number must always be quoted with the ground truth it was measured
against.

**The third pass moved the wide corpus by exactly one hit, and it moved it
because the ground truth was wrong in the parser's favour.** The only scored
date wave 2 touched was `20220331`: the panel holds **nine** rows, the ground
truth said eight (it had dropped `NEM`), and the parser was **already**
predicting `NEM`. So the hit count went 5 → 6 and the denominator 8 → 9 — the
old ground truth was counting a **correct reading as a false positive**.

The other two changed dates (`20220517`, `20220608`) are `scored: false` — their
logs carry no `ocr_words`, so they do not reach the scorer at all and cannot
move the number however they are corrected. That is the surviving-sample
problem in its sharpest form: **a correction to a date the sampler cannot
reach changes the ground truth and not the score.**

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

The current figures (re-measured 2026-11-02, after the curated-alias
rescue, the SPXL seed fix, the nine 2023-era curated aliases, the left-edge
column fix, all three passes of the ground-truth audit, **the Filter B
rewrite**, the four 2022-era alias rows, the 16 pixel-verified seed rows,
**the five 2026-11-02 alias rows**, **the column gate's row-stack evidence**
and **the one-glyph column rule** — and **unchanged by the sixth 2026-11-02
alias row**, which came out of a production scan and not the corpus):

| root set | dates scored | recall | precision |
|---|---|---|---|
| default (8 probe roots) | 8 | **97.6 %** (83/85) | **100 %** (83/83) |
| `data/video_ocr_probe` + `data/video_scan_test/_rerun` | 17 | **88.1 %** (148/168) | **89.2 %** (148/166) |

(The attribution of every step is in § 'Filter B — the position-aware vertical
bound': the Filter B rewrite is +5 hits on each corpus, the four alias rows
are +4 on the wide corpus, the 16 seed rows are +2 on each, and the two
2026-11-02 rows are +1 on the wide corpus — see § 'Two more curated aliases'.
The `LI`/`FTCH` rows are +2 on **each** corpus and the `N → AI` row is +1 on
each — see § 'The LI row, and three more aliases'. The **column gate's row-stack
evidence** is +12 hits on the wide corpus and +0 on the default roots, and the
**one-glyph rule** is +0 hits and −1 false positive — see § 'The column gate —
price-alignment was the wrong evidence'. The `RGN → RGTI` row is **+0 on both
corpora**, because the corpus contains no `RGN` — see § *The 2023-era production
smoke scan*.)

(Before the nine 2023-era aliases: 66.3 % (59/89) / 95.2 % (59/62) on the default roots,
and 64.7 % (110/170) / 82.1 % (110/134) on the wide corpus. See § 'Nine more curated
aliases' and § 'The column test'. The jump from 79.8 % to 84.7 % is the ground-truth
audit, not a parser change — see § 'The Qullamaggie ground truth, verified against its
pixels'.)

**A number measured against a wrong ground truth is a number about the ground
truth.** The audit moved the default-roots denominator from 89 to 85 and the wide
one from 170 to 165, so the recall figures before and after it are not
comparable unless the ground truth is the same.

**The second pass of the ground-truth audit moved the wide corpus the same
way, and for the same reason** — 119/165 → 119/167, two more denominator
entries (`BOIL` and `SIGA` on 20220606) and no new hits. The hit count did not
move because 20220606's logs score 0 of 10 on that date, which is a weakness in
those logs rather than in the parser. **The default 8-root number did not move
at all**, because none of the five corrected dates is in that set.

**The third pass moved it in the opposite direction, and by one hit** —
119/167 → 120/168 on the wide corpus, the default roots unchanged. The single
hit is `20220331`'s `NEM`: the panel holds nine rows, the old ground truth said
eight, and the parser had been predicting `NEM` all along — so the ground truth
was counting a correct reading as a false positive. The two other changed
dates are not reachable by the sampler at all, so they cannot move the number.

**So a score has TWO denominators, and both of them decay.** The first is the
corpus the logs can reach; the second is the ground truth the score is measured
against. Quoting a recall without both is quoting a number whose meaning
changes every time either does.

`test/evalParserReplay.test.js` pins the *methodology* on synthetic fixtures —
the real corpus is untracked, so a test asserting the real numbers would fail
on a fresh clone.

**Do not quote the replay number without its census.** `node
tools/evalParserReplay.js --json` prints it in machine-readable form.

---

## The video-level reading — `merged_position_list`, and the three arms that measure it

`merged_position_list` is the **video-level** consensus: the multi-frame
clusterer's reading of a whole video. It is what the production consumers read
(`tools/runQmgOcrBatch.js:143` and `tools/aggregateScanResults.js`), and it is
a **different artifact** from the per-capture reading
(`capture.chart_stream.position_list`) that the aggregator reads for a single
frame.

**The two have disagreed three times on record**, and every disagreement is
invisible to a capture-level metric:

| date | the merged list had | the capture list had | what it was |
|---|---|---|---|
| 20230609 | `REGN` | `RGTI` | a garble (`Rgn`) repaired to the WRONG seed ticker |
| 20230523 | `AI` | `LI` | a real holding **absorbed** by a one-edit neighbour |
| 20230605 | `AAPL` | — | a garbage reading **promoted** to a seed ticker |

The third is the worst kind: `AAPL` appears in **no** capture's reading of that
video at all. § *The clusterer's canonical selection* below is about it.

**So the merged list has to be scored, not just the captures.** The number
§ *The replay tool is a surviving sample* reports is a **capture-level**
number — it scores what a single frame's parser read. `tools/evalParserReplay.js`
therefore reports three **video-level** arms beside it:

| arm | what it reads |
|---|---|
| `recorded` | the log's own `merged_position_list`, verbatim — what production published |
| `rebuilt` | the **current** clusterer over the log's recorded per-frame readings |
| `rebuilt_current` | the **current** parser end to end over the captures the log kept |

`rebuilt` and `rebuilt_current` differ in one thing: **the clusterer's input**.
`rebuilt` clusters the **readings** the log recorded; `rebuilt_current` re-parses
the log's `ocr_words` with the current parser and clusters **those**. So
`rebuilt` isolates the **cluster rule**, and `rebuilt_current` measures the
whole pipeline.

**A null is not a zero.** A log that cannot support an arm's reading — no
`merged_position_list`, no per-frame readings, no `ocr_words` — is reported as
**unmeasured** in that arm and does not enter its denominator. An arm that
reported zero for a date it could not read would look like a total failure
rather than an absence.

**The census says where the arms' inputs came from**, because the corpus is
untracked and a reader cannot otherwise tell: `logsWithRecordedClusterInput`,
`logsWithFrameReadingFallback`, `logsWithNoClusterInput`.

**`cluster_input` post-dates every captured log**, so the `rebuilt` arm runs on
the **fallback** — the log's own per-frame readings — over the whole corpus.
That fallback is the readings of the **selected** captures, not of every
candidate frame the clusterer originally ran on, so `rebuilt` measures the
cluster rule over a slightly different input than production used. It is the
best available, and the census labels it.

---

## The clusterer's canonical selection — and the three ways it can be wrong

`clusterRawOcrTokens` (`src/parse/parseChartStream.js`) names **one canonical
per cluster** of garbled tokens, and that name is what the merged list
publishes. A canonical that is **a member** of the cluster is a *reading*. A
canonical that is **not** a member is a *correction* — the clusterer naming a
ticker that no frame of the video read.

**The shipped rule, in order:**

1. **Strategy 1** — a member that IS a lexicon ticker is the canonical.
2. **Strategy 2** — otherwise, the FIRST member of 4+ characters whose closest
   lexicon ticker shares **two prefix characters**.
3. **Strategy 3** — otherwise, the FIRST member of exactly 3 characters whose
   closest lexicon ticker is within **edit distance 1**.
4. The blocklist, then **Filter A** (the cluster must span N distinct frames).

Strategies 2 and 3 walk the members **in order** and commit to the **first**
correction they find. That is a **member-order** decision, not a similarity
decision.

### The measured instance: `{AACO, ARCO}` → `AAPL`

On 20230605 the merged list had **12** entries against a ground truth of 11.
`AAPL` was the only false positive, and it came from this cluster:

```jsonc
{ "canonical": "AAPL", "members": ["AACO", "ARCO"], "frequency": 2 }
```

`AAPL` is in **no** capture's reading of that video. The arithmetic — **measured,
not assumed**:

| member | candidate | distance | the video read it? |
|---|---|---|---|
| `AACO` | `AAPL` (C→P, O→L) | **2** | **no** — 0 frames |
| `AACO` | `AAL` | **2** | **no** — 0 frames |
| `ARCO` | `ARQQ` (C→Q, O→Q) | **2** | **yes — 6 frames** |
| `ARCO` | `ARKG` | **2** | **no** — 0 frames |

**Every candidate is TWO edits away.** So "closest" does not discriminate
between them at all: `AACO` sorts first, `findCloseTickerMatch` names
`AAPL` for it (the tie between `AAPL` and `AAL` is broken by "prefer the
longer ticker"), and the merged list publishes a holding the video never
showed.

> **The arithmetic is the whole story, and it is easy to get wrong.**
> `ARCO → ARQQ` is **two** substitutions (`C→Q` and `O→Q`), not one. A
> "prefer the closest correction" rule therefore **ties** on this instance
> and changes nothing — it keeps the earlier member's answer. An earlier
> draft of this work was built on the one-edit reading and measured a tie,
> not a win.

**What DOES discriminate is the video's own reading.** `ARQQ` was read in six
of that video's frames; `AAPL` in none. And `ARQQ` has its **own cluster** in
the same log (`{canonical: "ARQQ", members: ["ARQQ"], frequency: 6}`) — so
dropping the garbled cluster does **not** lose the holding, and resolving the
garbled cluster *to* `ARQQ` does not double-count it either.

### Two cures, and they are not the same cure

| rule | what it does to the instance |
|---|---|
| `corroborated` | a corrected canonical must be within edit distance 1 of some member, or the cluster is **DISCARDED**. `AAPL` is 2 edits from every member → the cluster is dropped, `AAPL` never reaches the merged list, and `ARQQ` still comes from its own cluster. |
| `supported` | the canonical is the correction the **video actually read**, breaking ties between equally-close candidates. The tie between `AAPL` and `ARQQ` is broken by support → `ARQQ`. |

`supported` is strictly more general: where the garbled cluster is the
**only** carrier of a holding, `corroborated` loses the holding and
`supported` recovers it.

**The two SUPPORTED rules differ in how they rank support against distance**,
and the corpus measurement is what decides between them:

| rule | ordering | what it changes |
|---|---|---|
| `supported` | **distance first**, support breaks a tie | only moves a cluster when two candidates are *equally* close — the conservative ordering |
| `video-supported` | **support first**, whatever the distance | can move a cluster off a correct one-glyph correction onto a farther candidate the video did read |

**Both SUPPORTED rules compete ACROSS the cluster's members, not within one.**
The shipped rule commits to the **first** member that yields a correction and
never looks at the others. Both supported rules consider **every** member's
corrections, so a later member's candidate can win — which is the whole point
on the measured instance, because `ARCO` is the member the shipped rule skipped.

**The candidate set is per-member minimum distance.** A member's candidates are
the tickers at **its own** minimum distance (the distance `findCloseTickerMatch`
would have found), subject to the same admissibility test the shipped rule
applies. A candidate further away than that is not that member's correction at
all.

**So the supported rule needs ALL of a member's candidates, not the one
`findCloseTickerMatch` returns.** That helper names **one** ticker per member,
and which one it names is decided by a tie-break ("prefer the longer ticker")
over candidates that are *equally* close — so `ARCO`'s two-edit candidates
`ARQQ` and `ARKG` are reduced to whichever the lexicon lists first, and the
one the video corroborates never enters the comparison at all.

**The names are the same in the measurement and in production**, so they cannot
drift apart:

| name | replay | scan tool | batch runner |
|---|---|---|---|
| `shipped` | `--cluster-rule shipped` | `--no-cluster-corroboration --no-cluster-swallowed-holdings` | `--cluster-rule shipped` |
| `corroborated` | `--cluster-rule corroborated` | `--no-cluster-swallowed-holdings` | `--cluster-rule corroborated` |
| `corroborated-strict` | `--cluster-rule corroborated-strict` | `--cluster-strict-corroboration --no-cluster-swallowed-holdings` | `--cluster-rule corroborated-strict` |
| `supported` | `--cluster-rule supported` | `--cluster-supported --no-cluster-corroboration --no-cluster-swallowed-holdings` | `--cluster-rule supported` |
| `supported+corroborated` | `--cluster-rule supported+corroborated` | `--cluster-supported --no-cluster-swallowed-holdings` | `--cluster-rule supported+corroborated` |
| `video-supported` | `--cluster-rule video-supported` | `--cluster-video-supported --no-cluster-corroboration --no-cluster-swallowed-holdings` | `--cluster-rule video-supported` |
| `video-supported+corroborated` | `--cluster-rule video-supported+corroborated` | `--cluster-video-supported --no-cluster-swallowed-holdings` | `--cluster-rule video-supported+corroborated` |
| `swallowed` | `--cluster-rule swallowed` | `--cluster-swallowed-holdings --no-cluster-corroboration` | `--cluster-rule swallowed` |
| `corroborated+swallowed` | `--cluster-rule corroborated+swallowed` | `--cluster-swallowed-holdings` | `--cluster-rule corroborated+swallowed` |

**`corroborated+swallowed` is the default** (changed 2026-11-04) — it is the
corroboration rule plus the measured threshold-4 recovery for a second lexicon
ticker swallowed by a cluster. The other rules are OFF, because each one
changes which holdings a scan publishes, and a wider measurement has to say
otherwise first. Use `--no-cluster-swallowed-holdings` / `--cluster-rule
corroborated` to reproduce corroborated-only output.

### What the supported rule actually changes

**The corroboration gate also accepts a canonical the video read.** A
correction two edits from every member of its cluster fails the distance-1
test, but a ticker the video read in six other frames is corroborated by the
video, which is stronger evidence than proximity. `ARQQ` is exactly that case.
Whether that counts is measured apart: `corroborated-strict` demands the
proximity test alone.

### The measurement — and it decides against three of the four rules

**The corpus replay and the production output measure different things, and
the production output is the one that decides.** The replay's `rebuilt` arm
clusters the log's **selected** captures; production clusters **every** OCR'd
candidate frame. The 20230605 log's own cluster table says its tokens
appeared in **12** frames, and the log carries **3** distinct readings — so
the replay cannot reproduce production's clusters. The production audit works
on the recorded cluster tables instead, which is what production actually
formed.

**The corpus replay** (`node tools/evalParserReplay.js --cluster-rule X`,
both corpora, `rebuilt` arm — hit / ground-truth / predicted):

| rule | default corpus | wide corpus |
|---|---|---|
| `shipped` | 69/281/114 — 24.6 % / 60.5 % | 197/332/300 — 59.3 % / 65.7 % |
| `corroborated` | **69/281/112** — 24.6 % / **61.6 %** | **197/332/294** — 59.3 % / **67.0 %** |
| `corroborated-strict` | 69/281/112 — 24.6 % / 61.6 % | 197/332/294 — 59.3 % / 67.0 % |
| `supported` | 69/281/**116** — 24.6 % / 59.5 % | 197/332/**304** — 59.3 % / 64.8 % |
| `supported+corroborated` | 69/281/112 — 24.6 % / 61.6 % | 197/332/295 — 59.3 % / 66.8 % |
| `video-supported` | 69/281/116 — 24.6 % / 59.5 % | 197/332/304 — 59.3 % / 64.8 % |
| `video-supported+corroborated` | 69/281/112 — 24.6 % / 61.6 % | 197/332/295 — 59.3 % / 66.8 % |

**The `rebuilt` arm's denominator is NOT the capture-level one, and the
absolute recall figures above are not comparable to the capture-level
numbers.** The `rebuilt` arm reaches **33 dates** on the default corpus and
**39** on the wide one, against the capture level's **8** and **17** — it
reads the log's per-frame readings, which exist for logs the capture level
cannot use. Its ground truth is therefore 281 and 332, not 85 and 168. The
numbers are comparable **across the rules** (same dates, same denominator)
and that is what the table is for.

**The hit count NEVER moves.** Every rule finds the same holdings; only the
number of predictions changes. So the question is purely about false
positives, and:

- `corroborated` **removes** false positives (−2 default, −6 wide) and loses
  nothing.
- `supported` and `video-supported` **ADD** false positives (+2 default,
  +4 wide) and gain nothing. On 20230605 the `supported` rule turns one
  false positive (`AR`) into **three** (`AR`, `DASH`, `IONQ`).

**The per-date diff says where**, and it is the same story in every case —
the supported rules *swap one wrong ticker for another*:

| date | shipped | `supported` |
|---|---|---|
| 20230523 | fp `[]` | fp `[OKTA]` |
| 20220607 | fp `[… FANG …]` | fp `[… RIOT …]` |
| 20230605 | fp `[AR]` | fp `[AR, DASH, IONQ]` |

**So the supported rules are a measured NEGATIVE result.** The video's
support is a good tie-break, but it is not a good *primary* key: preferring
the most-supported candidate moves a cluster onto a ticker the video read as
chart ink rather than onto the ticker it held.

### The swallowed holding — the LAST known defect, and its measured cure

The clusterer names **one** canonical per cluster. When a cluster holds two
**distinct** lexicon tickers that are one edit apart, the second is
**swallowed** — and on 20230522/20230523 the swallowed one is `LI`, a real
holding of those videos:

```jsonc
{ "canonical": "AI", "members": ["AI", "LI"], "frequency": 7 }
```

`AI` and `LI` are both holdings of that video. They are one edit apart, so
the clusterer merged them and published `AI`; `LI` was never published at
all. The merged list for 20230523 has 10 hits against 11 holdings, and `LI`
is the one missing.

**The census is small and exact.** Over every recorded production log, five
clusters swallow a second lexicon ticker:

| date | canonical | swallowed | a real holding? | cluster frequency |
|---|---|---|---|---|
| 20230522 | `AI` | `LI` | **YES** | **15** |
| 20230523 | `AI` | `LI` | **YES** | **7** |
| 20220607 | `NFLX` | `NFU` | no | **3** |
| 20220607 | `NFLX` | `NFU` | no | 3 |
| 20220607 | `NFLX` | `NFU` | no | 3 |

**Both `LI` and `NFU` are real tickers** (`LI` = Li Auto, `NFU` = Neogen
Food Safety — both in the seed lexicon), so the lexicon does not
discriminate. **The cluster frequency does**: a swallowed ticker read in
**≥ 4** frames is a real holding; one read in **≤ 3** is a one-off garble.

**The blunt cure is measured and REJECTED.** Publishing *every* lexicon
ticker in a cluster gains 5 holdings and adds **24 false positives** — the
whole damage is on 20220607, where `NFU` appears three times.

**The guarded cure is a clean win.** Publish the swallowed ticker only when
the video read it in **≥ 4** frames — its own attestation, independent of
the cluster that swallowed it:

| threshold | hits / gt | FP | hits gained | FP added |
|---|---|---|---|---|
| 1 | 71/74 | 7 | 2 | **1** |
| 2 | 71/74 | 7 | 2 | **1** |
| 3 | 71/74 | 7 | 2 | **1** |
| **4** | **71/74** | **6** | **2** | **0** |
| **5** | **71/74** | **6** | **2** | **0** |
| **6** | **71/74** | **6** | **2** | **0** |
| **7** | **71/74** | **6** | **2** | **0** |
| 8 | 70/74 | 6 | 1 | 0 |
| *shipped* | *69/74* | *6* | — | — |

**Thresholds 4–7: two holdings gained, no false positive added** — 69/74
→ 71/74 with the FP count unchanged. At ≤ 3, `NFU` slips in and adds its
false positive; at 8, one of the two `LI`s falls out.

**This is measured and shipped** (changed 2026-11-04). The corpus measurement
found thresholds 4–7 clean, and the production scan confirmed the threshold-4
guard: it recovered `LI` on 20230522 without adding a false positive, while
rejecting the one-frame `LI` noise case on 20230523. The implementation records
the swallowed ticker, its own frame count and publication decision in
`swallowedEvidence`, so the default decision is auditable. Use
`--no-cluster-swallowed-holdings` to disable it for a corroborated-only run.

#### And the production scan says the guard is exactly right

A production scan of the 2023-era dates under `corroborated+swallowed`
(`qmg-easyocr-20261103-swallowed`) — and the guard separates the two
`LI` cases on its own:

| date | `LI`'s own frames | the rule's decision | outcome |
|---|---|---|---|
| `20230522` | **4** | **PUBLISHED** | **7/7, 100 % recall, 0 FP** (the shipped rule: 6/7) |
| `20230523` | **1** | **rejected** | 10/11, 1 FP (`U`) — unchanged |

**`LI` was read in four frames of its own on 20230522 and in one on
20230523**, and the rule publishes it in exactly the first case. The
threshold of 4 is not a tuned constant — it is where the two measured
instances fall, and the clusterer records the count it judged on
(`swallowedEvidence`), so the decision is auditable.

The scan's four completed dates, scored on the **merged** list against the
pixel-verified ground truth:

| date | hits / gt | recall | FP | the shipped rule |
|---|---|---|---|---|
| `20230522` | **7 / 7** | 100 % | **0** | 6/7, 0 FP |
| `20230523` | 10 / 11 | 90.9 % | 1 (`U`) | 10/11, 1 FP (`U`) |
| `20230602` | 12 / 12 | 100 % | 1 (`IOT`) | 12/12, 1 FP (`IOT`) |
| `20230605` | 11 / 11 | 100 % | **0** | 11/11, 1 FP (`AAPL`) |
| **total** | **40 / 41** | **97.6 %** | **2** | 39/41, 3 FP |

**One more false positive removed and one more holding found, and nothing
lost.** The two FPs that remain (`U` on 20230523, `IOT` on 20230602) are
**capture-level** readings — they are in those captures' own
`position_list` — so no cluster rule can remove them.

The two dates the scan did not reach (`20230608`, `20230609`) are covered by
the `corroborated` scan, which has all six.

This is why the evidence had to travel with the cluster: the frame count
is the whole basis of the decision, and the log does not otherwise carry
the clusterer's input.

Pinned by `test/manual/clusterAbsorbedHolding.test.js` (the census),
`test/manual/clusterAbsorbedDiscriminator.test.js` (what separates a
swallowed holding from a swallowed noise token — and the answer: **not**
the lexicon, **not** "read without the canonical", but the frame count), and
`test/manual/clusterPublishBothGuarded.test.js` (the threshold sweep).
`test/manual/clusterPublishBothRule.test.js` pins the REJECTED blunt version,
so it is not re-attempted.

#### The log does NOT carry the clusterer's input

**This is the measurement caveat that governs every number above, and it is
easy to get wrong.**

The clusterer is fed **every OCR'd candidate frame** (`scanResult.candidates`,
not the selected captures). The probe log keeps the selected captures, the
top candidates and the rejected ones — each a SUMMARY. Re-clustering the
log's own frames does **not** reproduce the log's own cluster table:

| | count |
|---|---|
| logs whose cluster table the log's frames REPRODUCE exactly | **0** |
| logs whose cluster table the log's frames do NOT reproduce | 15 |
| logs with no frames at all | 37 |

One example: `20220607` — the log keeps **4** frames, and re-clustering them
gives **6** clusters against the **34** production recorded.

**So the log's frames are NOT the production input, and any measurement
built on them is measuring a different clustering than production ran.** The
cluster table is the only faithful record of what production formed.

Two consequences:

1. **The rule's numbers must come from the cluster tables**, not from
   re-clustering the log's frames. The census and the threshold sweep do
   that.
2. **A rule that needs a per-token frame count cannot be measured from the
   logs at all**, because the tables record a cluster's `frequency` — the
   SUM over its members' counts — and not each member's own count.

The second consequence is why the guard is implemented against the token's
own frame count (`tokenFrameIndices`) rather than the cluster's, and why
**the evidence now travels with the cluster**: the probe log records
`extraCanonicals` and `swallowedEvidence` (the swallowed ticker, its own
frame count, and whether it was published), so a later reader can tell
*why* one swallowed ticker was published and another was not — which they
could not do before, and could not do from the frames at all.

Pinned by `test/manual/clusterLogInputFidelity.test.js` (the fidelity
check itself) and `test/manual/clusterSwallowedOwnFrames.test.js` (the
own-frame-count measurement, which reports **zero** usable logs — the
finding that forced the evidence into the log).

**The production audit is the decisive one.** Every recorded log carries the
cluster table production actually formed, so the rule can be applied to it
directly. Over **46 logs / 2 480 clusters**:

| | snapshot (chart_stream) | whiteboard |
|---|---|---|
| clusters | 480 | 2 000 |
| readings (canonical is a member) | 153 | 364 |
| corrections | 327 | 1 636 |
| corroborated (d ≤ 1) | 143 | 792 |
| **uncorroborated (the rule would discard)** | **184** | **844** |
| …of those, false positives | 39 | 0 |
| …of those, **real holdings** | **8** | 0 |
| …of those, unknown (no ground truth) | 137 | 844 |

**And scored against the ground truth, at the level production publishes:**

| | count |
|---|---|
| published tickers the rule would drop | **1** |
| …real holdings lost | **0** |
| …false positives removed | **1** (`AAPL`, 20230605) |

**One published ticker changes, and it is the false positive the whole
exercise was for.** The 8 "real holdings" in the cluster table are each
carried by a **second, corroborated cluster** as well — `GTLB` is carried by
`[GTLB]` (a reading) *and* by `[GULE]` (the correction); `BOIL` by `[BOIL]`
and by `[MOL]`. A ticker survives the rule if **any** cluster carried it and
survived, and counting it otherwise is how the first version of this audit
wrongly reported two lost holdings.

**And that is the same conclusion the corpus replay reached** — so the two
measurements do not disagree once the accounting is right. They measure
different clusters, and both say the same thing: the rule removes a false
positive and loses no holding.

**The whiteboard branch is unaffected** — its `merged_position_list` merges
the structured GRO/TURBO holdings and never touches the clusterer
(`tools/scanVideoWithOcr.js`, `legacyConsensus` is `null` for a non-snapshot
scan). So the rule's blast radius is the chart_stream branch only.

### The decision

**`corroborated+swallowed` is the DEFAULT** (changed 2026-11-04). It is the
corroboration rule plus the threshold-4 swallowed-holding recovery: it removes
false positives and recovers the measured `LI` holding without adding a false
positive. The corroborated-only rule remains available explicitly and loses
that recovered holding.

**The measurement, on the dates the two scans SHARE** — two different scans of
different date sets cannot be compared in aggregate, so this is the
like-for-like comparison (`test/manual/corrobDefaultSafety.test.js`):

| date | shipped | corroborated | corroborated+swallowed | changed |
|---|---|---|---|---|
| `20230522` | 6/7, 0 FP | 6/7, 0 FP | **7/7, 0 FP** | `LI` recovered |
| `20230523` | 10/11, 1 FP (`U`) | 10/11, 1 FP (`U`) | 10/11, 1 FP (`U`) | — |
| `20230602` | 12/12, 1 FP (`IOT`) | 12/12, 1 FP (`IOT`) | 12/12, 1 FP (`IOT`) | — |
| `20230605` | 11/11, **1 FP (`AAPL`)** | **11/11, 0 FP** | **11/11, 0 FP** | `AAPL` removed |
| **total** | 39/41 hits, 3 FP | 39/41 hits, 2 FP | **40/41 hits, 2 FP** | **+1 hit, 0 FP added** |

The four-date production scan (`qmg-easyocr-20261103-swallowed`) measured the
same default rule's decisive change: **40/41 hits, 2 FP**, versus 39/41 and 3
FP under the pre-swallowed rule on those dates. The six-date
`qmg-easyocr-20261103-corroborated` scan remains the corroborated-only
comparison and removed the `AAPL` false positive with nothing lost.

**What it does NOT do, stated plainly:** it does **not** improve recall.
Across the corpus replay the hit count **never moves** under any rule — the
rule is a **precision** filter, not a recall one. It removes holdings the
clusterer invented; it does not find holdings the parser missed. The
recall gains in 2026 came from the **era-conditional crop** and the
**parser**, not from this rule. The rule contributed the false-positive
removal, and nothing else.

**The blast radius is the chart_stream branch only.** The whiteboard branch
merges the structured GRO/TURBO holdings and never reads the clusterer's
consensus (`legacyConsensus` is `null` for a non-snapshot scan), so the
rule cannot touch it. Every one of the 137 logs in the corpus is a snapshot
scan (`test/manual/clusterRuleBlastRadius.test.js`).

**How it is switched, and how it is switched back.** The corroboration and
swallowed-holdings rules are ON by default in `src/video/ocrScanArgs.js`:

```js
clusterCorroboration: null,       // null = "not mentioned"; corroboration ON
clusterSwallowedHoldings: true,   // threshold-4 recovery ON
```

`null` rather than `true` is used for corroboration so the flag can tell *not
mentioned* from *explicitly off*: `--no-cluster-corroboration` turns it off.
`--no-cluster-swallowed-holdings` turns off the swallowed-holdings recovery.
The scan tool records which combined rule actually ran (`cluster_rule` in the
probe log). The batch runner's `--cluster-rule shipped` passes both negative
flags, so it still means the pre-2026-11-03 behaviour.

**One implementation, three callers.** The rule's switches are resolved in
`resolveClusterRuleOptions()` and named by `clusterRuleName()` — both in
`src/parse/parseChartStream.js` — and the scan tool, the replay tool and
the batch runner all use them. They had drifted **twice** before: the replay
checked the strict flag before the supported one (so `supported+corroborated`
under the strict flag was misnamed `corroborated-strict`), and the two named
the swallowed rule differently (`swallowed+corroborated` against
`corroborated+swallowed`), which killed a scan at startup with "unknown
--cluster-rule". Pinned by `test/clusterRuleFlags.test.js`, which resolves
the batch runner's flags through the **shared** resolver — so it cannot drift
the way a copy of the logic did.

**The three supported rules are measured and rejected.** They add false
positives and recover no holdings. They stay available behind their flags,
because a rule that is wrong on this corpus could be right on another —
but nothing in the measurement argues for turning one on.
### The scan records which rule produced its merged list

```jsonc
{ "cluster_rule": "shipped", "cluster_corroboration": false,
  "cluster_supported": false, "cluster_video_supported": false }
```

so a replay can tell when a log's own merged list was made under a different
rule than the one being applied to it. The replay's census counts that
(`logsWithRecordedClusterRule`, `logsWithDifferentRecordedClusterRule`).

With a rule on, the scan also records **why a cluster was dropped**
(`cluster_dropped`), so a scan that lost a holding can say why.

Pinned by `test/chartStreamCluster.test.js` — the rules' behaviour, on a
synthetic lexicon so the arithmetic is fixed, and on the REAL decode lexicon
so a change to the seed cannot silently move the answer.

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
- **13 tickers were on TWO seed rows, and the duplicate gave them DOUBLE
  correction support** (fixed 2026-10-30). The seed lexicon is a **set** of
  tickers, and a ticker may be seeded for more than one reason — `SPCX` was
  both a "seeded recurring ETF" and a "seeded Discord recurring". The file
  recorded the two reasons on two rows, and `loadSeedLexiconSync` de-duplicated
  the set it returned — so the defect was invisible there. `loadTickerRepairConfig`
  did **not** de-duplicate, and the legacy repair scores every seed **entry**
  (`addScore(seedTokenScores, ..., 20)`), so a ticker listed twice scored 40.
  `findBestCorrection` multiplies the score by 10 while an edit costs 25, so the
  doubled score outweighed the edit distance outright: **71 correction targets
  flipped** on the duplicate rows alone. `TEM` corrected to `TEAM` instead of to
  itself; `IBIS` to `NBIS` instead of `IBIT`; `MRA` to `MRNA` instead of `URA`.

  Fixed at both ends: the 13 duplicate rows were merged into one row per ticker
  (both notes kept, joined with a semicolon), and `loadTickerRepairConfig` now
  de-duplicates like the scanner does — so the two consumers cannot drift apart
  again. The committed `data/portfolio_snapshots.csv` holdings are **unchanged**
  (re-running the repair over its own rows: 0 holdings moved), and the chart-stream
  replay numbers are unchanged (the seed was already de-duplicated there).

  Pinned by `test/lexiconVariants.test.js` ("no ticker appears on two seed rows",
  "every consumer of the seed sees the same set of tickers", "no seed ticker
  carries more than one reference score").
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
| **allow** | what may be **REPORTED** | seed only (224) |

`loadSeedLexiconSync()` is the allow list. `loadDecodeLexiconSync()` (seed +
observed) is the match lexicon. A ticker in the match set but not the allow set
is **resolved and then discarded** — the parser knows what it is and is forbidden
from reporting it. That is the intended behaviour for a ticker the seed has not
vouched for, and it is exactly how SPXL was being lost until 2026-10-30; see
§ 'SPXL' below.

**The chart-stream path uses the seed as its MATCH list**, not as an allow list
(`parseChartStream.js:570` and `:1149`), so a ticker missing from the seed is
unreachable there too — and worse than unreachable, it gets *repaired* to a
neighbouring seed ticker. SPXL was one edit from `SOXL`, so the chart-stream
parser published `SOXL` on the date Qullamaggie actually held SPXL.

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

### The fuzzy resolver was measured against the whole corpus, not just the fixtures

The fixture test covers three frames. The **fuzzy resolver** (`src/normalize/tickerFuzzyResolve.js`)
changes what the parser reads on *every* frame, so it was A/B'd over the whole cached
corpus: the same OCR fed to the pre-resolver parser and to the current one, with the frames
re-extracted so **both parsers see the same pixels** (Tesseract is not deterministic, so
comparing two independent OCR passes would mix the parser effect with OCR noise).

274 cached captures, of which **29 belong to a video with a ground truth**; 10 of those 29
changed. Scored against the ground truth:

| | count | in the ground truth |
|---|---|---|
| **added** by the new parser | 21 | **21 (100 %)** |
| **removed** by the new parser | 4 | **0 (0 %)** |

The four removals are the **action-line bleed**: on 20260924 the screen's own note reads
`TURBO RVAB: 1.51 (-2.41%/-5.52%) O-TRIM P ADD to SPXL SELL DELL SMTC` — `DELL` and
`SMTC` are what the action line *sells*, not holdings, and the old parser published them
as TURBO holdings (with `BITO` and `SHOP`). The corrected parser reads that frame as
GRO `{AMD, BE, DOCN, HPE, LITE, NCLD, P, PLTR, SKHY, SPYM, TQQQ, UPRO}` and TURBO
`{ETHA, HPE, MRNA, SPYM, UPRO}` — no false positives, where the old parser had three.

**So the resolver invents no holdings** on this corpus, and it removes exactly the
holdings the action line contributed. The additions are all real ones the old parser
missed (`IBIT` ×8, `NCLD`, `TQQQ`, `DOCN`, `LITE`, `ETHA`, `MRNA`, `PURR`, `SPYM`, `UPRO`,
`HPE`).

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
**94.0 % recall (140/149), 100 % precision**, against the recorded
88.1 % / 98.4 %.

The ground truth grew from 143 to 149 readings on 2026-10-30, because SPXL is
now listed in every TURBO list (see § *SPXL* below). Six readings were added
and five of them are read; the sixth was already being read, so the fix moved
five readings from missed to hit.

**The number went DOWN by one reading, and that is the fix working.** The
pre-fix parser read a `P` in the 20260924 GRO holdings that it should not
have: the word sits in the **action row** (the tail of `O-TRIM P`), not in the
holdings list. Removing that one word from the OCR makes the pre-fix parser
lose the `P` too — the holding list's own `MU,P` was OCRed as `AUP.` and
cannot be recovered. The pre-fix score counted the action line's `P` against
a ground truth that legitimately contains `P`, so it was flattered by a
coincidence. The post-fix parser excludes the action line by position, and
`P` is an honest OCR loss.

**A/B over the whole replayable corpus.** The probe logs do not retain word
geometry, so the re-parseable corpus is the OCR cache: 19 captures across
four videos. Run over all of it, the two parsers differ on **two** captures:

| capture | change |
|---|---|
| `fxi2xavpp-a@585` | TURBO **gains SPXL** — the fix |
| `plsp0tefisg@320` | GRO **loses P** — the action line's `P`, above |

The other 17 captures read identically. **No holding is lost anywhere else.**

The replay extracts at the same width the scan tool does
(`--ocr-frame-width`, default 1280), so it measures the pipeline and not a
different frame size.

**Tesseract is not deterministic**, so a replayed number moves slightly
between runs — that is what the OCR cache is for: two parser versions over
the *same* cached OCR is the only comparison that can attribute a difference
to the parser. The repeatable number is the fixture test's.

### SPXL — a holding the allow-list did not know (fixed 2026-10-30)

`SPXL` is in the **match** lexicon but was not in the **allow** list, so the
parser resolved it — it was an EXACT hit, not a misread — and then dropped it
at the allow-list gate (`parseWhiteboardScreenshotWithBoxes.js`, reason
`NOT_IN_ALLOWLIST`). It was also missing from **every** TURBO holdings list in
`data/revere_ground_truth.json`, although the screen shows it on all four
dates, second in the list, right after `UPRO`, and 20260924's own note reads
"ADD to SPXL".

The user confirmed the screen is right and the ground truth was wrong
(2026-10-30): **SPXL was a TURBO position on every date.** Three changes:

| change | where | why |
|---|---|---|
| `SPXL` added to the seed allow-list | `config/ticker_lexicon_seed.csv` | it is a real holding, so it may be REPORTED. The whiteboard MATCH set does not change — SPXL was already in it — so no new ambiguity is possible there |
| the ground truth lists SPXL, second in every TURBO list | `data/revere_ground_truth.json` | the ground truth is a record of what the screen showed, and the screen showed SPXL |
| the action line's words are excluded by POSITION | `findActionLine()` in the parser | see below |

**The chart-stream path was NOT untouched — it was wrong, and the seed fixed it.**
The two paths use the seed for opposite jobs: the whiteboard path uses it as the
**allow** list, but `parseChartStream.js` uses it as the **match** list (lines 570
and 1149), and SPXL was only in the *observed* lexicon (`config/ticker_lexicon_observed.csv:23`
— "observed in QMG position list 20220331"). So on the chart-stream path SPXL was
**not a match either**, and `findCloseTickerMatch('SPXL', seed)` repaired it to
**`SOXL`** — one edit away (`O`→`P`) and in the seed. Qullamaggie held SPXL on
20220331; the parser published **SOXL** instead, as a false positive on the very
date the holding was real.

Measured with `node tools/evalParserReplay.js` on the wide corpus
(`data/video_ocr_probe` + `data/video_scan_test/_rerun`), SPXL in the seed vs out:

| | hit / gt / pred | recall | precision |
|---|---|---|---|
| without SPXL | 109 / 170 / 134 | 64.1 % | 81.3 % |
| with SPXL | **110 / 170 / 134** | **64.7 %** | **82.1 %** |

Exactly **one** date changed, and it changed in both directions at once:
20220331's `SPXL` false positive became a `SPXL` hit, and the `SOXL` false
positive went away with it. The default 8-root replay is byte-identical
(59/89/62, 66.3 % / 95.2 %) either way. *(Those are the figures as of
2026-10-30; the table has since grown by nine curated aliases and the
column test has since changed, so the current default figures are 71/89,
79.8 % / 95.9 % — see § 'Nine more curated aliases' and § 'The column
test'.)*

**The seed change cannot create a new ambiguity on the whiteboard path.** The
MATCH set there is `seed + observed`, and SPXL was already in the observed half,
so the resolver's candidate set is unchanged. Enumerating every token within
one edit of any of the 249 match-list tickers (20,801 tokens): **0** had their
resolution change (status, canonical ticker, or candidate set) — 68 changed
**reportability** only, all of them one-edit neighbours of SPXL (`APXL`, `SPAL`,
`SPXA`, …) that the resolver had *already* decided was SPXL and that the allow
gate had been discarding. The fix lets through readings the resolver had made,
not readings it makes now.

**The seed has three consumers, and the blast radius was measured on each.**

| consumer | how it uses the seed | measured effect of adding SPXL |
|---|---|---|
| the whiteboard parser | the **allow** list — what may be reported | SPXL becomes reportable. 68 one-edit neighbours change reportability; **0** change resolution |
| `parseChartStream.js` (`:570`, `:1149`) | the **match** list — what a token may be | 98 repair targets shift, all one-edit neighbours of SPXL that previously repaired elsewhere (`SPXL`→`SOXL`, `SPXI`→`SOXL`, …). Measured on the corpus: one date changed, and it changed in both directions at once (a false positive became a hit) |
| `repairHoldings.js` (`src/index.js`'s legacy path) | correction candidates for the whole-panel repair | 2 corrections shift: `SPXL` itself (now exact, was `SOXL`) and `PXL` (now `SPXL`, was `PL` — both distance 1). 93 tokens that corrected to **nothing** now correct to SPXL |

The legacy path's 93 new corrections are all one-edit neighbours of SPXL
(`SPXI`, `SPXA`, `APXL`, …). A token that had **no** correction now has one,
which is a *gain* in a repair whose job is to resolve an unreadable token into
a known ticker — but it is the one place where the change creates readings
rather than letting through readings the resolver had already made.

**The action-line exclusion was the necessary second half.** The section filter
asks whether a token's TEXT appears inside the section, and that test cannot
tell the holdings line's `SPXL` from the action line's `SPXL` — a token that
appears in both places is admitted by the action line. Once SPXL became
reportable, 20260924's "ADD to SPXL" would have contributed a second one. The
action line is therefore excluded **by position**: from the `RVAB` keyword
onwards, a word is action text, and the holdings sit to the LEFT of it.

**The fusion hid the loss.** The screen writes the pair as `UPRO/SPXL`, and
on 20260924 the OCR read `UPRO/SPXLIBT` — SPXL fused with IBIT, the comma and
the `I` lost. `splitFusedTicker('SPXLIBT')` returns null (the trailing "IBT"
is ambiguous between IBIT and IOT and is never guessed), so both SPXL and
IBIT were lost. `splitFusedTickerExactPrefix()` now recovers the LEADING
ticker of such a token, because the leading part is an EXACT match — the
lexicon is asserting that this string is a ticker, which is not a guess — while
the unreadable remainder stays dropped.

Pinned by `test/parseWhiteboardHoldings.test.js` ("a holding the allow-list
did not know is reported, not dropped", "the action line's own SPXL never
contributes a second holding").

**The ground truth was verified from the pixels on all four dates.** The
screen writes `SPYM,UPRO/SPXL,...` — SPXL second, right after UPRO, on every
one of them, and GRO never held it (GRO shows `UPRO` alone). The three pinned
fixtures say the same:

| date | frame | TURBO holdings line |
|---|---|---|
| 20260922 | `test/fixtures/revere_whiteboard/20260922_ts700.png` | `SPYM,UPRO/SPXL,IBIT,ETHA,LABU,SPCX,PURR,MRNA,P,SMTC` |
| 20260924 | `test/fixtures/revere_whiteboard/20260924_ts360.png` | `SPYM,UPRO/SPXL,IBIT,ETHA,SPCX,PURR,MRNA,P,HPE` |
| 20260928 | `test/fixtures/revere_whiteboard/20260928_ts540.png` | `SPYM,UPRO/SPXL,IBIT,ETHA,SPCX,MRNA,P,HPE,SKHY` |

20260923 has **no fixture frame**; it was read from the video
(`data/video_pipeline/downloads_hires/20260923_U4dbSz0u11k.mp4`, 1918×1080 by
ffprobe) at 800 s, where the line reads
`SPYM,UPRO/SPXL,IBIT,ETHA,SPCX,PURR,MRNA,P,SMTC`.

## The Sevcik channel is read in CZECH (2026-11-05)

Everything the section above says about reading an English machine
translation is **superseded**. The channel is read as **Czech**, and the
vocabulary, the price roles and the certainty scale are all Czech.

### Why the English track was wrong

The extractor was built for English trading vocabulary and the corpus is
Czech. Measured on the 12-stream corpus (10,847 segments), the English
patterns fired on **nothing**:

| what | segments matched (English patterns) |
|---|---|
| bias | **0** |
| action | 2 ("hold") |
| horizon | **0** |
| segments with a price | 10 (of 10,847) |

And the extractor produced **2 signals from 12 videos**. It was reading
Czech and understanding none of it.

Two things caused it, and both had to be fixed:

1. **The ticker was found as a SYMBOL.** The channel's speaker says company
   **NAMES** — "Tesla", "Apple", "Amazon" — not symbols. The symbol path
   matched 25,136 tokens in the corpus and the name path matched 269.
2. **The vocabulary was English.** "bullish", "target", "stop loss",
   "going to buy" do not appear in Czech speech.

### The Czech vocabulary (measured, not guessed)

| pattern | segments | what it states |
|---|---|---|
| `do Longu` / `do Long` | 89 | **the direction** — the dominant construction |
| `do shortu` / `do Short` | 49 | the bearish construction |
| `poklesový` / `klesající` + `kanál` | 62 | a falling channel — the direction is in the slope |
| `rostoucí` + `kanál` | 4 | a rising channel |
| `kanál` | 384 | **the LEVEL** — and the thing he calls a setup |
| `odraz` | 125 | the bounce off a level |
| `zóna` | 33 | the zone |
| `podmíněný` | 14 | the conditional call |
| `úroveň` | — | the level |

**"Long" is written two ways.** The Czech audio renders it as "Long" and as
"Lon" — "to je 50 do Lon, 50 do shortu" — and the transcript carries both.
Every direction pattern accepts both spellings.

### There are NO targets and NO stops in this channel

This is the most important finding, and it is the user's own instruction
("levels, not targets — yes, that is his problem, not yours"):

| word | occurrences | what they actually are |
|---|---|---|
| `cíl` (target) | **2** | a GOAL ("aby se to uměli sami bez země"), not a price |
| `stop` | 15 | 13 are inside `stoprocentně` (one hundred percent) or a metaphor about a red button |
| `vstup` (entry) | 6 | "investiční vstup", "vstupní částky" — never a price to buy at |

So the price roles are **LEVELS**, and the role table says so. The user said
it directly: a target price he never stated must not appear in a portfolio
report.

### THE `\b` BUG — every Czech pattern was DEAD

**JS's `\b` is ASCII-based even under the `/u` flag.** It is a boundary
between a WORD character and a NON-WORD one, and "word" means
`[A-Za-z0-9_]`. So the `\b` **after** a Czech word fails, because the last
character of "není" is "í", which is not an ASCII word character.

The measurement: **`/\b(?:není)\b/iu` does not match the string "není".**

Every Czech pattern in this project had that shape, so **every one of them
was dead** — the certainty scale, the setup states, and the direction
patterns. The fix is a Unicode lookaround:

```js
// WRONG -- the trailing \b fails after "í"
/\b(?:není)\b/iu

// RIGHT
/(?<![\p{L}\p{N}])(?:není)(?![\p{L}\p{N}])/iu
```

The same applies to `\w`, which is also ASCII-only: `\w*` does not match
the diacritics, so `zneplatn\w*` stopped at "zneplatn" and never reached
"zneplatněna". The fix is `[\p{L}\p{N}]*`.

**This is worth remembering for every non-English pattern in this project.**

### The name matcher, not the symbol matcher

`findTickers` now has **two** paths:

1. the **name** path — `findCzechCompanyNames`, which is position-based
   (a capitalised word that is NOT the first word of its sentence), and
2. the **symbol** path — for the handful of times he says one out loud
   ("SPCX", "NVDA", "PSX").

**The symbol path is gated to the CONFIRMED table.** The Sevcik lexicon has
10,485 tickers, and the SEC's list carries one- and two-letter registrants
that ordinary Czech speech is full of. Measured on three videos, the
ungated symbol path matched **187 distinct symbols**, and the top of the
list was **M:906, E:778, A:629, V:558, TAK:446, SE:383, P:363** — every
one of them a Czech letter or a word, not a company. "Předtím", "a", "se",
"tak", "el" are not tickers.

So a symbol token has to be one that was confirmed as a symbol before it
counts. The gate is a **parameter** (`confirmedSymbols`), not a constant,
so the generic English tests still exercise the ungated path.

### The SETUPS — what the speaker is talking about (2026-11-05)

A **setup** is not a signal. The speaker does not disclose positions; he
describes setups and ideas. A signal is a trade-shaped sentence; a setup is
the THING he is talking about, which may run for ten minutes, be revisited,
and end up worked, failed, or invalidated.

`src/sevcik/setupSegmenter.js` and the `sevcik_setups` table hold them.
The lifecycle is read off his own words:

| state | the words | measured |
|---|---|---|
| `new` | "mám tady novou predikci" | |
| `running` | "predikce běží" — still live | |
| `worked` | "predikce vyšla" | |
| `failed` | "predikce nevyšla" | |
| `invalidated` | "predikce zneplatněna" | |
| `old` | "byla stará" | |

**The setup segmenter uses the RUN model, not the nearest-ticker rule.**

The first version attached each "predikce" sentence to the ticker nearest to
it, within three segments. Measured on the corpus it attached setups to the
**wrong ticker** and dropped them **entirely**:

| video | "predikce" sentences | setups found (nearest-ticker) | setups found (run model) |
|---|---|---|---|
| `zRiyF6dDekA` (2026-10-23) | 14 | **0** | 4 |
| corpus total | 297 | 24 | **68** |

And it attached "MONETA" the evidence "byl by důkaz, že predikce vyšla.
Zatím běží predikce na **Airbag**." — the Airbag setup, on the Moneta row.

A run is ONE subject, so every "predikce" sentence in it belongs to that
run's ticker. There is no search for the nearest ticker — the run already
knows.

**The outcome words are markers too.** He very often reports an outcome
WITHOUT naming the thing — "A tady prodejce do Long byla zneplatněná" —
so a marker set of "predikce" alone would miss every one of those, and the
setup would stay "running" after he had killed it.

**"Still running" is about the END of the video, not the whole video.**

The column's own meaning — in the schema, in the aggregate rollups and in
the report's tile — is "the setup was still live at the end of the video".
The rule used to answer a DIFFERENT question: it asked whether the setup
had **ever** run.

```js
still_running: group.states.includes('running') || group.states.includes('new')
```

So a setup that ran and was then finished was still reported as live.
Measured on the 15-video corpus, **13 of 73** setups were misflagged:

| misflagged | why |
|---|---|
| 6 **failed** | ran, then "nevyšla" |
| 7 **invalidated** | ran, then "byla zneplatněná" |
| 7 **already worked** | ran, then "vyšla" |

and the report's "still running" tile claimed **66 of 73** setups were live
when the truth is **52**.

The answer is the **final** state, because that is the state the speaker
last asserted. "predikce běží" after "predikce vyšla" means it is running
now; "predikce vyšla" after "predikce běží" means it is finished. Both
directions were wrong, and both are now tested.

The states list was also **deduplicated**, which is why the bug was
possible: a setup stated `running`, `failed`, `running` was stored as
`['running', 'failed']` — its middle state gone, and its history
unreadable. The list now keeps its order and its repeats, so the final
state is knowable and the sequence is too.

Pinned by `test/sevcikSetupSegmenter.test.js` — the "ran and then failed",
"ran and then was invalidated", "worked and was not reopened", "worked and
was then reopened" cases, and the state-order case.

### The CERTAINTY scale (`src/sevcik/certainty.js`)

The user asked for a scale: "when he uses some words, that means higher
certainty. When he uses others, that is less certainty." The corpus shows
he never says "high conviction" — so the scale is built from what he
**does** say, and every count is measured over the 12-stream corpus.

| level | the words | count | why it is where it is |
|---|---|---|---|
| `certain` | "stoprocentně", "jistota" | 10 + 3 | see the negation rule below |
| `high` | "velmi silný signál", "silnější" | 26 + 6 | a stronger signal |
| `conditional` | "podmíněný" | 14 | **its own level** — see below |
| `even` | "50 na 50", "patová" | 14 + 2 | he says it is a coin flip |
| `low` | "nevím", "pravděpodobně", "asi" | 95 + 45 + 49 | a hedge |
| `unknown` | — | — | nothing said |

**"Jasný" is NOT a certainty marker on its own.** It appears 68 times, and
**66 of the 68 are the filler "Jasně!"** — "Of course!" — in chat replies
and acknowledgements. Only two are about a signal. So it counts only next
to the trading vocabulary: "jasný signál", "jasný long".

**A NEGATED "stoprocentně" is not certainty.** He says "stoprocentně" 10
times, and NINE of them are in a sentence that DISCLAIMS it:

> "Není to žádná stoprocentní jistota, nikdy to nebyla. Je to jenom
> počítání pravděpodobnosti."

("It is not a 100% certainty, never was. It is only counting probability.")

So the negation check is what stops that sentence reading as the strongest
confidence in the corpus. And the negation window has to stop at a
**SENTENCE** boundary, not a comma — the comma in that sentence separates
the negation from the word it negates, and splitting on it made the
negation invisible.

**"Conditional" is NOT a point between "high" and "low".** "podmíněný" is his
DEFAULT form for a live setup, not an apology for a weak one:

> "Takže to 10 Amazon nevypadá špatně, pokud se dostane nad tuto úroveň,
> Long. Prvikce je Long, podmíněná, pokud se dostane nad tuhletu horní
> hranu kanálu."

A scale that forced it onto the high-to-low line would have to call it either
better or worse than a coin flip, and the corpus supports neither. So it is
its own level.

**"Nevím" is about the DIRECTION.** 95 occurrences, and most are about
where the price goes ("nevím, kam půjdou akcie"), not about the strength of
the call. So it is reported as `direction_uncertain` — a separate flag from
the setup's own certainty.

### The Deepgram fallback, tested on caption-less videos

The channel's 808 streams go back to **August 2020**, and the older ones
carry **no captions at all**. Six were confirmed caption-less
(`A0iREjBJr38`, `RHEBWpdIOKM`, `elDgW4j9qHA`, `0oNmAlVVhcE`,
`qyRGpavYGCY`, `_ZvGYjhGEdc`) and three have their audio downloaded to
`data/video_pipeline/audio_sevcik/`.

**All three downloaded videos have now been transcribed end to end**, which
is what confirms the Deepgram path generalises rather than working once:

| video | date | segments | signals | setups |
|---|---|---|---|---|
| `A0iREjBJr38` | 2020-08-13 | 417 | 8 | 2 |
| `RHEBWpdIOKM` | 2020-08-18 | 561 | 10 | 1 |
| `elDgW4j9qHA` | 2020-08-27 | 435 | 4 | 2 |

The corpus is now **15 videos and 11,847 segments**: 129 signals, 73
setups, 24 tickers.

**`language=en` on Czech audio produced 15 useless segments; `cs` produced
881.** The `language` parameter is a hard ACOUSTIC filter, not a
translation request, so the wrong language does not translate — it
mis-hears. The default is `cs`. See § *The Deepgram `language` is a MODEL
choice, not a hint* above for the two defects that made the shipped
catalog claim `en` for every one of these.

**THE SUBTITLE ENDPOINT IS CURRENTLY RATE-LIMITED (429)**, so all 15
transcripts in the catalog came from Deepgram. That is the project's own
standing rule — 30–60 minutes of quiet before retrying — and the captions
are worth fetching later, because they are free and Deepgram is not.

### The `--video-id` flag was broken

`tools/fetchSevcikTranscripts.js` appended `AND video_id = ?` **after** the
`ORDER BY`, so every run that used the flag died with "near AND: syntax
error". The filter has to go before the ORDER BY.


## The AsymTrading source — a SUBSTACK source, and the first one with a PAYWALL (2026-11-11)

`https://asymtrading.substack.com` — the project's **sixth** data source and
the first one that is **not a video channel at all**. It is a Substack
newsletter: a weekly "Market Pulse" written report, an embedded commentary
video, a breadth spreadsheet and a stock list.

**The thing that makes it different from every other source here is the
paywall.** Over the full corpus — 476 posts, 2023-03-29 to 2026-11-11 —
**42 are free and 434 are not.**

| | |
|---|---|
| posts | 476 |
| free | 42 (27 of them Market Pulse reports) |
| paid | 434 |
| free posts with an embedded video | 24 |
| series | `market_pulse`, `momentum_movers`, `market_monitor`, `focus_list`, `post_mortem`, `market_dashboard`, `swing_trading_course`, `trader_profile`, `essay`, `prelaunch`, `copy` |

**THE ACCESS GATE HAS TWO PARTS, and both are needed.**

1. `audience !== 'only_paid'` — the publication's own statement.
2. The body is actually there — the receipt.

Part 2 is not redundant. Part 1 is a claim; part 2 is the evidence that the
request was not served a teaser where a body was expected. Measured: the
`/api/v1/posts` LIST endpoint returns an empty body for a paid post, while
`/api/v1/posts/by-id/<id>` returns the **shared boilerplate every post
starts with** (the "What You Can Expect" block, 1,560 chars) and nothing
else — no report, no headings. So a reader cannot tell a paywalled post
from a free one by looking at the body; only the `audience` field says so.

**Nothing here reaches past the paywall.** There is no subscriber mode, no
cookie handling, and no scraping of a logged-in session. If that is ever
wanted it has to be built on the user's own credentials, explicitly.

**THE PAID POSTS ARE CATALOGUED ANYWAY.** `asym_posts` holds every post,
free and paid, with an `access` column recording which of `free` /
`paywalled` / `teaser_only` / `empty_body` applied. A paid post is a post
that exists; recording it keeps the corpus honest — "42 of 476 posts were
read" is a fact about the source, and "42 posts" would be a fact about the
pipeline pretending to be a fact about the source.

### Why the posts have their own tables

They do NOT go into `videos`. Two reasons:

1. `videos` is keyed on a YouTube video id, and its `status` column carries
   the OCR pipeline's lifecycle (pending → scanning → done). A Substack
   post's lifecycle is different — catalogued, body read, media
   transcribed — and overloading the OCR vocabulary would make both harder
   to read.
2. A paid post has no media and no body. It cannot be a "video" in any
   sense the rest of the pipeline means.

So:

| table | what it holds |
|---|---|
| `asym_posts` | every post, free and paid, with its access state, series and media id |
| `asym_articles` | the parsed report of every free post |

**The parsed readings are NOT `trade_signals`.** That table is a TICKER
table: one row per (video, ticker) with a direction and the sentence it
came from. "Breadth is Positive" is a statement about the market and
applies to no ticker at all, so putting it in `trade_signals` would mean
inventing a ticker for it. The article's index mentions (SPY/QQQ/MDY/IWM)
are kept in `asym_articles.index_tickers` as context, for the same reason.

### The report is a FIXED FORMAT — and it changed three times

This is the part worth reading before touching the parser. The report is
machine-readable, and the format evolved:

| reading | 2026 (current) | 2025-09 → 2025-12 | 2025-02 → 2025-06 |
|---|---|---|---|
| backdrop | `Market Backdrop:` (a paragraph) | — | `Overall:` (a heading) |
| trend | `Overall Trend:` | `Overall Trend:` | `Index Trends:` |
| breadth | `Overall NH/NL Breadth:` | same | same |
| momentum | `Overall Up/Down Momentum:` | same | same |
| plan sections | `1) Title -- State` | `1. Title` | unnumbered headings |

**So the parser switches on the LABELS, not on a date.** A date-based
switch breaks the moment the author changes the layout again, and it has to
be updated every time. All 27 free Market Pulse posts parse all four
readings, and every extracted value keeps the sentence it came from — a
breadth reading of "Positive" is a claim, and a claim you cannot point at
cannot be checked.

The sectors in focus are read the same way: the author names them in prose
("Primary focus: Energy, Defensives, Healthcare, …"), as a sub-heading
followed by a bullet per sector, or in a plain sentence. All three are
read, and the tier (primary / secondary / avoid) is recorded with its
evidence.

### The API's two quirks — both measured

- **The pagination is a CURSOR, not an offset.** `?offset=20` returns HTTP
  400 (`{"errors":[{"param":"offset","msg":"Invalid value"}]}`). The
  endpoint takes `cursor=<base64 of {"post_date":"..."}>` and returns
  `nextCursor`.
- **The two list endpoints return different amounts of the post.**
  `/api/v1/archive` returns `body_html: ""` for **every** post; `/api/v1/posts`
  returns the real body for free ones. The catalog uses the posts endpoint,
  because the body is the whole point of the source.

The endpoint is **undocumented** and the publication is **rate-limited** — a
full walk is 20 requests and asking repeatedly gets the IP throttled (HTTP
429, measured). So the tool walks once, and the **whole free corpus is
captured as fixtures** under `test/fixtures/asym/` (with a `manifest.json`
recording each file's md5), which is what lets the tests run offline.

### The catalog id is the NUMERIC post id, never the slug

Every post in this publication is titled "Market Pulse". The slug is
`market-pulse-<suffix>` and the suffix REPEATS across series —
`market-pulse-open-access` and `market-pulse-open-access-bf1` are different
posts, and `6-steps-to-profitable-swing-trading` appears with six different
suffixes. So a slug is a display name, not an identifier. The catalog id is
`asym_<post_id>`, namespaced so it can never collide with a YouTube video
id.

### The date is the date the post is ABOUT

The author's own label ("10/28/2026") is used, not the publication
timestamp. 86 of the corpus's posts are published after midnight UTC and
so carry a UTC date one day later than the label; for a market recap, the
day the report covers is the day that matters. The label is stored in
`asym_posts.post_label` and the derived `YYYYMMDD` in `upload_date`.

```bash
npm run asym:catalog       # walk the archive, record every post, parse the free ones
npm run asym:catalog:dry   # the same walk, writing nothing
```

The catalog is **idempotent**: a second run updates the rows in place
(measured: 476 inserted on the first run, 0 inserted / 476 updated on the
second), and it records a `catalog_runs` row like every other catalog run.

### The MEDIA, the TRANSCRIPTS, the SIGNALS and the OUTCOMES (2026-11-12)

The catalog reads the WRITTEN report. The video attached to the same post
says much of it out loud, and that is a second reading of the same view --
so the media is downloaded, transcribed, and run through the same signal
engine the other spoken sources use.

```bash
npm run asym:media        # download the MP4 of every free post that has one
npm run asym:transcripts  # Deepgram -> transcript JSON + catalog rows
npm run asym:signals      # transcript -> trade_signals
npm run asym:aggregate    # signals + readings -> CSV/JSON/HTML
npm run asym:outcomes     # score the calls against what the price did
```

**THE MEDIA COMES FROM SUBSTACK'S MUX ACCOUNT, NOT FROM YOUTUBE.**
There is no yt-dlp extractor for it, so it has its own downloader. The
`/api/v1/video/upload/<id>` endpoint describes the video (duration,
dimensions, the primary file's size) and the same endpoint with `/src`
redirects to a signed Mux URL.

**THE SIGNED URL EXPIRES IN ABOUT 24 HOURS, SO IT IS NEVER STORED.** The
catalog holds the PERMANENT identifier -- the media-upload id -- and the
URL is resolved fresh at download time. A stored URL would be a promise
that expires, and a re-run weeks later would fail against a dead token.

**THE RESOLUTION GATE IS FFPROBE, NOT FILESIZE.** A download is accepted
only when ffprobe reports at least 1280x720. Filesize says nothing about
resolution (a 10-minute FullHD video can be under 1 GB and a 2-hour 720p
video can be 2 GB), and a file that fails the gate is DELETED rather than
kept -- keeping it would leave the pipeline reading a video it cannot use.

**THE COST OF THE WHOLE CORPUS, MEASURED.** 24 posts carry a video:
**8.51 GB and 16.8 hours of audio**, every one 1920x1080. The downloads
go to `data/video_pipeline/downloads_asym/` -- its own directory, because
the three historical download directories are described by RESOLUTION and
are known to hold mixed content.

**DEEPGRAM IS MANDATORY, NOT A FALLBACK.** Every other transcript source
here can fall back on YouTube's own auto-captions. This one cannot: the
video is served from Mux, and Mux's assets carry `CLOSED-CAPTIONS=NONE`.
There is exactly one path to a transcript and it costs money (nova-2 is
about $0.0043/min, so the full corpus is on the order of $4.30).

**THE LANGUAGE IS `en` AND IT IS A HARD FILTER.** The shared client
defaults to `cs` because the Sevcik channel is Czech. The language selects
the ACOUSTIC MODEL, so pointing the Czech model at English audio produces
no transcript rather than a bad one. The default is overridden per call.

**THE SIGNALS GO INTO THE SHARED `trade_signals` TABLE**, keyed on
`asym_<post_id>` -- and the other sources' aggregators are NOT
contaminated by that, because both of them filter with
`WHERE v.channel = '...'` over a LEFT JOIN on `videos`, and an
AsymTrading signal has no `videos` row, so `v.channel` is NULL and the
row is excluded. Measured, not assumed -- `test/asymPipeline.test.js`
runs the REAL query text out of both aggregators' own source.

**THE EXTRACTOR IS THE ENGLISH ONE, not the Czech one.** Sevcik's name
finder drops sentence-initial capitals (Czech capitalises every
sentence-initial word); English does not, so "Apple is breaking out" has
to keep its "Apple". `src/t3live/englishNames.js` is reused as-is, with
the CAPS-symbol gate that English traders need.

**THE OUTCOME ENTRY IS THE CLOSE ON THE POST'S OWN DATE**, or the
previous trading day's close when the post is dated on a weekend -- a
Saturday Market Pulse is a preview of the week ahead, so its entry is
Friday's close. A mid-week post's entry leaves that day's own move OUT of
the measured return. That is conservative, and it is stated rather than
hidden.

**ONE CLAIM PER (POST, TICKER).** The author can come back to the same
ticker twice in one post; scoring each mention would count one call as
two correlated wins. A post that is bullish AND bearish on the same name
is NOT scored -- it is reported as conflicting. See `src/asym/claims.js`.

**THE AUDIO-ONLY PATH, AND WHY IT EXISTS.** The downloader has a
second mode. Instead of keeping the 1920x1080 MP4 it downloads the 480x270
rendition, extracts the audio from it, and deletes the video: the whole free
corpus is about **360 MB of audio** against **8.51 GB of video**.

It is not a different recording. Mux serves ONE master audio track muxed
into every rendition, so the audio is the same audio in a smaller file.
**Measured on one post: the transcripts of the 1920x1080 and the 480x270
renditions agree on 98.4% of their words (982 of 998).** The video's audio
is 192 kbps stereo and the low rendition's is 96 kbps, so the difference
is real but small.

There is **no audio-only rendition** -- `audio.m4a` is HTTP 404 on every
asset measured -- so the cheapest audio path is still a video file.

**THE VIDEO IS A SCREENCAST, AND ITS SECTOR TABLE IS READABLE.** This
matters more than the size. The video is a TradeStation screencast whose
left-hand panel is a **sector table**: eleven sectors with their 1 Mo,
3 Mo, 6 Mo, YTD and % Change figures, and an industry table with RS
values beneath it. That is QUANTITATIVE data the written report does not
carry -- the article gives the author's qualitative picks ("Primary focus:
Energy, Healthcare"), and the table gives the numbers behind them.

So the audio path is a **transcript-only fast path**, not a substitute for
the video. The table is legible at 1920x1080 and not at 480x270, so a
corpus-wide OCR pass needs the full-resolution video.

**THE DOWNLOADER CANNOT BE MADE TO LOOK LIKE A HANG.** A 271 MB file
measured at 126 KB/s takes 36 minutes, and a download that prints nothing
for 36 minutes is indistinguishable from a freeze. So it:

- reports **progress** -- bytes, expected bytes, and the rate, every 5 s;
- **detects a stall** -- no bytes for 90 s aborts the request, because a
  slow link and a dead one are otherwise the same thing;
- **resumes** -- a partial file is continued with an HTTP Range request
  rather than started again;
- **checks the length** -- the body has to end up as long as the
  Content-Length says, because a truncated video still has a valid header
  and the resolution gate would accept it;
- **checks the duration** -- the file has to last as long as the source
  says. This is the gate that catches a truncated download, and the
  metadata's `primary_file_size` cannot be used for it: that number is
  the size of the ORIGINAL UPLOADED asset, and the served rendition is
  Mux's own re-encode, which is smaller. The DURATION is the same for
  both, because they are the same recording;
- **takes a lock** -- a second downloader is refused with the owning pid
  rather than allowed to compete. Two at once is a measured failure: the
  second died with "fetch failed: terminated" and the first left a
  half-written carrier behind;
- **sweeps its leftovers** -- an abandoned carrier is removed at startup.

**THE REPORT LEADS WITH THE WRITTEN READINGS.** The dashboard shows the
market backdrop, the index trend, the breadth and momentum readings, the
sectors and the Bottom Line per post, because those are why the source is
worth reading -- and it shows the COVERAGE beside them, because the
publication is mostly paywalled and a dashboard showing only the free
posts without saying so would read as the whole publication.
