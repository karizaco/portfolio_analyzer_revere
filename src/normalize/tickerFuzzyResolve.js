'use strict';

/**
 * Lexicon-constrained resolution of an OCR token to a ticker.
 *
 * TWO LEXICONS, TWO JOBS:
 *
 *   match — what a token MAY be. The seed lexicon plus the observed one.
 *           A real ticker the seed does not know resolves to ITSELF here
 *           rather than to a neighbouring seed ticker: SPXL must not become
 *           SOXL, which is a different instrument. (CLAUDE.md: "the clusterer
 *           repairs against the OBSERVED lexicon, not the seed lexicon".)
 *   allow — what may be REPORTED. The seed.
 *
 * A token that resolves to a known ticker which is not on the allow list is
 * dropped rather than reported: the report is a list of holdings, and a wrong
 * ticker in it is worse than a missing one.
 *
 * A token with SEVERAL equally close candidates is ambiguous. The parser
 * cannot know which instrument was meant, so the token is dropped rather than
 * guessed — and the candidates are returned so the loss stays visible in the
 * rejection log instead of disappearing.
 */

const DEFAULT_MAX_EDIT_DISTANCE = 2;

/**
 * Levenshtein distance between two strings. Callers upper-case first.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let previous = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) previous[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const current = new Array(n + 1);
    current[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[n];
}

/**
 * Resolve one OCR token to a ticker.
 *
 * Returns one of:
 *   { status: 'exact',     ticker, corrected: false, reportable }
 *   { status: 'corrected', ticker, corrected: true, distance, reportable }
 *   { status: 'ambiguous', ticker: null, candidates: [...] }
 *   { status: 'unknown',   ticker: null }
 */
function resolveTickerToken(token, options) {
  const {
    matchTickers = [],
    matchSet = new Set(matchTickers),
    allowSet = matchSet,
    maxDistance = DEFAULT_MAX_EDIT_DISTANCE,
  } = options || {};

  const upper = String(token || '').toUpperCase();
  if (!upper) return { status: 'unknown', ticker: null };

  if (matchSet.has(upper)) {
    return { status: 'exact', ticker: upper, corrected: false, reportable: allowSet.has(upper) };
  }

  let best = Infinity;
  const candidates = [];
  for (const ticker of matchTickers) {
    const dist = levenshtein(upper, ticker);
    if (dist === 0 || dist > maxDistance) continue;
    if (dist < best) {
      best = dist;
      candidates.length = 0;
      candidates.push(ticker);
    } else if (dist === best) {
      candidates.push(ticker);
    }
  }

  if (!candidates.length) return { status: 'unknown', ticker: null };
  if (candidates.length > 1) {
    return { status: 'ambiguous', ticker: null, candidates: candidates.slice() };
  }
  return {
    status: 'corrected',
    ticker: candidates[0],
    corrected: true,
    distance: best,
    reportable: allowSet.has(candidates[0]),
  };
}

/**
 * Split a token that is several tickers fused together by the OCR.
 *
 * Tesseract loses the comma between two holdings and renders it as nothing
 * at all ("TQQNCLD", "SPXLIBIT") or as a period ("LITE.OOCN").
 *
 * Every part must RESOLVE — exactly, or to a single close candidate — or the
 * split is rejected: a partition that guesses is worse than no partition.
 * A two-character part must be an EXACT ticker: a two-character token that
 * "corrects" into a longer one is how a partition invents a holding
 * ("SP" → "SPY").
 *
 * Among the partitions that do resolve, the one with the most parts wins,
 * then the one with the fewest corrections.
 *
 * Returns null when the token cannot be split.
 */
function splitFusedTicker(token, options) {
  const upper = String(token || '').toUpperCase();
  // Two tickers need at least four characters ("MU,P" is three).
  if (upper.length < 5) return null;

  const maxParts = Math.min(4, Math.floor(upper.length / 2));
  const splits = [];

  const walk = (start, path) => {
    if (start === upper.length) {
      if (path.length >= 2) splits.push(path.slice());
      return;
    }
    if (path.length >= maxParts) return;
    for (let len = 2; len <= Math.min(5, upper.length - start); len += 1) {
      const slice = upper.slice(start, start + len);
      const resolution = resolveTickerToken(slice, options);
      // Unknown or ambiguous → not a part.
      if (!resolution.ticker) continue;
      // A two-character part has to BE a ticker.
      if (slice.length === 2 && resolution.status !== 'exact') continue;
      walk(start + len, [...path, { text: slice, resolution }]);
    }
  };
  walk(0, []);

  if (!splits.length) return null;

  const edits = (parts) => parts.reduce((sum, p) => sum + (p.resolution.corrected ? 1 : 0), 0);
  splits.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const diff = edits(a) - edits(b);
    if (diff !== 0) return diff;
    return a.map((p) => p.text).join('|').localeCompare(b.map((p) => p.text).join('|'));
  });
  return splits[0];
}

module.exports = {
  DEFAULT_MAX_EDIT_DISTANCE,
  levenshtein,
  resolveTickerToken,
  splitFusedTicker,
};
