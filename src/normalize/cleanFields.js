const ACTION_PATTERN = /\b(BUY|SELL|ADD|TRIM)\b\s+([^]+?)(?=\b(?:BUY|SELL|ADD|TRIM|NO CHANGES)\b|$)/g;

const LABEL_PATTERN = /(FOCUS\s*[:.]|PORTFOLIO(?:\s*\/\s*RVAB(?:2)?(?:\s*\/\s*REBAR)?|\s+RVAB(?:\s*\/\s*REBAR)?)\s*[:.]|GRO\s+RVAB(?:\s*\/\s*REBAR)?\s*[:.]|TURBO\s+RVAB(?:\s*\/\s*REBAR)?\s*[:.]|GRO(?:\s+HOLDINGS)?\s*[:.]|TURBO(?:\s+HOLDINGS)?\s*[:.]|RVAB(?:\s*\/\s*REBAR)?\s*[:.]|BOTTOM\s+LINE\s*[:.]?)/g;

const STRONG_LABEL_PATTERNS = [
  /^FOCUS\b/,
  /^PORTFOLIO\b/,
  /^GRO\b.*HOLDINGS\b/,
  /^GRO\b.*RVAB\b/,
  /^TURBO\b.*HOLDINGS\b/,
  /^TURBO\b.*RVAB\b/,
  /^BOTTOM\b.*LINE\b/
];

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeLeadingNoise(value) {
  return value.replace(/^[^A-Z0-9(]+/, '').trim();
}

function normalizeOcrFragment(value) {
  if (!value) {
    return '';
  }

  return normalizeWhitespace(
    value
      .toUpperCase()
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[—–]/g, '-')
      .replace(/½/g, '1/2')
      .replace(/[|¦]/g, ' ')
      .replace(/\bRE[-\s]?BUY\b/g, 'BUY')
      .replace(/\b(BUY|SELL|ADD|TRIM)(?=[A-Z])/g, '$1 ')
      .replace(/([A-Z0-9])(?=(BUY|SELL|ADD|TRIM)\b)/g, '$1 ')
      .replace(/\bRBAV\b/g, 'RVAB')
      .replace(/\bRYAB\b/g, 'RVAB')
      .replace(/\bRVAD\b/g, 'RVAB')
      .replace(/\bRVAG\b/g, 'RVAB')
      .replace(/\bRVAS\b/g, 'RVAB')
      .replace(/\bRVAB2\b/g, 'RVAB')
      .replace(/\bREDAR\b/g, 'REBAR')
      .replace(/\bREDAR\b/g, 'REBAR')
      .replace(/\bB0TTOM\b/g, 'BOTTOM')
      .replace(/\bBOTTOMLINE\b/g, 'BOTTOM LINE')
      .replace(/\bBOTTOMUNE\b/g, 'BOTTOM LINE')
      .replace(/\bLINF\b/g, 'LINE')
      .replace(/\bBOTTOM\s+UNE\b/g, 'BOTTOM LINE')
      .replace(/\bH0LDINGS\b/g, 'HOLDINGS')
      .replace(/\bOLDINGS\b/g, 'HOLDINGS')
      .replace(/\bHO\s+DRNGS\b/g, 'HOLDINGS')
      .replace(/\bPORTFOUIO\b/g, 'PORTFOLIO')
      .replace(/\bPORTFOLIQ\b/g, 'PORTFOLIO')
      .replace(/\bTUR8O\b/g, 'TURBO')
      .replace(/\bGR0\b/g, 'GRO')
  );
}

function isStrongLabel(line) {
  return STRONG_LABEL_PATTERNS.some((pattern) => pattern.test(line));
}

function derivePortfolioHint(line) {
  if (/^GRO\b/.test(line)) {
    return 'GRO';
  }

  if (/^TURBO\b/.test(line)) {
    return 'TURBO';
  }

  return '';
}

function normalizeLabelSegment(segment, portfolioHint) {
  let normalized = sanitizeLeadingNoise(segment);

  normalized = normalized
    .replace(/^GRO\s*[:.]\s*/i, 'GRO HOLDINGS: ')
    .replace(/^TURBO\s*[:.]\s*/i, 'TURBO HOLDINGS: ')
    .replace(/^PORTFOLIO\s+RVAB/i, 'PORTFOLIO/RVAB')
    .replace(/^BOTTOM\s+LINE\s*[:.]?\s*/i, 'BOTTOM LINE: ');

  if (portfolioHint && /^RVAB\b/i.test(normalized)) {
    normalized = `${portfolioHint} ${normalized}`;
  }

  return normalizeWhitespace(normalized);
}

function splitEmbeddedLabels(line) {
  const matches = [...line.matchAll(LABEL_PATTERN)];
  if (matches.length <= 1) {
    return [normalizeLabelSegment(line, '')];
  }

  const segments = [];
  let portfolioHint = '';
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index || 0;
    const end = index + 1 < matches.length
      ? matches[index + 1].index || line.length
      : line.length;
    const segment = normalizeLabelSegment(line.slice(start, end), portfolioHint);
    if (segment) {
      segments.push(segment);
      portfolioHint = derivePortfolioHint(segment) || portfolioHint;
    }
  }

  return segments;
}

function normalizeLines(text) {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/\t/g, ' ')))
    .filter(Boolean);

  const normalized = rawLines
    .flatMap((line) => splitEmbeddedLabels(normalizeOcrFragment(line)))
    .map(sanitizeLeadingNoise)
    .filter(Boolean);
  const merged = [];

  for (const line of normalized) {
    if (!merged.length || isStrongLabel(line)) {
      merged.push(line);
      continue;
    }

    merged[merged.length - 1] = normalizeWhitespace(`${merged[merged.length - 1]} ${line}`);
  }

  return merged;
}

function extractHoldingsContent(line, portfolioKey, layoutType) {
  if (!line) {
    return '';
  }

  if (layoutType === 'legacy_focus') {
    return normalizeWhitespace(line.replace(/^FOCUS\s*:?\s*/i, ''));
  }

  if (portfolioKey === 'gro') {
    return normalizeWhitespace(line.replace(/^GRO\s+HOLDINGS\s*:?\s*/i, ''));
  }

  return normalizeWhitespace(line.replace(/^TURBO\s+HOLDINGS\s*:?\s*/i, ''));
}

function extractBottomLine(line) {
  if (!line) {
    return '';
  }

  return normalizeWhitespace(line.replace(/^BOTTOM\s+LINE\s*[:.]?\s*/i, ''));
}

function cleanTickerToken(token) {
  const cleaned = token
    .replace(/^\(+|\)+$/g, '')
    .replace(/^[^A-Z0-9]+|[^A-Z0-9.\-/%]+$/g, '');

  if (!cleaned) {
    return '';
  }

  if (!/[A-Z]/.test(cleaned)) {
    return '';
  }

  if (['FOCUS', 'GRO', 'TURBO', 'HOLDINGS'].includes(cleaned)) {
    return '';
  }

  if (/(BUY|SELL|ADD|TRIM|BOTTOM|LINE)/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

function normalizeHoldings(rawHoldings) {
  if (!rawHoldings) {
    return [];
  }

  const normalized = normalizeOcrFragment(rawHoldings)
    .replace(/[()]/g, ' ')
    .replace(/\bAND\b/g, ',')
    .replace(/\s*&\s*/g, ',')
    .replace(/[;:]/g, ',');

  const holdings = [];
  for (const token of normalized.split(/[\s,]+/)) {
    const ticker = cleanTickerToken(token);
    if (!ticker || holdings.includes(ticker)) {
      continue;
    }

    holdings.push(ticker);
  }

  return holdings;
}

function cleanActionItem(rawItem) {
  return normalizeWhitespace(
    normalizeOcrFragment(rawItem)
      .replace(/^[:\-,]+\s*/, '')
      .replace(/\s*[.;]+$/, '')
  );
}

function parseActions(actionText) {
  if (!actionText) {
    return [];
  }

  ACTION_PATTERN.lastIndex = 0;
  const normalized = normalizeOcrFragment(actionText);
  if (/\bNO CHANGES\b/.test(normalized)) {
    return ['NO CHANGES'];
  }

  const actions = [];
  let match;
  while ((match = ACTION_PATTERN.exec(normalized)) !== null) {
    const actionType = match[1];
    const actionBody = match[2];
    const items = actionBody
      .split(/,|\bAND\b/)
      .map(cleanActionItem)
      .filter(Boolean);

    if (!items.length) {
      actions.push(`${actionType}:`);
      continue;
    }

    for (const item of items) {
      actions.push(`${actionType}:${item}`);
    }
  }

  return actions;
}

function findFirstActionIndex(line) {
  const normalized = normalizeOcrFragment(line);
  const matches = [
    normalized.search(/\bBUY\b/),
    normalized.search(/\bSELL\b/),
    normalized.search(/\bADD\b/),
    normalized.search(/\bTRIM\b/),
    normalized.search(/\bNO CHANGES\b/)
  ].filter((index) => index >= 0);

  if (!matches.length) {
    return -1;
  }

  return Math.min(...matches);
}

function parseMetricBundle(line) {
  if (!line) {
    return {
      actionText: '',
      actionTextRaw: '',
      actions: [],
      metricFirst: '',
      metricScalar: '',
      metricSecond: '',
      metricsRaw: '',
      noChanges: false
    };
  }

  const normalizedLine = normalizeOcrFragment(line)
    .replace(/^GRO\s+/i, '')
    .replace(/^TURBO\s+/i, '')
    .replace(/^PORTFOLIO\s*\//i, 'PORTFOLIO/');

  const actionIndex = findFirstActionIndex(normalizedLine);
  const metricsSegment = actionIndex >= 0
    ? normalizedLine.slice(0, actionIndex).trim()
    : normalizedLine;
  const actionText = actionIndex >= 0
    ? normalizedLine.slice(actionIndex).trim()
    : '';

  let metricScalar = '';
  let metricFirst = '';
  let metricSecond = '';

  const scalarAndPairMatch = metricsSegment.match(/([0-9]+(?:\.[0-9]+)?)\s*\(([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)\)/);
  if (scalarAndPairMatch) {
    metricScalar = scalarAndPairMatch[1];
    metricFirst = scalarAndPairMatch[2];
    metricSecond = scalarAndPairMatch[3];
  } else {
    const pairMatch = metricsSegment.match(/\(?\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*\)?/);
    if (pairMatch) {
      metricFirst = pairMatch[1];
      metricSecond = pairMatch[2];
    }

    const scalarMatch = metricsSegment.match(/\b([0-9]+(?:\.[0-9]+)?)\b/);
    if (scalarMatch && scalarMatch[1] !== metricFirst) {
      metricScalar = scalarMatch[1];
    }
  }

  return {
    actionText: normalizeWhitespace(actionText),
    actionTextRaw: actionText,
    actions: parseActions(actionText),
    metricFirst,
    metricScalar,
    metricSecond,
    metricsRaw: metricsSegment,
    noChanges: /\bNO CHANGES\b/.test(actionText)
  };
}

module.exports = {
  extractBottomLine,
  extractHoldingsContent,
  normalizeWhitespace,
  normalizeHoldings,
  normalizeLines,
  normalizeOcrFragment,
  parseMetricBundle
};
