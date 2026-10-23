'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Decoding a mis-read ticker against the lexicon.
//
// The position list's glyphs are 7-9 px tall. The recogniser reads most of
// them, but it substitutes letters it cannot resolve ("TQQQ" -> "TOCQ",
// "COPX" -> "COPY") and sometimes drops one ("TSLA" -> "TSL"). The errors
// are STABLE: the same pixels give the same mis-reading at every scale and
// every resampling, because the information is simply not in the picture.
// A second opinion from the same recogniser cannot fix that — only a
// second RECOGNISER, or a constraint, can.
//
// The constraint is the lexicon: a position list holds tickers, and there
// are only so many tickers. Decoding the read against the lexicon turns
// "TOCQ" back into "TQQQ" without anybody having to write down that TOCQ
// means TQQQ.
//
// This replaces the hand-written ticker-pair list
// (config/ticker_ocr_confusions.csv) with a CHARACTER-level model that is
// ESTIMATED from labelled reads (tools/learnCharConfusion.js). A
// character-level model generalises: once "X -> Y" has been seen a few
// times, every ticker containing an X is corrected, including tickers
// nobody has tripped over yet.
//
// THE COST MODEL
//   match              0
//   substitution       1.0 normally; 0.25-0.75 for a pair the confusion
//                      model has actually observed, scaled by how often it
//                      was observed
//   insertion/deletion 1.5
//
// A substitution the model has never seen costs 1.0, which is above the
// acceptance threshold: an unexplained one-character difference is NOT
// silently corrected into some other ticker. Only a difference the model
// can explain is accepted. That is what keeps precision up — the decoder
// must not turn every stray fragment into a plausible ticker.

const DEFAULT_MAX_COST = 0.85;
const DEFAULT_MARGIN = 0.2;
const INDEL_COST = 1.5;
const UNKNOWN_SUBSTITUTION = 1.0;

// A hypothesis is a ticker-shaped string. Anything longer is a merged
// reading, not a ticker.
const MAX_TICKER_LENGTH = 5;

let cachedConfusion = null;
let cachedConfusionKey = '';

/**
 * Load the learned character confusion matrix.
 *
 * The file is written by tools/learnCharConfusion.js as
 * "from,to,count" — one row per observed character substitution.
 *
 * @returns {{pairs: Map<string, number>, max: number, path: string}}
 */
function loadCharConfusion(csvPath) {
  const resolved = path.resolve(
    csvPath || path.join(__dirname, '..', '..', 'config', 'ticker_char_confusion.csv')
  );
  if (cachedConfusion && cachedConfusionKey === resolved) return cachedConfusion;
  const pairs = new Map();
  let max = 0;
  if (fs.existsSync(resolved)) {
    const raw = fs.readFileSync(resolved, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(',').map((p) => p.trim());
      if (parts.length < 3) continue;
      const from = parts[0].toUpperCase();
      const to = parts[1].toUpperCase();
      const count = Number(parts[2]);
      if (!from || !to || !Number.isFinite(count) || count <= 0) continue;
      if (from.length !== 1 || to.length !== 1) continue;
      pairs.set(`${from}>${to}`, count);
      if (count > max) max = count;
    }
  }
  cachedConfusion = { pairs, max, path: resolved };
  cachedConfusionKey = resolved;
  return cachedConfusion;
}

function clearCharConfusionCache() {
  cachedConfusion = null;
  cachedConfusionKey = '';
}

/**
 * The cost of substituting one character for another.
 */
function substitutionCost(from, to, model) {
  if (from === to) return 0;
  if (!model || !model.max) return UNKNOWN_SUBSTITUTION;
  const count = model.pairs.get(`${from}>${to}`);
  if (!count) return UNKNOWN_SUBSTITUTION;
  // A frequently observed confusion is cheap, a rare one is nearly as
  // expensive as an unexplained difference.
  return 0.25 + 0.5 * (1 - count / model.max);
}

/**
 * Weighted edit distance between two strings.
 *
 * `costOf(a, b)` gives the cost of substituting `a` with `b`.
 */
function weightedEditDistance(a, b, costOf) {
  const n = a.length;
  const m = b.length;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j * INDEL_COST;
  for (let i = 1; i <= n; i++) {
    cur[0] = i * INDEL_COST;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + costOf(a[i - 1], b[j - 1]);
      const del = prev[j] + INDEL_COST;
      const ins = cur[j - 1] + INDEL_COST;
      cur[j] = Math.min(sub, del, ins);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[m];
}

/**
 * Decode one cell's read against the lexicon.
 *
 * @param {Array<{text:string, conf?:number, source?:string}>} hypotheses
 * @param {object} options
 *   lexicon    {tickers: string[], tickerSet: Set<string>}
 *   confusion  the learned matrix (see loadCharConfusion)
 *   maxCost    acceptance threshold (default 0.85)
 *   margin     how far the winner must beat the runner-up (default 0.2)
 * @returns {{ticker:string, raw:string, cost:number, confidence:number,
 *            source:string, alternatives:Array}|null}
 */
function decodeCell(hypotheses, options = {}) {
  const lexicon = options.lexicon;
  if (!lexicon || !lexicon.tickers || !lexicon.tickers.length) return null;
  const model = options.confusion || loadCharConfusion();
  const maxCost = options.maxCost === undefined ? DEFAULT_MAX_COST : options.maxCost;
  const margin = options.margin === undefined ? DEFAULT_MARGIN : options.margin;
  const set = lexicon.tickerSet || new Set(lexicon.tickers);

  let best = null;
  const alternatives = [];

  for (const h of hypotheses || []) {
    const text = String((h && h.text) || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!text || text.length > MAX_TICKER_LENGTH) continue;
    const conf = Number((h && h.conf) || 0);

    // An exact hit needs no search.
    if (set.has(text)) {
      const candidate = { ticker: text, raw: text, cost: 0, confidence: conf, source: (h && h.source) || '' };
      if (!best || candidate.cost < best.cost
        || (candidate.cost === best.cost && candidate.confidence > best.confidence)) {
        best = candidate;
      }
      alternatives.push(candidate);
      continue;
    }

    let localBest = null;
    let localSecond = null;
    for (const ticker of lexicon.tickers) {
      // A ticker can only be a near-miss of a read of a similar length.
      if (Math.abs(ticker.length - text.length) > 2) continue;
      const cost = weightedEditDistance(text, ticker, (a, b) => substitutionCost(a, b, model));
      if (!localBest || cost < localBest.cost) {
        localSecond = localBest;
        localBest = { ticker, cost };
      } else if (!localSecond || cost < localSecond.cost) {
        localSecond = { ticker, cost };
      }
    }
    if (!localBest || localBest.cost > maxCost) continue;
    // The read must identify ONE ticker. If a second ticker explains it
    // almost as well, the read does not say which one it is — and guessing
    // would be exactly the ad-hoc repair this decoder replaces.
    if (localSecond && localSecond.cost - localBest.cost < margin) continue;
    const candidate = {
      ticker: localBest.ticker,
      raw: text,
      cost: localBest.cost,
      confidence: conf,
      source: (h && h.source) || '',
    };
    alternatives.push(candidate);
    if (!best || candidate.cost < best.cost
      || (candidate.cost === best.cost && candidate.confidence > best.confidence)) {
      best = candidate;
    }
  }

  if (!best) return null;

  // The winner must be clearly better than the next plausible ticker.
  // Two tickers at the same cost means the read does not identify one.
  const rivals = alternatives
    .filter((a) => a.ticker !== best.ticker)
    .map((a) => a.cost)
    .sort((x, y) => x - y);
  const rival = rivals.length ? rivals[0] : Infinity;
  if (best.cost > 0 && rival - best.cost < margin) return null;

  return { ...best, alternatives };
}

/**
 * Decode a column's rows.
 *
 * @param {Array<{text:string, conf?:number}>} rows
 * @returns {Array<{ticker:string|null, raw:string, cost:number}>}
 */
function decodeRows(rows, options = {}) {
  return (rows || []).map((row) => {
    const decoded = decodeCell([row], options);
    return {
      ticker: decoded ? decoded.ticker : null,
      raw: row.text,
      cost: decoded ? decoded.cost : Infinity,
      confidence: decoded ? decoded.confidence : 0,
    };
  });
}

module.exports = {
  decodeCell,
  decodeRows,
  loadCharConfusion,
  clearCharConfusionCache,
  weightedEditDistance,
  substitutionCost,
  DEFAULT_MAX_COST,
  DEFAULT_MARGIN,
  INDEL_COST,
};
