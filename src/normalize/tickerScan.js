'use strict';

// Thin convenience wrapper around repairHoldings' ticker extraction so the
// video OCR scanner can pull tickers out of free-form OCR text without
// duplicating the seed-lexicon + fuzzy-correction logic.
//
// The scan-side use case is narrower than the full repair pipeline:
//   * No prior parsed rows are available (we only have raw OCR text).
//   * The seed lexicon (config/ticker_lexicon_seed.csv) is the only reference.
//   * Output should be a deduped, sorted, uppercase list of ticker symbols
//     that survived the strict-ticker shape check AND appear in the seed
//     lexicon — fuzzy correction is deliberately disabled here so a stray
//     OCR fragment like "TALE" or "TUE" can't be auto-corrected into the
//     nearest seed ticker and falsely reported as a holding.

const fs = require('node:fs');
const path = require('node:path');

const { buildTickerKnowledge, buildReferenceScores } = require('./repairHoldings');

const { STRICT_TICKER_PATTERN, tokenizeText, extractTickers } = require('./tickerExtraction');

let cachedLexicon = null;

function normalizeSeedTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function loadSeedLexiconSync(configDirectory) {
  if (cachedLexicon) {
    return cachedLexicon;
  }

  const resolvedDirectory = path.resolve(
    configDirectory || path.join(__dirname, '..', '..', 'config')
  );
  const csvPath = path.join(resolvedDirectory, 'ticker_lexicon_seed.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');

  const tickers = [];
  let isHeader = true;
  for (const line of raw.split(/\r?\n/)) {
    if (isHeader) {
      isHeader = false;
      if (/^ticker\s*,/i.test(line)) {
        continue;
      }
    }
    const firstField = line.split(',')[0].trim();
    const ticker = normalizeSeedTicker(firstField);
    if (ticker) {
      tickers.push(ticker);
    }
  }

  cachedLexicon = {
    csvPath,
    tickers: [...new Set(tickers)].sort(),
    tickerSet: new Set(tickers)
  };
  return cachedLexicon;
}

function buildSeedReferenceScores(configDirectory) {
  const { tickers } = loadSeedLexiconSync(configDirectory);
  const knowledge = buildTickerKnowledge({ seedTickers: tickers, rows: [] });
  return {
    knowledge,
    referenceScores: buildReferenceScores(knowledge, [])
  };
}

function extractTickersFromOcrText(ocrText, options = {}) {
  const text = String(ocrText || '');
  if (!text.trim()) {
    return [];
  }

  const { tickers } = loadSeedLexiconSync(options.configDirectory);
  const lexicon = new Set(tickers);

  // Pre-process: find tokens that look like ticker merges (long, not in lexicon)
  // and replace them with their split components so extractTickers can find them.
  const TOKEN_SPLIT_PATTERN = /[\s,;:()\[\]{}<>/\\|]+/;
  const STRICT_TICKER_PATTERN = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;
  const seen = new Set();
  const extraSplitTickers = [];

  for (const rawToken of text.toUpperCase().split(TOKEN_SPLIT_PATTERN)) {
    const token = rawToken.replace(/[^A-Z0-9]/gi, '');
    if (!token || token.length <= 5) continue;
    if (STRICT_TICKER_PATTERN.test(token)) continue;  // was already handled
    if (lexicon.has(token)) continue;  // actually in lexicon

    // This token is a potential ticker merge — try to split it
    const splits = tryLexiconSplits(token, lexicon);
    for (const t of splits) {
      if (!seen.has(t)) { seen.add(t); extraSplitTickers.push(t); }
    }
  }

  // Build a modified text with split tokens injected
  let modifiedText = text;
  for (const t of extraSplitTickers) {
    // Append the split ticker as a separate "word" so tokenizeText finds it
    modifiedText += ' ' + t;
  }

  const allTickers = extractTickers(modifiedText, lexicon);
  return [...new Set(allTickers)].sort();
}

/**
 * Try all partitions of `token` where every part is a lexicon ticker.
 * Returns the split with the most parts (most granular).
 */
function tryLexiconSplits(token, lexicon) {
  if (token.length <= 5) return [];
  const splits = [];
  const maxParts = Math.floor(token.length / 2);

  // DP approach: reachable[i] = true if token[0..i] can be segmented into lexicon tickers.
  // Compute reachable positions by trying every ticker length (2-5) at every position.
  const reachable = new Array(token.length + 1).fill(false);
  reachable[0] = true;

  for (let i = 0; i < token.length; i++) {
    if (!reachable[i]) continue;
    for (let len = 2; len <= Math.min(5, token.length - i); len++) {
      const part = token.slice(i, i + len);
      if (lexicon.has(part)) {
        reachable[i + len] = true;
      }
    }
  }

  if (!reachable[token.length]) return [];

  // Backtrack to find all valid partitions from position 0
  function backtrack(start, path) {
    if (start === token.length) {
      splits.push([...path]);
      return;
    }
    for (let len = 2; len <= Math.min(5, token.length - start); len++) {
      const part = token.slice(start, start + len);
      if (lexicon.has(part) && reachable[start + len]) {
        backtrack(start + len, [...path, part]);
        if (path.length + 1 >= maxParts) break;  // prune: don't explore more parts than needed
      }
    }
  }

  backtrack(0, []);

  if (splits.length > 0) {
    splits.sort((a, b) => b.length - a.length);
    return splits[0];
  }
  return [];
}

function clearTickerScanCache() {
  cachedLexicon = null;
}

module.exports = {
  buildSeedReferenceScores,
  clearTickerScanCache,
  extractTickersFromOcrText,
  loadSeedLexiconSync
};

