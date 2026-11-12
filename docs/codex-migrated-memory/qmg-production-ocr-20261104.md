---
name: qmg-production-ocr-20261104
description: "RESUME POINT — the QMG EasyOCR production batch planned for 2026-11-04 (target dates, exact flags, why those dates)"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-04T10:49:19.410Z
---

**DONE 2026-11-04 — all four dates scanned. Outcome:**

| date | result |
|---|---|
| 20231201 | done, 8 tickers (no GT) |
| 20231215 | done, 11 tickers (no GT) |
| 20230518 | done, 7/8, FP `U` |
| 20230601 | 12-frame run TIMED OUT at 2400 s (no log). Retry at `--prefilter-max-frames 6 --max-captures 1` (run tag `qmg-easyocr-20261104-prod-6frames`) finished: **9/9 of the old GT + `SOUN`** |

**`SOUN` on 20230601 is a REAL holding, not a false positive.** The frame's
Positions panel shows 10 rows and the footer says "10 Items in Personal
WatchList"; the old GT had 9. Added as GT capture `1` (uncommitted as of
writing). The merged list is therefore 10/10.

`tools/runQmgOcrBatch.js` now has `--max-frames` / `--max-captures`
(uncommitted) so a timed-out video can be retried through the runner:
`node tools/runQmgOcrBatch.js --dates <d> --low-cpu --parallel 1 --max-frames 6 --max-captures 1 --run-tag <tag>`.
EasyOCR is already `gpu=False` in `tools/_easyocr_ocr.py`, so "low GPU" is
automatic. The batches 20231201/20231215/20230518 ran BEFORE the
swallowed-holdings default and record `cluster_rule: corroborated`.

*(Original plan below, kept for the reasoning.)*

**Started 2026-11-04. If a conversation is restarted, resume here.**

## Where the work stands

The prefilter-resolution sweep is **COMPLETE, committed and pushed**
(commits `1552155` and `fc016a3` on
`feature/sevcik-transcript-signals`). Nothing further is owed on it.

The remaining task is the **QMG EasyOCR production scan** of a few more
dates, at low CPU load. It had NOT started when the session was
interrupted — the Bash tool was failing with
`claude-opus-5 is temporarily unavailable, so auto mode cannot determine
the safety of Bash right now`, repeatedly, and never recovered.

## The engine — EasyOCR, and why

Three OCR engines exist in this project:

| engine | status |
|---|---|
| Tesseract | legacy default; ~25 % recall on QMG chart-stream; ~2 s/frame; still the Revere whiteboard path |
| **EasyOCR** | **the one to use for QMG** — ~75 % recall on 20220606 vs Tesseract's 25 %; ~60 s/frame |
| PaddleOCR PP-OCRv6 | **unusable** — the model download is blocked (Baidu CDN) and `tools/_paddleocr_ocr.py` does not exist. `~/.paddleocr/whl/det/en/` exists but holds **no model files** |

So: **EasyOCR, always, with `--low-cpu`.**

## `--low-cpu` is MANDATORY

EasyOCR uses PyTorch + OpenCV + NumPy, each spawning multi-threaded
pools. Without it, parallel scans saturate every core and the machine
freezes (measured 10× slowdown). `tools/runQmgOcrBatch.js --low-cpu`
sets `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`,
`KMP_DUPLICATE_LIB_OK=TRUE` and **caps parallelism at 2**.

## The exact command

```bash
node tools/runQmgOcrBatch.js --dates <d1,d2,...> \
  --low-cpu --parallel 2 --run-tag qmg-easyocr-20261104-prod
```

`--parallel 2` is the effective maximum under `--low-cpu` anyway.
The batch runner sets the era rules itself: the crop comes from the
upload date inside the scan tool, and `--temporal-decay 0` is added for
the 2023 sidebar dates. The cluster rule defaults to `corroborated`,
the production default since 2026-11-03.

**Time ONE video first** with the exact flags, confirm the probe log
lands with a non-empty `position_list`, and only then scale up.

## The dates, and why each one

All four have **1080p media on disk** in `data/video_pipeline/downloads_1080p/`.

| date | media | GT | why it is worth a scan |
|---|---|---|---|
| **20231201** | `20231201_TZnX1qEiOkM.mp4` | none | the era crop's real test — the old hand-listed `WIDE_CROP_DATES` **missed** this date, because its ticker column starts further left (source x 1586) than any other layout. `x=0.83` shaves the first glyph off every ticker; `x=0.82` does not. |
| **20231215** | `20231215_JNVA5cd_m7M.mp4` | none | the same reason (source x 1585) — the "right sidebar A′" layout |
| **20230518** | `20230518_1AJIzXSkfyM.mp4` | 8 tickers | has pixel-verified GT and was only ever scanned by an **old** run, so the current era crop + `corroborated` rule has never been measured on it |
| **20230601** | `20230601_1HFPeLD2zwc.mp4` | 9 tickers | has GT and has **never been scanned at all** — the sweep could not score it (no usable aligned label/media pair), so a production scan is the only way to read it |

`20230519` (`20230519__y9Wo0eBP4A.mp4`, 1080p, **no GT**) is the
spare, if a fifth is wanted.

## Rules that apply to the run

- **After every chunk**, check for orphans:
  `tasklist | findstr ffmpeg.exe` and `tasklist | findstr node.exe`.
- **Do NOT** `ls` or `Read` `data/video_scan_test/_rerun/` directly — it
  holds hundreds-to-thousands of PNGs per run. Use `Glob` with a pattern.
- Score the **`merged_position_list`** (the video-level consensus), not
  the per-capture list. The two have disagreed three times on record and
  the merged list is what production publishes.
- The output lands in `data/video_scan_test/_rerun/<run-tag>/`.

## Related

[[prefilter-resolution-sweep-resume]], [[qullamaggie-easyocr-breakthrough]],
[[easyocr-low-cpu-mandate]], [[quillamaggie-scan-freeze-guidelines]],
[[next-steps-assessment-2026-10-28]].
