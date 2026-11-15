# EasyOCR Garbling Analysis -- Plan

## Context

Analysis of probe logs from data/video_scan_test/_rerun/qmg-easyocr-20261017/ocr_probe/logs/
(8 snapshot JSON files covering dates: 20220413, 20220607, 20220608, 20221104,
20230126, 20230518, 20230522, 20230523, 20230602, 20230605, 20230608, 20230609)
plus full reading of src/parse/parseChartStream.js.

---

## Finding 1: Wrong OCR Engine (Directory Name Is Misleading)

Every probe log shows tesseract_version: 6.0.1 and ocr_profile: empty string.
The directory is named qmg-easyocr but Tesseract 6.0.1 is running, NOT EasyOCR.
All garbling patterns are produced by Tesseract 6.0.1.

Action: Rename directory to qmg-tesseract-20261017 or clarify in docs.

---

## Finding 2: Column Filter Permanently Disabled

Every capture has column_filter: null -- the column filter never fires.

X_POSITION_LIST_MIN = round(1150 * (cropWidth / 750))
With EasyOCR crop width 1340px: threshold = 2058px.
The actual position-list column sits at x approx 450px. Since 450 < 2058,
identifyPositionListColumn returns early with inListTickers = [] (disabled).

The parser always falls back to lexicon + price-nearby path (lines 490-527),
bypassing the column-position structural check entirely.

Action: Calibrate X_POSITION_LIST_MIN for the actual Tesseract crop geometry.

---

## Finding 3: Garbling Is Character-Level (Not Structural)

The position list IS visible in OCR output. Characters are consistently swapped.
Dominant substitution set: T<->I, N<->M, O<->0, L<->1/I, S<->5, B<->8, Z<->2.

Key garbling examples found in probe logs:

| OCR Output | Likely Correct | Edit Distance | Notes |
| --- | --- | --- | --- |
| INA | TNA | 1 (I->T) | TNA = Direxion Daily Tech Bull 3x |
| 1c | IC | 1 (1->I) | 20230523 frame 200 |
| Z.M / ZM | ZM | 1 (removing dot) | Zoom in 20230522 |
| RgI | RGI | 1 (g->G) | 20230602 |
| APLd | APLD | 1 (d->D) | 20230602 |
| TI5SM | TISM or noise | multiple | garbled beyond recovery |

---

## Finding 4: TNA Missed as INA (GOVX, NFLX, LABU Not Found)

TNA (Direxion Daily Tech Bull 3x) appears garbled as INA in:
- 20220607 frame 592: INA OSar accepted, TNA never recovered
- 20220608 frame 154: INA 0f5 411S 7,59

Edit distance INA->TNA = 1. MAX_OCR_EDIT_DISTANCE = 2, so correction is in range.
However, findCloseTickerMatch only fires for in-column tokens.
Since column filter is disabled, INA is never corrected to TNA.

GOVX, NFLX, LABU: Not present in any of the 8 probe log files.
These tickers may appear in different videos, or be garbled beyond recovery.

Action: Add a post-clustering correction pass that runs findCloseTickerMatch
on ALL accepted tokens, not just in-column ones.

---

## Finding 5: NFU Rejected Despite Price Nearby

20220607 frame 592: NFU Jan Sik 5,34 -- NFU is in tickers_rejected_list.
Price 5,34 is within 13 chars of NFU, within 25-char window.

Root cause: NFU is NOT in the seed lexicon and column filter is disabled.
The hasPriceNear check only fires AFTER a token passes the column filter
or is in the lexicon. For non-lexicon tokens without column-filter support,
NFU is rejected outright.

hasPriceNear regex: digit followed by comma digits matches 5,34 correctly.
The regex is fine -- the issue is that NFU never reaches hasPriceNear
because it fails the lexicon + column-filter gate.

Action: Add NFU to seed lexicon. Move hasPriceNear to be a primary gate
for non-lexicon tokens that pass STRICT_TICKER_PATTERN.

---

## Finding 6: Accepted Tickers That Are Likely Non-Tickers

Lexicon + price-nearby fallback accepts tokens that are chart noise garbled
beyond recognition. Examples: OSA, OSAR, SIK, JUC, ZE, OD, TIAM, DAM, OUA,
CD, KON, HA, HJE, LJM, KIAE, LM, ASM, JIAS, AOU, JZU, LOK, IAM, LOM, OT, KT.

These pass STRICT_TICKER_PATTERN and have nearby prices, but are not real tickers.
The column filter exists to solve this -- re-enabling it (Finding 2) would help.

---

## Priority 1: Re-enable Column Filter with Correct Threshold

X_POSITION_LIST_MIN formula is wrong for Tesseract crop geometry.

ocr_frame_width: 1280 in all logs suggests Tesseract scales to 1280px.
At that scale, position-list column at x=450 (1920p) becomes x=300.
A threshold of 200-250px might work.

But more fundamentally: the phash_region_fraction 0.86,0.55,0.14,0.45
covers x=[1651,1920] at 1920p -- the position-list column at x=450
is NOT in the crop at all. The column filter cannot work structurally
unless the crop is widened to include the position-list column.

Two options:
(a) Widen crop to include x=450 (use 0.22,0.55,0.70,0.45)
(b) Accept that column filter cannot work and rely on lexicon + price-nearby

---

## Priority 2: Fix TNA->INA Correction (Post-Clustering Edit-distance)

Add a correction pass after clustering in parseChartStream.js that runs
findCloseTickerMatch on ALL accepted tokens, not just in-column ones.
This converts INA->TNA (dist=1), catches similar 1-2 char errors.

---

## Priority 3: Add Missing Tickers to Lexicon

Add NFU and other leveraged ETFs that appear in QMG watchlists:
NFU, NFO, BNO, UO, LABU, GOVX, TNA, YINN, SOXL, TECL, EDC, DPST, NAIL, DRN, RUSL, WEAT

---

## Priority 4: Move hasPriceNear to Primary Gate

Currently hasPriceNear only fires for column-filtered (in-list) tokens.
For non-lexicon tokens, it never runs.

Change the gate logic so that any token passing STRICT_TICKER_PATTERN
goes through hasPriceNear if not in lexicon -- making it a primary filter
rather than secondary.

---

## Priority 5: Verify GOVX, NFLX, LABU in Other Videos

GOVX, NFLX, LABU were not found in any probe log. Search full OCR corpus.

---

## NOT Recommended

- Relaxing MAX_OCR_EDIT_DISTANCE beyond 2: risk of over-correction
- Removing STRICT_TICKER_PATTERN: would flood output with single letters
- Disabling lexicon check entirely: would accept all uppercase tokens

---

## Files to Modify

| File | Change |
| --- | --- |
| src/parse/parseChartStream.js | Priorities 1, 2, 4 |
| src/parse/tickerLexicon.js (or seed file) | Priority 3: Add NFU, leveraged ETFs |
| data/video_scan_test/_rerun/qmg-easyocr-20261017/ | Rename to reflect Tesseract |

---

## Verification

1. After adding NFU to lexicon + post-clustering correction:
   Re-run 20220607: NFU should appear, INA should correct to TNA
2. After fixing column filter threshold:
   Check that inListTickers is no longer empty, false-positive rate decreases
3. Check GOVX, NFLX, LABU in GT videos where they are expected tickers
