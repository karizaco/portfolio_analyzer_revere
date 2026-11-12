---
name: qmg-ground-truth
description: Human-verified tickers for Qullamaggie snapshot test set + validated crop + OCR findings
metadata:
  type: reference
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-09-21T03:14:40.168Z
---

# Qullamaggie Ground Truth — Snapshot Review Test Set

Human-verified ticker labels for Qullamaggie chart-stream snapshots.
Videos: 1920×1080, YouTube Qullamaggie streams.

## Ground Truth (verified 2026-09-21)

| Video | Snapshots | Ground Truth Tickers |
|-------|-----------|----------------------|
| 20220606 | qmg_20220606.png … _12.png | GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX |
| 20220607 | qmg_20220607.png, _2, _3 | UCO, VLO, ALB, BOIL, NFLX, TNA, LTHM |
| 20220608 | qmg_20220608.png, _2, _3 | SIGA, TNA, VLO, UCO, NFLX, ALB, BOIL, LTHM, AERC |
| 20220614 | qmg_20220614.png, _2, _3 | UVXY, VLO, UCO |
| 20221117 | qmg_20221117.png, _2, _3 | FREY, OIH, ASML, U, SI, SOXL |
| 20230126 | qmg_20230126.png, _2, _3 | CVNA, FCX, TNA, CWEB, YINN, PDD, MDGL, GNS |

(20221104: no ground truth available)

## OCR Recall vs Ground Truth (1080p snapshots, negate pipeline)

| Video | Recall | Found | Missed |
|-------|--------|-------|--------|
| 20220606 | 5/8 (63%) | ALB, GOVX, LABU, NFLX, TNA | UCO, CBIO, VLO |
| 20220607 | 5/7 (71%) | ALB, BOIL, BUCO, LAR, LTHM, NFLX, TNA, VIO | UCO, VLO |
| 20220608 | 6/9 (67%) | AERC, LTHM, NFLX, SIGA, SON, TEEN, TNA, UCO | VLO, ALB, BOIL |
| 20220614 | 0/3 (0%) | VIO | UVXY, VLO, UCO |
| 20221117 | 4/6 (67%) | ASML, FREY, SOXL, ST, U | OIH, SI |
| 20230126 | 6/8 (75%) | BE, CVNA, CWEB, FCX, GNS, LI, MDGL, ON, TNA, X | YINN, PDD |
| **Mean** | **~57%** | | |

## Key Findings

### Crop region (validated)
`{x:0.70, y:0.60, w:0.30, h:0.40}` — 56% recall vs 44-47% for wider crops.

### Negate preprocessing
**Makes zero difference** on 1080p snapshots — both negated and original produce identical output.
(The negate() in the pipeline may still help on some frames; but on these specific snapshots it's neutral.)

### 360p video is completely unusable
Tesseract reads nothing from 640×360 frames. The position-list overlay is too small.
Must use 1080p source for Qullamaggie chart-stream OCR.

### Systematic OCR misreads
These are the primary remaining bottlenecks:
- **UCO → BUCO/LUCO** (U misread as B or L)
- **VLO → VIO** (L→I or vice versa)
- **ALB → AB** (missing L)
- **YINN → not found**
- **PDD → not found**
- **OIH → not found** (also SI)
- **CBIO → not found**

These are character-level confusions in Tesseract, not crop or preprocessing issues.

## Files
- Review page: `tools/qmg_snapshot_review.html` (ground truth + recall column)
- Ground truth embedded in: `tools/buildQmgReviewPage.js` → `GROUND_TRUTH` constant
- S&P 500 fallback: `config/ticker_sp500.csv` (505 symbols)

## Improvement Ideas
1. **Post-OCR correction via edit distance** — correct BUCO→UCO, VIO→VLO, AB→ALB using lexicon + Levenshtein distance ≤2
2. **Wider ticker list** — the S&P 500 CSV (505 symbols) is a start; full US ticker list (~10k+) would catch more
3. **Font/training** — Tesseract is confused by I/O/L, U/V, B/H confusions specific to the chart overlay font
