---
name: easyocr-low-cpu-mandate
description: "MANDATORY: --low-cpu for any EasyOCR batch testing — 11 parallel processes without it overwhelmed the system"
metadata:
  type: feedback
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
  modified: 2026-10-18T13:17:20.121Z
---

# MANDATORY RULE: `--low-cpu` for EasyOCR Testing

## What happened
On 2026-10-18, I launched 11 parallel EasyOCR scans WITHOUT `--low-cpu`. Each EasyOCR process spawns multiple Python threads (torch, numpy, opencv) that together consume all CPU cores. With 11 concurrent scans, the system was completely saturated — disk I/O went to 100%, individual scans took 10× longer than normal (600s/frame vs 60s), and the system became unresponsive.

## The rule
**Every EasyOCR batch command MUST include `--low-cpu`.** This flag:
- Limits parallelism to `--parallel 2` maximum (regardless of what you asked for)
- Sets `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `KMP_DUPLICATE_LIB_OK=TRUE` environment variables

## Correct command pattern
```bash
node tools/runQmgOcrBatch.js --dates d1,d2,... --low-cpu --parallel 4
# OR for individual scans:
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js ... --ocr-engine easyocr
```

## Why it matters
- EasyOCR uses PyTorch + OpenCV + NumPy — each spawns thread pools
- Without thread limits, one EasyOCR process can consume all CPU cores
- 11 concurrent scans = system saturation = 10× slowdown = unresponsive machine
- `--low-cpu` caps this so the machine stays responsive and each scan completes in ~5-20 min instead of timing out

**Why this was violated**: I was impatient and wanted faster results. That was wrong. Never trade system stability for speed on batch OCR runs.

**How to apply**: Before launching ANY EasyOCR batch, confirm `--low-cpu` is in the command. If you forget, the system will freeze again.
