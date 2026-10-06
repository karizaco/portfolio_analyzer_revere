# Portfolio Analyzer — Qullamaggie + Revere OCR Pipeline

OCR-powered pipeline that crawls YouTube channels (Qullamaggie, Revere), extracts
position/ticker data from video frames, normalizes tickers, and produces portfolio
analytics.

Stack: Node.js + Python (yt-dlp/ffmpeg) + SQLite + Tesseract OCR + sharp.

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

# Run OCR on downloaded videos
python tools/parallelOcrScan.py \
  --prefilter-profile chart_stream \
  --basename qmg \
  --chart-stream-parser \
  --channel qullamaggie

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

- **OCR pipeline**: `src/ocr/ocrImage.js` (`chart-stream` profile) — crops overlay region, upscales 3× with lanczos3, grayscale, `negate()` (white-on-dark → black-on-white), normalize, sharpen(σ=1.5), linear(1.8, −64), then Tesseract.

- **Scanner**: `tools/scanVideoWithOcr.js` uses `--prefilter-profile chart_stream` and `--chart-stream-parser`. Default crop is `{x:0.70, y:0.60, w:0.30, h:0.40}`.

### Validated Crop Region

```
{x: 0.70, y: 0.60, w: 0.30, h: 0.40}   ← 30% width × 40% height, anchored bottom-right
```

This was validated against human-verified snapshots. Mean ticker recall: **56%** with this crop vs 44–47% for wider crops. **Do not widen this crop without re-validating.**

### Resolution Requirements

| Resolution | Result |
|---|---|
| 1080p (1920×1080) | ✅ Works — mean recall ~57–70% |
| 720p | ⚠️ Marginal — significantly worse |
| 360p | ❌ Completely unusable |

**Must use 1080p source** for QMG chart-stream OCR. The 360p default download will not work.

### Ground Truth Test Set

Human-verified tickers for 6 QMG snapshots (1920×1080):

| Video | Ground Truth |
|-------|-------------|
| 20220606 | GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX |
| 20220607 | UCO, VLO, ALB, BOIL, NFLX, TNA, LTHM |
| 20220608 | SIGA, TNA, VLO, UCO, NFLX, ALB, BOIL, LTHM, AERC |
| 20220614 | UVXY, VLO, UCO |
| 20221117 | FREY, OIH, ASML, U, SI, SOXL |
| 20230126 | CVNA, FCX, TNA, CWEB, YINN, PDD, MDGL, GNS |

Run the ground truth test:
```bash
node tools/buildQmgReviewPage.js   # rebuild review page
# open tools/qmg_snapshot_review.html in a browser
```

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

# Parallel OCR
python tools/parallelOcrScan.py \
  --prefilter-profile chart_stream \
  --basename qmg \
  --chart-stream-parser \
  --channel qullamaggie \
  --workers 4

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
