# Qullamaggie Prefilter Comparison — 2026-09-29

## TL;DR

The new `chart_stream` prefilter (introduced in commit `37a5dfc`, with
`midToneRatioTicker` + `rowDensity` features) is **substantially worse than
the legacy baseline** on the 6 "validated GT" Quullamaggie videos:

| Metric | Legacy baseline (qmg-1080p-ocr-v2) | New prefilter (this run) |
|---|---|---|
| Total GT tickers | 41 | 41 |
| Correct (in GT) | 21 | 2 |
| **Recall** | **51%** | **5%** |
| False positives | 74 | 45 |
| Captures | 18 | 13 |

The new prefilter finds frames with **non-position-list content** (chart-area
text, browser chrome) instead of frames with the position list visible.

## Per-video results

| Date | GT | Legacy Rec | New Rec | Legacy FP | New FP |
|---|---|---|---|---|---|
| 20220606 | 8 | 50% (4: ALB,GOVX,NFLX,TNA) | **0%** | 10 | 8 |
| 20220607 | 7 | 57% (4: ALB,LTHM,NFLX,TNA) | **0%** | 9 | 14 |
| 20220608 | 9 | 44% (4: AERC,LTHM,NFLX,TNA) | **0%** (0 captures) | 19 | 0 |
| 20220614 | 3 | 33% (1: UVXY) | **0%** | 9 | 9 |
| 20221117 | 6 | 50% (3: ASML,FREY,U) | **0%** | 11 | 5 |
| 20230126 | 8 | 62% (5: FCX,GNS,MDGL,TNA,YINN) | 25% (2: MDGL,TNA) | 16 | 9 |

## Methodology

### Legacy baseline (`qmg-1080p-ocr-v2`, 2026-09-23)

- Stored probe logs at `data/video_scan_20260923/qmg-1080p-ocr-v2/`.
- Run command:
  ```
  node tools/scanVideoWithOcr.js --prefilter-profile chart_stream \
    --chart-stream-parser --basename qmg --output-kind snapshot \
    --fps 0.25 --output-root ... --run-tag qmg-1080p-ocr-v2
  ```
- Note: **legacy run logged "best prefilter NaN"** for every frame in console.
  Probe JSON has `prefilter_score: null` (JSON serialization of NaN). Captures
  were selected using fallback threshold (`bestPrefilter.prefilterScore || 18`,
  `tools/scanVideoWithOcr.js:1145`).

### New prefilter (this run, 2026-09-29)

- Same code (commit `37a5dfc`), now producing finite scores
  (verified `scoreFramePrefilter` returns valid numbers on real frames).
- Run command:
  ```
  node tools/scanAllGtVideos.js --dates 20220606,20220607,20220608,20220614,20221117,20230126 \
    --parallel 3 --fps 1 --max-captures 3 --prefilter-max-frames 12
  ```
- Difference from legacy: **fps 1 vs 0.25** (4× more sample frames), **`--prefilter-max-frames 12`** (caps OCR candidates at 12 vs default ~60).

### Recall computation

```
recall = |captured tickers ∩ GT tickers| / |GT tickers|
FPs     = |captured tickers ∖ GT tickers|  (unique)
```

Script: `data/_summarize_existing.py` — accepts a base dir + date list.

## Why is the new prefilter worse?

### 1. **Aggressive midToneRatioTicker weighting**

The new chart_stream profile rewards frames with high mid-tone pixel ratio in
the bottom-right ticker rectangle. But **chart-area text and y-axis labels**
also produce mid-tone pixels in that rectangle. The prefilter now prefers
frames with bright chart text over frames with the actual position list (which
is darker overall with white text).

### 2. **Over-reward on `darkRatio` target**

`darkTarget: 0.55, darkSlope: 20` — chart frames with <50% dark pixels are
penalized. Position list frames are typically 70-90% dark, but mid-frame
transitions to bright chart areas can push them above the target, getting
penalized.

### 3. **`--prefilter-max-frames 12` starvation**

The legacy run fed ~60 frames to OCR. The new run caps at 12. With fewer OCR
candidates, the parser has fewer chances to hit a position-list frame, and
`pickTopDistinctCandidates` falls back to lower-scoring frames that may be
chart-area-only.

### 4. **`--fps 1` extracts 4× more sample frames but midToneRatioTicker bias means the wrong ones win**

At fps=1 vs 0.25, we get ~4× more prefilter candidates. With 12 OCR slots and
`midToneRatioTicker` bias toward bright-chart-frames, the budget gets spent
on the wrong frames.

## Honest assessment

The previous Claude session's "Option B" prefilter (midToneRatioTicker +
rowDensity) **regressed overall recall from 51% to 5%** on the validated GT
set. The earlier 3-frame end-to-end test that showed 9/11 recall was on a
**single video with a known-good position list UI** — not representative of
the full corpus.

The previous "discrimination" claim (good frames scored 21-27, bad Google
Drive frame scored 1.75) was real — the new prefilter **does** reject obvious
distractors. But it now **prefers the wrong kind of "good" frame**.

## Recommended fixes (NOT applied)

| Fix | Expected impact |
|---|---|
| Revert `midToneRatioTicker` weight from 30 → 5 (was meant to dominate but now swamps) | Re-balance toward legacy behavior |
| Raise `--prefilter-max-frames 12` to default (~60) | Give OCR more chances to hit a position list |
| Add a **negative gate** when chart-text Tickers are detected in the crop region (low chart-area vs position-list discriminator) | Reject chart-area false frames |
| Test `darkRatio` ceiling for chart-stream — current 0.92 may let in chart text | Tighter dark ratio band |

## Files

- Wrapper: `tools/scanAllGtVideos.js` (modified for parallelism + correct GT recall)
- Aggregator: `data/_summarize_existing.py` (correct recall / FP counting)
- Old run probe logs: `data/video_scan_20260923/qmg-1080p-ocr-v2/`
- New run probe logs: `data/video_scan_test/_rerun/`
- Comparison raw data: `data/video_scan_test/_rerun_6gt_v2.log`

## How to reproduce

```bash
# New prefilter
node tools/scanAllGtVideos.js \
  --dates 20220606,20220607,20220608,20220614,20221117,20230126 \
  --parallel 3 --fps 1 --max-captures 3 --prefilter-max-frames 12

# Summarize
py -3 data/_summarize_existing.py data/video_scan_test/_rerun rerun_

# Compare against legacy
py -3 data/_summarize_existing.py data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2 -
```