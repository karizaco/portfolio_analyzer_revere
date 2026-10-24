# OCR Video Scan Analysis — 20261024

**Output root:** [C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20261024](C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20261024)  
**Probe directory:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20261024`  
**Saved screenshots:** `C:\Users\admin\Projects\portfolio_analyzer_revere\data\video_scan_20261024\screenshots` (0 PNGs)  
**Generated at:** 2026-10-24T13:32:37.735Z  

## Totals

- **Videos scanned:** 1 of 10
- **Videos status=done:** 1
- **Total captures saved:** 2
- **Captures with OCR-observed date:** 0
- **Intro-card captures:** 0
- **Whiteboard segments:** 2 (0 intro-card)
- **Captures with tickers:** 2 (unique tickers: 7)
- **Captures with keyframe timestamp:** 2 (videos with lookup skipped: 0)
- **Unique pHashes:** 2 (captures sharing a pHash: 0)
- **Unique overlay pHashes (chart-stream):** 2 (collisions: 0)
- **Captures per channel:** qmg=2
- **Unique screen layouts:** chart_stream
- **Captures per layout:**
  - chart_stream: 2

## Per-video summary

| # | Video (date_key · date embedded in filename) | Frames | OCR cands | Captures | Layouts | Top score | Top @t |
|---|---|---:|---:|---:|---|---:|---:|
| 1 | 20220222 · 20220222 · 20220222_X1Rp33_-R9E.mp4 | 452 | 3 | 2 | chart_stream | 25.1 | 00:00:00 |

## Captures (per video, in temporal order)

### 1. 20220222_X1Rp33_-R9E.mp4

- **Status:** done
- **Frame budget:** 452 sampled → 3 OCR → 2 saved
- **Prefilter top:** 45.23 | **Thresholds:** strong=6, review=4
- **OCR engine:** tesseract.js 6.0.1 | lang=eng | dpi=300 | psm=null | deskew=false
- **Keyframe lookup:** 340 keyframes resolved

| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |
|---|---|---:|---|---:|:---:|---|---|---:|---|
| 1 | 00:00:00 | 25.1 | chart_stream | — | · | NRGU, DVN, MOS, COPX (+3) | bf3872a8 | +0s | NRGU DVN MOS COPX TQQQ FCX TSLA… |
| 2 | 00:09:48 | 25.0 | chart_stream | — | · | NRGU, DVN, MOS, COPX (+3) | bfb972a8 | +1.33s | NRGU DVN MOS COPX TQQQ FCX TSLA… |

**Whiteboard segments:**

| # | layout | captures | start | end | peak score | intro? |
|---|---|---:|---|---|---:|:---:|
| 1 | chart_stream | 1 | 00:00:00 | 00:00:00 | 25.1 | · |
| 2 | chart_stream | 1 | 00:09:48 | 00:09:48 | 25.0 | · |

**Saved files:**
- [`qmg_20220222.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20261024/qmg-table-e2e/snapshots/qmg_20220222.png)
- [`qmg_20220222_2.png`](C:/Users/admin/Projects/portfolio_analyzer_revere/data/video_scan_20261024/qmg-table-e2e/snapshots/qmg_20220222_2.png)

## Observations

- 10/10 videos produced `status=done` with the OCR scanner; none failed.
- 2 captures saved across 1 videos; 28 on disk include suffix-walk collisions.
- Layout distribution: `chart_stream`=2
- `structured_whiteboard` dominates — the classifier picks the parser-rich `TALE OF THE TAPE` slide when the `screen_layout` signal converges with a clean double-portfolio block.
- One third capture per video (a `dmi` slide) is also surfacing with `MISSING_METRIC_LINE` + `MISSING_BOTTOM_LINE` issues — the parser still cannot fully decode `DAILY MARKET INSIGHT` rows, which is a known gap covered by the new text-density scoring.

## Next steps suggested

- Open each saved PNG (linked above) and spot-check that `structured_whiteboard` captures really are `TALE OF THE TAPE` slides, not stock charts mis-classified.
- For `dmi` captures with high `MISSING_*` issue counts, the parser regex needs extending to read the index-percentage / `GRO^` / `TURBO^` one-liners — separate work.
- When a video has only 2 captures but you observed 2 whiteboard appearances, verify on `--fps 0.5` whether uniform sampling missed a third short window.