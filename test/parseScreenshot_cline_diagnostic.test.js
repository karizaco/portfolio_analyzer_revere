'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// CLINE DIAGNOSTIC TEST (do not merge)
// ──────────────────────────────────────────────────────────────────────────────
// Diagnostic test for src/parse/parseScreenshot.js (Revere GRO/TURBO parser).
// This module has ZERO existing test coverage. Claude Code's in-flight work
// does not touch this file or its imports (../normalize/cleanFields).
//
// IMPORTANT FINDING (Cline, 2026-09-20): parseScreenshot returns a single
// object, NOT an array. Existing callers must use `row.field`, not `row[0]`.
// This was discovered while writing this test.
//
// Authored by Cline to characterize behavior and document it. Delete before
// committing by removing this file. Run with:
//   node --test test/parseScreenshot_cline_diagnostic.test.js
// ──────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScreenshot } = require('../src/parse/parseScreenshot');

function buildMetadata(overrides = {}) {
  return {
    asOfDate: '2026-09-10',
    fileName: '20260910_ps.jpg',
    sequence: 1,
    ...overrides
  };
}

function buildOcr(overrides = {}) {
  return {
    confidence: 84,
    profileName: 'threshold',
    text: '',
    bottomText: '',
    ...overrides
  };
}

test('cline_diagnostic: parseScreenshot — canonical gro_turbo layout', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'GRO HOLDINGS: AAPL, MSFT, NVDA',
        'GRO RVAB: 1.45/1.51 ADD LEADERS',
        'TURBO HOLDINGS: TSLA, AMD',
        'TURBO RVAB: 0.90/0.95 TRIM SMALL CAPS',
        'BOTTOM LINE: HEALTHY PULLBACK'
      ].join('\n')
    })
  });
  assert.equal(row.layout_type, 'gro_turbo');
  assert.equal(row.gro_metric_1, '1.45');
  assert.equal(row.gro_metric_2, '1.51');
  assert.equal(row.turbo_metric_1, '0.90');
  assert.equal(row.turbo_metric_2, '0.95');
  assert.equal(row.bottom_line, 'HEALTHY PULLBACK');
  assert.equal(row.parse_status, 'ok');
  assert.equal(row.issue_codes, '');
});

test('cline_diagnostic: parseScreenshot — gro_turbo with action items', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'GRO HOLDINGS: AAPL, MSFT',
        'GRO RVAB: BUY AAPL, BUY MSFT',
        'TURBO HOLDINGS: TSLA',
        'TURBO RVAB: TRIM TSLA',
        'BOTTOM LINE: ADD TO WINNERS'
      ].join('\n')
    })
  });
  assert.equal(row.gro_actions.length, 2);
  assert.deepEqual(row.gro_actions, ['BUY:AAPL', 'BUY:MSFT']);
  assert.equal(row.turbo_actions.length, 1);
  assert.deepEqual(row.turbo_actions, ['TRIM:TSLA']);
});

test('cline_diagnostic: parseScreenshot — gro_only layout (no TURBO line)', () => {
  // In a `gro_only` layout, no TURBO line is expected. The parser correctly
  // does NOT flag MISSING_TURBO_HOLDINGS for gro_only — it's gated by
  // `layoutType === 'gro_turbo'` (parseScreenshot.js:155).
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'GRO HOLDINGS: AAPL, MSFT',
        'GRO RVAB: 1.45/1.51 NO CHANGES',
        'BOTTOM LINE: NO MOVES'
      ].join('\n')
    })
  });
  assert.equal(row.layout_type, 'gro_only');
  assert.equal(row.gro_no_changes, 'true');
  assert.deepEqual(row.gro_actions, ['NO CHANGES']);
  assert.ok(!row.issue_codes.includes('MISSING_TURBO_HOLDINGS'),
    `gro_only should NOT flag MISSING_TURBO_HOLDINGS (got "${row.issue_codes}")`);
  assert.equal(row.parse_status, 'ok');
});

test('cline_diagnostic: parseScreenshot — legacy_focus layout uses FOCUS keyword', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'FOCUS 2: NVDA, AMD',
        'PORTFOLIO/RVAB: BUY NVDA, BUY AMD',
        'BOTTOM LINE: FOCUS BUILDS'
      ].join('\n')
    })
  });
  assert.equal(row.layout_type, 'legacy_focus');
  assert.ok(row.gro_holdings.length >= 1,
    `expected gro_holdings populated, got ${JSON.stringify(row.gro_holdings)}`);
  assert.equal(row.bottom_line, 'FOCUS BUILDS');
});

test('cline_diagnostic: parseScreenshot — missing BOTTOM LINE issues MISSING_BOTTOM_LINE', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: 'GRO HOLDINGS: AAPL\nGRO RVAB: NO CHANGES'
    })
  });
  assert.ok(row.issue_codes.includes('MISSING_BOTTOM_LINE'),
    `expected MISSING_BOTTOM_LINE, got ${row.issue_codes}`);
  assert.equal(row.parse_status, 'review');
});

test('cline_diagnostic: parseScreenshot — bottomText fallback when BOTTOM LINE absent', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: 'GRO HOLDINGS: AAPL\nGRO RVAB: NO CHANGES',
      bottomText: 'HEALTHY PULLBACK'
    })
  });
  assert.equal(row.bottom_line, 'HEALTHY PULLBACK',
    `expected bottomText fallback to win, got "${row.bottom_line}"`);
});

test('cline_diagnostic: parseScreenshot — missing GRO HOLDINGS issues MISSING_GRO_HOLDINGS', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'GRO RVAB: 1.45/1.51 NO CHANGES',
        'TURBO HOLDINGS: TSLA',
        'TURBO RVAB: 0.90/0.95 TRIM TSLA',
        'BOTTOM LINE: STAY DEFENSIVE'
      ].join('\n')
    })
  });
  assert.ok(row.issue_codes.includes('MISSING_GRO_HOLDINGS'),
    `expected MISSING_GRO_HOLDINGS, got ${row.issue_codes}`);
});

test('cline_diagnostic: parseScreenshot — low OCR confidence issues LOW_OCR_CONFIDENCE', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      confidence: 30,
      text: [
        'GRO HOLDINGS: AAPL',
        'GRO RVAB: NO CHANGES',
        'TURBO HOLDINGS: TSLA',
        'TURBO RVAB: NO CHANGES',
        'BOTTOM LINE: NO MOVES'
      ].join('\n')
    })
  });
  assert.ok(row.issue_codes.includes('LOW_OCR_CONFIDENCE'),
    `expected LOW_OCR_CONFIDENCE, got ${row.issue_codes}`);
});

test('cline_diagnostic: parseScreenshot — propagates metadata fields', () => {
  const row = parseScreenshot({
    metadata: {
      asOfDate: '2026-09-10',
      fileName: 'custom_filename.jpg',
      sequence: 42
    },
    ocr: buildOcr({
      text: [
        'GRO HOLDINGS: AAPL',
        'GRO RVAB: NO CHANGES',
        'TURBO HOLDINGS: TSLA',
        'TURBO RVAB: NO CHANGES',
        'BOTTOM LINE: ALL QUIET'
      ].join('\n')
    })
  });
  assert.equal(row.as_of_date, '2026-09-10');
  assert.equal(row.source_file, 'custom_filename.jpg');
  assert.equal(row.sequence, 42);
});

test('cline_diagnostic: parseScreenshot — multiple issues pipe-separated', () => {
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      confidence: 30,
      text: 'GRO RVAB: NO CHANGES'
    })
  });
  const issues = row.issue_codes.split('|');
  assert.ok(issues.includes('MISSING_GRO_HOLDINGS'));
  assert.ok(issues.includes('MISSING_BOTTOM_LINE'));
  assert.ok(issues.includes('LOW_OCR_CONFIDENCE'));
  assert.equal(row.parse_status, 'review');
});

test('cline_diagnostic: parseScreenshot DISCOVERY — main-line vs bottomText disagreement (silent today)', () => {
  // Documents the silent-bug that BOTTOM_LINE_CONFLICT would fix:
  // when the main-line BOTTOM LINE value and the bottomText fallback
  // disagree, the parser silently picks the main-line value with no
  // issue_code emitted. This is the test Cline will use to verify the
  // future fix.
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: [
        'GRO HOLDINGS: AAPL',
        'GRO RVAB: NO CHANGES',
        'TURBO HOLDINGS: TSLA',
        'TURBO RVAB: NO CHANGES',
        'BOTTOM LINE: MAIN_LINE_VALUE'
      ].join('\n'),
      bottomText: 'BOTTOMTEXT_VALUE'
    })
  });
  assert.equal(row.bottom_line, 'MAIN_LINE_VALUE',
    `expected main-line wins (current behavior), got "${row.bottom_line}"`);
  assert.equal(row.issue_codes, '',
    `expected no issue_codes (current behavior), got "${row.issue_codes}"`);
});

test('cline_diagnostic: parseScreenshot — bottomText used when main-line is garbage', () => {
  // Companion: when the main-line contains noise but no clear value, the
  // bottomText fallback should win. Confirms the fallback works for
  // real-world OCR noise patterns.
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: 'GRO HOLDINGS: AAPL\nGRO RVAB: NO CHANGES\nBOTTOM LIN: ???',
      bottomText: 'REAL_VALUE'
    })
  });
  assert.equal(row.bottom_line, 'REAL_VALUE');
});

test('cline_diagnostic: parseScreenshot — return shape is a single object (not array)', () => {
  // Documents the API surface so future readers don't repeat Cline's
  // initial mistake of indexing it with [0].
  const row = parseScreenshot({
    metadata: buildMetadata(),
    ocr: buildOcr({
      text: 'GRO HOLDINGS: AAPL\nGRO RVAB: NO CHANGES\nBOTTOM LINE: X'
    })
  });
  assert.ok(row && typeof row === 'object');
  assert.ok(!Array.isArray(row), 'parseScreenshot must return a single object, not an array');
});

