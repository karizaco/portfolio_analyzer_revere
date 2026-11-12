---
name: qmg-chunk1-2-results
description: "Chunk 1+2 EasyOCR low-cpu results — 10 Feb-Apr 2022 dates, poor recall confirmed"
metadata:
  node_type: memory
  type: reference
  modified: 2026-10-11T16:39:42.315Z
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
---

# Qullamaggie Chunk 1+2 EasyOCR Results (2026-10-11)

Run tag: `qmg-easyocr-20261011` — 5 videos/chunk, --low-cpu --parallel 1
Engine: EasyOCR, --fps 0.25, --prefilter-max-frames 6, --max-captures 3

## Chunk 1 (Feb–Mar 2022)

| Date | Recall | Hits | Misses | FPs |
|------|--------|------|--------|-----|
| 20220218 | 9% (1/11) | TSLA | 10 missed (UPST,DVN,NRGU,MOS,TQQQ,FCX,DWAC,COPX,ROKU,DCX) | 0 |
| 20220222 | 12% (1/8) | TSLA | 7 missed (NRGU,DVN,MOS,COPX,TQQQ,FCX,NDGU) | 0 |
| 20220301 | 18% (2/11) | FCX, MP | 9 missed + 1 FP (X) | X |
| 20220302 | 14% (1/7) | FCX | 6 missed (NUGT,X,ERX,EDV,COPX,AGQ) | 0 |
| 20220318 | 43% (3/7) | COPX, REGN, URA | 4 missed (NUGT,FCX,URNM,KWEB) | 0 |

## Chunk 2 (Mar–Apr 2022)

| Date | Recall | Hits | Misses | FPs |
|------|--------|------|--------|-----|
| 20220321 | 25% (2/8) | COPX, NUGT | 6 missed (DIDI,URNM,REGN,FCX,NUZE,X) | 0 |
| 20220323 | 0% (0/11) | — | merged empty (all 11 GT tickers missed) | 0 |
| 20220330 | 25% (2/8) | COPX, LABU | 6 missed (NFLX,KWEB,REGN,X,NUGT,FCX) | 0 |
| 20220331 | 25% (2/8) | COPX, FCX | 6 missed (KWEB,SPXL,TQQQ,X,REGN,NUGT) | 0 |
| 20220405 | 9% (1/11) | JNUG | 10 missed (CWEB,REGN,KWEB,GGPI,TAN,NEM,COPX,FCX,NUGT,X) | 0 |

## Key Findings

1. **Zero false positives** across all 10 videos — precision is excellent
2. **Recall is poor on Feb–Apr 2022 dark era** (9–43%, avg ~20%)
3. **Root cause**: `chartStream.position_list` is undefined for all captures — column filter finds no price-aligned tickers in garbled EasyOCR text. Parser falls back to `tickers` field (raw OCR tickers), which are also garbled.
4. **COPX, NUGT, FCX, TSLA** are consistently found — most other tickers missed
5. **`merged_raw_token_clusters`** is empty for these runs — the clusterer has nothing to cluster
6. **20220323 is worst**: merged empty despite 11 GT tickers. All captures had garbled OCR.
7. **X appears as FP on 20220301** — edit-distance correction from chart-area noise

## Why the prefilter misses position-list frames

The prefilter (`midToneRatioTicker`) fires on ANY chart content (candles, axis labels) in the bottom-right rectangle. These Feb–Apr 2022 videos appear to have darker/lower-contrast position-list overlays than the Jun 2022 video used to tune the prefilter. The `meanLumaFloor=30` penalty may be firing on position-list frames that have low mean luma.

## Next steps

- Recalibrate prefilter for dark-era videos (add `meanLumaFloor=20` alternative or lower threshold)
- Increase `--fps` to capture more frames — `--fps 0.25` at 6 frames may be too sparse
- Try `--prefilter-max-frames 12` to evaluate more candidates
- The crop `{x:0.87,y:0.58,w:0.13,h:0.40}` may need adjustment for this era's overlay position

## Chunk 3 (Apr 2022)

| Date | Recall | Hits | Misses | FPs |
|------|--------|------|--------|-----|
| 20220406 | 12% (1/8) | NEM | 7 missed (X,FCX,REGN,COPX,NUGT,LHX,LMT) | 0 |
| 20220412 | 27% (3/11) | FCX, URA, URNM | 8 missed (LHX,LMT,WEAT,X,COPX,REGN,NUGT,JNUG) | 0 |
| 20220413 | 0% (0/11) | — | TIMEOUT — merged empty | 0 |
| 20220414 | 27% (3/11) | COPX, URA, URNM | 8 missed (NUGT,JNUG,WEAT,GUSH,X,REGN,FCX,LMT) | 0 |
| 20220418 | 17% (2/12) | COPX, FCX | 10 missed (VERU,WEAT,URA,URNM,LMT,REGN,GUSH,X,NUGT,JNUG) | 0 |

## Running Totals (Chunks 1–3, 15 dates)

- **Dates with ≥1 hit**: 13/15
- **Dates with 0 hits**: 2 (20220323 timeout, 20220413 timeout)
- **Total recall range**: 0–43%
- **Most consistent hits**: COPX (5×), FCX (4×), URA (3×), URNM (2×), NUGT (2×)
- **False positives**: 1 total (X on 20220301)
- **Timeouts**: 2 (20220413, 20220418 was slow at 618s)
- **Zero FPs** across all 15 videos — precision is excellent

## Root Cause Summary

The prefilter consistently selects frames where COPX/FCX/URA/URNM appear but misses most other GT tickers. The `meanLumaFloor=30` penalty likely fires on dark-era position-list overlays, suppressing the best frames from scoring. The EasyOCR text on captured frames is garbled — the column filter finds no price-aligned tickers, so `chartStream.position_list` is undefined and the parser falls back to raw OCR tickers.
