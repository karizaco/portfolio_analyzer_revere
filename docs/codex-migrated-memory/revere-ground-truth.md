---
name: revere-ground-truth
description: Ground truth files for Revere and Qullamaggie OCR evaluation
metadata:
  node_type: memory
  type: reference
  originSessionId: 85592b5a-0751-4168-87a4-d5984b62b725
  modified: 2026-10-03T17:29:52.631Z
---

# Ground Truth Files

## Revere
- **File:** `data/revere_ground_truth.json`
- **Format:** `{ dateKey: { frameId: { gro: [...], turbo: [...] } } }`
- **Source:** User-provided from visual inspection of captured frames
- **Dates covered:** 20260922, 20260923, 20260924, 20260928
- **How to use:** Load and compare against positional parser `tickers_from_bbox` output

## Qullamaggie
- **File:** `data/qmg_ground_truth.json`
- **Format:** `{ dateKey: { captureIndex: [tickers...] } }`
- **Source:** Verified by visual inspection of crop_comparison.html snapshots
- **Dates covered:** 20220323 through 20230609 (many dates)
- **Note:** `_meta` field documents crop coordinates and per-capture variants

## Key bug found
In `parseWhiteboardScreenshotWithBoxes.js`, the `buildRows` function calls `extractTickersNearLabel` but **never uses its return value** (`t.tickers`) to populate `holdingsTickers`. Result: `tickers_from_bbox` is always `[]` even when the parser correctly finds GRO/TURBO rows.

```javascript
// Current (BROKEN):
const tickerResult = extractTickersNearLabel({ rows, labelRow: row, windowBounds, lexicon });
rows.push({ portfolio, holdingsRow: row, ... });
// tickerResult.tickers is NEVER captured!

// Fix: capture and use tickerResult.tickers
const { tickers: holdingsTickers } = extractTickersNearLabel({ rows, labelRow: row, windowBounds, lexicon });
rows.push({ portfolio, holdingsRow: row, tickers_from_bbox: holdingsTickers, ... });
```
