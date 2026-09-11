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