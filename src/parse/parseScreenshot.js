const { LOW_CONFIDENCE_THRESHOLD } = require('../config/schema');
const {
  extractBottomLine,
  extractHoldingsContent,
  normalizeHoldings,
  normalizeLines,
  parseMetricBundle
} = require('../normalize/cleanFields');

function detectLayoutType(lines) {
  if (lines.some((line) => /^TURBO\b/.test(line))) {
    return 'gro_turbo';
  }

  if (lines.some((line) => /^FOCUS\b/.test(line) || /^PORTFOLIO\b/.test(line))) {
    return 'legacy_focus';
  }

  return 'gro_only';
}

function findLine(lines, matcher) {
  return lines.find((line) => matcher.test(line)) || '';
}

function buildPortfolioFields({ actionLine, holdingsLine, layoutType, portfolioKey }) {
  const holdingsRaw = extractHoldingsContent(holdingsLine, portfolioKey, layoutType);
  const metrics = parseMetricBundle(actionLine);

  return {
    actions: metrics.actions,
    actionText: metrics.actionText,
    actionTextRaw: metrics.actionTextRaw,
    holdings: normalizeHoldings(holdingsRaw),
    holdingsRaw,
    metricFirst: metrics.metricFirst,
    metricScalar: metrics.metricScalar,
    metricSecond: metrics.metricSecond,
    metricsRaw: metrics.metricsRaw,
    noChanges: metrics.noChanges
  };
}

function appendIssue(issues, condition, issueCode) {
  if (condition) {
    issues.push(issueCode);
  }
}

function parseScreenshot({ metadata, ocr }) {
  const mergedLines = normalizeLines(ocr.text);
  const layoutType = detectLayoutType(mergedLines);

  const groHoldingsLine = layoutType === 'legacy_focus'
    ? findLine(mergedLines, /^FOCUS\b/)
    : findLine(mergedLines, /^GRO\b.*HOLDINGS\b/);
  const groActionLine = layoutType === 'legacy_focus'
    ? findLine(mergedLines, /^PORTFOLIO\b/)
    : findLine(mergedLines, /^GRO\b(?!.*HOLDINGS\b).*RVAB\b/);
  const turboHoldingsLine = layoutType === 'gro_turbo'
    ? findLine(mergedLines, /^TURBO\b.*HOLDINGS\b/)
    : '';
  const turboActionLine = layoutType === 'gro_turbo'
    ? findLine(mergedLines, /^TURBO\b(?!.*HOLDINGS\b).*RVAB\b/)
    : '';
  const bottomLineRaw = findLine(mergedLines, /^BOTTOM\b.*LINE\b/);

  const gro = buildPortfolioFields({
    actionLine: groActionLine,
    holdingsLine: groHoldingsLine,
    layoutType,
    portfolioKey: 'gro'
  });
  const turbo = buildPortfolioFields({
    actionLine: turboActionLine,
    holdingsLine: turboHoldingsLine,
    layoutType,
    portfolioKey: 'turbo'
  });

  const bottomLine = extractBottomLine(bottomLineRaw);
  const issues = [];
  appendIssue(issues, !gro.holdings.length, 'MISSING_GRO_HOLDINGS');
  appendIssue(issues, !gro.metricsRaw, 'MISSING_GRO_ACTION_LINE');
  appendIssue(issues, layoutType === 'gro_turbo' && !turbo.holdings.length, 'MISSING_TURBO_HOLDINGS');
  appendIssue(issues, layoutType === 'gro_turbo' && !turbo.metricsRaw, 'MISSING_TURBO_ACTION_LINE');
  appendIssue(issues, !bottomLine, 'MISSING_BOTTOM_LINE');
  appendIssue(issues, ocr.confidence < LOW_CONFIDENCE_THRESHOLD, 'LOW_OCR_CONFIDENCE');

  return {
    as_of_date: metadata.asOfDate,
    bottom_line: bottomLine,
    bottom_line_raw: bottomLineRaw,
    gro_action_text: gro.actionText,
    gro_action_text_raw: gro.actionTextRaw,
    gro_actions: gro.actions,
    gro_holdings: gro.holdings,
    gro_holdings_raw: gro.holdingsRaw,
    gro_metric_1: gro.metricFirst,
    gro_metric_2: gro.metricSecond,
    gro_metric_scalar: gro.metricScalar,
    gro_metrics_raw: gro.metricsRaw,
    gro_no_changes: gro.noChanges ? 'true' : 'false',
    issue_codes: issues.join('|'),
    layout_type: layoutType,
    ocr_confidence: ocr.confidence.toFixed(2),
    ocr_profile: ocr.profileName,
    parse_status: issues.length ? 'review' : 'ok',
    raw_lines: mergedLines.join(' || '),
    sequence: metadata.sequence,
    source_file: metadata.fileName,
    turbo_action_text: turbo.actionText,
    turbo_action_text_raw: turbo.actionTextRaw,
    turbo_actions: turbo.actions,
    turbo_holdings: turbo.holdings,
    turbo_holdings_raw: turbo.holdingsRaw,
    turbo_metric_1: turbo.metricFirst,
    turbo_metric_2: turbo.metricSecond,
    turbo_metric_scalar: turbo.metricScalar,
    turbo_metrics_raw: turbo.metricsRaw,
    turbo_no_changes: turbo.noChanges ? 'true' : 'false'
  };
}

module.exports = {
  parseScreenshot
};
