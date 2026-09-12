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

// Broader regex that also accepts trailing noise characters after the
// portfolio keyword, e.g. "GRO^ -0.46%", "TURBO~", "GR0 1.23", "GRO|".
// The previous strict `^GRO\b` rejected these because `^` / `~` / `|` are
// not word characters. OCR commonly produces them on the Daily Market
// Insight screen, where `GRO` appears as `GRO^` followed by a daily P&L.
function buildPortfolioMetricMatcher(portfolio) {
  // `\\b` requires a word boundary on the right side as well. We strip the
  // trailing punctuation separately before parseMetricBundle sees it.
  return new RegExp(`^${portfolio}[\\^~\\|0]?\\b`, 'i');
}

function resolvePortfolioMetricLine(lines, portfolio) {
  const structured = findLine(
    lines,
    new RegExp(`^${portfolio}\\b.*(?:RVAB|REBAR|[0-9])`, 'i')
  );
  const lenient = structured || findLine(lines, buildPortfolioMetricMatcher(portfolio));

  // Strip the trailing `^` / `~` / `|` that the lenient matcher tolerates
  // so downstream `parseMetricBundle` sees a clean portfolio keyword.
  const cleaned = String(lenient || '').replace(/^([A-Z]+)[\^~\|]/, '$1');

  return normalizePortfolioLine(cleaned, portfolio);
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

// Classify a frame's OCR text into a screen layout. The detection scoring
// uses this to label captures and to weight them differently. Returns:
//   'structured_whiteboard' - the canonical GRO HOLDINGS / TURBO RVAB / BOTTOM LINE layout
//   'dmi'                   - Daily Market Insight page (index %s + one-line GRO/TURBO P&L)
//   'tale_of_the_tape'      - market recap with leader / laggard tables
//   'unknown_text'          - text-heavy but not one of the named layouts
//   'chart'                 - low text density (likely stock chart)
const SCREEN_LAYOUT_KEYWORDS = {
  dmi: ['DAILY MARKET INSIGHT', 'MARKET STATE', 'WHAT HAPPENED TODAY'],
  tale_of_the_tape: ['TALE OF THE TAPE', 'LEADERS', 'LAGGARDS', 'WINNERS', 'LOSERS']
};

function detectScreenLayout(ocrText, ocrLines) {
  const upper = String(ocrText || '').toUpperCase();
  const lines = Array.isArray(ocrLines) ? ocrLines : [];
  const compactCharCount = String(ocrText || '').replace(/\s+/g, '').length;

  const structuredHits = ['HOLDINGS', 'GRO', 'TURBO', 'RVAB', 'BOTTOM LINE']
    .filter((token) => upper.includes(token)).length;
  if (structuredHits >= 2 && /HOLDINGS/.test(upper)) {
    return 'structured_whiteboard';
  }

  const dmiHits = SCREEN_LAYOUT_KEYWORDS.dmi.filter((token) => upper.includes(token)).length;
  if (dmiHits >= 2 || (dmiHits >= 1 && compactCharCount > 200)) {
    return 'dmi';
  }

  const taleHits = SCREEN_LAYOUT_KEYWORDS.tale_of_the_tape.filter((token) => upper.includes(token)).length;
  if (taleHits >= 2 || (lines.length >= 8 && compactCharCount > 300)) {
    return 'tale_of_the_tape';
  }

  if (lines.length >= 6 && compactCharCount > 200) {
    return 'unknown_text';
  }

  return 'chart';
}

module.exports = {
  detectScreenLayout,
  parseWhiteboardScreenshot
};
