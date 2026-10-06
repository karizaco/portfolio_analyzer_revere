# QMG EasyOCR Statistical Analysis (Saved Rerun Logs)

Date: 2026-10-01

## Scope

- Source logs: `data/video_scan_test/_rerun/**/ocr_probe/logs/*.json`
- Curated sample size: 20 logs across 6 known GT dates (20220606, 20220607, 20220608, 20220614, 20221117, 20230126)
- Ground truth: `data/qmg_ground_truth.json`
- Metric per capture:
  - Recall = `TP / GT_count`
  - FP count = predicted tickers not in GT for that capture index

## Important Data Caveat

Many logs in easyocr-labeled folders still report `ocr_engine_metadata` for Tesseract only. For this analysis, engine grouping is:

- `tesseract`: run tags without easyocr markers
- `easyocr_labeled`: run tags containing `easyocr` or `cross_test_v30`

So these are operational labels from run naming, not fully reliable engine provenance in metadata.

## Aggregate Results (20 curated logs)

From `data/video_scan_test/_rerun/_curated_summary.json`:

- All logs: 20 logs, 29 captures, mean recall 0.2063, total FP 102
- Tesseract group: 17 logs, 26 captures, mean recall 0.1587, total FP 96
- EasyOCR-labeled group: 3 logs, 3 captures, mean recall 0.6190, total FP 6

Interpretation: easyocr-labeled runs are materially better on recall in this sample (~0.62 vs ~0.16), even with the metadata ambiguity.

## Crop Region Pattern

- Crop `0.86,0.55,0.14,0.45`:
  - 19 logs, 28 captures, mean recall 0.2092, total FP 96
- Crop `0.86,0.55,0.14,0.40`:
  - 1 log, 1 capture, mean recall 0.1250, total FP 6

Conclusion: in this rerun set, `h=0.45` outperforms `h=0.40`.

## Best and Worst Timestamp Windows

Top capture timestamps by observed mean recall in this sample:

1. `20220606 00:42:00` -> recall 0.75
2. `20220607 00:19:48` -> recall 0.7143
3. `20220606 00:16:52` -> recall 0.625 (seen in 2 logs)
4. `20220607 00:39:36` -> recall 0.5714
5. `20220607 00:29:36` -> recall 0.5714

Low reliability timestamps (example):

- `20221117 00:49:40` -> recall 0.0
- `20220614 00:14:40` -> recall 0.0

Practical takeaway: timestamp quality dominates outcomes; preserving strong prefilter ranking is as important as OCR engine choice.

## Does the Position List Change During a Video?

Yes, but change level differs by day/video.

- `cross_test_v30_20220607`: pairwise Jaccard between 2 captures = 0.7143 (fairly stable)
- `final_v29_20220606`: pairwise Jaccard between 2 captures = 0.5556 (moderate drift)
- `rerun_20230126`: average pairwise Jaccard across 3 captures = 0.0476 (high drift / unstable extraction)

Interpretation: multi-frame fusion helps most when overlap is moderate; when overlap collapses (near-zero), timestamp/parse quality must be fixed first.

## Per-run Signals Worth Tracking

- `no_col_filter_v25_20220606`: recall 0.75 with 2 FP (strong single-capture result)
- `cross_test_v30_20220607`: avg recall 0.6429 with 3 FP across 2 captures
- Several rerun logs (`rerun_20220607`, `rerun_20220614`, `rerun_20221117`) remain at recall 0, indicating frame selection and/or parser gating failure, not just OCR character quality.

## Recommendation

Prioritize this order:

1. Ensure consistent EasyOCR execution path and metadata tagging.
2. Preserve crop at `0.86,0.55,0.14,0.45` for chart-stream unless revalidated.
3. Improve candidate timestamp selection on low-recall dates before adding parser complexity.
4. Use multi-frame voting as a second-stage recovery, not as a substitute for good candidate selection.
