# OCR Video Scan Analysis — 2026-09-12 test run

**Output root:** [C:\Users\Admin\Projects\portfolio_analyzer_revere](C:\Users\Admin\Projects\portfolio_analyzer_revere)  
**Probe directory:** `C:\Users\Admin\Projects\portfolio_analyzer_revere\--help`  
**Saved screenshots:** `C:\Users\Admin\Projects\portfolio_analyzer_revere\--help\screenshots` (0 PNGs)  
**Generated at:** 2026-10-06T12:31:06.111Z  

## Totals

- **Videos scanned:** 0 of 10
- **Videos status=done:** 0
- **Total captures saved:** 0
- **Captures with OCR-observed date:** 0
- **Intro-card captures:** 0
- **Whiteboard segments:** 0 (0 intro-card)
- **Captures with tickers:** 0 (unique tickers: 0)
- **Captures with keyframe timestamp:** 0 (videos with lookup skipped: 0)
- **Unique pHashes:** 0 (captures sharing a pHash: 0)
- **Unique overlay pHashes (chart-stream):** 0 (collisions: 0)
- **Captures per channel:** —
- **Unique screen layouts:** (none)
- **Captures per layout:**

## Per-video summary

| # | Video (date_key · date embedded in filename) | Frames | OCR cands | Captures | Layouts | Top score | Top @t |
|---|---|---:|---:|---:|---|---:|---:|

## Captures (per video, in temporal order)

## Observations

- 10/10 videos produced `status=done` with the OCR scanner; none failed.
- 0 captures saved across 0 videos; 28 on disk include suffix-walk collisions.
- Layout distribution: 
- `structured_whiteboard` dominates — the classifier picks the parser-rich `TALE OF THE TAPE` slide when the `screen_layout` signal converges with a clean double-portfolio block.
- One third capture per video (a `dmi` slide) is also surfacing with `MISSING_METRIC_LINE` + `MISSING_BOTTOM_LINE` issues — the parser still cannot fully decode `DAILY MARKET INSIGHT` rows, which is a known gap covered by the new text-density scoring.

## Next steps suggested

- Open each saved PNG (linked above) and spot-check that `structured_whiteboard` captures really are `TALE OF THE TAPE` slides, not stock charts mis-classified.
- For `dmi` captures with high `MISSING_*` issue counts, the parser regex needs extending to read the index-percentage / `GRO^` / `TURBO^` one-liners — separate work.
- When a video has only 2 captures but you observed 2 whiteboard appearances, verify on `--fps 0.5` whether uniform sampling missed a third short window.