const { LOW_CONFIDENCE_THRESHOLD } = require('../config/schema');
const { normalizeOcrFragment } = require('./cleanFields');

const ACTION_TYPES = ['BUY', 'SELL', 'ADD', 'TRIM'];
const COMPOSITE_MIN_LENGTH = 2;
const COMPOSITE_MAX_LENGTH = 5;
const HIGH_CONFIDENCE_THRESHOLD = 75;
const MAX_TICKER_ALPHA_LENGTH = 5;

const ACTION_STOP_WORDS = new Set([
  'A',
  'ALL',
  'AND',
  'BACK',
  'BOTTOM',
  'BPS',
  'CASH',
  'CHANGES',
  'COMMENT',
  'DAY',
  'DURING',
  'FRI',
  'HOLDS',
  'IN',
  'KEY',
  'KEYS',
  'LINE',
  'MARKET',
  'MON',
  'NO',
  'OF',
  'ON',
  'PIVOT',
  'RALLY',
  'RANGE',
  'THE',
  'TO',
  'TODAY',
  'VOLATILITY',
  'VS',
  'WATCH',
  'WERE',
  'WITH'
]);

const NON_TICKER_TOKENS = new Set([
  'ADD',
  'BOTTOM',
  'BUY',
  'CHANGES',
  'FOCUS',
  'GRO',
  'HOLDINGS',
  'LINE',
  'NO',
  'PORTFOLIO',
  'RBAV',
  'REBAR',
  'RVAB',
  'SELL',
  'TBILL',
  'TBILLS',
  'TBILLS',
  'TRIM',
  'TURBO'
]);

const OCR_TICKER_SUBSTITUTIONS = {
  '$': 'S',
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '6': 'G',
  '8': 'B'
};

function addScore(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

function alphaOnly(value) {
  return value.replace(/[^A-Z]/g, '');
}

function appendIssueCode(row, issueCode) {
  const codes = row.issue_codes ? row.issue_codes.split('|').filter(Boolean) : [];
  if (!codes.includes(issueCode)) {
    codes.push(issueCode);
  }

  row.issue_codes = codes.join('|');
  row.parse_status = row.issue_codes ? 'review' : 'ok';
}

function buildCandidateScores(knowledge, contextTickers = []) {
  const candidateScores = new Map();

  for (const [token, count] of knowledge.seedTokenScores.entries()) {
    addScore(candidateScores, token, count + 15);
  }

  for (const [token, count] of knowledge.exactTokenScores.entries()) {
    addScore(candidateScores, token, count);
  }

  for (const [token, count] of knowledge.strongTokenScores.entries()) {
    addScore(candidateScores, token, count + 20);
  }

  for (const token of contextTickers) {
    addScore(candidateScores, token, 80);
  }

  return candidateScores;
}

function buildReferenceScores(knowledge, contextTickers = []) {
  const referenceScores = new Map();

  for (const [token, count] of knowledge.seedTokenScores.entries()) {
    addScore(referenceScores, token, count + 25);
  }

  for (const [token, count] of knowledge.strongTokenScores.entries()) {
    addScore(referenceScores, token, count + 20);
  }

  for (const token of contextTickers) {
    addScore(referenceScores, token, 100);
  }

  return referenceScores;
}

function canonicalizeTicker(rawToken) {
  return normalizeOcrFragment(rawToken || '')
    .replace(/^[^A-Z0-9]+|[^A-Z0-9./-]+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '');
}

function dedupePreserveOrder(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function findBestCorrection(token, referenceScores, relaxed = false) {
  const base = alphaOnly(token);
  if (!base) {
    return null;
  }

  let bestMatch = null;

  for (const [candidate, score] of referenceScores.entries()) {
    if (!isStrictTicker(candidate)) {
      continue;
    }

    const candidateAlpha = alphaOnly(candidate);
    const distance = levenshtein(base, candidateAlpha);
    const allowedDistance = relaxed && candidateAlpha.length >= 4 ? 2 : 1;
    if (distance > allowedDistance) {
      continue;
    }

    const lengthDelta = Math.abs(candidateAlpha.length - base.length);
    const suffixBonus = candidateAlpha.endsWith(base) ? 20 : 0;
    const prefixBonus = candidateAlpha.startsWith(base) ? 20 : 0;
    const droppedBoundaryBonus = candidateAlpha.length === base.length + 1
      && (candidateAlpha.endsWith(base) || candidateAlpha.startsWith(base))
      ? 50
      : 0;
    const insertiveBonus = candidateAlpha.length === base.length + 1
      && (candidateAlpha.endsWith(base) || candidateAlpha.startsWith(base))
      ? 15
      : 0;
    const weightedScore = (score * 10)
      - (distance * 25)
      - (lengthDelta * 4)
      + suffixBonus
      + prefixBonus
      + droppedBoundaryBonus
      + insertiveBonus;
    if (!bestMatch || weightedScore > bestMatch.score) {
      bestMatch = {
        candidate,
        distance,
        score: weightedScore
      };
    }
  }

  return bestMatch;
}

function findOneCharBoundaryExpansion(token, referenceScores) {
  const base = alphaOnly(token);
  if (!base || base.length < 2 || base.length > 4) {
    return null;
  }

  let bestMatch = null;
  for (const [candidate, score] of referenceScores.entries()) {
    if (!isStrictTicker(candidate) || candidate === token) {
      continue;
    }

    const candidateAlpha = alphaOnly(candidate);
    if (candidateAlpha.length !== base.length + 1) {
      continue;
    }

    if (!candidateAlpha.endsWith(base) && !candidateAlpha.startsWith(base)) {
      continue;
    }

    const weightedScore = (score * 10) + 40;
    if (!bestMatch || weightedScore > bestMatch.score) {
      bestMatch = {
        candidate,
        score: weightedScore,
        support: score
      };
    }
  }

  return bestMatch;
}

function isShareClassTicker(token) {
  return /^[A-Z]{1,5}\.[A-Z]{1,2}$/.test(token);
}

function isPlausibleUnknownTicker(token) {
  return /^[A-Z]{3,5}$/.test(token) && !NON_TICKER_TOKENS.has(token) && !ACTION_STOP_WORDS.has(token);
}

function isStrictTicker(token) {
  return /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/.test(token) && !NON_TICKER_TOKENS.has(token);
}

function isSupportedTicker(token, referenceScores) {
  return referenceScores.has(token);
}

function isSuspiciousTicker(token, referenceScores, rowContext) {
  const alphaLength = alphaOnly(token).length;
  if (!token) {
    return true;
  }

  if (!isStrictTicker(token)) {
    return true;
  }

  if (alphaLength > MAX_TICKER_ALPHA_LENGTH) {
    return true;
  }

  if (token.includes('/') || token.split('.').length > 2) {
    return true;
  }

  if (token.includes('.') && !isShareClassTicker(token)) {
    return true;
  }

  if (referenceScores.has(token)) {
    return false;
  }

  return rowContext.lowConfidence || rowContext.noChanges;
}

function levenshtein(left, right) {
  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let rowIndex = 0; rowIndex < left.length; rowIndex += 1) {
    const current = [rowIndex + 1];
    for (let columnIndex = 0; columnIndex < right.length; columnIndex += 1) {
      const substitutionCost = left[rowIndex] === right[columnIndex] ? 0 : 1;
      current[columnIndex + 1] = Math.min(
        current[columnIndex] + 1,
        previous[columnIndex + 1] + 1,
        previous[columnIndex] + substitutionCost
      );
    }

    for (let columnIndex = 0; columnIndex < current.length; columnIndex += 1) {
      previous[columnIndex] = current[columnIndex];
    }
  }

  return previous[right.length];
}

function normalizeTickerVariant(rawToken) {
  return canonicalizeTicker(rawToken)
    .replace(/[01568$]/g, (character) => OCR_TICKER_SUBSTITUTIONS[character] || character)
    .replace(/\.$/, '');
}

function extractLooseTickerCandidates(text) {
  const prepared = prepareActionText(text)
    .replace(/\b\d+(?:\.\d+)?%\b/g, ' ')
    .replace(/\b\d+\/\d+\b/g, ' ')
    .replace(/[+&]/g, ' ');
  const result = [];

  for (const chunk of prepared.split(/[\s,;:()]+/)) {
    const token = normalizeTickerVariant(chunk);
    if (!token || NON_TICKER_TOKENS.has(token) || ACTION_STOP_WORDS.has(token)) {
      continue;
    }

    if (/[./]/.test(token) && !isShareClassTicker(token)) {
      for (const part of token.split(/[./]/).map(normalizeTickerVariant)) {
        if (isStrictTicker(part)) {
          result.push(part);
        }
      }

      continue;
    }

    if (isStrictTicker(token)) {
      result.push(token);
    }
  }

  return dedupePreserveOrder(result);
}

function buildOverrideKey(sourceFile, portfolioKey, token) {
  return `${sourceFile || '*'}::${portfolioKey || '*'}::${token}`;
}

function buildManualOverrideIndex(manualOverrides = []) {
  const overrideIndex = new Map();

  for (const override of manualOverrides) {
    const key = buildOverrideKey(override.sourceFile, override.portfolio.toLowerCase(), override.rawToken);
    overrideIndex.set(key, override);
  }

  return overrideIndex;
}

function findManualOverride(overrideIndex, sourceFile, portfolioKey, token) {
  const portfolio = portfolioKey.toLowerCase();
  return overrideIndex.get(buildOverrideKey(sourceFile, portfolio, token))
    || overrideIndex.get(buildOverrideKey('', portfolio, token))
    || overrideIndex.get(buildOverrideKey(sourceFile, '', token))
    || overrideIndex.get(buildOverrideKey('', '', token))
    || null;
}

function applyManualOverrides(tokens, options) {
  const repairedTokens = [];
  const notes = [];

  for (const token of tokens) {
    const override = findManualOverride(options.overrideIndex, options.sourceFile, options.portfolioKey, token);
    if (!override) {
      repairedTokens.push(token);
      continue;
    }

    repairedTokens.push(...override.replacementTokens);
    const replacementText = override.replacementTokens.join('+') || 'DROP';
    const noteSuffix = override.note ? `:${override.note}` : '';
    notes.push(`OVERRIDE:${token}->${replacementText}${noteSuffix}`);
  }

  return {
    notes,
    tokens: repairedTokens
  };
}

function extractRawHoldingCandidates(text) {
  const prepared = normalizeOcrFragment(text || '')
    .replace(/[()]/g, ' ')
    .replace(/[+&]/g, ' ')
    .replace(/\bAND\b/g, ' ');
  const result = [];

  for (const rawToken of prepared.split(/[\s,;:]+/)) {
    const token = normalizeTickerVariant(rawToken);
    if (!token || NON_TICKER_TOKENS.has(token) || ACTION_STOP_WORDS.has(token)) {
      continue;
    }

    const splitTokens = splitOnSeparators(token);
    for (const splitToken of splitTokens) {
      if (isStrictTicker(splitToken)) {
        result.push(splitToken);
      }
    }
  }

  return dedupePreserveOrder(result);
}

function extractActionSignals(actionText, referenceScores = new Map()) {
  const prepared = prepareActionText(actionText);
  const signals = {
    ADD: [],
    ALL: [],
    BUY: [],
    SELL: [],
    TRIM: [],
    noChanges: /\bNO CHANGES\b/.test(prepared)
  };

  const pattern = /\b(BUY|SELL|ADD|TRIM)\b([^]+?)(?=\b(?:BUY|SELL|ADD|TRIM)\b|$)/g;
  let match;
  while ((match = pattern.exec(prepared)) !== null) {
    const actionType = match[1];
    const actionBody = match[2]
      .replace(/\bKEYS?\b.*$/g, '')
      .replace(/\bBOTTOM\b.*$/g, '');
    const tickers = extractTickersFromFragment(actionBody, referenceScores);
    signals[actionType].push(...tickers);
  }

  for (const actionType of ACTION_TYPES) {
    signals[actionType] = dedupePreserveOrder(signals[actionType]);
    signals.ALL.push(...signals[actionType]);
  }

  signals.ALL = dedupePreserveOrder(signals.ALL);
  return signals;
}

function extractTickersFromFragment(fragment, referenceScores) {
  const prepared = normalizeOcrFragment(fragment)
    .replace(/\b\d+(?:\.\d+)?%\b/g, ' ')
    .replace(/\b\d+\/\d+\b/g, ' ')
    .replace(/[+&]/g, ' ')
    .replace(/\bTO\b/g, ' ');
  const tokens = [];

  for (const rawToken of prepared.split(/[\s,;:()]+/)) {
    const normalized = normalizeTickerVariant(rawToken);
    if (!normalized || ACTION_STOP_WORDS.has(normalized) || NON_TICKER_TOKENS.has(normalized)) {
      continue;
    }

    const splitTokens = splitOnSeparators(normalized);
    if (splitTokens.length > 1) {
      for (const splitToken of splitTokens) {
        if (isStrictTicker(splitToken)) {
          tokens.push(splitToken);
        }
      }

      continue;
    }

    if (isStrictTicker(normalized)) {
      tokens.push(normalized);
      continue;
    }

    const segmented = segmentCompositeToken(normalized, referenceScores);
    if (segmented.length > 1) {
      tokens.push(...segmented);
      continue;
    }

    const correction = findBestCorrection(alphaOnly(normalized), referenceScores, true);
    if (correction) {
      tokens.push(correction.candidate);
    }
  }

  return dedupePreserveOrder(tokens);
}

function prepareActionText(value) {
  return normalizeOcrFragment(value || '')
    .replace(/\bKEYS?\b.*$/g, '')
    .replace(/\bCOMMENT\b.*$/g, '');
}

function buildTickerKnowledge(rows) {
  const exactTokenScores = new Map();
  const highConfidenceScores = new Map();
  const actionTokenScores = new Map();
  const rawHoldingTokenScores = new Map();
  const seedTokenScores = new Map();

  const seedTickers = rows.seedTickers || [];
  for (const ticker of seedTickers) {
    addScore(seedTokenScores, normalizeTickerVariant(ticker), 20);
  }

  for (const row of rows.rows || rows) {
    for (const portfolioKey of ['gro', 'turbo']) {
      const holdings = Array.isArray(row[`${portfolioKey}_holdings`]) ? row[`${portfolioKey}_holdings`] : [];
      for (const holding of holdings) {
        const token = normalizeTickerVariant(holding);
        if (isStrictTicker(token)) {
          addScore(exactTokenScores, token);
          if (row.parse_status === 'ok' && Number(row.ocr_confidence || 0) >= HIGH_CONFIDENCE_THRESHOLD) {
            addScore(highConfidenceScores, token);
          }
        }
      }

      const rawHoldings = row[`${portfolioKey}_holdings_raw`] || '';
      for (const token of extractRawHoldingCandidates(rawHoldings)) {
        addScore(rawHoldingTokenScores, token);
      }

      const actionText = row[`${portfolioKey}_action_text`] || '';
      for (const token of extractLooseTickerCandidates(actionText)) {
        addScore(actionTokenScores, token);
      }
    }
  }

  const strongTokenScores = new Map();
  const allTokens = new Set([
    ...seedTokenScores.keys(),
    ...exactTokenScores.keys(),
    ...highConfidenceScores.keys(),
    ...rawHoldingTokenScores.keys(),
    ...actionTokenScores.keys()
  ]);

  for (const token of allTokens) {
    const exactCount = exactTokenScores.get(token) || 0;
    const highConfidenceCount = highConfidenceScores.get(token) || 0;
    const rawHoldingCount = rawHoldingTokenScores.get(token) || 0;
    const actionCount = actionTokenScores.get(token) || 0;
    const seedCount = seedTokenScores.get(token) || 0;
    if (seedCount > 0 || actionCount > 0 || exactCount > 1 || highConfidenceCount > 0 || rawHoldingCount > 1) {
      strongTokenScores.set(
        token,
        (seedCount * 3) + exactCount + (highConfidenceCount * 2) + rawHoldingCount + (actionCount * 3)
      );
    }
  }

  return {
    actionTokenScores,
    exactTokenScores,
    rawHoldingTokenScores,
    seedTokenScores,
    strongTokenScores
  };
}

function collectContextTickers(rows, actionSignalsByRow, rowIndex, portfolioKey, passIndex) {
  const contextTickers = [];
  const currentSignals = actionSignalsByRow[rowIndex][portfolioKey];
  contextTickers.push(...currentSignals.ALL);

  for (let offset = 1; offset <= 2; offset += 1) {
    if (rowIndex - offset >= 0) {
      contextTickers.push(...rows[rowIndex - offset][`${portfolioKey}_holdings`]);
      contextTickers.push(...actionSignalsByRow[rowIndex - offset][portfolioKey].BUY);
      contextTickers.push(...actionSignalsByRow[rowIndex - offset][portfolioKey].ADD);
    }

    if (rowIndex + offset < rows.length) {
      contextTickers.push(...rows[rowIndex + offset][`${portfolioKey}_holdings`]);
      contextTickers.push(...actionSignalsByRow[rowIndex + offset][portfolioKey].SELL);
      contextTickers.push(...actionSignalsByRow[rowIndex + offset][portfolioKey].TRIM);
    }
  }

  if (rows[rowIndex][`${portfolioKey}_no_changes`] === 'true') {
    if (rowIndex > 0) {
      contextTickers.push(...rows[rowIndex - 1][`${portfolioKey}_holdings`]);
    }

    if (rowIndex + 1 < rows.length) {
      contextTickers.push(...rows[rowIndex + 1][`${portfolioKey}_holdings`]);
    }
  }

  if (passIndex === 0) {
    return dedupePreserveOrder(contextTickers);
  }

  return dedupePreserveOrder(contextTickers);
}

function mergeAdjacentFragments(tokens, candidateScores, relaxed) {
  const merged = [];
  const notes = [];

  for (let index = 0; index < tokens.length; index += 1) {
    let consumed = 1;
    for (let span = 3; span >= 2; span -= 1) {
      if (index + span > tokens.length) {
        continue;
      }

      const slice = tokens.slice(index, index + span);
      const joined = normalizeTickerVariant(slice.join(''));
      if (!candidateScores.has(joined)) {
        continue;
      }

      const shouldMerge = relaxed || slice.some((token) => !candidateScores.has(token) || alphaOnly(token).length <= 1);
      if (!shouldMerge) {
        continue;
      }

      merged.push(joined);
      notes.push(`MERGE:${slice.join('+')}->${joined}`);
      consumed = span;
      break;
    }

    if (consumed > 1) {
      index += consumed - 1;
      continue;
    }

    merged.push(tokens[index]);
  }

  return {
    notes,
    tokens: merged
  };
}

function resolveCompositePart(part, referenceScores) {
  if (referenceScores.has(part)) {
    return {
      knownCount: 1,
      score: referenceScores.get(part) + (part.length * 10),
      token: part
    };
  }

  const correction = findBestCorrection(part, referenceScores, false);
  if (correction && correction.distance <= 1) {
    return {
      knownCount: 1,
      score: correction.score + 20,
      token: correction.candidate
    };
  }

  if (isPlausibleUnknownTicker(part)) {
    return {
      knownCount: 0,
      score: part.length,
      token: part
    };
  }

  return null;
}

function segmentCompositeToken(token, referenceScores) {
  const compact = alphaOnly(normalizeTickerVariant(token));
  if (compact.length <= MAX_TICKER_ALPHA_LENGTH) {
    return [];
  }

  const anchoredSplit = segmentUsingKnownAnchor(compact, referenceScores);
  if (anchoredSplit.length > 1) {
    return anchoredSplit;
  }

  const directSplit = segmentIntoTwoParts(compact, referenceScores);
  if (directSplit.length > 1) {
    return directSplit;
  }

  const memo = new Map();

  function search(index, partsUsed, unknownPartsUsed) {
    const memoKey = `${index}:${partsUsed}:${unknownPartsUsed}`;
    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }

    if (index >= compact.length) {
      return {
        knownCount: 0,
        parts: [],
        score: 0
      };
    }

    if (partsUsed >= 4 || unknownPartsUsed > 1) {
      return null;
    }

    let best = null;
    for (let length = COMPOSITE_MIN_LENGTH; length <= COMPOSITE_MAX_LENGTH; length += 1) {
      if (index + length > compact.length) {
        continue;
      }

      const part = compact.slice(index, index + length);
      const resolvedPart = resolveCompositePart(part, referenceScores);
      if (!resolvedPart) {
        continue;
      }

      const nextUnknownParts = unknownPartsUsed + (resolvedPart.knownCount === 0 ? 1 : 0);
      const rest = search(index + length, partsUsed + 1, nextUnknownParts);
      if (!rest) {
        continue;
      }

      const candidate = {
        knownCount: resolvedPart.knownCount + rest.knownCount,
        parts: [resolvedPart.token, ...rest.parts],
        score: resolvedPart.score + rest.score - (resolvedPart.knownCount === 0 ? 12 : 0)
      };
      if (!best
        || candidate.knownCount > best.knownCount
        || (candidate.knownCount === best.knownCount && candidate.score > best.score)) {
        best = candidate;
      }
    }

    memo.set(memoKey, best);
    return best;
  }

  const best = search(0, 0, 0);
  if (!best || best.parts.length <= 1 || best.knownCount === 0) {
    return [];
  }

  return best.parts;
}

function segmentUsingKnownAnchor(compact, referenceScores) {
  const candidates = [...referenceScores.entries()]
    .filter(([candidate]) => isStrictTicker(candidate))
    .sort((left, right) => {
      const leftLength = alphaOnly(left[0]).length;
      const rightLength = alphaOnly(right[0]).length;
      if (leftLength !== rightLength) {
        return rightLength - leftLength;
      }

      return (right[1] || 0) - (left[1] || 0);
    });

  for (const [candidate] of candidates) {
    const candidateAlpha = alphaOnly(candidate);
    if (candidateAlpha.length < 4 || candidateAlpha.length >= compact.length) {
      continue;
    }

    const suffixFragment = compact.slice(compact.length - candidateAlpha.length);
    if (levenshtein(suffixFragment, candidateAlpha) <= 1) {
      const prefixFragment = compact.slice(0, compact.length - candidateAlpha.length);
      const prefixResolved = resolveCompositePart(prefixFragment, referenceScores);
      if (prefixResolved && (prefixResolved.knownCount > 0 || isPlausibleUnknownTicker(prefixResolved.token))) {
        return [prefixResolved.token, candidate];
      }
    }

    const prefixFragment = compact.slice(0, candidateAlpha.length);
    if (levenshtein(prefixFragment, candidateAlpha) <= 1) {
      const suffixRemainder = compact.slice(candidateAlpha.length);
      const suffixResolved = resolveCompositePart(suffixRemainder, referenceScores);
      if (suffixResolved && (suffixResolved.knownCount > 0 || isPlausibleUnknownTicker(suffixResolved.token))) {
        return [candidate, suffixResolved.token];
      }
    }
  }

  return [];
}

function segmentIntoTwoParts(compact, referenceScores) {
  let best = null;

  for (let splitIndex = COMPOSITE_MIN_LENGTH; splitIndex <= compact.length - COMPOSITE_MIN_LENGTH; splitIndex += 1) {
    const leftPart = compact.slice(0, splitIndex);
    const rightPart = compact.slice(splitIndex);
    const resolvedLeft = resolveCompositePart(leftPart, referenceScores);
    const resolvedRight = resolveCompositePart(rightPart, referenceScores);
    if (!resolvedLeft || !resolvedRight) {
      continue;
    }

    const knownCount = resolvedLeft.knownCount + resolvedRight.knownCount;
    if (knownCount === 0) {
      continue;
    }

    const candidate = {
      knownCount,
      parts: [resolvedLeft.token, resolvedRight.token],
      score: resolvedLeft.score
        + resolvedRight.score
        - (resolvedLeft.knownCount === 0 ? 10 : 0)
        - (resolvedRight.knownCount === 0 ? 10 : 0)
    };

    if (!best
      || candidate.knownCount > best.knownCount
      || (candidate.knownCount === best.knownCount && candidate.score > best.score)) {
      best = candidate;
    }
  }

  return best ? best.parts : [];
}

function splitOnSeparators(token) {
  const normalized = normalizeTickerVariant(token);
  if (!/[./]/.test(normalized) || isShareClassTicker(normalized)) {
    return [normalized];
  }

  return normalized
    .split(/[./]/)
    .map(normalizeTickerVariant)
    .filter(Boolean);
}

function repairHoldingTokens(rawTokens, options) {
  const rowContext = {
    lowConfidence: options.ocrConfidence < LOW_CONFIDENCE_THRESHOLD,
    noChanges: options.noChanges
  };
  const candidateScores = buildCandidateScores(options.knowledge, options.contextTickers);
  const referenceScores = buildReferenceScores(options.knowledge, options.contextTickers);
  const initialTokens = rawTokens
    .map(normalizeTickerVariant)
    .filter(Boolean)
    .flatMap((token) => splitOnSeparators(token));
  const overrideResult = applyManualOverrides(initialTokens, options);
  const mergeResult = mergeAdjacentFragments(overrideResult.tokens, candidateScores, rowContext.lowConfidence || rowContext.noChanges);
  const repaired = [];
  const notes = [...overrideResult.notes, ...mergeResult.notes];

  for (const token of mergeResult.tokens) {
    const normalized = normalizeTickerVariant(token);
    if (!normalized || NON_TICKER_TOKENS.has(normalized)) {
      continue;
    }

    const expansion = findOneCharBoundaryExpansion(normalized, referenceScores);
    const supportedScore = referenceScores.get(normalized) || 0;
    if (expansion && expansion.support > supportedScore) {
      repaired.push(expansion.candidate);
      notes.push(`EXPAND:${normalized}->${expansion.candidate}`);
      continue;
    }

    const segmented = segmentCompositeToken(normalized, referenceScores);
    if (segmented.length > 1) {
      repaired.push(...segmented);
      notes.push(`SPLIT:${normalized}->${segmented.join('+')}`);
      continue;
    }

    const strictAndSupported = isStrictTicker(normalized) && isSupportedTicker(normalized, referenceScores);
    const needsCorrection = !strictAndSupported
      && (!isSupportedTicker(normalized, referenceScores)
        || normalized.includes('.')
        || alphaOnly(normalized).length > MAX_TICKER_ALPHA_LENGTH
        || (!isStrictTicker(normalized) && (rowContext.lowConfidence || rowContext.noChanges)));
    if (needsCorrection) {
      const correction = findBestCorrection(alphaOnly(normalized), referenceScores, rowContext.lowConfidence || rowContext.noChanges);
      if (correction && correction.candidate !== normalized) {
        repaired.push(correction.candidate);
        notes.push(`CORRECT:${normalized}->${correction.candidate}`);
        continue;
      }
    }

    repaired.push(normalized);
  }

  const finalTokens = dedupePreserveOrder(repaired.filter(Boolean));
  const suspiciousTickers = finalTokens.filter((token) => isSuspiciousTicker(token, referenceScores, rowContext));

  return {
    notes: dedupePreserveOrder(notes),
    suspiciousTickers: dedupePreserveOrder(suspiciousTickers),
    tokens: finalTokens
  };
}

function shouldInheritPreviousHoldings(row, previousRow, portfolioKey) {
  if (!previousRow) {
    return false;
  }

  if (row[`${portfolioKey}_no_changes`] !== 'true') {
    return false;
  }

  const currentSuspicious = row[`${portfolioKey}_suspicious_tickers`] || [];
  const previousSuspicious = previousRow[`${portfolioKey}_suspicious_tickers`] || [];
  const previousHoldings = previousRow[`${portfolioKey}_holdings`] || [];
  if (!previousHoldings.length) {
    return false;
  }

  const lowConfidence = Number(row.ocr_confidence || 0) < HIGH_CONFIDENCE_THRESHOLD;
  if (!lowConfidence && currentSuspicious.length === 0) {
    return false;
  }

  return previousSuspicious.length <= currentSuspicious.length;
}

function inheritPreviousHoldings(row, previousRow, portfolioKey) {
  row[`${portfolioKey}_holdings`] = [...previousRow[`${portfolioKey}_holdings`]];
  row[`${portfolioKey}_suspicious_tickers`] = [...(previousRow[`${portfolioKey}_suspicious_tickers`] || [])];
  row[`${portfolioKey}_repair_notes`] = dedupePreserveOrder([
    ...(row[`${portfolioKey}_repair_notes`] || []),
    `INHERIT_NO_CHANGES:${previousRow.source_file}`
  ]);
}

function repairSnapshotRows(rows) {
  const options = arguments[1] || {};
  const workingRows = rows.map((row) => ({
    ...row,
    gro_holdings: Array.isArray(row.gro_holdings) ? [...row.gro_holdings] : [],
    gro_repair_notes: [],
    gro_suspicious_tickers: [],
    turbo_holdings: Array.isArray(row.turbo_holdings) ? [...row.turbo_holdings] : [],
    turbo_repair_notes: [],
    turbo_suspicious_tickers: []
  }));
  const originals = workingRows.map((row) => ({
    gro: [...row.gro_holdings],
    turbo: [...row.turbo_holdings]
  }));
  const overrideIndex = buildManualOverrideIndex(options.manualOverrides || []);

  for (let passIndex = 0; passIndex < 2; passIndex += 1) {
    const knowledge = buildTickerKnowledge({
      rows: workingRows,
      seedTickers: options.tickerSeeds || []
    });
    const actionSignalsByRow = workingRows.map((row) => ({
      gro: extractActionSignals(row.gro_action_text || '', knowledge.strongTokenScores),
      turbo: extractActionSignals(row.turbo_action_text || '', knowledge.strongTokenScores)
    }));

    for (let rowIndex = 0; rowIndex < workingRows.length; rowIndex += 1) {
      const row = workingRows[rowIndex];
      for (const portfolioKey of ['gro', 'turbo']) {
        const repairResult = repairHoldingTokens(originals[rowIndex][portfolioKey], {
          contextTickers: collectContextTickers(workingRows, actionSignalsByRow, rowIndex, portfolioKey, passIndex),
          knowledge,
          noChanges: row[`${portfolioKey}_no_changes`] === 'true',
          ocrConfidence: Number(row.ocr_confidence || 0),
          overrideIndex,
          portfolioKey,
          sourceFile: row.source_file
        });

        row[`${portfolioKey}_holdings`] = repairResult.tokens;
        row[`${portfolioKey}_repair_notes`] = repairResult.notes;
        row[`${portfolioKey}_suspicious_tickers`] = repairResult.suspiciousTickers;

        const previousRow = rowIndex > 0 ? workingRows[rowIndex - 1] : null;
        if (shouldInheritPreviousHoldings(row, previousRow, portfolioKey)) {
          inheritPreviousHoldings(row, previousRow, portfolioKey);
        }
      }
    }
  }

  for (const row of workingRows) {
    if (row.gro_suspicious_tickers.length) {
      appendIssueCode(row, 'SUSPICIOUS_GRO_TICKERS');
    }

    if (row.turbo_suspicious_tickers.length) {
      appendIssueCode(row, 'SUSPICIOUS_TURBO_TICKERS');
    }
  }

  return workingRows;
}

module.exports = {
  buildTickerKnowledge,
  extractActionSignals,
  findBestCorrection,
  repairSnapshotRows
};