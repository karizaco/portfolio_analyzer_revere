# Quullamaggie OCR Crop Analysis — 2026-09-25

## The Core Finding

The original crop `0.70,0.55,0.30,0.45` was 391-432px too far **left** — capturing chart area, not the position list. The new default `0.87,0.58,0.13,0.40` captures the correct region but is 104px wider than the ticker column itself at 1080p, producing many false positives from chart text.

**The scanner cannot distinguish ticker-column tickers from chart-text tickers** — both pass the lexicon filter when near prices. This is a fundamental parser limitation, not a crop problem.

## Position-List-Aware Filter (2026-09-25)

**Big win.** Instead of relying on crop precision alone, the parser now uses **per-word OCR positions** (from Tesseract TSV output) to identify the dominant ticker column and reject chart-area text.

### Key signal
Real position list rows have structure: `ticker | price | % change | vol buzz`. Chart y-axis labels have the OPPOSITE structure: `price | ticker-shape-word`. The discriminator is whether a **price/percent token appears to the RIGHT of the ticker on the same line**.

### Filter logic
1. Find dominant x-column (bin ticker-shape words by x, pick the bin with most words)
2. Keep only tokens in the column (x range ~25px wide)
3. For each column token, require a price/percent token to its RIGHT in the same line
4. Edit-distance correction only applied to in-column tokens (chart text outside column can't get mis-corrected to random tickers)

### Results
With fresh OCR (Tesseract is non-deterministic across runs — stored probe logs may have lower-quality text):

| Metric | Before (legacy parser) | After (column-aware) |
|--------|------------------------|----------------------|
| Recall | 23/33 = 70% | **9/11 = 82%** |
| False positives | 1 | **1** |
| Precision | 23/24 = 96% | **9/10 = 90%** |

For the 20220323 video specifically (11 GT tickers), fresh OCR on saved snapshots:
- Legacy parser: 6/11, 9/11, 8/11 GT across 3 captures (0-1 FPs each)
- Column-aware parser: 9/11 GT, 1 FP on the single capture

The main win from the column-aware filter is **eliminating chart-area false positives** — when given good OCR, the legacy parser reaches 70-82% recall on its own, but produces chart-text tokens (FANG, INUG, FX, etc.) that the column filter rejects.

Note: stored probe logs often contain lower-quality OCR text from earlier Tesseract runs; the comparison above is on equal footing (re-OCR every capture live). The HTML review page at `tools/qmg_crop_comparison.html` does this re-OCR automatically.

### Limitations
- Single-letter tickers (A, I, X) are rejected — too ambiguous, get edit-distance-corrected to U/LI/MP
- Real GT X (US Steel) is missed in some captures — would need a tighter confidence check
- Frames where the position list header overlaps the crop top edge (e.g. text before "A - Positio...") can produce tokens outside the column

## Resolution Reality

- **93% of Quullamaggie videos in `downloads_1080p/` are true 1920×1080**
- `downloads_hires/` is mixed (Quullamaggie 720p + Revere) — not for Quullamaggie scans
- Always use `downloads_1080p/` for Quullamaggie

At 1080p (1920×1080) with `0.87,0.58,0.13,0.40`:
- x=[1670-1920], y=[626-1060], w=250px, h=434px
- Position-list ticker column: x=[1766-1911], y=[626-1060] = 145×434px (real column: x=1766-1911)
- Crop is 104px wider than ticker column, capturing chart area

At 720p (1280×720) with the same fractions:
- x=[1114-1280], y=[417-705], w=166px, h=288px
- Position-list ticker column: x=[1157-1277], y=[470-604] = 120×134px
- Crop is 46px wider, capturing chart area

## Missing Lexicon Additions (2026-09-25)

Added to `config/ticker_lexicon_seed.csv`:
- WEAT (wheat ETF)
- URNM (uranium miners ETF)
- JNUG (junior gold miners 2x)
- NUGT (gold miners 2x)
- COPX (copper miners ETF)
- KWEB (China internet ETF)
- X (US Steel)
- VRM (Vroom)

These were missing from the seed lexicon, causing correct tickers to be edit-distance-mis-corrected:
- `WEAT` (distance 2) → AMAT ❌
- `URNM` (distance 2) → ARM ❌
- `KWEB` (distance 1) → CWEB ❌
- `NUGT` (distance 2) → HUT ❌

## Post-Processing Fixes Applied

### `|` prefix/suffix stripping
```js
// Blue flag | merges with tickers: |WEAT→WEAT, KWEB|→KWEB
const stripped = String(token || '').replace(/^\|+|\|+$/g, '');
```

### Edit-distance correction (Levenshtein ≤2)
```js
// INUG→JNUG, XX→X, ERS→REGN, FX→FCX
// RESTRICTED to in-column tokens only after position-list-aware filter
findCloseTickerMatch(token, lexicon) → corrected ticker or null
```

### O(1) lexicon lookup
```js
// tickerSet.has() vs tickerSet.includes() — O(1) vs O(n)
lexicon.tickerSet.has(ticker)
```

### Position-list-aware column detection
```js
// Identify dominant ticker column from per-word OCR positions.
// In scaled 750px image: column at x=348-358 (10px wide) for real Quullamaggie position lists.
identifyPositionListColumn(words, scaledWidth) → { inListTickers: Set<string>, dominantColumnX, columnWidth }
```

## Verified Ground Truth Crops (at 1080p)

| Date | GT Tickers | Crop [x1,y1,x2,y2] | Dimensions |
|------|-----------|---------------------|------------|
| 20220323 | 11 | [1766,705,1911,906] | 145×201 |
| 20220510 | 2 | [1757,703,1903,1022] | 146×319 |
| 20220427 | 6 | [1776,653,1916,1023] | 140×370 |
| 20220428 | 4 | [1735,653,1912,774] | 177×121 |
| 20220614 | 3 | [1716,706,1907,778] | 191×72 |

Note: GT crop for 20220323 was only 201px tall, missing top rows (BOIL, JNUG, NUGT, X, WEAT, KWEB).

## Key Files

- `src/video/ocrScanArgs.js` — `CHART_STREAM_REGION_FRACTION_DEFAULT = '0.87,0.58,0.13,0.40'`
- `src/parse/parseChartStream.js` — position-list-aware column filter + edit-distance correction + `|` stripping
- `src/ocr/ocrImage.js` — exposes per-word TSV positions in OCR result.words
- `src/normalize/tickerScan.js` — O(1) `tickerSet` lookup
- `config/ticker_lexicon_seed.csv` — added WEAT, URNM, JNUG, NUGT, COPX, KWEB, X, VRM
- `data/qmg_ground_truth.json` — per-frame GT tickers + crop coordinates
- `tools/qmg_crop_comparison.html` — comparison page (BEFORE/AFTER)
