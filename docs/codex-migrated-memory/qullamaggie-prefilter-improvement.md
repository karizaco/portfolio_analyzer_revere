---
name: qullamaggie-prefilter-improvement
description: "MidToneRatioTicker prefilter feature, weight tuning, GT video rerun results, scan timeout issues"
metadata:
  node_type: memory
  type: project
  originSessionId: 0e51feae-906c-425a-988a-f2ef09fd994d
  modified: 2026-09-29T03:23:25.698Z
---

# Qullamaggie Prefilter Improvement (2026-09-22 to 2026-09-23)

## What was done

### New feature: midToneRatioTicker (in summarizeLumaBuffer)
- Counts ratio of pixels in brightness range 51-150 within bottom-right ticker rectangle (x≥0.85, y≥0.55 of frame)
- Qullamaggie position list frames: 0.5-0.85 (gray ticker text on dark bg)
- Google Drive / browser overlays: 0.0-0.05 (different overlay colors)
- Distinguishes "position list visible" from "high-contrast distraction"

### New feature: rowDensity in ticker region
- Counts dark-to-bright transitions within ticker rectangle
- 10-15 transitions = real position list rows

### Tuned chart_stream profile weights
- brightWeight: 12 → 4
- darkWeight: 8 → 3
- edgeWeight: 8 → 3
- stdDevWeight: 6 → 3
- **midToneWeight: 0 → 30** (new dominant signal, linear reward)
- rowDensityWeight: 10 (kept as secondary)

### Test results on 3 frames
| Frame | midTone | Score | Verdict |
|---|---|---|---|
| GOOD qmg_20220323.png | 0.83 | 13.97 | ✅ |
| GOOD qmg_20220428.png | 0.67 | 16.02 | ✅ |
| BAD t=1644 (Google Drive overlay) | 0.00 | 1.75 | ❌ rejected |

### End-to-end test on 20220323
- 2 captures saved
- Capture 1 at ts=1200, score=30.85: detected 12 tickers (BOIL, COPX, KWEB, NUGT, REGN, URA, URNM, WEAT, X correct + some FPs)
- Google Drive frame no longer picked — prefilter correctly prefers frames with position list visible

---

## GT video rerun (all 40 videos)

### Setup
- Script: `tools/scanAllGtVideos.js` — ran full pipeline on all 40 GT dates
- Timeout: 600s per scan
- Parameters: `--fps 0.5 --max-captures 5`

### Results
- Most scans **timed out** at 600s (scans take 10+ minutes each)
- 40 videos × 10 min = ~6.6 hours — too slow for practical iteration
- 20220218: new prefilter found AMD, BE, DBRG, DVN, MP, PL, PSX, UST, X — GT was [TQQQ, MOS, FCX, EWMC, COPX] — Trade-Ideas UI failure mode (already documented)

### Remaining issues
- FPs: ARM, BKR, ON, NG — chart-area text picked up by legacy parser
- OCR ceiling: Tesseract garbles dense ticker text
- Trade-Ideas UI failure on some videos
- Scan speed too slow for full GT rerun

## Next steps (suggested)
1. Reduce scan time (fewer frames, faster fps) to enable full GT rerun
2. Add background denoising for OCR step
3. Address Trade-Ideas UI failure mode on specific videos
