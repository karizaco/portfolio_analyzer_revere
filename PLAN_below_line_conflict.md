# Plan: surface `BOTTOM_LINE_CONFLICT` issue code in `parseScreenshot.js`

## Context

`src/parse/parseScreenshot.js` parses the **Revere** whiteboard GRO/TURBO
screenshots. At line 149–150, it computes the bottom line in two ways:

```js
const fallbackBottomLine = extractBottomLine(ocr.bottomText || '');
const bottomLine = extractBottomLine(bottomLineRaw) || fallbackBottomLine;
```

When the main-line `BOTTOM LINE:` regex match (`bottomLineRaw`) and the
preprocessed `ocr.bottomText` fallback both yield non-empty values but
**disagree**, the parser silently picks the main-line value and emits no
`issue_code`. Downstream consumers (e.g. `aggregateScanResults.js`,
`repairHoldings.js`, the CSV writers, the HTML report) cannot distinguish
"clean parse" from "two sources disagreed and one was chosen".

This was discovered by Cline's diagnostic test
`test/parseScreenshot_cline_diagnostic.test.js` (test name:
`cline_diagnostic: parseScreenshot DISCOVERY — main-line vs bottomText
disagreement (silent today)`). The test currently documents the silent
behavior and is expected to be updated to assert the new issue code once
the fix lands.

## Goal

When the main-line BOTTOM LINE and the OCR bottomText fallback both
produce non-empty values that are **not equal**, emit a new
`BOTTOM_LINE_CONFLICT` issue code so downstream filters / reports /
analysts can see the disagreement.

## Scope

**In scope:**
- `src/parse/parseScreenshot.js` — emit the new code
- `test/parseScreenshot_cline_diagnostic.test.js` — update the discovery
  test to assert the new behavior (rename it from "DISCOVERY" to a
  behavior test, since the behavior will no longer be silent)

**Out of scope (do not touch):**
- The chart-stream parser (`src/parse/parseChartStream.js`) — unrelated.
  Claude Code is actively editing this file.
- `tools/aggregateScanResults.js` — no schema changes; the new code flows
  through the existing `issue_codes` pipe-delimited field naturally.
- `tools/scanVideoWithOcr.js` — the scan driver is untouched by this fix.
- The `aggregateScanResults.js` aggregate JSON shape — `issue_codes` is
  already an array of strings there (no change needed).

## Implementation steps

### Step 1 — emit `BOTTOM_LINE_CONFLICT`

In `src/parse/parseScreenshot.js`, the `parseScreenshot()` function around
line 149–158. The current code is:

```js
const fallbackBottomLine = extractBottomLine(ocr.bottomText || '');
const bottomLine = extractBottomLine(bottomLineRaw) || fallbackBottomLine;
const resolvedBottomLineRaw = bottomLineRaw || (fallbackBottomLine ? `BOTTOM LINE: ${fallbackBottomLine}` : '');
const issues = [];
appendIssue(issues, !gro.holdings.length, 'MISSING_GRO_HOLDINGS');
appendIssue(issues, !gro.metricsRaw, 'MISSING_GRO_ACTION_LINE');
appendIssue(issues, layoutType === 'gro_turbo' && !turbo.holdings.length, 'MISSING_TURBO_HOLDINGS');
appendIssue(issues, layoutType === 'gro_turbo' && !turbo.metricsRaw, 'MISSING_TURBO_ACTION_LINE');
appendIssue(issues, !bottomLine, 'MISSING_BOTTOM_LINE');
appendIssue(issues, ocr.confidence < LOW_CONFIDENCE_THRESHOLD, 'LOW_OCR_CONFIDENCE');
```

Add the disagreement check. Both sides must be non-empty AND not equal
(case-insensitive after `normalizeWhitespace` trim, since `extractBottomLine`
already normalizes). Suggested placement — just after the `bottomLine` is
computed, alongside the other `appendIssue(...)` calls:

```js
const fallbackBottomLine = extractBottomLine(ocr.bottomText || '');
const bottomLineRawValue = extractBottomLine(bottomLineRaw);
const bottomLine = bottomLineRawValue || fallbackBottomLine;
const resolvedBottomLineRaw = bottomLineRaw || (fallbackBottomLine ? `BOTTOM LINE: ${fallbackBottomLine}` : '');

// Both sources produced a value but they disagree — surface it.
const hasMainLineValue = !!bottomLineRawValue;
const hasFallbackValue = !!fallbackBottomLine;
const mainAndFallbackDisagree = hasMainLineValue && hasFallbackValue
  && bottomLineRawValue.toUpperCase() !== fallbackBottomLine.toUpperCase();

const issues = [];
appendIssue(issues, mainAndFallbackDisagree, 'BOTTOM_LINE_CONFLICT');
appendIssue(issues, !gro.holdings.length, 'MISSING_GRO_HOLDINGS');
// ... rest unchanged
```

Notes:
- `extractBottomLine` already calls `normalizeWhitespace`, so a
  `String#toUpperCase()` comparison is sufficient (OCR can produce
  different cases for the same text).
- The `bottomLineRawValue` variable name avoids shadowing the existing
  `bottomLineRaw` parameter; do not rename the parameter.
- `MISSING_BOTTOM_LINE` is still emitted when **both** sources are empty
  (`!bottomLine` is true). That's correct — `BOTTOM_LINE_CONFLICT` only
  fires when both are present and disagree.

### Step 2 — update the diagnostic test

In `test/parseScreenshot_cline_diagnostic.test.js`, locate the test:

```
test('cline_diagnostic: parseScreenshot DISCOVERY — main-line vs bottomText disagreement (silent today)', () => {
```

Update it to:

1. Rename the test to drop "DISCOVERY — silent today" and replace with a
   description of the new behavior, e.g.:

   ```
   test('cline_diagnostic: parseScreenshot — main-line vs bottomText disagreement emits BOTTOM_LINE_CONFLICT', () => {
   ```

2. Change the assertions from "expected silent" to "expected surfaced":
   - `assert.equal(row.bottom_line, 'MAIN_LINE_VALUE', ...)` — keep this
     (main-line still wins, that's the current behavior).
   - Replace `assert.equal(row.issue_codes, '', ...)` with:
     ```
     assert.ok(row.issue_codes.includes('BOTTOM_LINE_CONFLICT'),
       `expected BOTTOM_LINE_CONFLICT, got "${row.issue_codes}"`);
     assert.equal(row.parse_status, 'review');
     ```

### Step 3 — add a positive / negative test pair

In the same file, add two new tests right after the updated one to cover
the matrix:

1. **Positive: only one source present** — `BOTTOM_LINE_CONFLICT` MUST
   NOT fire. (Existing `MISSING_BOTTOM_LINE` test already covers
   both-empty; this new test covers "fallback-only, no main-line".)
2. **Negative (no conflict): both sources present and equal** — main-line
   and bottomText both say "HEALTHY PULLBACK"; `BOTTOM_LINE_CONFLICT`
   MUST NOT fire.

Suggested names:

```
test('cline_diagnostic: parseScreenshot — no conflict when only one source present', ...)
test('cline_diagnostic: parseScreenshot — no conflict when both sources agree', ...)
```

### Step 4 — verify

Run:

```
node --test test/parseScreenshot_cline_diagnostic.test.js
node --test
```

Expected:
- All parseScreenshot diagnostic tests pass.
- Full suite: 140 → 142 tests, 0 new failures.
- The pre-existing `test/chartStream.e2e.test.js` failure is unchanged
  (still failing — it lives in Claude's wheelhouse, see note below).

## Notes for Claude Code

- **Coexistence reminder:** Claude is currently editing the chart-stream
  pipeline (`src/ocr/ocrImage.js`, `src/parse/parseChartStream.js`,
  `src/video/ocrScanArgs.js`, `tools/aggregateScanResults.js`,
  `tools/scanVideoWithOcr.js`, `tools/whiteboard_worker.py`). **None of
  those files overlap with this plan** — `parseScreenshot.js` is the
  Revere whiteboard parser, not the chart-stream parser. Safe to proceed
  without coordination.

- **Convention alignment:** the new code follows the same
  `appendIssue(issues, condition, code)` pattern used by the file. The
  issue code name `BOTTOM_LINE_CONFLICT` matches the existing
  `SCREAMING_SNAKE_CASE` style of `MISSING_BOTTOM_LINE`,
  `LOW_OCR_CONFIDENCE`, etc.

- **Schema impact:** `issue_codes` is a pipe-delimited string here; the
  aggregate layer (`tools/aggregateScanResults.js`) splits it into an
  array. No schema migration is required — the new code flows through
  transparently.

- **Backward compatibility:** any downstream filter that checks
  `row.parse_status === 'ok'` will now see `'review'` for rows that
  previously looked clean. This is the desired behavior — those rows
  were silently wrong. If any report / CSV needs to suppress
  `BOTTOM_LINE_CONFLICT`-only rows to match historical output, that's a
  follow-up fix in that consumer, not in `parseScreenshot.js`.

- **The diagnostic test file has the `cline_diagnostic_` prefix.** The
  author (Cline) intends to keep these tests around as living
  documentation. Consider renaming / merging into the existing
  `test/parseWhiteboardScreenshot.test.js` if you prefer a single
  canonical test file — but DO NOT delete the discovery tests; they pin
  the matrix.

- **Reference reading order for the implementer:**
  1. `src/parse/parseScreenshot.js` lines 108-110 (`appendIssue` helper)
     and 149-158 (where the new call goes).
  2. `src/normalize/cleanFields.js` line 158 (`extractBottomLine`) — note
     it already calls `normalizeWhitespace`, so the new comparison can
     rely on that.
  3. `src/normalize/repairHoldings.js` lines 85-93 (`appendIssueCode`
     helper) — shows the downstream pattern; no change needed there.
  4. `test/parseScreenshot_cline_diagnostic.test.js` — current diagnostic
     tests, including the one to update and the matrix cases to add.


