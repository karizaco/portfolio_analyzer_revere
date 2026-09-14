# Revere Portfolio Extractor

This workspace contains a small Node.js CLI that reads the linked screenshot directory in read-only mode, OCRs each PNG, extracts the portfolio snapshot fields, and writes CSV outputs inside this workspace.

## Editable Inputs

- `config/ticker_lexicon_seed.csv`: recurring tickers that should be treated as known symbols during cleanup.
- `config/manual_ticker_overrides.csv`: exact per-file or global corrections for OCR mistakes. `replacement` accepts one ticker or a pipe-delimited list such as `TQQQ|IBIT`.

## Outputs

- `data/portfolio_snapshots.csv`: canonical extracted snapshot rows, one per dated screenshot.
- `data/review_queue.csv`: rows flagged for manual review because of missing fields or low OCR confidence.
- `data/portfolio_actions.csv`: normalized `BUY` / `ADD` / `SELL` / `TRIM` action rows, one row per parsed ticker-level instruction.
- `data/portfolio_actions_review.csv`: action fragments that could not be mapped cleanly to a single ticker-level instruction.
- `data/position_events.csv`: holdings-derived entry and exit events by portfolio and day.
- `data/position_events_review.csv`: candidate events that were withheld from the trusted output because they conflict with action text or come from noisy holdings.
- `data/position_performance.csv`: reconstructed position lifecycles with baseline synthesis, sizing assumptions, historical price dates, price-source metadata, current weight, and realized or unrealized return fields.
- `data/portfolio_performance_summary.csv`: per-portfolio counts for open and closed positions, baseline rows, sizing methods, adjustment counts, review totals, and the latest estimated equity, cash weight, and invested weight.
- `data/portfolio_performance_timeseries.csv`: per-snapshot portfolio timeline with an estimated equity index, cash-conserving exposure model, price-coverage counts, and observed screenshot metrics for later calibration.
- `data/portfolio_performance_review.csv`: lifecycle mismatches, unmapped adjustments, and action-parse review rows withheld from the main performance outputs.

## Usage

1. Install dependencies:

```bash
npm install
```

1. Verify the linked screenshot inventory:

```bash
npm run discover
```

1. Run a small sample first:

```bash
npm run extract:sample
```

1. Run the full extraction:

```bash
npm run extract
```

1. Build the standalone performance scaffolding from the extracted CSVs:

```bash
npm run performance
```

1. Generate the static HTML report and charts from the performance outputs:

```bash
npm run report
```

## Video Whiteboard Worker

The screenshot extractor remains focused on the dated `revere_*.png` image set. Video harvesting for the GRO/TURBO whiteboard starts in a separate worker so playlist state, retries, and large temporary downloads do not complicate the existing OCR flow.

Current scope of the worker:

- initialize a resumable workspace under `data/video_pipeline/`
- persist playlist catalog state in SQLite
- import a YouTube playlist or channel catalog through `yt-dlp` (with real `YYYYMMDD` upload dates)
- resumable, low-resolution downloads with status-based + disk-based dedup
- frame extraction via either reference-hash similarity (`video:scan`) or the direct OCR probe (`video:scan-ocr`)
- screenshot output feeds `whiteboard:extract` (whiteboard frames) or `extract` (snapshot frames) for the existing parser pipeline

Current non-goals of this first pass:

- high-resolution / archival-quality downloads (the default format caps at 480p for speed and OCR is fine with it)
- scanning whiteboard screenshots into the portfolio CSVs (still requires the downstream `whiteboard:extract` / `extract` pass)

Prerequisites:

- Python 3 available through `py -3`, `python`, or `python3`
- `yt-dlp` installed and available on `PATH` (or via `py -3 -m yt_dlp`) for the catalog + download steps
- `ffmpeg` for the scan step (the bundled OCR probe also needs it for frame extraction)

Initialize the worker state:

```bash
npm run video:init
```

Inspect the current worker state:

```bash
npm run video:status
```

Include a few recent catalog rows in the status output:

```bash
npm run video:status -- --list-limit 10
```

Import a playlist or channel catalog into SQLite:

```bash
npm run video:catalog -- --source-url "https://www.youtube.com/playlist?list=..."
```

Download the next pending videos at low resolution and mark them ready for scanning:

```bash
npm run video:download -- --limit 5
```

Import local sample videos directly into the scan queue without using YouTube:

```bash
npm run video:import-local -- --video-dir "D:\\courses_F\\revere_asset" --limit 2
```

Scan a local sample video directly with OCR, without any reference stills:

```bash
npm run video:scan-ocr -- --video "D:\\courses_F\\revere_asset\\sample.mp4" --output-kind whiteboard
```

Scan downloaded videos against a small reference set and save the best whiteboard screenshot:

```bash
npm run video:scan -- --reference-dir ".\\data\\video_pipeline\\references" --limit 5
```

Useful catalog options:

- `--limit N` to test on a small subset first (defaults to 0 = no limit, but YouTube's `--playlist-end` accepts very large numbers so a small batch is recommended when smoke-testing)
- `--cookies-from-browser chrome` or `firefox` if playlist metadata requires a logged-in browser session
- `--cookies-file exported-cookies.txt` when Chromium DPAPI decryption fails on your machine
- `--yt-dlp-bin C:\\path\\to\\yt-dlp.exe` if `yt-dlp` is not on `PATH`
- `--yt-dlp-bin py-yt-dlp` to force module-based invocation through the local Python install
- The catalog command uses `--skip-download` (not `--flat-playlist`) so `upload_date` is resolved to a real `YYYYMMDD` instead of `NA`. Re-running the same catalog is safe: existing rows are updated, never duplicated. To pull the next batch beyond the initial `--limit`, just raise it — the SQLite upsert keeps everything idempotent.

Useful download options:

- `--limit 5` to process a small batch per run
- `--video-id VIDEO_ID` to retry one specific row
- `--cookies-from-browser firefox` or `--cookies-file path.txt` when YouTube requires a logged-in session
- `--format "bv*[height<=480]+ba/b[height<=480]"` to override the default low-resolution selector
- The default `--extractor-args "youtube:player_client=android,web_safari,web"` and `--js-runtimes node` are the combination that bypasses the YouTube "page needs to be reloaded" anti-bot check on Revere-style channels. Override only if those clients fail on a specific video.
- The download summary now includes `reused_from_disk`: rows in `pending` / `error` whose `<upload_date>_<id>.<ext>` file already exists locally are flipped to `scanning` without invoking yt-dlp. Together with `download_archive.txt` and the status-based skip (`done` / `scanning` / `review` / `no_match` rows are not selected), the download step is fully idempotent — re-running `npm run video:download` against the same catalog does zero work.

Useful local import options:

- `--video-dir path` to register sample `.mp4`, `.mov`, `.mkv`, `.m4v`, or `.webm` files for direct scanning
- `--limit 2` to queue only a couple of sample videos at first
- `--extensions .mp4,.mov` to narrow which local files get imported

Useful direct OCR scan options:

- `--video path` to scan a single local video directly
- `--output-kind whiteboard|snapshot` to choose which parser/target screen to search for
- `--output-root .\\data\\video_pipeline_samples` to control where the extracted frame is written
- `--fps 0.25` to adjust frame sampling density; this is the default direct-scan rate
- `--prefilter-threshold 14` to control the cheap image-based filter before OCR starts
- `--prefilter-min-frames 12` and `--prefilter-max-frames 60` to bound how many frames are sent to OCR
- `--prefilter-neighbors 1` to retain adjacent timestamps around strong prefilter hits
- `--strong-threshold 6` and `--review-threshold 4` to tune automatic timestamp selection; the defaults are calibrated for the new text-density scorer (DMI / ToTT pages score 60-130, chart pages score negative)
- `--max-captures 3` to save up to N screenshots per video; the strongest distinct candidates (with a minimum frame gap of 10) are kept, so both the Daily Market Insight page and the Tale of the Tape page in the same video are typically captured
- `--progress-interval 10` to print OCR progress every N sampled frames
- `--top-candidates 5` to include the best timestamp candidates in the output log
- `--keep-frames` to preserve sampled frames for manual inspection during debugging

For the Revere YouTube channel (`https://www.youtube.com/@revereasset/videos`, channel id `UCV27KlSTS2zAidGEbu0HcZA`), the live catalog + download flow has been validated end-to-end without cookies:

- `npm run video:catalog -- --source-url "https://www.youtube.com/@revereasset/videos" --limit 70 --yt-dlp-bin py-yt-dlp` pulled the top 70 videos with real `YYYYMMDD` upload dates spanning 2026-07-04 → 2026-09-12. No malformed rows, no `NA` dates, no cookies required.
- `npm run video:download -- --limit 30 --yt-dlp-bin py-yt-dlp` downloaded 30 videos at 360p (`bv*[height<=480]+ba/b[height<=480]` lands on 360p because no 480p progressive stream is exposed by the android / web_safari / web client set). Typical sizes: 22-50 MB for 13-35 minute videos. Downloads are resumable via `download_archive.txt` and skip already-on-disk files (see `reused_from_disk` in the summary).
- `npm run video:scan-ocr -- --video <path> --output-kind whiteboard --fps 0.25` then extracts the `TALE OF THE TAPE` / `DAILY MARKET INSIGHT` slides in ~12 minutes per video with full OCR text + tickers + pHash + nearest-keyframe PTS recorded.

If you hit a "page needs to be reloaded" or 403 error on a specific video (rare with the default extractor-args), export cookies from a normal logged-in browser session to a Netscape-format text file and pass it with `--cookies-file`. The default client set (`android,web_safari,web`) is a deliberate trade-off: it bypasses the reload check without needing browser cookies, but some region-locked or premium videos may still need cookies.

Sample-video workflow for ffmpeg and OCR testing:

1. Put one or two sample videos in the linked asset folder or another readable local directory.
2. Run `npm run video:init -- --pipeline-root .\\data\\video_pipeline_samples`.
3. Run `npm run video:import-local -- --pipeline-root .\\data\\video_pipeline_samples --video-dir "D:\\courses_F\\revere_asset" --limit 2`.
4. Run `npm run video:scan -- --pipeline-root .\\data\\video_pipeline_samples --reference-dir <portfolio-whiteboard-reference-dir> --video-id <imported-id>` to extract the `YYYYMMDD_ps.jpg` whiteboard frame.
5. Run `npm run whiteboard:extract -- --input-dir .\\data\\video_pipeline_samples\\screenshots` to OCR and parse the saved portfolio-performance frame.
6. Run `npm run video:scan -- --pipeline-root .\\data\\video_pipeline_samples --reference-dir <position-change-reference-dir> --video-id <imported-id> --output-kind snapshot` to extract the holdings/action frame as `revere_YYYYMMDD[_N].png`.
7. Run `npm run extract -- --input-dir .\\data\\video_pipeline_samples\\snapshots` to test the existing holdings parser on the video-derived screenshot.

If you do not want to manage reference stills at all, use the direct OCR command instead:

1. Run `npm run video:scan-ocr -- --video "D:\\courses_F\\revere_asset\\sample.mp4" --output-kind whiteboard --output-root .\\data\\video_pipeline_samples`.
2. Run `npm run whiteboard:extract -- --input-dir .\\data\\video_pipeline_samples\\screenshots`.
3. Run `npm run video:scan-ocr -- --video "D:\\courses_F\\revere_asset\\sample.mp4" --output-kind snapshot --output-root .\\data\\video_pipeline_samples`.
4. Run `npm run extract -- --input-dir .\\data\\video_pipeline_samples\\snapshots`.

For a first coarse pass on a 15-25 minute video, prefer a lower sampling rate plus the prefilter cap, for example:

```bash
npm run video:scan-ocr -- --video "D:\\courses_F\\revere_asset\\sample.mp4" --output-kind whiteboard --output-root .\\data\\video_pipeline_samples --fps 0.1 --prefilter-max-frames 20 --prefilter-min-frames 8 --progress-interval 10
```

The direct OCR probe currently writes the whiteboard output as `YYYYMMDD_ps.png` instead of `.jpg` because that is more reliable on the current ffmpeg build. The stem naming stays the same, and `whiteboard:extract` accepts PNG inputs.

### Aggregating OCR probe output

After running `video:scan-ocr` across multiple videos, use `tools/aggregateScanResults.js` to roll up the per-video probe logs into a single `analysis.json` + `analysis.md`:

```bash
node tools/aggregateScanResults.js data/video_pipeline_samples/yt_first
```

Per-capture fields in `analysis.json` include the full Phase 2 surface: `ocr_text` (full inline OCR text), `parsed_observations` (GRO + TURBO at-a-glance), `prefilter_stats`, `tickers`, `phash`, `low_res_frame_path`, `timestamp_hms`, `nearest_ffmpeg_keyframe_ts`, and `confusion_with_nearby`. Per-video metadata carries `ocr_engine_metadata` (tesseract.js version + flags) and `top_rejected_candidates`. Totals include `captures_with_tickers`, `unique_tickers`, `unique_phashes`, `phash_collisions` (captures sharing a pHash — same-slide dedup signal), `captures_with_keyframe_ts`, and `videos_with_keyframe_lookup_skipped`. A second tool, `tools/compareScanAnalyses.js <baseline.json> <current.json>`, prints a side-by-side totals + per-video breakdown so before/after probe-log changes are easy to verify.

To compare two analysis runs against each other:

```bash
node tools/compareScanAnalyses.js data/video_scan_20260913/fields-v1/analysis.json data/video_scan_20260914/fields-v2/analysis.json
```

### OCR quality vs. download resolution

YouTube's default progressive streams for Revere videos top out at 360p on the android / web_safari / web client combo, so the default download format (`bv*[height<=480]+ba/b[height<=480]`) lands at 360p with typical file sizes of 22-50 MB per 13-35 minute video (versus 500 MB+ at 1080p). For OCR this is fine: tesseract.js downsamples internally to ~300 DPI regardless of input resolution, and the large Revere whiteboard text (`MARKET STATE`, `TALE OF THE TAPE`, `BOTTOM LINE`) is still 30-50 px tall at 360p. A live validation on `0_YeDfX1atU` (Sept 11, 2026, 70 MB / 360p / 1217s) recovered the full `TALE OF THE TAPE — THURSDAY, SEPTEMBER 11, 2026` header and 6 tickers (`CF`, `OKTA`, `PLTR`, `SPYM`, `HOOD`, `TAN`) cleanly. Bump to 720p only if you need a high-res archival copy — pass `--format "bv*[height<=720]+ba/b[height<=720]"` to `npm run video:download`.

Debugging a wrong timestamp or wrong screenshot:

1. Re-run the command with `--keep-frames` so the sampled PNGs remain under `data/.../ocr_probe/frames/`.
2. Check the JSON log under `data/.../ocr_probe/logs/`; it records `status`, `top_candidate`, `top_candidates`, `captures` (array, one entry per saved screenshot), window timing, prefilter reduction, and any frame-level OCR errors. Each capture and top candidate also includes `screen_layout`, `ocr_text_snippet` (first ~200 chars of OCR text), `parsed_row_count`, `issue_codes` (array), `ocr_profile`, `prefilter_score`, plus the full Phase 2 fields: `ocr_text`, `parsed_observations`, `prefilter_stats`, `tickers`, `phash`, `low_res_frame_path`, `timestamp_hms`, `nearest_ffmpeg_keyframe_ts`, and `confusion_with_nearby`. The probe-log level carries `ocr_engine_metadata` (tesseract.js version + per-scan flags) and `top_rejected_candidates` so you can see what was filtered out and why.
3. If the right screen exists but was missed, increase density with `--fps 0.5` or `--fps 1` so the scan samples more timestamps.
4. If a near-miss was chosen, raise `--strong-threshold` or inspect the top candidate timestamps in the JSON log and compare them to the saved frames.
5. If no useful candidates appear, run the same video once with `--output-kind whiteboard` and once with `--output-kind snapshot`; the two scoring heuristics are intentionally different.

### Whiteboard detection (Daily Market Insight / Tale of the Tape)

The whiteboard scorer uses a text-density signal as the primary discriminator between real whiteboard slides and stock-chart pages wrapped in browser chrome:

- `scoreTextDensity(ocrResult)` — `lines * 1.5 + chars / 50 + keywordHits * 4` where keywordHits is the count of `TEXT_DENSITY_KEYWORDS` (`DAILY MARKET INSIGHT`, `TALE OF THE TAPE`, `MARKET STATE`, `WHAT HAPPENED TODAY`, `GROTECTION`, `GROTECTION GAUGE`, `MAG7`, `RAI100`, `21/21`, `BOTTOM LINE`, `PORTFOLIO`, `HOLDINGS`) found in the OCR text.
- When `keywordHits === 0`, the text-density score is capped at 8 so that browser-chrome-only OCR (Safari File Edit View History Bookmarks Window Help + chart labels, ~30 lines / ~2300 chars) cannot dominate.
- `scoreWhiteboardCandidate` adds a `-18` penalty when OCR text contains zero whiteboard keywords — this rejects stock-chart screenshots wrapped in browser chrome even when the chart penalty is borderline.
- `scoreChartLikeness` returns a chart penalty when the vertical-edge to horizontal-edge ratio exceeds 1.2 (candlestick signature); text on a white background has mostly horizontal strokes and a much smaller ratio. Applied at both prefilter (×1, gentle so dense-text screens still pass) and OCR stages (raw, defense in depth).

Recognized `screen_layout` values in the JSON log:

- `dmi` — Daily Market Insight page (MARKET STATE, WHAT HAPPENED TODAY, BOTTOM LINE, etc.)
- `tale_of_the_tape` — Tale of the Tape page (TALE OF THE TAPE header, index/sentiment/case lines)
- `structured_whiteboard` — Full Revere whiteboard with both GRO and TURBO HOLDINGS / RVAB / REBAR / BOTTOM LINE fields
- `chart` — Stock chart page (candlestick + oscillator)
- `unknown_text` — Text-heavy but not matching any of the above

Prefilter is intentionally permissive (`brightRatio < 0.30` rejection, `meanLuma < 140` rejection, gentle chart penalty ×1) so dense-text DMI slides and tabular ToTT layouts still reach OCR. After OCR, the keyword penalty and capped text-density scoring reliably separate whiteboard pages from chart pages. `selectFramesForOcr` adds 12 uniformly-spaced frames on top of the top-scoring prefilter seeds, so short-duration whiteboard windows (a few seconds in a 16-minute video) are still sampled even when their luma-only prefilter scores are modest.

Useful scan options:

- `--reference-dir path` to point at 1-5 known-good whiteboard examples
- `--similarity-threshold 0.9` to tighten or loosen auto-save behavior
- `--review-threshold 0.82` to keep near-misses for human inspection
- `--video-id VIDEO_ID` to rescan a single downloaded row
- `--output-kind whiteboard|snapshot` to choose whether the extracted frame should feed `whiteboard:extract` or the existing `extract` command
- `--ffmpeg-bin C:\\path\\to\\ffmpeg.exe` if `ffmpeg` is not on `PATH`

The worker stores its state at `data/video_pipeline/state.sqlite` and creates local directories for `catalog`, `downloads`, `frames`, `logs`, `references`, `review`, `screenshots`, and `snapshots`. Those artifacts stay inside this workspace and are ignored by git.

Each successful catalog import also saves the raw `yt-dlp` output to `data/video_pipeline/catalog/` so the playlist snapshot can be inspected or replayed later. The catalog row in SQLite carries a real `upload_date` (`YYYYMMDD`), `source_url`, `video_url`, and the latest `title`; re-running `npm run video:catalog` against the same source updates those fields without duplicating rows.

The download step keeps a local `download_archive.txt` under `data/video_pipeline/` so interrupted runs can resume without re-downloading completed video IDs. The JSON summary emitted at the end of `npm run video:download` includes `attempted`, `downloaded`, `reused_from_disk`, `errored`, plus a per-row `results` array — `reused_from_disk: N` reports how many rows were skipped because the matching file was already present, which is how idempotent re-runs surface their no-op behavior.

The scan step samples frames at low resolution, matches them against the reference stills, groups consecutive hits into candidate windows, prefers a later sharp frame inside the best window, and saves the extracted screenshot as `YYYYMMDD_ps.jpg` with collision-safe suffixes.

## Dry-Run and Smoke Tests

The workspace ships with deterministic, offline smoke tests that exercise both the local-video flow and the YouTube-channel flow end-to-end. They are designed to fail fast (non-zero exit) if any of the integration points regress.

Prerequisites:

- `node` (already required by the rest of the project)
- A working `ffmpeg` binary — the helper `tools/buildSyntheticWhiteboardVideo.js` and the e2e tests look for it on `PATH`, in `FFMPEG_BIN`, in `C:/ffmpeg/bin/ffmpeg.exe`, `C:/Program Files/ffmpeg/bin/ffmpeg.exe`, or under `~/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/.../bin/ffmpeg.exe` (the WinGet Gyan install). On non-Windows hosts, install ffmpeg via your package manager.
- `bash` (Git Bash is fine on Windows)

Build the synthetic fixtures (~18 KB MP4 + ~627 B white reference PNG). This is a one-off; the fixtures are committed but easy to regenerate:

```bash
npm run fixture:build-synthetic
```

Run the unit + e2e test suite. The e2e tests auto-skip when `ffmpeg` or the synthetic fixture is missing:

```bash
node --test test/
```

Run the YouTube dry run against the bundled mock yt-dlp fixture (`test/fixtures/mockYtDlp.py`). No network access required:

```bash
npm run video:dryrun-yt
```

Expected last line:

```text
[dryrun-yt] OK: catalog=2, downloaded=1, total_videos=2, scanning=1
```

Run the local-video dry run against the synthetic MP4 + the white reference. Uses the real `ffmpeg` + the Python whiteboard worker. Sandboxes all writes under `data/video_pipeline_dryrun_local_<pid>/` and removes them on exit:

```bash
npm run video:dryrun-local
```

Expected last line:

```text
[dryrun-local] OK: imported=1, scan_status=ok, done=1, errored=0, screenshot=20260104_ps.jpg
```

Run both dry runs in sequence:

```bash
npm run video:dryrun
```

Expected last line:

```text
[dryrun] OK: both dry runs passed
```

What the dry runs assert:

- **YouTube dry run** — `init → catalog → download → status` against a sandboxed pipeline root. Verifies: 2 catalog rows persisted, 1 mock MP4 written under `downloads/`, the SQLite row flipped to `video_counts.scanning = 1`, the catalog TSV exists under `catalog/`, and `download_archive.txt` recorded the mock video id `youtube abc123`.
- **Local-video dry run** — `init → import-local → scan → status` against the synthetic whiteboard MP4 and a near-uniform white reference image. Verifies: 1 row imported, scan returns `status='ok'`, `video_counts.done = 1`, `video_counts.error = 0`, and exactly one `20260104_ps*.jpg` screenshot was extracted under `screenshots/`.

Sandboxing guarantees:

- All pipeline-root writes happen under `data/video_pipeline_dryrun_<pid>/` and are removed on script exit. Nothing under `D:\courses_F\revere_asset` is ever touched (it remains read-only per the workspace constraints in `CLAUDE.md`).
- The local dry run also copies the synthetic MP4 into a dedicated scratch directory so it does not collide with the existing 23-byte OCR-error stub at `test/fixtures/local_20260104_sample.mp4`.

If the local dry run starts failing with `status='error'` and a message containing `preflight`, the cause is almost always an `ffmpeg` regression on the whiteboard preflight path — the same caveat flagged in commit `5f496ee`. The fast-fail behavior of `tools/scanVideoWithOcr.js` (no long OCR run on bad input) keeps the feedback loop short.

## Accessing Final Processed Data

- The final processed datasets live under `data/` inside this workspace.
- Use `data/portfolio_performance_summary.csv` for top-line portfolio summaries, `data/portfolio_performance_timeseries.csv` for time-series charts, and `data/position_performance.csv` for position-level drilldowns.
- Use `data/portfolio_performance_review.csv` and `data/portfolio_actions_review.csv` to inspect rows that were excluded or flagged during action parsing, pricing, or lifecycle reconstruction.
- Open these CSVs directly in Excel, LibreOffice Calc, Google Sheets, or import them into a notebook or BI tool for presentations and visualizations.
- Run `npm run report` to generate a self-contained HTML report at `data/report/index.html` from `data/portfolio_performance_summary.csv` and `data/portfolio_performance_timeseries.csv`.
- Open `data/report/index.html` directly in a browser for the built-in charting and presentation layer. The underlying CSV files remain the canonical inputs for deeper analysis or custom visualizations.
- Historical price cache files used by the performance pass are stored under `data/price_cache/yahoo/`.

## Notes

- `sample_screenshots.lnk` is intentionally kept local and ignored by git. Create your own local shortcut or use `--input-dir` / `--shortcut` when running the CLI.
- If `sample_screenshots.lnk` exists locally, the extractor resolves it automatically and only reads from its target.
- The linked screenshot folder is treated as read-only. All generated files stay under this workspace.
- Legacy `FOCUS` / `PORTFOLIO` screenshots are mapped into the `GRO` columns, with `TURBO` left empty.
- The first snapshot establishes a baseline. Position enter/exit events are only derived when a previous snapshot exists.
- The action ledger is additive. `data/position_events.csv` remains focused on `ENTER` / `EXIT`, while `data/portfolio_actions.csv` preserves ticker-level `BUY` / `ADD` / `SELL` / `TRIM` instructions for later sizing logic.
- Rows with low OCR confidence or missing core fields are written to `data/review_queue.csv` for manual cleanup rather than being dropped.
- When a row has explicit `BUY` or `SELL` signals, the trusted event file prefers those signals over raw holdings diffs. Unmatched diff-only events are pushed to `data/position_events_review.csv` instead.
- The current `performance` command reconstructs position lifecycles, attaches mapped `ADD` / `TRIM` adjustments, and fetches daily Yahoo Finance chart data into `data/price_cache/yahoo/`.
- Price lookups use adjusted close when available, fall back to close when needed, and choose the same trading day or the nearest prior trading day for a screenshot date. Missing or unresolved quotes are pushed into `data/portfolio_performance_review.csv` instead of being treated as cleanly priced.
- Equal-weight fallback entries are funded by a cash-conserving assumption: use explicit action percentages when present, otherwise assign the same-day unresolved new positions an equal target weight and fund them from cash first, then by proportional dilution of existing open positions.
- `data/portfolio_performance_timeseries.csv` now emits a normalized equity index plus cash and invested weights. It is still an assumed model and should be calibrated later if screenshot-level portfolio performance figures or a better source of sizing truth become available.
- Set `REVERE_PRICE_SOURCE=none` before `npm run performance` if you want to skip network price lookups and regenerate the unpriced scaffolding only.
