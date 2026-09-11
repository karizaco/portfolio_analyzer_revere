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

const LOW_CONFIDENCE_THRESHOLD = 60;

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  POSITION_EVENT_COLUMNS,
  SNAPSHOT_COLUMNS
};
