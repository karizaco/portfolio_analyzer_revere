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
- import a YouTube playlist or channel catalog through `yt-dlp`

Current non-goals of this first pass:

- downloading videos
- scanning frames
- selecting final whiteboard screenshots
- parsing harvested whiteboard screenshots into CSVs

Prerequisites:

- Python 3 available through `py -3`, `python`, or `python3`
- `yt-dlp` installed and available on `PATH` for the catalog import step

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

Scan downloaded videos against a small reference set and save the best whiteboard screenshot:

```bash
npm run video:scan -- --reference-dir ".\\data\\video_pipeline\\references" --limit 5
```

Useful catalog options:

- `--limit 10` to test on a small subset first
- `--cookies-from-browser chrome` or `firefox` if playlist metadata requires a logged-in browser session
- `--cookies-file exported-cookies.txt` when Chromium DPAPI decryption fails on your machine
- `--yt-dlp-bin C:\\path\\to\\yt-dlp.exe` if `yt-dlp` is not on `PATH`
- `--yt-dlp-bin py-yt-dlp` to force module-based invocation through the local Python install

Useful download options:

- `--limit 5` to process a small batch per run
- `--video-id VIDEO_ID` to retry one specific row
- `--cookies-from-browser firefox` or `--cookies-file path.txt` when YouTube requires a logged-in session
- `--format "bv*[height<=480]+ba/b[height<=480]"` to override the default low-resolution selector

For the Revere YouTube channel, a live smoke test succeeded for catalog import with Chrome cookies, while Edge cookie decryption failed with a DPAPI error and a cookie-less download retry hit a YouTube page reload check. If Chromium browser-cookie access fails locally, export cookies from a normal logged-in browser session to a Netscape-format text file and pass that file with `--cookies-file`.

Useful scan options:

- `--reference-dir path` to point at 1-5 known-good whiteboard examples
- `--similarity-threshold 0.9` to tighten or loosen auto-save behavior
- `--review-threshold 0.82` to keep near-misses for human inspection
- `--video-id VIDEO_ID` to rescan a single downloaded row
- `--ffmpeg-bin C:\\path\\to\\ffmpeg.exe` if `ffmpeg` is not on `PATH`

The worker stores its state at `data/video_pipeline/state.sqlite` and creates local directories for `catalog`, `downloads`, `frames`, `logs`, `references`, `review`, and `screenshots`. Those artifacts stay inside this workspace and are ignored by git.

Each successful catalog import also saves the raw `yt-dlp` output to `data/video_pipeline/catalog/` so the playlist snapshot can be inspected or replayed later.

The download step also keeps a local `download_archive.txt` under `data/video_pipeline/` so interrupted runs can resume without re-downloading completed video IDs.

The scan step samples frames at low resolution, matches them against the reference stills, groups consecutive hits into candidate windows, prefers a later sharp frame inside the best window, and saves the extracted screenshot as `YYYYMMDD_ps.jpg` with collision-safe suffixes.

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
