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

const PREFILTER_PROFILE_DEFAULT = 'whiteboard';

// Sevcik trade-signal columns ---------------------------------------------
//
// The signal table's own shape. `evidence_text` is in it, and that is not
// decoration: a signal without the words it was read from cannot be
// checked, and an unchecked claim in a portfolio report is worth nothing.

const TRADE_SIGNAL_COLUMNS = [
  'video_id',
  'upload_date',
  'provider',
  'event_time_sec',
  'ticker',
  'action',
  'bias',
  'confidence_label',
  'confidence_score',
  'entry_price',
  'target_price_low',
  'target_price_high',
  'stop_price',
  'horizon_text',
  'rationale',
  'evidence_text',
  'parser_version'
];

const TRADE_SIGNAL_DAILY_COLUMNS = [
  'upload_date',
  'video_id',
  'title',
  'provider',
  'signal_count',
  'bullish_count',
  'bearish_count',
  'neutral_count',
  'mixed_count',
  'unique_tickers',
  'avg_confidence',
  'high_confidence_count',
  'signals_with_entry',
  'signals_with_target',
  'tickers'
];

const TRADE_SIGNAL_TICKER_COLUMNS = [
  'ticker',
  'signal_count',
  'bullish_count',
  'bearish_count',
  'neutral_count',
  'mixed_count',
  'video_count',
  'first_date',
  'last_date',
  'avg_confidence',
  'max_confidence',
  'high_confidence_count',
  'signals_with_entry',
  'signals_with_target',
  'avg_entry_price',
  'avg_target_price',
  'bullish_ratio'
];

// The SETUPS -- what the speaker is talking about.
//
// A setup is not a signal. The speaker does not disclose positions; he
// describes setups and ideas. So the columns are the LIFECYCLE of a
// setup, not a trade's entry and target.
const SEVCIK_SETUP_COLUMNS = [
  'video_id',
  'upload_date',
  'provider',
  'ticker',
  'spoken_name',
  'state',
  'states',
  'mentions',
  'event_time_sec',
  'certainty_level',
  'certainty_confidence',
  'certainty_marker',
  'probability',
  'direction_uncertain',
  'still_running',
  'invalidated',
  'worked',
  'failed',
  'evidence_text',
  'parser_version'
];

// One row per stream -- how many setups it carried, and what became of
// them.
const SEVCIK_SETUP_DAILY_COLUMNS = [
  'upload_date',
  'video_id',
  'title',
  'provider',
  'setup_count',
  'tickers',
  'new_count',
  'running_count',
  'worked_count',
  'failed_count',
  'invalidated_count',
  'still_running_count',
  'avg_certainty',
  'high_certainty_count',
  'conditional_count',
  'direction_uncertain_count'
];

// One row per ticker -- how this source has talked about this name.
const SEVCIK_SETUP_TICKER_COLUMNS = [
  'ticker',
  'spoken_name',
  'setup_count',
  'video_count',
  'first_date',
  'last_date',
  'worked_count',
  'failed_count',
  'invalidated_count',
  'still_running_count',
  'avg_certainty',
  'high_certainty_count',
  'conditional_count',
  'even_count',
  'low_certainty_count',
  'direction_uncertain_count',
  'mentions'
];

module.exports = {
  LOW_CONFIDENCE_THRESHOLD,
  PREFILTER_PROFILE_DEFAULT,
  PORTFOLIO_ACTION_COLUMNS,
  PERFORMANCE_REVIEW_COLUMNS,
  PORTFOLIO_PERFORMANCE_TIMESERIES_COLUMNS,
  POSITION_EVENT_COLUMNS,
  POSITION_PERFORMANCE_COLUMNS,
  POSITION_PERFORMANCE_SUMMARY_COLUMNS,
  SEVCIK_SETUP_COLUMNS,
  SEVCIK_SETUP_DAILY_COLUMNS,
  SEVCIK_SETUP_TICKER_COLUMNS,
  SNAPSHOT_COLUMNS,
  TRADE_SIGNAL_COLUMNS,
  TRADE_SIGNAL_DAILY_COLUMNS,
  TRADE_SIGNAL_TICKER_COLUMNS,
  WHITEBOARD_OBSERVATION_COLUMNS
};
