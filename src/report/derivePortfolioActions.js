const { normalizeOcrFragment, normalizeWhitespace } = require('../normalize/cleanFields');
const { buildTickerKnowledge, extractActionSignals } = require('../normalize/repairHoldings');

const ACTION_PATTERN = /\b(BUY|SELL|ADD|TRIM)\b([^]+?)(?=\b(?:BUY|SELL|ADD|TRIM|NO CHANGES)\b|$)/g;
const PERCENT_PATTERN = /\d+(?:\.\d+)?%/g;

function stripTrailingCommentary(value) {
  return normalizeWhitespace(
    normalizeOcrFragment(value || '')
      .replace(/\bKEYS?\b.*$/g, '')
      .replace(/\bCOMMENT\b.*$/g, '')
      .replace(/\bBOTTOM\b.*$/g, '')
  );
}

function splitByRepeatedPercent(fragment) {
  const matches = [...fragment.matchAll(PERCENT_PATTERN)];
  if (matches.length <= 1) {
    return [fragment];
  }

  const parts = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = index + 1 < matches.length
      ? matches[index + 1].index
      : fragment.length;
    parts.push(fragment.slice(start, end).trim());
  }

  return parts.filter(Boolean);
}

function cleanFragment(fragment) {
  return normalizeWhitespace(
    fragment
      .replace(/^[,;+&\s]+/, '')
      .replace(/[,;+&\s]+$/g, '')
  );
}

function splitActionFragments(actionBody) {
  const cleaned = stripTrailingCommentary(actionBody);
  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/[;,]/)
    .flatMap((fragment) => splitByRepeatedPercent(fragment.trim()))
    .map((fragment) => cleanFragment(fragment))
    .filter(Boolean);
}

function parsePercent(fragment) {
  const match = fragment.match(PERCENT_PATTERN);
  if (!match) {
    return {
      parsedPercentText: '',
      parsedPercentValue: ''
    };
  }

  const parsedPercentText = match[0];
  return {
    parsedPercentText,
    parsedPercentValue: String(Number(parsedPercentText.slice(0, -1)))
  };
}

function buildActionRow({
  actionDate,
  actionStatus,
  actionType,
  parseBasis,
  parsedPercentText,
  parsedPercentValue,
  portfolio,
  rawFragment,
  sequence,
  sourceFile,
  ticker,
  actionContext
}) {
  return {
    action_context: actionContext,
    action_date: actionDate,
    action_status: actionStatus,
    action_type: actionType,
    parse_basis: parseBasis,
    parsed_percent_text: parsedPercentText,
    parsed_percent_value: parsedPercentValue,
    portfolio,
    raw_fragment: rawFragment,
    sequence,
    source_file: sourceFile,
    ticker
  };
}

function classifyFragment(actionType, fragment, referenceScores) {
  const fragmentWithoutPercent = cleanFragment(fragment.replace(PERCENT_PATTERN, ' '));
  const signals = extractActionSignals(`${actionType} ${fragmentWithoutPercent}`, referenceScores);
  const tickers = signals[actionType] || [];
  const percent = parsePercent(fragment);

  if (!tickers.length) {
    return {
      parseBasis: 'missing_ticker',
      percent,
      status: 'review',
      tickers: ['']
    };
  }

  if (tickers.length > 1 && percent.parsedPercentValue) {
    return {
      parseBasis: 'ambiguous_percent_multi_ticker',
      percent,
      status: 'review',
      tickers
    };
  }

  return {
    parseBasis: tickers.length > 1 ? 'multi_ticker_fragment' : 'single_ticker_fragment',
    percent,
    status: 'trusted',
    tickers
  };
}

function parseActionText({
  actionDate,
  actionText,
  portfolio,
  referenceScores,
  sequence,
  sourceFile
}) {
  const trustedRows = [];
  const reviewRows = [];
  const prepared = stripTrailingCommentary(actionText);

  if (!prepared || /\bNO CHANGES\b/.test(prepared)) {
    return {
      reviewRows,
      trustedRows
    };
  }

  ACTION_PATTERN.lastIndex = 0;
  let match;
  while ((match = ACTION_PATTERN.exec(prepared)) !== null) {
    const actionType = match[1];
    const actionBody = match[2];
    const fragments = splitActionFragments(actionBody);

    if (!fragments.length) {
      reviewRows.push(buildActionRow({
        actionContext: prepared,
        actionDate,
        actionStatus: 'review',
        actionType,
        parseBasis: 'missing_fragment',
        parsedPercentText: '',
        parsedPercentValue: '',
        portfolio,
        rawFragment: '',
        sequence,
        sourceFile,
        ticker: ''
      }));
      continue;
    }

    for (const fragment of fragments) {
      const classification = classifyFragment(actionType, fragment, referenceScores);
      const targetRows = classification.status === 'trusted' ? trustedRows : reviewRows;
      for (const ticker of classification.tickers) {
        targetRows.push(buildActionRow({
          actionContext: prepared,
          actionDate,
          actionStatus: classification.status,
          actionType,
          parseBasis: classification.parseBasis,
          parsedPercentText: classification.percent.parsedPercentText,
          parsedPercentValue: classification.percent.parsedPercentValue,
          portfolio,
          rawFragment: fragment,
          sequence,
          sourceFile,
          ticker
        }));
      }
    }
  }

  return {
    reviewRows,
    trustedRows
  };
}

function sortActionRows(rows) {
  rows.sort((left, right) => {
    if (left.action_date !== right.action_date) {
      return left.action_date.localeCompare(right.action_date);
    }

    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    if (left.portfolio !== right.portfolio) {
      return left.portfolio.localeCompare(right.portfolio);
    }

    if (left.action_type !== right.action_type) {
      return left.action_type.localeCompare(right.action_type);
    }

    if (left.ticker !== right.ticker) {
      return left.ticker.localeCompare(right.ticker);
    }

    return left.raw_fragment.localeCompare(right.raw_fragment);
  });
}

function derivePortfolioActions(rows) {
  const trustedRows = [];
  const reviewRows = [];
  const knowledge = buildTickerKnowledge(rows);

  for (const row of rows) {
    for (const portfolioKey of ['gro', 'turbo']) {
      const actionText = row[`${portfolioKey}_action_text`] || '';
      if (!actionText) {
        continue;
      }

      const parsed = parseActionText({
        actionDate: row.as_of_date,
        actionText,
        portfolio: portfolioKey.toUpperCase(),
        referenceScores: knowledge.strongTokenScores,
        sequence: row.sequence,
        sourceFile: row.source_file
      });

      trustedRows.push(...parsed.trustedRows);
      reviewRows.push(...parsed.reviewRows);
    }
  }

  sortActionRows(trustedRows);
  sortActionRows(reviewRows);

  return {
    reviewRows,
    trustedRows
  };
}

module.exports = {
  derivePortfolioActions,
  parseActionText,
  splitActionFragments
};