# Portfolio Analyzer — Qullamaggie + Revere OCR Pipeline

OCR-powered pipeline that crawls YouTube channels (Qullamaggie, Revere), extracts
position/ticker data from video frames, normalizes tickers, and produces portfolio
analytics.

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + EasyOCR + Tesseract OCR + sharp.

---

## YouTube Download: `visios` client (CRITICAL)

Bot protection blocks the `tv` client even with valid cookies — it returns "Video unavailable" for ALL videos. The `visios` (visionOS API) client bypasses this.

**Always use these flags together:**
```bash
--extractor-args "youtube:player_client=visios" --js-runtimes node
```

| Client | Result |
|--------|--------|
| `tv` | "Video unavailable" — bot blocked |
| `android` | SABR-only formats, no MP4 streams |
| `web_safari` | "Video unavailable" — bot blocked |
| `visios` + `--js-runtimes node` | **Works** |

**Never assume a video is truly unavailable** just because yt-dlp returns "Video unavailable" — switch to `visios` before concluding a video is gone.

**Cookie refresh**: SID and __Secure-3PSID are long-lived (~2 years). SIDCC/__Secure-1PSIDTS expire same-day and are not needed for download. When cookies fail, export fresh ones from Firefox Cookie-Editor.

### SABR blocking

YouTube's SABR-only streaming blocks yt-dlp on some videos. Error looks like:
```
WARNING: [youtube] VIDEO_ID: Some android client https formats have been skipped as they are missing a URL.
```
Fix: `visios` client handles this correctly. Do not use `android` client for QMG videos.

### Rate-limiting

Running too many yt-dlp requests rapidly (catalog refresh, batch downloads) triggers YouTube rate-limiting:

```
ERROR: [youtube] VIDEO_ID: This content isn't available, try again later.
The current session has been rate-limited by YouTube for up to an hour.
```

- **Catalog refresh** is the biggest offender — one yt-dlp invocation per video with no built-in delay.
- **Batch downloads** with `--limit 200` are safer because each download takes 20–60s, naturally spacing requests.
- If rate-limited: **stop all YouTube activity for 30–60 minutes** before retrying.
- Do NOT run catalog refresh and batch downloads concurrently — they compete for the same rate-limit budget.
- The `--sleep-requests` yt-dlp flag does NOT help for catalog refresh (separate invocation per video).

---

## Quick Start

```bash
npm install

# Initialize SQLite schema
node tools/whiteboard_worker.py init

# Catalog Qullamaggie channel
python tools/whiteboard_worker.py catalog \
  --channel qullamaggie \
  --source-url https://www.youtube.com/@Qullamaggie/videos

# Download QMG videos at 1080p
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200

# Run OCR on downloaded videos (EasyOCR recommended)
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js \
  --video-dir data/video_pipeline/downloads_1080p/ \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --ocr-engine easyocr

# Aggregate results
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/
```

---

## Qullamaggie Chart-Stream OCR

Qullamaggie's live trading sessions show a **position-list overlay** in the bottom-right corner — a small table listing open positions with ticker symbols and price/percent data. This is fundamentally different from Revere's whiteboard slides.

### Architecture

- **Parser**: `src/parse/parseChartStream.js` — extracts ticker symbols from raw OCR text using two signals:
  1. **Lexicon membership** — ticker appears in `config/ticker_lexicon_seed.csv`
  2. **Price-nearby** — ticker appears within 12 characters of a price token (`$`, decimal number, `HIGH/LOW/CLOSE/TARGET/STOP/BID/ASK`, or `+/-value%`)

- **OCR pipeline**: `src/ocr/easyocrAdapter.js` (EasyOCR, recommended) or `src/ocr/ocrImage.js` (Tesseract, legacy). EasyOCR crops from the original source video, scales the era-specific position-list region 5×, then runs the CNN. The crop width is measured at runtime; do not hardcode it.

- **Scanner**: `tools/scanVideoWithOcr.js` uses `--prefilter-profile chart_stream` and `--chart-stream-parser`. The default chart-stream crop is selected from the upload date by `src/video/chartStreamCrop.js` (see below).

### Current Crop Region

```
{x: 0.86, y: 0.60, w: 0.14, h: 0.28}   ← 2022-era layout — floating bottom-right panel
{x: 0.82, y: 0.60, w: 0.18, h: 0.32}   ← 2023-era layout — table docked to the right edge
```

The crop targets the position-list column specifically (not the chart area). It is **era-conditional** — Qullamaggie moved the position list from a floating bottom-right panel to a right-docked table between 2023-01-26 and 2023-05-18 — and both rectangles live in `src/video/chartStreamCrop.js`, which is the single source of truth. EasyOCR is used with this crop for ~75% recall on 20220606 vs ~25% with Tesseract on the old wider crop.

### Cluster canonical rules

The chart-stream scan produces two readings: each capture's `position_list`, and the video-level `merged_position_list` formed by clustering all OCR candidate frames. The options below affect the **video-level merge only**; they do not make EasyOCR read a missed ticker. The current default is **`corroborated`**, in both the scan tool and the QMG batch runner.

A cluster may publish a lexicon ticker exactly read by the video, or a corrected canonical inferred from a garbled token. The `corroborated` rule rejects a corrected canonical unless it is within edit distance 1 of a cluster member (or is corroborated by the video's own reading under the non-strict rule). This prevents the clusterer from inventing a holding such as `AAPL` when no frame read it. It is a precision filter, not a recall mechanism.

| Named rule | Meaning | Scan flags | Batch/replay selection |
| --- | --- | --- | --- |
| `corroborated` | **Default**; require distance-1 corroboration | no extra flag | `--cluster-rule corroborated` |
| `shipped` | Pre-2026-11-03 behavior; corroboration off | `--no-cluster-corroboration` | `--cluster-rule shipped` |
| `corroborated-strict` | Corroboration by proximity only; video support does not count | `--cluster-strict-corroboration` | `--cluster-rule corroborated-strict` |
| `supported` | Prefer a canonical the video read when equally close; no corroboration gate | `--cluster-supported --no-cluster-corroboration` | `--cluster-rule supported` |
| `supported+corroborated` | Supported tie-break plus corroboration | `--cluster-supported` | `--cluster-rule supported+corroborated` |
| `video-supported` | Prefer video support regardless of edit distance; no gate | `--cluster-video-supported --no-cluster-corroboration` | `--cluster-rule video-supported` |
| `video-supported+corroborated` | Video-supported selection plus corroboration | `--cluster-video-supported` | `--cluster-rule video-supported+corroborated` |
| `swallowed` | Also publish another lexicon ticker in a cluster when independently read often enough; no gate | `--cluster-swallowed-holdings --no-cluster-corroboration` | `--cluster-rule swallowed` |
| `corroborated+swallowed` | Swallowed-holding guard plus corroboration | `--cluster-swallowed-holdings` | `--cluster-rule corroborated+swallowed` |

The scanner's `--cluster-min-frequency <n>` setting controls the minimum number of distinct OCR frames that must contribute a canonical to the merge; its default is **2**, while `1` permits single-frame garbles. This is separate from the corroboration rule: frequency controls voting, while corroboration checks whether an inferred correction has evidence.

The swallowed-holding option uses `--cluster-swallowed-min-frames <n>`, default **4**. It publishes the additional ticker only when that ticker was read in at least `n` of its own frames. This option is **off by default**; the measured threshold 4–7 gained two holdings without adding a false positive, but it has not replaced the default in production. The supported and video-supported variants are also opt-in because corpus measurements added false positives.

For direct scans, `--cluster-corroboration` explicitly enables the default gate and `--no-cluster-corroboration` explicitly disables it. The option is tri-state internally: omitted means the current default, while the negative flag means explicitly off. Probe logs record the resolved `cluster_rule` and component flags, so results remain auditable. The batch runner defaults to `corroborated`; pass `--cluster-rule shipped` only when reproducing historical output.

The replay tool accepts the same nine names with `node tools/evalParserReplay.js --cluster-rule <name>`. Run `node tools/scanVideoWithOcr.js --help` for the complete scan-tool option list. Every EasyOCR command must include `--low-cpu` when using the batch runner or a low-CPU environment.

### Resolution Requirements

| Resolution | Result |
|---|---|
| 1080p (1920×1080) | ✅ Works — mean recall ~57–70% |
| 720p | ⚠️ Marginal — significantly worse |
| 360p | ❌ Completely unusable |

**Must use 1080p source** for QMG chart-stream OCR. The 360p default download will not work.

### Ground Truth Test Set

Human-verified tickers for QMG snapshots are in `data/qmg_ground_truth.json`. The file contains 42 dated entries. Always verify GT against the actual video content before trusting recall numbers — some entries (e.g. 20220510) were recorded with incorrect assumptions.

### Portable remote benchmark kit

For low-resource remote runners, use the portable curated benchmark instead of a
full video sweep. It uses the repo's Tesseract path only and requires a small
out-of-band snapshot bundle rather than the full scan directories.

Required curated 1080p snapshots:

- `qmg_20220218_2.png`
- `qmg_20220606_2.png`
- `qmg_20221104_3.png`
- `qmg_20230609_3.png`

Run:

```bash
npm run qmg:benchmark:curated -- --snapshot-root /path/to/qmg-curated-snapshots
```

Artifacts are written to `artifacts/qmg_ocr_remote/` as:

- `REPORT.txt`
- `benchmark_results.json`

The command exits early if the snapshot root is missing or if any curated PNG is
absent, so remote runs fail clearly rather than silently falling back to the
wrong artifact set.

### Known OCR Failure Modes

These are **character-level confusions** from the overlay font:

| Ticker | OCR Reads As |
|--------|-------------|
| UCO | BUCO, LUCO |
| VLO | VIO |
| ALB | AB |
| YINN | *(missed entirely)* |
| PDD | *(missed entirely)* |
| OIH | *(missed entirely)* |
| CBIO | *(missed entirely)* |

The overlay font makes `I`, `O`, `L`, `U`, `B`, `V` easy to confuse. Fix approaches:
1. **Post-OCR edit-distance correction** — Levenshtein ≤2 against seed lexicon
2. **Larger fallback lexicon** — `config/ticker_sp500.csv` (505 symbols) catches more

### Negate Preprocessing

`negate()` (white-on-dark → black-on-white) gave **+13pp** OCR confidence improvement on dark-overlay frames. On well-lit 1080p snapshots, negate makes zero difference — both produce identical output. Keep it enabled; it helps on darker frames.

---

## Revere Whiteboard OCR

Revere videos show structured **whiteboard slides** (GRO/TURBO portfolios, DMI, Tale of the Tape) — fundamentally different from QMG's chart-stream overlay.

### Architecture

- **Parser**: `src/parse/parseWhiteboardScreenshot.js` — parses GRO/TURBO structured fields
- **Scanner**: `tools/scanVideoWithOcr.js` with `--prefilter-profile whiteboard`
- **Classifier**: `src/normalize/videoTypeClassifier.js` — categorizes videos as `daily` / `weekend_review` / `feature` / `live_update`

### Video Type Classification

| Kind | Detection | Treatment |
|------|-----------|-----------|
| `daily` | Tue-Fri upload, date prefix or DMI/ToTT keywords | Primary signal: per-day timeline rollup |
| `weekend_review` | Weekend upload, non-LIVE title | Weekly context only |
| `feature` | All-caps / sector-themed title | Ticker union only, no daily rollup |
| `live_update` | Title carries `LIVE`, `MIDDAY`, `PRE-MARKET` | Short chatter, often no captures |

### Resolution: 720p Recommended

| Resolution | OCR Confidence | File Size | Recommendation |
|---|---|---|---|
| 360p | 38 | ~50 MB | ❌ Too coarse for dense slides |
| **720p** | **64** | ~55 MB | ✅ Best trade-off |
| 1080p | 66 | ~114 MB | ⚠️ Marginal gain (+2pp) over 720p |

720p is recommended for Revere. Download via `tools/downloadHiresBatch.js`.

---

## Troubleshooting

### FFmpeg path missing (`ffmpeg.exe ENOENT`)
On Windows, the Gyan FFmpeg symlink may be broken. Recreate it:
```bash
cd tools && mklink ffmpeg.exe "C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe"
```

### Video ID leading underscore
QMG video IDs can start with `_` (e.g. `_9o5_4iZ0zjI`). yt-dlp may truncate these. The download script handles this. If files appear truncated, rename with the full ID and update SQLite.

### Cookie file error (`does not look like a Netscape format`)
Cookie SID/`__Secure-3PSID` expired or malformed. Re-export fresh cookies from Firefox Cookie-Editor.

### Wrong screenshot or timestamp selected
1. Re-run with `--keep-frames` to preserve sampled PNGs under `ocr_probe/frames/`
2. Check the JSON log under `ocr_probe/logs/` — it records `top_candidates`, `captures`, and prefilter scores
3. If the right screen exists but was missed: increase density with `--fps 0.5`
4. If a near-miss was chosen: raise `--strong-threshold`

---

## Common Commands

```bash
# Initialize SQLite
node tools/whiteboard_worker.py init

# Catalog a channel
python tools/whiteboard_worker.py catalog \
  --channel qullamaggie \
  --source-url https://www.youtube.com/@Qullamaggie/videos

# QMG 1080p batch download
node tools/downloadQmg1080p.js --cookies youtube_cookies.txt --limit 200

# Revere 720p batch download
node tools/downloadHiresBatch.js --limit 30 --height 720

# QMG chart-stream OCR (EasyOCR)
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js \
  --video-dir data/video_pipeline/downloads_1080p/ \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --ocr-engine easyocr

# Aggregate scan results
node tools/aggregateScanResults.js data/video_scan_YYYYMMDD/

# Prune old probe directories
node tools/prune_old_probes.js           # dry-run
node tools/prune_old_probes.js --execute # actually delete
```

---

## Data Layout

```
data/
  video_pipeline/
    state.sqlite          # SQLite catalog
    downloads_1080p/      # QMG 1080p videos
    downloads_hires/      # Revere 720p videos
  video_scan_YYYYMMDD/    # OCR scan outputs
  video_ocr_probe/       # Temporary probe directories (prune if >10 MB)
  price_cache/yahoo/      # Historical price data
```

**Never infer resolution from filesize.** A 10-minute 1080p video can be under 1 GB. Use `ffprobe` to check actual resolution.

---

## Outputs

- `data/portfolio_snapshots.csv` — canonical extracted snapshot rows
- `data/review_queue.csv` — rows flagged for manual review
- `data/portfolio_actions.csv` — normalized BUY/ADD/SELL/TRIM rows
- `data/position_events.csv` — entry/exit events by portfolio and day
- `data/portfolio_performance_summary.csv` — per-portfolio summary
- `data/portfolio_performance_timeseries.csv` — portfolio timeline
