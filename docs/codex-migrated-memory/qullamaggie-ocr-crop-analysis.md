---
name: qullamaggie-ocr-crop-analysis
description: "The shipped chart-stream crop is ERA-CONDITIONAL (0.86,0.60,0.14,0.28 for 2022, 0.82,0.60,0.18,0.32 for 2023) + multi-frame merge for FP reduction; failure modes for low-recall captures"
metadata:
  node_type: memory
  type: reference
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-11-02T10:11:40.173Z
---

# Quullamaggie OCR Crop Analysis

## The shipped crop (as of 2026-11-02) — ERA-CONDITIONAL
`src/video/chartStreamCrop.js` is the single source of truth. **There is no longer
one rectangle**, because Qullamaggie moved his position list between 2023-01-26 and
2023-05-18:

| era | crop | source pixels (1920x1080) | ticker column x | rows y |
|---|---|---|---|---|
| 2022 (floating panel) | `0.86,0.60,0.14,0.28` | x 1651-1920, y 648-950 | 1795-1812 | 660-940 |
| 2023 (right sidebar) | `0.82,0.60,0.18,0.32` | x 1574-1920, y 648-994 | 1585-1712 | 661-934 |

The era is read off the upload date; an **unknown date falls back to the sidebar
crop**, because the sidebar crop still contains the 2022-era panel and the
floating-panel crop does not contain the sidebar column. The era boundary sits
inside a real gap in the catalog (nothing published 2023-01-26 → 2023-05-18), so
no video can be mis-assigned. `x=0.82` is required: a crop starting at 1594
shaves the first glyph off every ticker on 20231215.

The older figures below (`0.86,0.55,0.14,0.45` and the `cropOverride` field)
are **history** — the crop is derived from the date now, so no date list can go
stale.

Historical A/B (8 GT videos, single capture each, 48 GT ticker appearances):
- `0.91,0.09` (173w): 31% recall, 8 FPs — too narrow, cuts off left edge
- `0.87,0.13` (250w): 42% recall, 10 FPs — too wide, picks up chart annotations
- `0.86,0.14` (269w): 48% recall, 7 FPs — best balance

## Position-list-aware column filter
Two-pass approach:
1. **Price-on-right detection**: For each OCR line, check if a price/percent token appears to the RIGHT of any ticker-shape word. Real position list rows are structured as `ticker | price | % change | vol buzz`. Chart y-axis labels are the OPPOSITE: `price | ticker-shape-word`.
2. **Median x of price-aligned tickers**: This avoids bucket-tying issues where chart header words (SYM, Cran, Pre, Buzz) land at the same x as the position list ticker column.

**Minimum 3 ticker-shape words** required to identify the column (relaxed below this and the algorithm degrades — single-ticker lists still fail because Tesseract reads "OIH" as "MOH" or "SGMO" in older Trade-Ideas UI screenshots).

## Multi-frame merge
Real position lists change during a stream (Quullamaggie adds/removes tickers as the trade progresses), so requiring a ticker to appear in ≥2 of 3 captures eliminates single-frame OCR garbling AND unstable position entries. Implementation in `mergeMultiplePositionLists()`:

- **FP reduction**: 4-5 FPs typically collapse to 1 FP per video
- **Recall impact**: drops 10-20% because real position changes look like OCR noise to the threshold
- **Best for**: downstream consumers who care more about precision than recall

Trade-off: single-capture column-aware gives best recall (100% on 20220323); multi-frame merge gives best FP reduction (1 FP vs 11 FPs on 20220405).

## Low-recall failure modes (41 GT videos analyzed)

After OCR-ing 41 Quullamaggie videos, low-recall captures fall into 4 modes:

### Mode 1: Trade-Ideas platform (3 videos — 0% recall each)
Videos: 20220218, 20220318, 20220222 (early Feb-Mar 2022).
Quullamaggie used **Trade-Ideas** UI (smaller font, narrower ticker column, different anti-aliasing). Tesseract reads the column as gibberish (e.g. "A-Posti@ im: 1 E88 x" instead of "A - Positions"). Total: 0/15 GT tickers detected.
**Fix**: Would need a different OCR preprocessing pipeline or custom Tesseract config trained on Trade-Ideas screenshots. Out of scope.

### Mode 2: Sparse position lists (1-2 tickers)
Videos: 20221104 (1 ticker OIH), 20220426 (2 tickers BOIL WEAT).
Column-detection requires ≥3 ticker-shape words. With 1-2 tickers, `inListTickers` is empty. Additionally, Tesseract misreads "OIH" as "MOH"/"SGMO" in the old UI, so even with threshold relaxed the result is wrong.
**Fix**: Lower threshold to ≥1, but risk more FPs.

### Mode 3: Dense new-UI lists (7 videos — 15-30% recall)
Videos: 20230518, 20230523, 20230601, 20230602, 20230605, 20230608, 20230609.
Post-May-2023 videos use wider table layout with extra columns (`Dol Vol`, `Vol Buzz`, `ADR % 20 days Daily`). The default crop cut off the ticker column.
**Fix (2026-11-02)**: the era-conditional crop reaches the sidebar column (x 1585+), and the parser's own row stack (Filter B) keeps the bottom of a long list. Measured over seven pinned 2023-era frames: the old crop read 27/56 holdings, the era crop reads **69/75 with 8 false positives**. The `cropOverride` field is gone.

### Mode 4: Garbled OCR on dense lists (most low-recall cases)
Tesseract can't read dense position lists consistently. Single-capture parsing produces many FNs + FPs. Multi-frame merge consistently reduces FPs (75→14, 33→11, 40→4).
**Fix**: Multi-frame merge. Already implemented.

## Tesseract is non-deterministic
Same image can produce different OCR text across runs. When comparing parser variants, always re-OCR the same snapshot to ensure fair comparison. Stored probe logs should NOT be used as ground truth for parser comparison.

## Missing lexicon tickers (added)
WEAT, URNM, JNUG, NUGT, COPX, KWEB, X, VRM were missing from `config/ticker_lexicon_seed.csv`. Without them, correct tickers got edit-distance-mis-corrected (WEAT→AMAT, URNM→ARM, KWEB→CWEB, NUGT→HUT).

## OCR pipeline changes
- `src/ocr/ocrImage.js` — now requests Tesseract TSV output, exposes `ocr.words` with per-word positions. TSV adds no measurable latency (~850ms/call either way).
- `src/parse/parseChartStream.js` — `identifyPositionListColumn()` + `parseChartStreamPositionList()` + `mergeMultiplePositionLists()`.

## Resolution reality
- 93% of Quullamaggie videos in downloads_1080p/ are true 1920x1080
- downloads_hires/ is mixed (Quullamaggie 720p + Revere) — NOT for Quullamaggie OCR
- Always use downloads_1080p/ for Quullamaggie scans

## HTML review
`tools/qmg_crop_comparison.html` — 41 videos, 118 captures spanning Feb 2022 - Dec 2023.

## Key files
- `src/video/chartStreamCrop.js` — the era-conditional crop (the single source of truth)
- `src/video/ocrScanArgs.js` — chooses the crop; `chartStreamCropFractionForDate(dateKey)`
- `src/parse/parseChartStream.js` — `identifyPositionListColumn` + `parseChartStreamPositionList` + `mergeMultiplePositionLists`
- `src/ocr/ocrImage.js` — exposes `ocr.words`
- `src/normalize/tickerScan.js` — O(1) `tickerSet` lookup
- `config/ticker_lexicon_seed.csv` — added 8 Quullamaggie chart ETFs
- `data/qmg_ground_truth.json` — per-frame GT tickers + crop coordinates
- `docs/qmg-ocr-crop-analysis.md` — full analysis with BEFORE/AFTER numbers
- `tools/qmg_crop_comparison.html` — HTML review page with live re-OCR
