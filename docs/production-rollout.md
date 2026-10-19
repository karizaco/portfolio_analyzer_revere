# Production Rollout Plan: EasyOCR for QMG Chart-stream

Date: 2026-10-01

## Goal

Move from manual EasyOCR invocation to safe default behavior for chart-stream workloads, while containing runtime and CI risk.

## Current State

- EasyOCR exists behind `--ocr-engine easyocr`.
- Chart-stream scans can still run in Tesseract mode unless explicitly switched.
- Runtime is substantially slower per frame when EasyOCR is active.

## Phase 1: Default Engine Behavior

### Change

When `--chart-stream-parser` is set and user does not explicitly pass `--ocr-engine`, default to `easyocr`.

### Guardrails

- Keep explicit override precedence:
  - If user passes `--ocr-engine tesseract`, honor it.
- Keep non-chart-stream workflows untouched.

### Acceptance Criteria

- Chart-stream command with no `--ocr-engine` runs EasyOCR path.
- Whiteboard / non-chart-stream commands remain unchanged.

## Phase 2: `scanAllGtVideos` Runtime Strategy

EasyOCR is slower, so orchestration must avoid watchdog timeouts and zombie process buildup.

### Planned updates for `tools/scanAllGtVideos.js`

1. Engine-aware presets:
   - EasyOCR preset: lower `--fps`, lower frame budget, fewer captures per video.
2. Strong per-video timeout increase (or adaptive timeout by engine).
3. Explicit worker concurrency cap (default small for EasyOCR).
4. Chunked execution mode (5-10 videos per batch).
5. On timeout/error:
   - detect and clean orphan ffmpeg/python processes before next video.

### Recommended default profile for EasyOCR GT sweeps

- `--parallel 4`
- `--fps 0.25`
- `--prefilter-max-frames 12`
- `--max-captures 1`

## Phase 3: CI and Environment Validation

## Python 3.11 verification

Add a CI preflight that validates:

1. Python 3.11 availability.
2. EasyOCR import works in selected interpreter.
3. Wrapper script `tools/_easyocr_ocr.py` can execute a smoke run.

### CI behavior

- If EasyOCR checks fail:
  - mark EasyOCR integration job failed
  - do not block unrelated Node-only jobs unless branch is explicitly EasyOCR rollout

### Suggested CI matrix split

- `node-core` (existing tests)
- `ocr-easyocr-smoke` (Python 3.11 + easyocr wrapper)

## Phase 4: Observability and Backward Compatibility

## Logging updates

- Include actual OCR engine used in scan log metadata.
- Record whether EasyOCR used original-video crop path or fallback frame path.
- Record per-capture OCR duration for regression monitoring.

## Backward compatibility

- Keep `--ocr-engine tesseract` fully supported.
- Keep legacy behavior for non-chart-stream parser runs.

## Rollout Checklist

1. Implement default engine switch logic for chart-stream parser mode.
2. Add engine-aware orchestration defaults to `scanAllGtVideos.js`.
3. Add CI Python 3.11 + easyocr smoke validation.
4. Add explicit engine metadata in logs.
5. Re-run benchmark dates and compare recall/FP/runtime before enabling as default for all runs.

## Rollback Plan

If runtime instability or FP growth appears:

1. Revert default back to Tesseract for chart-stream.
2. Keep EasyOCR as opt-in flag only.
3. Preserve new logging to continue diagnosis.
