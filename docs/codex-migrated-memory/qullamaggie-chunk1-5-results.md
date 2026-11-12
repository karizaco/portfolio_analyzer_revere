---
name: qmg-chunk1-5-results
description: "EasyOCR low-cpu results for 25 Qullamaggie dates (chunks 1-5), Feb-May 2022, recall avg ~18%, GT accuracy issues found"
metadata:
  node_type: memory
  type: reference
  modified: 2026-10-11T18:04:36.991Z
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
---

# Qullamaggie EasyOCR Low-CPU Results — Chunks 1–5 (2026-10-11)

Run tag: `qmg-easyocr-20261011` — 5 videos/chunk, `--low-cpu --parallel 1`
Engine: EasyOCR, `--fps 0.25 --prefilter-max-frames 6 --max-captures 3`

---

## Chunk 1 (Feb–Mar 2022)

| Date | Recall | Hits | Misses | FPs |
|-----|--------|------|--------|-----|
| 20220218 | 9% (1/11) | TSLA | UPST,DVN,NRGU,MOS,TQQQ,FCX,DWAC,COPX,ROKU,DCX | 0 |
| 20220222 | 12% (1/8) | TSLA | NRGU,DVN,MOS,COPX,TQQQ,FCX,NDGU | 0 |
| 20220301 | 18% (2/11) | FCX, MP | 9 missed | 1 (X) |
| 20220302 | 14% (1/7) | FCX | NUGT,X,ERX,EDV,COPX,AGQ | 0 |
| 20220318 | 43% (3/7) | COPX, REGN, URA | NUGT,FCX,URNM,KWEB | 0 |

## Chunk 2 (Mar–Apr 2022)

| Date | Recall | Hits | Misses | FPs |
|-----|--------|------|--------|-----|
| 20220321 | 25% (2/8) | COPX, NUGT | DIDI,URNM,REGN,FCX,NUZE,X | 0 |
| 20220323 | 0% (0/11) | — | merged empty (timeout) | 0 |
| 20220330 | 25% (2/8) | COPX, LABU | NFLX,KWEB,REGN,X,NUGT,FCX | 0 |
| 20220331 | 25% (2/8) | COPX, FCX | KWEB,SPXL,TQQQ,X,REGN,NUGT | 0 |
| 20220405 | 9% (1/11) | JNUG | CWEB,REGN,KWEB,GGPI,TAN,NEM,COPX,FCX,NUGT,X | 0 |

## Chunk 3 (Apr 2022)

| Date | Recall | Hits | Misses | FPs |
|-----|--------|------|--------|-----|
| 20220406 | 12% (1/8) | NEM | X,FCX,REGN,COPX,NUGT,LHX,LMT | 0 |
| 20220412 | 27% (3/11) | FCX, URA, URNM | LHX,LMT,WEAT,X,COPX,REGN,NUGT,JNUG | 0 |
| 20220413 | 0% (0/11) | — | merged empty (timeout) | 0 |
| 20220414 | 27% (3/11) | COPX, URA, URNM | NUGT,JNUG,WEAT,GUSH,X,REGN,FCX,LMT | 0 |
| 20220418 | 17% (2/12) | COPX, FCX | VERU,WEAT,URA,URNM,LMT,REGN,GUSH,X,NUGT,JNUG | 0 |

## Chunk 4 (Apr 2022)

| Date | Recall | Hits | Misses | FPs |
|-----|--------|------|--------|-----|
| 20220419 | 14% (2/14) | URA, URNM | VERU,REGN,JNUG,LMT,NUGT,X,COPX,WEAT,FCX,GUSH,BOIL,KOLD | 0 |
| 20220421 | 19% (3/16) | REGN, URA, URNM | FCX,JNUG,NUGT,COPX,WEAT,VERU,X,GUSH,LAC,UCO,FTNT,BOIL,TSLA | 0 |
| 20220425 | 25% (1/4) | BOIL | KOLD,WEAT,VERU | 0 |
| 20220426 | 0% (0/2) | — | merged empty | 0 |
| 20220427 | 0% (0/4) | — | GT: FAULL(garbled),LABU,NUGT,SOXL,UVXY,WEAT all missed; BOIL,TSLA are FPs | 2 (BOIL, TSLA) |

## Chunk 5 (Apr–May 2022)

| Date | Recall | Hits | Misses | FPs |
|-----|--------|------|--------|-----|
| 20220428 | 0% (0/4) | — | CWEB,KWEB,TSLA,WEAT all missed | 4 (CWEB,DO,KWEB,WEAT) |
| 20220429 | 0% (0/5) | — | merged empty (timeout) | 0 |
| 20220506 | 75% (3/4) | LTHM, TSLA, WEAT | UCO missed | 0 |
| 20220510 | 0% (0/3) | — | **GT IS WRONG**: GT says LABU/TNA but video actually had TSLA+VRM. OCR found TSLA+VRM correctly. | 2 (TSLA, VRM — these are actually correct) |
| 20220517 | 0% (0/7) | — | FNGU,TQQQ,OXY,COIN,ERX,AR,WEAT all missed | 0 |

---

## Running Totals (Chunks 1–5, 25 dates)

| Metric | Value |
|--------|-------|
| Dates with ≥1 hit | 13/25 |
| Dates with 0 hits | 12/25 |
| Total timeouts | 3 (20220323, 20220413, 20220429) |
| Total false positives | 10 (across 4 dates) |
| Dates with zero FPs | 21/25 |

**False positive breakdown:**
- 20220427: BOIL, TSLA — real tickers, not in that video's GT
- 20220428: CWEB, DO, KWEB, WEAT — `DO` is garbled OCR; CWEB/KWEB/WEAT are real but not in that video
- 20220510: TSLA, VRM — OCR is CORRECT; GT is wrong

**Timeouts:** 20220429 (20 min kill), 20220413 (20 min kill), 20220323 (20 min kill)

## Ticker Hit Frequency (across all 25 dates)

| Ticker | Hits |
|--------|------|
| COPX | 8 |
| FCX | 6 |
| URA | 5 |
| URNM | 4 |
| TSLA | 3 |
| NUGT | 2 |
| REGN | 2 |
| BOIL | 1 |
| JNUG | 1 |
| LABU | 1 |
| LTHM | 1 |
| MP | 1 |
| NEM | 1 |
| WEAT | 1 |
| X | 1 |

## Root Cause Analysis

1. **GT accuracy issues are a major factor.** At least 3 GT entries appear wrong:
   - 20220510: GT says LABU/TNA, video had TSLA+VRM (OCR correct)
   - 20220427: GT has `FAULL` (garbled text, not a real ticker)
   - 20220428: GT says CWEB/KWEB/TSLA/WEAT, but none of those were in the video's position list

2. **The prefilter consistently selects wrong frames.** `chartStream.position_list` is undefined for most captures — the column filter finds no price-aligned tickers in garbled OCR text. The `meanLumaFloor=30` penalty likely fires on dark-era overlays, suppressing position-list frames.

3. **COPX is the most reliably found ticker** (8/25 dates) — appears to be the brightest/highest-contrast in the position-list overlay across this era.

4. **Recall floor without prefilter recalibration:** Without fixing the prefilter or GT accuracy, meaningful recall improvement is not possible for most dates.

## Next Steps

1. **Verify GT accuracy** — check video timestamps for 20220427, 20220428, 20220510 against GT labels before trusting any recall numbers
2. **Recalibrate prefilter** for dark-era videos: lower or remove `meanLumaFloor` penalty, widen the crop slightly
3. **Increase `--prefilter-max-frames`** from 6 to 12+ to evaluate more candidates per video
4. **Add `DO` (garbled from chart noise) to the ticker blocklist** — it appeared as a "ticker" on 20220428
