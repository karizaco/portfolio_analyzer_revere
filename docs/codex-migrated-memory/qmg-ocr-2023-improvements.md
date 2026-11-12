---
name: qmg-ocr-2023-improvements
description: "QMG 2023-era OCR improvements: 10% → 42% recall"
metadata:
  node_type: memory
  type: project
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
  modified: 2026-10-18T07:03:24.746Z
---

QMG chart-stream OCR improvements committed to `fix/cluster-overrides-capture-tickers` (02e481f).

**Results**: 7 QMG 2023-era dates: 8/77 (10%) → 32/77 (42%), +24 tickers recovered.

**Key fixes**:
1. **Filter B ±8×** (`parseChartStream.js`): bbox y-range widened from ±2× to ±8× lineHeight (~448px). Accepts all rows in position lists. Root cause: PLTR at y=772, APLD at y=1314 — ±2× (~112px) clipped top and bottom rows.
2. **temporal-decay=0** (`ocrScanLogic.js`): disabled temporal boost `6*(1-ts/1800)` that was favoring intro cards at ts=2 over position-list frames at ts=358+.
3. **Wide crop for 2023-era** (`runQmgOcrBatch.js`): `WIDE_CROP_DATES` set + `getFlagsForDate()` applies `--phash-region-fraction 0.83,0.55,0.17,0.45` for May–Jun 2023 videos (5-column table overflows default 0.86,0.14 crop).
4. **Batch snapshots**: `--batch-snapshots --batch-count 5 --batch-window 4` recovers tickers across multiple position-list frames.
5. **EasyOCR price pattern** (`parseChartStream.js`): added bare 4-6 digit price to `hasPriceNear` regex.
6. **Row-density fix** (`ocrScanLogic.js`): count both dark→bright AND bright→dark transitions.

**Remaining issues**:
- LI (2-char) is illegible to EasyOCR — parser can't recover it
- 20230608/20230609 prefilter picks wrong frames (tale_of_the_tape at ts=3469/5627 instead of chart_stream at ts=1940/2904) — prefilter score calibration needed for mixed content
- `runQmgOcrBatch.js` hangs on prefilter phase for some dates; run dates individually if batch fails

**GT corrections (Oct 18)**:
- 20230518: add CVNA to GT
- 20230602: replace wrong GT (IOT/TEAM/MTCH not positions) with correct 12 tickers
- 20230609: add ARQQ and GSIT to GT

**Seed lexicon additions**: AROQ, ARCQ (ARQQ), OBTS (QBTS), GSII (GSIT), IOI (IOT), PLIR (PLTR)

**Why it was stuck at 10%**: Three compounding issues — Filter B clipping tickers, temporal boost biasing to intro cards, and 2023-era crop too narrow. All three needed fixing simultaneously.
