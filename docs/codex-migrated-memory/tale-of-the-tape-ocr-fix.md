---
name: tale-of-the-tape-ocr-fix
description: "Revere's tale_of_the_tape layout has Positions table center-right, not bottom-right; new profile + crop fixes targeting"
metadata:
  node_type: memory
  type: project
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
  modified: 2026-10-16T10:45:38.961Z
---

# tale_of_the_tape OCR Fix (Revere)

## Root Cause
Recent Revere videos (H7FxO8A92VI and others from 2026) use the **tale_of_the_tape** screen layout, NOT the classic Revere whiteboard format. In tale_of_the_tape:
- The **Positions table** sits in the **center-right** of the frame (x≈50-87%, y≈58-97%)
- The classic chart_stream crop `0.86,0.55,0.14,0.45` captures the chart area, missing the Positions table entirely

Note: Qullamaggie's chart_stream layout still uses the bottom-right position list. The tale_of_the_tape profile is for Revere only.

## Fix Applied
1. **New prefilter profile `tale_of_the_tape`**: targets center-right stats region, lower threshold (6)
2. **New crop `TALE_OF_THE_TAPE_CROP_FRACTION = '0.50,0.55,0.45,0.43'`**: captures center-right where Positions table sits in Revere's tale_of_the_tape format
3. **Comma-decimal support**: EasyOCR reads European decimal format (7,36) as well as US format (14.86) — fixed `hasPriceNear` regex and `identifyPositionListColumn` price token regex
4. **`tale_of_the_tape` auto-enables `--chart-stream-parser`**

## Files Changed
- `src/video/ocrScanLogic.js`: added `tale_of_the_tape` PREFILTER_PROFILES entry
- `src/video/ocrScanArgs.js`: added `TALE_OF_THE_TAPE_CROP_FRACTION`, help text, profile validation, auto-parser logic
- `src/parse/parseChartStream.js`: comma-decimal price patterns in `hasPriceNear` and `identifyPositionListColumn`

## Verified Result
On 20230609 (VdQSDGZBLQE) — Revere video with tale_of_the_tape format:
- Old (chart_stream crop): `position_list: ["ROSOR"]` — wrong column, chart-area garbage
- New (tale_of_the_tape crop + EasyOCR): `position_list: ["A","AROQ","ATR","JNUG"]` — ATR + AROQ correctly captured from Positions table
- Remaining recall gap (CVNA, RGTI, QBTS, INGN, IOT, ARQQ) is purely EasyOCR garbling on this video — not a parser issue

## Usage
```bash
# For Revere tale_of_the_tape videos (center-right positions):
node tools/scanVideoWithOcr.js --video <path> --date <date> \
  --prefilter-profile tale_of_the_tape --chart-stream-parser \
  --ocr-engine easyocr --max-captures 1 --fps 0.25 --prefilter-max-frames 6

# For Revere whiteboard videos:
node tools/scanVideoWithOcr.js --video <path> --date <date> \
  --prefilter-profile whiteboard --output-kind whiteboard \
  --ocr-engine tesseract --max-captures 3 --fps 0.25 --prefilter-max-frames 8

# For Qullamaggie chart_stream videos (classic bottom-right positions):
node tools/scanVideoWithOcr.js --video <path> --date <date> \
  --prefilter-profile chart_stream --chart-stream-parser \
  --ocr-engine easyocr --max-captures 1 --fps 0.25 --prefilter-max-frames 6
```

## Open Issue
The tale_of_the_tape crop + EasyOCR produces garbled OCR on some frames where the complex background (chart candles + UI chrome) confuses EasyOCR's CNN. The correct crop is confirmed. This is a source quality limitation, not a parser bug.
