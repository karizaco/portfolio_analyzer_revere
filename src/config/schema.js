const SNAPSHOT_COLUMNS = [
  'source_file',
  'as_of_date',
  'sequence',
  'layout_type',
  'ocr_profile',
  'ocr_confidence',
  'parse_status',
  'issue_codes',
  'raw_lines',
  'gro_holdings_raw',
  'gro_holdings',
  'gro_suspicious_tickers',
  'gro_repair_notes',
  'gro_metrics_raw',
  'gro_metric_scalar',
  'gro_metric_1',
  'gro_metric_2',
  'gro_action_text_raw',
  'gro_action_text',
  'gro_actions',
  'gro_no_changes',
  'turbo_holdings_raw',
  'turbo_holdings',
  'turbo_suspicious_tickers',
  'turbo_repair_notes',
  'turbo_metrics_raw',
  'turbo_metric_scalar',
  'turbo_metric_1',
  'turbo_metric_2',
  'turbo_action_text_raw',
  'turbo_action_text',
  'turbo_actions',
  'turbo_no_changes',
  'bottom_line_raw',
  'bottom_line'
];

const POSITION_EVENT_COLUMNS = [
  'portfolio',
  'event_date',
  'sequence',
  'event_type',
  'ticker',
  'source_file',
  'previous_source_file',
  'action_context',
  'event_status',
  'repair_basis'
];

const PORTFOLIO_ACTION_COLUMNS = [
  'portfolio',
  'action_date',
  'sequence',
  'action_type',
  'ticker',
  'source_file',
  'action_context',
  'raw_fragment',
  'parsed_percent_text',
  'parsed_percent_value',
  'action_status',
  'parse_basis'
];

const POSITION_PERFORMANCE_COLUMNS = [
  'portfolio',
  'ticker',
  'entry_date',
  'entry_sequence',
  'entry_source_file',
  'entry_origin',
  'entry_action_type',
  'entry_sizing_method',
  'entry_weight_fraction',
  'current_weight_fraction',
  'entry_percent_text',
  'entry_percent_value',
  'adjustment_count',
  'adjustment_percent_total',
  'adjustment_last_date',
  'exit_date',
  'exit_sequence',
  'exit_source_file',
  'exit_action_type',
  'exit_percent_text',
  'exit_percent_value',
  'is_open',
  'mark_date',
  'entry_price_date',
  'exit_price_date',
  'mark_price_date',
  'price_source',
  'price_status',
  'entry_price',
  'exit_price',
  'mark_price',
  'return_pct',
  'lifecycle_status'
];

const POSITION_PERFORMANCE_SUMMARY_COLUMNS = [
  'portfolio',
  'as_of_date',
  'estimated_equity_index',
  'cash_weight',
  'invested_weight',
  'closed_positions',
  'open_positions',
  'baseline_positions',
  'explicit_weight_entries',
  'assumed_equal_weight_entries',
  'total_adjustments',
  'unpriced_positions',
  'review_rows',
  'price_status'
];

const WHITEBOARD_OBSERVATION_COLUMNS = [
  'source_file',
  'as_of_date',
  'sequence',
  'portfolio',
  'ocr_profile',
  'ocr_confidence',
  'parse_status',
  'issue_codes',
  'raw_lines',
  'metrics_raw',
  'metric_scalar',
  'metric_1',
  'metric_2',
  'action_text_raw',
  'action_text',
  'actions',
  'bottom_line_raw',
  'bottom_line'
];

const PORTFOLIO_PERFORMANCE_TIMESERIES_COLUMNS = [
  'portfolio',
  'as_of_date',
  'estimated_equity_index',
  'curve_status',
  'open_positions',
  'cash_weight',
  'weighted_exposure',
  'priced_positions',
  'unpriced_positions',
  'observed_metric_scalar',
  'observed_metric_1',
  'observed_metric_2',
  'whiteboard_source_file',
  'whiteboard_ocr_confidence',
  'whiteboard_metric_scalar',
  'whiteboard_metric_1',
  'whiteboard_metric_2',
  'whiteboard_action_text',
  'whiteboard_bottom_line'
];

const PERFORMANCE_REVIEW_COLUMNS = [
  'review_type',
  'portfolio',
  'ticker',
  'review_date',
  'sequence',
  'source_file',
  'related_file',
  'review_basis',
  'details'
];

const LOW_CONFIDENCE_THRESHOLD = 60;

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  PORTFOLIO_ACTION_COLUMNS,
  PERFORMANCE_REVIEW_COLUMNS,
  PORTFOLIO_PERFORMANCE_TIMESERIES_COLUMNS,
  POSITION_EVENT_COLUMNS,
  POSITION_PERFORMANCE_COLUMNS,
  POSITION_PERFORMANCE_SUMMARY_COLUMNS,
  SNAPSHOT_COLUMNS,
  WHITEBOARD_OBSERVATION_COLUMNS
};
