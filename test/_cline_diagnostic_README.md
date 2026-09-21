# Cline Diagnostic Session — 2026-09-20

## Coexistence with Claude Code

Claude Code is actively working on **chart-stream OCR accuracy** for the
Qullamaggie video pipeline. Their in-flight diff (uncommitted, 6 files,
+158/-33) touches:

- `src/ocr/ocrImage.js` — new `chart-stream` preprocessing profile
- `src/parse/parseChartStream.js` — loosened `PRICE_TOKEN_PATTERN`
- `src/video/ocrScanArgs.js` — new `CHART_STREAM_REGION_FRACTION_DEFAULT`
- `tools/aggregateScanResults.js` — multi-root scan-dir discovery
- `tools/scanVideoWithOcr.js` — wired new option into `ocrImage()`
- `tools/whiteboard_worker.py` — default format 480p → 720p

Confirmed at start and end of session: diff stat unchanged.

## Test suite baseline

- **Baseline (pre-Cline):** 106 pass / 1 fail / 107 total
- **After Cline diagnostics:** 139 pass / 1 fail / 140 total
- **Failing test:** `test/chartStream.e2e.test.js` — `phash_overlay must be 16-char hex, got null`. This is in Claude Code's wheelhouse (they're editing `imageHashRegion.js` consumers). **Do not touch.**

## Files added by Cline (delete before commit)

1. `test/extractObservedDate_cline_diagnostic.test.js` — 20 tests
   - Edge cases for `extractObservedDate`, `inferDateKey`, `formatDuration`
     in `src/video/ocrScanLogic.js`. None of these helpers are in Claude's diff.

2. `test/parseScreenshot_cline_diagnostic.test.js` — 13 tests
   - First-ever coverage for `src/parse/parseScreenshot.js` (Revere GRO/TURBO).
   - Documents the silent-bug where `BOTTOM_LINE` main-line value and
     `bottomText` fallback can disagree without any `issue_code` being set.

## Discoveries made during this session

### Discovery 1: `parseScreenshot()` returns a single object, not an array

`src/parse/parseScreenshot.js:114` returns one row containing both GRO and
TURBO fields, not `[gro_row, turbo_row]` as one might assume from the
similar `parseWhiteboardScreenshot()` (which DOES return an array). Any
caller doing `parseScreenshot(...)[0]` will get `undefined`.

### Discovery 2: `MISSING_TURBO_HOLDINGS` is gated by `layoutType === 'gro_turbo'`

`parseScreenshot.js:155` only emits `MISSING_TURBO_HOLDINGS` when the layout
is `gro_turbo`. For `gro_only` layouts, missing TURBO data is not flagged
(because it's expected). This is **intentional**, not a bug.

### Discovery 3: `BOTTOM_LINE_CONFLICT` is a real silent failure mode

If the main-line `BOTTOM LINE: X` and the OCR `bottomText` fallback `Y`
disagree, the parser silently picks X and emits no issue code. This is the
exact failure mode that Phase 3 of the plan would address by adding a new
`BOTTOM_LINE_CONFLICT` issue code (NOT IMPLEMENTED YET — diagnostic test
documents the current behavior).

### Discovery 4: century-cutoff heuristic documented as `< 70 → 2000+YY`

`extractObservedDate` (`ocrScanLogic.js:54`) treats two-digit years as:
`< 70 → 2000+YY, ≥ 70 → 1900+YY`. This is correct for this corpus
(2022-2026) but will break for any historical pre-1970 video. Diagnostic
test pins current behavior.

## What I did NOT touch

- Anything in Claude's 6-file diff.
- Any existing test file.
- Any existing source file.
- The pre-existing failing chart-stream e2e test.
