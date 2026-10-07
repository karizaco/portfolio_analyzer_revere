const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWhiteboardScreenshot } = require('../src/parse/parseWhiteboardScreenshot');

test('parseWhiteboardScreenshot extracts GRO and TURBO whiteboard rows', () => {
  const rows = parseWhiteboardScreenshot({
    metadata: {
      asOfDate: '2024-09-10',
      fileName: '20240910_ps.jpg',
      sequence: 1
    },
    ocr: {
      confidence: 84,
      profileName: 'threshold',
      text: [
        'GRO RVAB: (1.45/1.51) ADD TO LEADERS',
        'TURBO RVAB: (0.90/0.95) TRIM SMALL CAPS',
        'BOTTOM LINE: HEALTHY PULLBACK'
      ].join('\n')
    }
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.portfolio, row.metric_1, row.metric_2, row.action_text, row.bottom_line, row.parse_status]),
    [
      ['GRO', '1.45', '1.51', 'ADD TO LEADERS', 'HEALTHY PULLBACK', 'ok'],
      ['TURBO', '0.90', '0.95', 'TRIM SMALL CAPS', 'HEALTHY PULLBACK', 'ok']
    ]
  );
});

test('parseWhiteboardScreenshot strips a trailing OCR "0" glued to GRO and TURBO keywords', () => {
  // OCR on whiteboard screenshots commonly glues a trailing digit to the
  // portfolio keyword ("GRO0" / "TURBO0" instead of "GRO " / "TURBO ").
  // Two fixes are required for a complete recovery:
  //   1. parseWhiteboardScreenshot.resolvePortfolioMetricLine strips the
  //      trailing 0 from the lenient-match result so parseMetricBundle
  //      sees "GRO" / "TURBO".
  //   2. cleanFields.normalizeOcrFragment adds a TURBO0 -> TURBO
  //      substitution (analogous to the existing GR0 -> GRO and TUR8O ->
  //      TURBO) so normalizeLines.splitEmbeddedLabels recognises TURBO0
  //      as a section boundary and the GRO line is not merged with the
  //      TURBO line.
  // Without both fixes, the GRO action_text swallows the TURBO line.
  const rows = parseWhiteboardScreenshot({
    metadata: {
      asOfDate: '2024-09-10',
      fileName: '20240910_ps.jpg',
      sequence: 1
    },
    ocr: {
      confidence: 84,
      profileName: 'threshold',
      text: [
        'GRO0 RVAB: (1.45/1.51) ADD TO LEADERS',
        'TURBO0 RVAB: (0.90/0.95) TRIM SMALL CAPS',
        'BOTTOM LINE: HEALTHY PULLBACK'
      ].join('\n')
    }
  });

  const groRow = rows.find((row) => row.portfolio === 'GRO');
  const turboRow = rows.find((row) => row.portfolio === 'TURBO');

  assert.equal(groRow.metric_1, '1.45');
  assert.equal(groRow.metric_2, '1.51');
  assert.equal(groRow.action_text, 'ADD TO LEADERS');
  assert.equal(groRow.parse_status, 'ok');
  assert.equal(turboRow.metric_1, '0.90');
  assert.equal(turboRow.metric_2, '0.95');
  assert.equal(turboRow.action_text, 'TRIM SMALL CAPS');
  assert.equal(turboRow.parse_status, 'ok');
});