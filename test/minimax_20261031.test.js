const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReportHtml,
  normalizeSummaryRows,
  normalizeTimeseriesRows
} = require('../src/report/generatePerformanceReport');

test('buildReportHtml sorts portfolio timeseries chronologically without mutating input', () => {
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

  const laterRow = {
    portfolio: 'GRO',
    as_of_date: '2026-09-10',
    estimated_equity_index: '1.56',
    curve_status: 'ok',
    open_positions: '15',
    cash_weight: '0.08',
    weighted_exposure: '0.92',
    priced_positions: '14',
    unpriced_positions: '1'
  };
  const earlierRow = {
    portfolio: 'GRO',
    as_of_date: '2026-09-09',
    estimated_equity_index: '1.40',
    curve_status: 'ok',
    open_positions: '14',
    cash_weight: '0.10',
    weighted_exposure: '0.90',
    priced_positions: '13',
    unpriced_positions: '1'
  };

  const unsortedRows = normalizeTimeseriesRows([laterRow, earlierRow]);
  const sortedRows = normalizeTimeseriesRows([earlierRow, laterRow]);
  const originalOrder = unsortedRows.map((row) => row.as_of_date);

  const unsortedHtml = buildReportHtml({
    generatedAt: '2026-09-11T00:00:00.000Z',
    summaryRows,
    timeseriesRows: unsortedRows
  });
  const sortedHtml = buildReportHtml({
    generatedAt: '2026-09-11T00:00:00.000Z',
    summaryRows,
    timeseriesRows: sortedRows
  });

  assert.equal(unsortedHtml, sortedHtml);
  assert.deepEqual(unsortedRows.map((row) => row.as_of_date), originalOrder);
});
