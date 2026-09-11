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

function findLineIndex(lines, matcher) {
  return lines.findIndex((line) => matcher.test(line));
}

function attachPortfolioPrefix(line, portfolioPrefix) {
  if (!line || !portfolioPrefix || /^PORTFOLIO\b/.test(line) || /^FOCUS\b/.test(line)) {
    return line;
  }

  if (/^RVAB\b/.test(line)) {
    return `${portfolioPrefix} ${line}`;
  }

  return line;
}

function findFollowingMetricLine(lines, startIndex, portfolioPrefix) {
  if (startIndex < 0) {
    return '';
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(?:GRO|TURBO)\b.*HOLDINGS\b/.test(line) || /^FOCUS\b/.test(line) || /^BOTTOM\b/.test(line)) {
      break;
    }

    if (/^PORTFOLIO\b/.test(line) || /^RVAB\b/.test(line) || /^(?:GRO|TURBO)\b.*RVAB\b/.test(line)) {
      return attachPortfolioPrefix(line, portfolioPrefix);
    }
  }

  return '';
}

function splitInlineMetricLine(holdingsLine, portfolioKey) {
  if (!holdingsLine) {
    return {
      actionLine: '',
      holdingsLine: ''
    };
  }

  const markerMatch = holdingsLine.match(/\s(RVAB(?:\s*\/\s*REBAR)?\s*[:.].*)$/);
  if (!markerMatch || markerMatch.index === undefined) {
    return {
      actionLine: '',
      holdingsLine
    };
  }

  const prefix = holdingsLine.slice(0, markerMatch.index).trim();
  const metricSuffix = markerMatch[1].trim();
  const portfolioPrefix = portfolioKey === 'turbo' ? 'TURBO' : 'GRO';

  return {
    actionLine: /^RVAB\b/.test(metricSuffix) ? `${portfolioPrefix} ${metricSuffix}` : metricSuffix,
    holdingsLine: prefix
  };
}

function buildPortfolioFields({ actionLine, holdingsLine, layoutType, portfolioKey }) {
  const inlineSplit = !actionLine
    ? splitInlineMetricLine(holdingsLine, portfolioKey)
    : { actionLine, holdingsLine };
  const holdingsRaw = extractHoldingsContent(inlineSplit.holdingsLine, portfolioKey, layoutType);
  const metrics = parseMetricBundle(actionLine || inlineSplit.actionLine);

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

  const groHoldingsIndex = layoutType === 'legacy_focus'
    ? findLineIndex(mergedLines, /^FOCUS\b/)
    : findLineIndex(mergedLines, /^GRO\b.*HOLDINGS\b/);
  const groHoldingsLine = groHoldingsIndex >= 0 ? mergedLines[groHoldingsIndex] : '';
  const groActionLine = layoutType === 'legacy_focus'
    ? findLine(mergedLines, /^PORTFOLIO\b/)
    : (findLine(mergedLines, /^GRO\b(?!.*HOLDINGS\b).*RVAB\b/)
      || findFollowingMetricLine(mergedLines, groHoldingsIndex, 'GRO'));
  const turboHoldingsIndex = layoutType === 'gro_turbo'
    ? findLineIndex(mergedLines, /^TURBO\b.*HOLDINGS\b/)
    : -1;
  const turboHoldingsLine = turboHoldingsIndex >= 0 ? mergedLines[turboHoldingsIndex] : '';
  const turboActionLine = layoutType === 'gro_turbo'
    ? (findLine(mergedLines, /^TURBO\b(?!.*HOLDINGS\b).*RVAB\b/)
      || findFollowingMetricLine(mergedLines, turboHoldingsIndex, 'TURBO'))
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

  return {
    as_of_date: metadata.asOfDate,
    bottom_line: bottomLine,
    bottom_line_raw: resolvedBottomLineRaw,
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
