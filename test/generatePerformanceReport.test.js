const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLinePath,
  buildReportHtml,
  normalizeSummaryRows,
  normalizeTimeseriesRows
} = require('../src/report/generatePerformanceReport');

test('buildLinePath returns an SVG path for numeric values', () => {
  const pathData = buildLinePath([1, 1.2, 0.9], 400, 200, { bottom: 20, left: 20, right: 20, top: 20 });

  assert.match(pathData, /^M /);
  assert.match(pathData, / L /);
});

test('buildReportHtml renders summary cards and portfolio sections', () => {
  const summaryRows = normalizeSummaryRows([
    {
      portfolio: 'GRO',
      as_of_date: '2026-09-10',
      estimated_equity_index: '1.56',
      cash_weight: '0.08',
      invested_weight: '0.92',
      closed_positions: '10',
      open_positions: '15',
      baseline_positions: '3',
      explicit_weight_entries: '2',
      assumed_equal_weight_entries: '12',
      total_adjustments: '5',
      unpriced_positions: '1',
      review_rows: '9',
      price_status: 'partial_price_data'
    }
  ]);
  const timeseriesRows = normalizeTimeseriesRows([
    {
      portfolio: 'GRO',
      as_of_date: '2026-09-09',
      estimated_equity_index: '1.40',
      curve_status: 'ok',
      open_positions: '14',
      cash_weight: '0.10',
      weighted_exposure: '0.90',
      priced_positions: '13',
      unpriced_positions: '1',
      observed_metric_scalar: '1.20',
      observed_metric_1: '',
      observed_metric_2: ''
    },
    {
      portfolio: 'GRO',
      as_of_date: '2026-09-10',
      estimated_equity_index: '1.56',
      curve_status: 'partial_price_data',
      open_positions: '15',
      cash_weight: '0.08',
      weighted_exposure: '0.92',
      priced_positions: '14',
      unpriced_positions: '1',
      observed_metric_scalar: '1.21',
      observed_metric_1: '',
      observed_metric_2: '',
      whiteboard_source_file: '20260910_ps.jpg',
      whiteboard_ocr_confidence: '89',
      whiteboard_metric_scalar: '',
      whiteboard_metric_1: '1.66',
      whiteboard_metric_2: '1.70',
      whiteboard_action_text: 'ADD TO LEADERS',
      whiteboard_bottom_line: 'Breadth still healthy'
    }
  ]);

  const html = buildReportHtml({
    generatedAt: '2026-09-11T00:00:00.000Z',
    summaryRows,
    timeseriesRows
  });

  assert.match(html, /Static performance report from extracted CSVs/);
  assert.match(html, /GRO Estimated Equity Index/);
  assert.match(html, /Latest Whiteboard/);
  assert.match(html, /ADD TO LEADERS/);
  assert.match(html, /data\/report\/index\.html/);
});