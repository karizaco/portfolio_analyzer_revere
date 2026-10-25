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

### Never scan the filesystem without permission

**Do not run filesystem-wide or multi-drive file searches** — `find /c`, `find /d`, `find /f`,
`find /p`, "where did this file go" sweeps across other volumes — unless the user has
explicitly approved that exact search. The user's other drives and personal files (their
pCloud trading-course library, `D:`, `F:`, `P:`) are theirs to control. Do not run such
searches in the background either.

Investigation stays inside `C:/Users/Admin/Projects/portfolio_analyzer_revere`. If evidence
points outside it, name the exact path and command, then wait for approval. To find where a
user keeps a backup, **ask them** — do not go looking.

### YouTube cookie sessions expire

YouTube session cookies in `youtube_cookies.txt` expire and become 0-byte files. When downloads fail with `"does not look like a Netscape format cookies file"`, re-export fresh cookies from Firefox Cookie-Editor and convert to Netscape format.

### YouTube downloads: use the visionOS client, not `tv`

Bot protection blocks the `tv` client even with valid cookies — it returns "Video unavailable" for ALL videos regardless of whether they exist. The visionOS (Apple Vision Pro API) client bypasses this.

**Always use these flags together:**
```bash
--extractor-args "youtube:player_client=visionos" --js-runtimes node
```

`--js-runtimes node` is required — without it, yt-dlp cannot execute the visionos player extraction and falls back to storyboard-only (no video). The `tv` client does not need the JS runtime, which is why it seemed to work until the bot-block kicked in.

**The client was renamed.** Older yt-dlp builds call it `visios`; builds from 2026.08 call it
`visionos` and print `Skipping unsupported client "visios"` for the old name. Always
check which name your build accepts:

```bash
py -3 -c "import yt_dlp.extractor.youtube._video as v; print(list(v.INNERTUBE_CLIENTS.keys()))"
```

`tools/downloadQmg1080p.js` probes this at runtime, so it works on either build.

**What fails:**
- `tv` client → "Video unavailable" (bot protection)
- `android` client → SABR-only formats, no MP4 streams
- `web_safari` client → "Video unavailable" (bot protection)

**What works:** `visionos` with `--js-runtimes node`

### Bot protection symptoms and diagnosis

| Symptom | yt-dlp message | Actual cause |
|---------|----------------|--------------|
| All videos return unavailable | `"Video unavailable"` | Bot protection on `tv` client — switch to `visionos` |
| Page needs reload | `"The page needs to be reloaded."` | Heavy bot/captcha — try again later |
| SABR formats only | `"Some formats have been skipped"` + no MP4 URLs | `android` client — switch to `visionos` |
| No JS runtime | `"No supported JavaScript runtime could be found"` | yt-dlp can't extract visionos without `--js-runtimes node` |
| Client name rejected | `"Skipping unsupported client \"visios\""` | yt-dlp build is new enough to want `visionos` |
| Cookie file error | `"does not look like a Netscape format"` | Cookie SID/`__Secure-3PSID` expired or malformed |
| Rate-limited | `"rate-limited by YouTube for up to an hour"` | Too many rapid requests — pause 30–60 min before retrying |

**Never assume a video is truly unavailable** just because yt-dlp returns "Video unavailable" — the `tv` client is almost always bot-blocked. Test with `visionos` before concluding a video is gone.

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

### Sparse checkout is DISABLED — do not re-enable it

`core.sparseCheckout` and `core.sparseCheckoutCone` are both `false` in this repo, so
git ignores any pattern set and never prunes the working tree. A stale pattern file may
still exist at `.git/info/sparse-checkout`; it is **inert** while sparse-checkout is off.
Do not re-enable it.

**What happened on 2026-10-21:** the repo was a cone-mode sparse checkout whose pattern
set included `data/qmg_ground_truth.json` but *not* `data/video_pipeline/`. At 14:41:23
I ran `git sparse-checkout add test` to materialise the `test/` directory. Re-applying
the sparse set pruned `data/video_pipeline/` out of the working tree. The ~215 GB of
downloaded videos inside it (718 untracked, gitignored `.mp4` files) were destroyed with
it and could not be restored — git had no copy, and they were never committed.

Evidence from the session transcript: `du -sh data/video_pipeline/*` reported
`215G downloads_1080p` at 14:33:56; the in-flight scan's ffmpeg reported
`Error opening input: No such file or directory` at 14:41:59 for a video it had been
reading seconds earlier; at 14:42:58 the directory held only the tracked `state.sqlite`,
freshly re-materialised from the index.

**Do not over-claim the internals.** A scratch-repo reproduction did *not* reproduce the
untracked-file loss: git 2.44 printed
`warning: directory 'data/video_pipeline/' contains untracked files, but is not in the
sparse-checkout cone` and left the files alone. What is proven is the **timing** and the
**only candidate command**, not git's exact internal code path.

**Three independent guards now exist. Do not remove any of them:**

1. `core.sparseCheckout=false` and `core.sparseCheckoutCone=false` — git never prunes.
2. A `PreToolUse` hook (`.claude/settings.json` → `tools/guardDestructiveBash.js`)
   blocks `git sparse-checkout add|set|init|reapply`, `git config
   core.sparseCheckout*=true`, `git clean -f`, and recursive deletes that target the
   media directory or any path outside the project. Self-test:
   `node tools/guardSelfTest.js` (36/36); also runs as part of `npm test`
   (`test/guardDestructiveBash.test.js`).
3. `.gitignore` keeps `data/video_pipeline/` untracked except `state.sqlite`.

The guard inspects the **command line**, not prose: commit-message bodies (`-m`, `-F`,
heredocs) are stripped first, so the incident can still be documented in a commit, while
a real invocation later in the same command line is still blocked. It also only inspects
paths once a recursive delete is present, so read-only commands that merely mention a
path outside the project are not blocked. The `git clean` and `git config` rules are
scoped to *their own* arguments — a greedy match would fire on an unrelated `rm -f`
later in the same line.

**If you need to change which files are tracked, edit `.gitignore` — never the
sparse-checkout set.** To materialise files, use `git checkout -- <path>`.

### The media lives OUTSIDE the git working tree — do not move it back

Re-downloaded videos go to:

```
C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_1080p/
```

This is a **sibling** of the repo, not a child of it, and that is the point. Verified on
2026-10-21: `git status` sees 0 entries there, `git ls-files` tracks 0 files there, and
a full `git clean -ndx` preview lists **0** of them. Even if sparse-checkout were
re-enabled and pruned the working tree, git has no path to these files. This removes
the failure mode structurally, rather than relying on the hook to never fire.

`state.sqlite` stores absolute `download_path` values, so pointing the tooling at the
new directory needs no code change:

```bash
node tools/downloadQmg1080p.js --limit 30 --dl-dir "C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_1080p"
node tools/scanVideoWithOcr.js --video-dir "C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_1080p" --file <path> ...
```

### Re-downloading a lost video

Rows whose media was destroyed still point at the old in-tree paths, and the downloader
skips rows whose `download_path` mentions `downloads_1080p` or whose status is
`scanning`/`done`. Reset them first — `tools/resetLostVideoRows.py` clears
`download_path` and sets `status='pending'`, and writes the previous values to a JSON
manifest so the change is reversible:

```bash
py -3 tools/resetLostVideoRows.py --ids id1,id2,... --dry-run   # inspect
py -3 tools/resetLostVideoRows.py --ids id1,id2,...             # apply
py -3 tools/resetLostVideoRows.py --manifest data/_lost_rows_manifest.json --restore
```

**The player-client name changed.** CLAUDE.md used to say `visios`; current yt-dlp
builds (2026.08+) call it `visionos` and print `Skipping unsupported client "visios"`
for the old name. `tools/downloadQmg1080p.js` now probes `INNERTUBE_CLIENTS` at runtime
and uses whichever name the installed yt-dlp has, so it works on both old and new
builds. `--js-runtimes node` is still required.

`data/video_pipeline/state.sqlite` is the authoritative record of what should be on disk
(channel, upload date, expected filename per video). If the media is missing, regenerate
the inventory from it with `tools/inventoryLostVideos.py` rather than guessing.

### The 39 known 720p-only videos get their own directory

All 39 IDs on the hardcoded 720p-only list are downloaded and live in
`downloads_720p/`. Asking for format 137 on those fails with
`Requested format is not available` — that is the *genuine* no-1080p case, not
throttling. They are fetched at 720p (format 136) into a separate out-of-tree
directory so they are not mistaken for 1080p media:

```bash
node tools/downloadQmg1080p.js --limit 40 --height 720 --only-ids <the 39 ids> \
  --dl-dir "C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_720p" \
  --cookies data/youtube_cookies.txt
```

That lands 1280×720 files, which the OCR pipeline handles correctly — `parseChartStream.js`
scales `X_POSITION_LIST_MIN` off the measured crop width, so a 720p source is fine
(895px crop instead of 1345px).

**A video's original directory does NOT tell you its available resolution.** The 26
qullamaggie videos that had been in `downloads_hires/` turned out to have 1080p
uploads — 21 of them downloaded fine at format 137. Original placement reflects the
download policy at the time, not YouTube's format ladder.

**Confirmed 2026-10-23: the revere uploads have 1080p too.** `--list-formats` on
`-e2AV8iAAFw` and `0R1_i4G7dIw` both offer format 137. So the whole "720p scope"
(the 26 qullamaggie + 151 revere videos that originally sat in `downloads_hires/`)
is fetched at 1080p first, and only videos with genuinely no 1080p stream fall back
to 720p.

**Revere's 1080p uploads are not 1920×1080, and not even a fixed height.** A
six-video sample of revere format-137 frames measured 1670×1080, 1728×1080,
1920×1078 and 1920×1080. Verify by **height with a small tolerance**, never by
exact dimensions — a hardcoded `1920x1080` check fails most revere files, and an
exact-height check fails the 1078 crop. `tools/redownloadLostQmg.js` uses
`|height − target| ≤ 4`.

**Never add an ID to the 39 list from a "format unavailable" error.** Per the
throttling rule above, that error on a non-listed video means YouTube is throttling,
not that the video lacks 1080p. Confirm with `--list-formats` before concluding a
video genuinely has no 1080p.

**Never downgrade a throttled video to 720p.** Confirmed 2026-10-24:
`i-FvQ9bD9S8` failed its format-137 attempt, got fetched at 720p instead —
and `--list-formats` showed format 137 *present*. YouTube was throttling and
lying. A 720p copy is strictly worse than what was lost, so the rule is:

1. Ask what the format ladder actually contains (`--list-formats`, or `-j`).
2. No 137 → the video genuinely has no 1080p stream → fetch it at 720p.
3. 137 present but the download failed → it was throttled → leave it errored
   and retry later with fresh cookies. **Do not** take the 720p copy.

`tools/redownloadLostQmg.js` implements this: it checks each failure against
the real ladder before downgrading, requeues throttled videos for a later
attempt, and passes `--retry-errored` so a requeued video is actually retried.

### The authoritative lost set: `data/_lost_videos_ledger.json`

718 entries, generated from the pre-loss `state.sqlite` as it stood in git HEAD:
541 qullamaggie @1080p, 26 qullamaggie @720p, 151 revere @720p. The count matches
the 718 files lost exactly.

**Use this ledger, not the live SQLite paths, to decide what is still missing.**
Resetting a row clears its `download_path`, so inferring the lost set from the live
DB silently drops in-flight and already-reset rows from the plan.

`node tools/ledgerStatus.js` tallies recovered-vs-lost per scope against the
ledger; `--next-ids N` also prints the next N ids for each pool.

### What survived the 2026-10-21 loss — do not re-derive this

Measured 2026-10-21 with `tools/snapshotCensus.js` and `tools/snapshotCoverage.js`:

| Asset | Status |
|---|---|
| OCR **text** results | **Intact.** 767 `logs/*_snapshot.json` files under `data/`, 390 with a non-empty `merged_position_list`, 80 distinct date-keys with ticker output. 475 Tesseract, 90 EasyOCR. |
| Snapshot **images** | **582 of 756 usable** (527 @1920px, 55 @1280px). The 174 low-res ones (640px prefilter samples) come only from `qmg-ocr-20260917-v2` and `qmg-ocr-20260917-missing19`. Every `_rerun` batch dir is 100% usable. |
| **Videos** | **308 of 718 re-downloaded** into the out-of-tree media dir: 269 @1080p + 39 @720p. All verified by ffprobe — never inferred from filesize. 410 still to go. |

**The extracted tickers were not lost** — re-downloading the videos is not required to
keep the OCR results. Re-download only if you need to re-run OCR at a different crop,
engine, or frame density.

### Re-download progress

Measured 2026-10-23 with `node tools/ledgerStatus.js`.

| Scope | Recovered | Remaining |
|---|---|---|
| qullamaggie @1080p | 249 | 254 |
| qullamaggie @720p-scope | 21 | 5 |
| qullamaggie @720p — the hardcoded 39 | 38 | 0 |
| revere @720p-scope | 0 | 151 |
| **Total** | **308 / 718** | **410** |

To continue, repeat the same three steps for the next batch of ids:

```bash
py -3 tools/resetLostVideoRows.py --ids <comma-separated ids> --dry-run
py -3 tools/resetLostVideoRows.py --ids <comma-separated ids>
node tools/downloadQmg1080p.js --limit 30 --only-ids <same ids> \
  --dl-dir "C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_1080p" \
  --cookies data/youtube_cookies.txt
```

The downloader is resumable: the checkpoint file in each media dir
(`_qmg_1080p_checkpoint.json`) remembers what succeeded, so re-running the same
command after an interruption picks up exactly the stragglers.

`tools/redownloadLostQmg.js` does all of this in one call and verifies every landed
file with ffprobe. Use it for a single batch:

```bash
node tools/redownloadLostQmg.js --batch 30 --media-root "C:/Users/Admin/Projects/portfolio_analyzer_revere_media"
```

**Disk is the binding constraint**: ~157 GB free on C:, and the remaining ~410 videos
need ~119 GiB — the 285 qullamaggie files at the measured 0.37 GiB average (~106 GiB),
plus the 151 revere files at ~0.09 GiB each (~14 GiB), since revere uploads are much
shorter. It fits, but only just. The `frames/` subdirectories under
`data/video_scan_test/_rerun/` hold regenerable OCR intermediate PNGs (45,038 of them,
5.5 GiB) and are the cheapest thing to reclaim — but they are **not** covered by
`tools/prune_old_probes.js`, which only handles `data/video_ocr_probe/`. The scan
*results* (`logs/*.json`) and snapshots live outside `frames/` and are untouched by
that cleanup.

### OCR on the restored media — validated 2026-10-24

Two ground-truth videos were re-scanned from the out-of-tree media to confirm
the restored files work end-to-end with the OCR pipeline. Run tag
`qmg-restore-20261024`, output under `data/video_scan_20261024/`:

```bash
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE \
node tools/scanVideoWithOcr.js \
  --video "C:/Users/Admin/Projects/portfolio_analyzer_revere_media/downloads_1080p/20220218_Cd_IXyHwO3o.mp4" \
  --date 20220218 --output-root data/video_scan_20261024 --run-tag qmg-restore-20261024 \
  --prefilter-profile chart_stream --chart-stream-parser --basename qmg \
  --output-kind snapshot --ocr-engine easyocr --fps 0.25 --prefilter-max-frames 12 \
  --max-captures 3 --batch-snapshots --batch-count 8 --batch-window 4 --temporal-decay 1800
```

| video | recall (exact) | false positives | note |
|---|---|---|---|
| 20220218 | 7/9 = 77.8% | **0** | `TOCQ`→TQQQ and `TSUA`→TSLA are misreads of real GT tickers; the snapshot image visually shows all 9 GT tickers in the POSITIONS panel |
| 20220606 | 4/8 = 50% | 6 | `INA`/`OTNA`→TNA, `NFU`→NFLX are misreads; GOVX and ALB missed |

The 20220218 result is **cleaner than any pre-loss run** — the surviving
`qmg-alt-alt` log for the same video has 3 false positives and the
pre-blocklist `qmg-batch-a` log has 14. Both restored files are full
1920×1080 with legible position lists, so the media loss cost nothing but
the file copies.

Timings with `OMP_NUM_THREADS=1` alongside a concurrent download: 4 min
(20220218) and 11 min (20220606). No ffmpeg orphans left behind. The
low-cpu env vars are what keep this safe to run next to a download.

---

## Video dates — `tools/qmgVideoDates.js`

Most catalogued videos have no upload date on file, so the OCR pipeline had
nothing to name its output after. `tools/qmgVideoDates.js` builds the best
available date for every catalogued video and writes
`data/qmg_video_dates.json` = `{ "<video_id>": {date, confidence} }`, where
confidence is `exact` | `year` | `interpolated`.

Sources, in decreasing trust:

| source | what it gives |
|---|---|
| `data/qmg_upload_dates.json` | the catalog's own `upload_date` (dumped from `state.sqlite` by `tools/dumpUploadDates.py`) |
| `data/qmg_date_anchors.json` | the same dates plus ones recovered from scan logs — **only** when the log's video filename starts with `<dateKey>_` (the file was named after its upload date). A log whose date_key was just the scan date must never be used as an anchor; mixing those in dated 449 of 588 videos to 2026-10-0x |
| `data/qmg_extra_dates.json` | hand-probed upload dates (one `yt-dlp -J` each) for videos the other sources miss |
| `data/qmg_tab_dates.tsv` | a flat crawl of the channel's Videos tab. **The year only is meaningful** — yt-dlp renders YouTube's "3 years ago" as the current day-of-month, so every entry lands on the same day |

The playlist (`data/qmg_playlist_full.txt`) is strictly newest-first, so index
order is a reliable time axis. Each undated video is interpolated between the
exact anchors that bracket it, bounded by its approximate year.

**The only correctness check applied to anchors is monotonicity**: an anchor
whose date is newer than the anchor before it is provably wrong (the catalog's
`upload_date` is not always right — `Quo56MNcUxA` is catalogued as 20220517
but YouTube says 20211217). A rate/outlier smoothness filter was tried and
**rejected** — QMG's upload rate is irregular enough (an 80-day gap between
adjacent videos is normal) that any smoothness test throws away correct dates.

Current output: 588 videos, 93 exact / 356 year / 139 interpolated, spanning
2017-01-22 .. 2023-12-15. Leave-one-out accuracy over the interior anchors:
31% exact, 63% within 1 day, 82% within 3 days.

Rebuild with:

```bash
py -3 tools/dumpUploadDates.py                 # state.sqlite -> data/qmg_upload_dates.json
node tools/videoDateAnchors.js --write data/qmg_date_anchors.json
node tools/qmgVideoDates.js --check            # leave-one-out report
```

---

## OCR sweep over the no-GT videos — `tools/qmgOcrSweep.js`

The user asked for OCR on more videos, "including those where you don't know
the GTs". The curated benchmark covers only a handful of dates, so the widest
source of signal is running the pipeline over the whole restored catalogue and
reading the tickers off the frames.

`tools/qmgOcrSweep.js` is a resumable daemon:

- The work list comes from `tools/listOcrTargets.js` → `collectTargets()`:
  a video on disk, with a date, no ground truth, and no surviving EasyOCR log.
  Because the selection is derived from what is on disk, a scanned video drops
  out of the list on the next pass — the sweep resumes for free.
- Each chunk is a separate `tools/runQmgOcrBatch.js` invocation, which owns
  the per-date crop / temporal-decay logic. The sweep only decides WHAT to run
  and records WHAT came back.
- Failures are recorded in `data/qmg_ocr_sweep.json` so a failing video does
  not spin the loop forever. A re-run that fails keeps the earlier success.
- A lock file (`data/qmg_ocr_sweep.lock`) keeps two sweeps from running at
  once; a stale lock (dead pid) is cleared automatically.
- `--max-videos N` bounds a session; the sweep is safe to stop and restart.

```bash
node tools/qmgOcrSweep.js --dry-run                    # show the work list
node tools/qmgOcrSweep.js --chunk 8 --max-videos 40    # bounded session
node tools/qmgOcrSweep.js --batch-count 4 --batch-window 30
```

The sweep prints a ticker-frequency histogram at the end — the most useful
output when there is no ground truth to score against.

**"Already scanned" must be tracked per VIDEO, not per date.** Several videos
share an interpolated date, so a date-keyed set hides all but one of them.

---

## Testing

```bash
npm test        # node --test test/*.test.js
```

192 tests, all passing (as of 2026-10-21).

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

### Offline analysis tools (no video, no OCR — seconds instead of minutes)
- `tools/reparseOcrLogs.js` — re-derive `merged_position_list` from the OCR already stored
  in scan logs; `--write` to persist, `--gt` to score against ground truth
- `tools/compareColumnGate.js` — A/B the accept-path column gate against the GT
- `tools/compareMergeModes.js` — A/B the stored merged list against the multi-frame clusterer
- `tools/listOcrTargets.js` — videos on disk with a date, no GT, and no EasyOCR log yet

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

### The position-list overlay drifts LEFT over time — pick the crop by date

The default crop (x=0.86, w=0.14) covers the ticker column in 2022, but the
overlay moves left as the stream format changes. Measured on the frames
themselves:

| era | ticker column at (frame x) | crop to use |
|---|---|---|
| 2022 (through Apr 2023) | ≈ 0.90 – 0.93 | default `0.86,0.62,0.14,0.22` |
| May 2023 – Nov 2023 | ≈ 0.846 | `0.83,0.55,0.17,0.45` |
| Dec 2023 onward | ≈ 0.827 – 0.839 | `0.80,0.60,0.20,0.26` |

`tools/runQmgOcrBatch.js` applies this automatically via `cropForDate()` and
also sets `--temporal-decay 0` for the 2023 eras (the position list appears
*late* in those streams, so the 2022-era early-frame bias is wrong).

A crop that starts to the left of the ticker column also pulls in chart area,
which is where the false positives come from — hence the narrowest crop that
still covers the column. Verified on `20231215_JNVA5cd_m7M.mp4`: the new crop
reads `DDOG, DKNG, GME, JST, LND, PDD, SMCI` where the default crop read only
`U`.

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

### The ticker column is LEFT-aligned — band on the left edge, not the center

The QMG overlay renders the position list as three left-aligned columns:
`ticker | shares | price`. In the 1345px EasyOCR crop of the 20220421 frame:

| column | left edge | centers |
|---|---|---|
| ticker | 732–736 (all fourteen rows) | 757–807 (varies with ticker length) |
| shares | 976–1000 | ~1040–1053 |
| price | 1185–1250 | ~1230–1293 |

The **left edge is the stable anchor**; the center moves with the length of the ticker.
"X" and "URNM" share a left edge of 735 but center at 757 and 807. A center-based band
of ±25px therefore drops every short ticker — which is exactly where the ground truth
has single-letter positions (X, U).

`identifyPositionListColumn` now returns `dominantLeft` (median left edge of the
price-aligned rows) and builds `inColumnTickers` from the **left** edge, while
`dominantX` (the center) stays for the `X_POSITION_LIST_MIN` gate and diagnostics.

### The accept-path column gate (`ocr._columnGate`)

The accept path is text-based: "is this token in the lexicon, or does a price-like token
follow it in the OCR text?" That cannot tell the ticker column from the shares or price
column, so a garbled shares value ("0,9483" → `OST`) or a stray price-column letter
(`U`, `X`) is admitted as a position.

The gate rejects any token that does not land in the detected ticker column. It is
**relative to the detected column**, so it survives the overlay drifting left over time
(the column is at x≈765 in 2022 and x≈620 by late 2023 in the 1345px crop).

The gate only engages when the column detector is confident:

- the column was found by **price alignment** (not the densest-bucket fallback), and
- at least **two rows confirmed it** — a ticker-shaped word in the band with a price to
  its right (`columnTokenCount`).

Measured with `node tools/compareColumnGate.js` over 102 ground-truth-scored EasyOCR logs
(full multi-frame pipeline: per-frame parse → `clusterRawOcrTokens`):

| arm | recall | FP |
|---|---|---|
| no gate | 476/898 (53%) | 206 |
| gate `'inloop'` (in the accept loop) | **476/898 (53%)** | **158** |
| gate `'post'` (after Filter B) | 448/898 (50%) | 130 |

`'inloop'` is the default — same recall, 23% fewer false positives. `'post'` costs
recall, because Filter B derives its y-band from the median of the accepted tickers, so
gating *before* Filter B shifts that median and can push a genuine position out of the
band. Set `ocr._columnGate = false` to disable; `'post'` is available for comparison.

Tuning knobs (both measured, both worse or neutral): `ocr._columnGateTolerance`
(left-edge band half-width; 25 → 6 changes nothing, because the columns are 250px
apart), `ocr._columnGateMinTokens` (2 → 3+ loses recall and FP).

### The multi-frame clusterer was dead (fixed 2026-10-25)

`tools/scanVideoWithOcr.js` feeds `clusterRawOcrTokens` the per-frame `position_list` so
chart-area text never reaches the clusterer. But it read `c.chartStream.position_list`
while `summarizeCandidate` writes the parse under the snake_case key **`chart_stream`** —
so every candidate was filtered out, the clusterer ran on an empty input, and
`merged_position_list` was just the single phash-deduped capture's tickers. **The
multi-frame vote never happened.** Both spellings are now accepted.

### Panel-boundary gate (positions / watchlist)

`findPanelBoundaries` locates the "POSITIONS" header line and the "Personal WatchList" header
line and uses them to restrict which rows may contain position-list tickers.

**The watchlist bound only applies when the watchlist header is BELOW the positions header.**
A stray `Watch…` token picked up above the panel (a chat overlay, a streamer name) would
otherwise act as a lower bound and reject *every* real row. Same rule applies inside
`identifyPositionListColumn`'s `lineIsInPanel` and to `panelGateActive`.

### Diagnostic fields exposed

- `chart_stream.column_filter` — `dominant_x`, `column_width`, `in_list_token_count`, plus
  `column_is_price_aligned`, `column_token_count`, `column_gate_active`
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
