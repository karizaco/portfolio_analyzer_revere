---
name: qullamaggie-easyocr-breakthrough
description: Qullamaggie chart-stream OCR went from 25% recall (Tesseract) to 75% recall (EasyOCR + original-video crop + parser column-filter fix) on 20220606 — recorded for future Qullamaggie OCR work
metadata:
  node_type: memory
  type: project
  originSessionId: ba4fc76f-933d-43f8-addb-9ea105b4d328
  modified: 2026-10-24T13:14:22.160Z
---

# Qullamaggie chart-stream OCR: 25% → 100% recall breakthrough (2026-09-30 / 2026-10-01)

Verified pipeline results on Qullamaggie videos:
- Legacy baseline (per `docs/qmg-prefilter-comparison-2026-09-29.md`): 51% recall (NaN-fallback path)
- Tesseract path: 25% recall
- **EasyOCR + original-video crop + parser column-filter fix: 75% recall** (commit `d824431`)
- **+ multi-frame raw-OCR token voting: 100% recall** on 20220606 (8/8 GT) and 20220607 (7/7 GT) — commits `866bfa0`, `446b4de`, `8e88d8f`

## How to reproduce

```bash
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 \
  --date 20220606 \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 1 --fps 0.25 --prefilter-max-frames 6 \
  --ocr-engine easyocr
```

Captured tickers at 00:42:00: `[ALB, CBIO, COIN, GOVX, LABU, UCO, VLO, X]` → 6/8 GT matches.

## Three layered fixes (all required — no one alone works)

1. **Crop from ORIGINAL 1920px video, not the 1280px OCR-resolution frame.**
   EasyOCR's CNN is sensitive to anti-aliasing artifacts from the 1280→1345 downscale-then-upscale. The EasyOCR branch in `tools/scanVideoWithOcr.js` now uses `ffmpeg -ss <ts> -i <videoPath>` instead of `-i <ocr-resolution-frame>`. Required threading: `videoPath` and `timestamp` through `buildSnapshotCandidate` → `runChartStreamOcr`.

2. **Parser column detector picks wrong dominant_x for EasyOCR.**
   `identifyPositionListColumn` was finding `dominant_x=510` (chart-area header) instead of `~1218` (actual position-list column) because EasyOCR places word bounding boxes at different x-centers than Tesseract. **Fix in `src/parse/parseChartStream.js`**: removed the strict column-gated acceptance (`if (inListColumn && (inLexicon || priceNearby))`), replaced with `if (inLexicon || priceNearby)` (column-agnostic). Chart-area text ("SYM", "ARITH", "Cran", etc.) doesn't match the seed lexicon so it stays rejected.

3. **Prefilter picks intro/warmup frames by default.**
   Added `multiColStripeCountWeight: 20` (replacing earlier `maxColRowDensityWeight: 25`) in chart_stream profile in `src/video/ocrScanLogic.js`. Position list has 3 spread columns (ticker + price + change) × ~2-4 transitions each → ~3 columns with ≥2 transitions; intro frames concentrate in 1 column. The earlier `maxColRowDensity` was measuring max transitions in ONE column (rewards intro), not multi-column spread (rewards position list). Also fixed the broken `rowDensity` formula (was `max(0, weight - |rowD-target|/slope)` which always returned 0 because target=150 was unreachable).

## Key insights

- **Why EasyOCR > Tesseract for Qullamaggie**: EasyOCR's CNN (ResNet + BiLSTM + CTC) is trained on synthetic scene text — designed for UI overlays, small white text on dark panels. Tesseract's LSTM is document-trained. Qullamaggie position lists are scene text, not documents.
- **Why resolution matters for EasyOCR but not Tesseract**: Tesseract was bottlenecked by OCR garbling (`BGO` vs `GOVX` etc.) and never noticed the resolution issue. EasyOCR's CNN is sensitive to anti-aliasing artifacts from downscaling — pipeline cropping from the 1280px OCR-resolution frame produced garbage OCR. Crop from the original 1920px source.
- **Why column filter rejected everything with EasyOCR**: Same EasyOCR-vs-Tesseract word-position difference. Tesseract's positions triggered the column detector correctly. EasyOCR's positions put the dominant bucket at a chart-area header x instead of the position-list column.

## Why this is in memory

If I work on Qullamaggie OCR again, I should know:
- Default to `--ocr-engine easyocr` (75% vs 25% — huge difference)
- EasyOCR requires Python 3.11 (`C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe`)
- Tesseract is still the default for backward compat — production needs to opt in
- Pipeline preprocessing (crop, negate, contrast, sharpen) was tuned for Tesseract; EasyOCR uses simpler preprocessing (crop + scale only)
- The `--ocr-engine easyocr` flag added in commit `14fc3d3`
- The prefilter fix (multiColStripeCount replacing maxColRowDensity) in commit `c888a9c`
- The parser column-filter fix in commit `d824431`

## Related notes

- [[qullamaggie-position-table-profile]] — the table reader that supersedes this for the positions table
- [[qullamaggie-prefilter-improvement]] — earlier prefilter experiments (midToneRatioTicker)
- [[qullamaggie-scan-freeze-guidelines]] — how to run scans safely without freezing
- [[qullamaggie-ocr-crop-analysis]] — Qullamaggie position list crop region iteration history

## Multi-frame raw-OCR token voting (clusterRawOcrTokens)

After EasyOCR brings 75% recall, the remaining misses are mostly garbled
forms (BGO vs GOVX, Tan vs TNA, NFU vs NFLX). The parser's per-frame
scoring can't recover them because each frame's garbled forms differ.

**Approach**: collect RAW ticker-shape tokens from each frame's OCR text,
group them via Union-Find by edit-distance ≤ `maxDistance` (default 1),
pick a canonical per cluster (preferring seed-lexicon match → longest
ticker at equal edit distance → alphabetical).

Verified end-to-end:
- 20220606: 8/8 GT (100%) — including GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX
- 20220607: 7/7 GT (100%) — including NFLX recovered from NFU+NFL cluster
- 20220608: 8/8 GT (100%) — including SIGA, TNA, VLO, UCO, NFLX, ALB, BOIL, AERC

3 videos × 23 GT tickers → 23/23 (100% recall).

FPs per video: 9, 23, 29 (all real tickers in the seed lexicon, just not in
the specific video's GT). For Qullamaggie position-list extraction, recall > precision.

**Trade-off**: clusterer is permissive (recall-focused). On 20220607 it
returns 23 FPs that are real tickers in the seed lexicon but not in this
video's GT. For Qullamaggie position-list extraction, missing a GT ticker is
much worse than including a plausible wrong one — the user can sanity-
check by viewing the captured frame. Recall >> precision here.

**Key code locations**:
- `src/parse/parseChartStream.js`:
  - `clusterRawOcrTokens(frameTexts, options)` — main entry point
  - `findCloseTickerMatch(token, lexicon)` — lexicon edit-distance lookup (prefers longer ticker at equal distance)
- `tools/scanVideoWithOcr.js`:
  - `merged_raw_token_list` field in scan log output
  - Voting input comes from `scanResult.candidates` (the RAW candidates), **not**
    `scanResult.topCandidates`. The top candidates are summaries and spell the
    field `chart_stream`; the raw candidates spell it `chartStream`. Reading
    the camelCase field off the summaries was always `undefined`, so the
    clusterer's input was empty and Filter A never ran — it was dormant from
    2026-10-11 until it was fixed on 2026-10-24 (commit `bdd4dbc`). A future
    session that reads the clusterer's input should check this spelling.

**Pipeline stages** (full chart-stream):
```
ffmpeg -ss <ts> -i <video>  →  ffmpeg crop+scale 1345
                            →  EasyOCR (Python subprocess)
                            →  parseChartStreamPositionList (per-frame)
                            →  clusterRawOcrTokens across all OCR'd frames
                            →  merged_raw_token_list (the canonical output)
```

**How to reproduce**:
```bash
node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 \
  --date 20220606 \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --max-captures 3 --fps 0.25 --prefilter-max-frames 3 \
  --ocr-engine easyocr
```

→ Captured frame at 00:42:00, merged_raw_token_list = 8/8 GT + 9 FPs.
→ Same setup on 20220607: 7/7 GT + 23 FPs.

**What this is in memory for**: if I work on Qullamaggie OCR again, the clusterer
is the breakthrough — it goes from 75% (single-frame best) to 100%
(multi-frame consensus). The key insight is that garbled OCR reads (Tan,
NFU, BGO) need to be matched against the SEED LEXICON, not against each
other — the clusterer uses `findCloseTickerMatch` to bridge the gap.

## The `position_table` profile supersedes this for the positions table (2026-10-24)

The Qullamaggie position list is a TradingView GUI **table**, not a chart
overlay, and there are two layouts (2022-era floating panel bottom-right;
2023-era right sidebar at x 1606-1739, y 444-708 of 1920x1080). The
`chart_stream` profile above only ever saw the first one, and it trades
precision for recall (9-29 FPs per video, all real tickers that merely are
not in that video's GT).

`--prefilter-profile position_table` (commit `bdd4dbc`) reads the table
properly: source-resolution frames, a wide title probe to identify which
table is the positions table, then a narrow ticker-column read decoded
against the lexicon. On 20220222 it read NRGU/DVN/MOS/COPX/TQQQ/FCX/TSLA
= **100% recall AND 100% precision**, with `verified: true` on both
captures. Full rules and geometry: `docs/qmg-positions-layout-findings.md`
and the `position_table` section of CLAUDE.md.

Use the `position_table` profile for new Qullamaggie work; the
`chart_stream` profile above remains the fallback and the legacy path.
