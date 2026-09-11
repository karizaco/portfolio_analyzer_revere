const { LOW_CONFIDENCE_THRESHOLD } = require('../config/schema');
const {
  extractBottomLine,
  normalizeLines,
  parseMetricBundle
} = require('../normalize/cleanFields');

function findLine(lines, matcher) {
  return lines.find((line) => matcher.test(line)) || '';
}

function normalizePortfolioLine(line, portfolio) {
  if (!line) {
    return '';
  }

  const normalized = line.trim();
  if (/^PORTFOLIO\b/.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith(portfolio)) {
    return normalized;
  }

  return `${portfolio} ${normalized}`;
}

function resolvePortfolioMetricLine(lines, portfolio) {
  return normalizePortfolioLine(
    findLine(lines, new RegExp(`^${portfolio}\\b.*(?:RVAB|REBAR|[0-9])`, 'i')) || findLine(lines, new RegExp(`^${portfolio}\\b`, 'i')),
    portfolio
  );
}

function buildObservationRow({ metadata, ocr, portfolio, portfolioLine, bottomLine, bottomLineRaw, rawLines }) {
  const metrics = parseMetricBundle(portfolioLine);
  const issues = [];

  if (!metrics.metricsRaw) {
    issues.push('MISSING_METRIC_LINE');
  }

  if (!bottomLine) {
    issues.push('MISSING_BOTTOM_LINE');
  }

  if (ocr.confidence < LOW_CONFIDENCE_THRESHOLD) {
    issues.push('LOW_OCR_CONFIDENCE');
  }

  return {
    action_text: metrics.actionText,
    action_text_raw: metrics.actionTextRaw,
    actions: metrics.actions,
    as_of_date: metadata.asOfDate,
    bottom_line: bottomLine,
    bottom_line_raw: bottomLineRaw,
    issue_codes: issues.join('|'),
    metric_1: metrics.metricFirst,
    metric_2: metrics.metricSecond,
    metric_scalar: metrics.metricScalar,
    metrics_raw: metrics.metricsRaw,
    ocr_confidence: ocr.confidence.toFixed(2),
    ocr_profile: ocr.profileName,
    parse_status: issues.length ? 'review' : 'ok',
    portfolio,
    raw_lines: rawLines.join(' || '),
    sequence: metadata.sequence,
    source_file: metadata.fileName
  };
}

function parseWhiteboardScreenshot({ metadata, ocr }) {
  const rawLines = normalizeLines(ocr.text);
  const groLine = resolvePortfolioMetricLine(rawLines, 'GRO');
  const turboLine = resolvePortfolioMetricLine(rawLines, 'TURBO');
  const bottomLineRaw = findLine(rawLines, /^BOTTOM\b.*LINE\b/);
  const bottomLine = extractBottomLine(bottomLineRaw);

  return [
    buildObservationRow({
      bottomLine,
      bottomLineRaw,
      metadata,
      ocr,
      portfolio: 'GRO',
      portfolioLine: groLine,
      rawLines
    }),
    buildObservationRow({
      bottomLine,
      bottomLineRaw,
      metadata,
      ocr,
      portfolio: 'TURBO',
      portfolioLine: turboLine,
      rawLines
    })
  ];
}

module.exports = {
  parseWhiteboardScreenshot
};