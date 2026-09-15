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

const STRICT_TICKER_PATTERN = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;
const TOKEN_SPLIT_PATTERN = /[\s,;:()\[\]{}<>/\\|]+/;

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
    tickers: [...new Set(tickers)].sort()
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

// Strip non-alphanumeric noise from an OCR fragment so "TQQQ." or "TQQQ,"
// collapses to the same seed match as "TQQQ".
function normalizeTickerToken(rawToken) {
  return String(rawToken || '')
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, '');
}

function extractTickersFromOcrText(ocrText, options = {}) {
  const text = String(ocrText || '');
  if (!text.trim()) {
    return [];
  }

  const seedTickerSet = new Set(loadSeedLexiconSync(options.configDirectory).tickers);

  const seen = new Set();
  const matched = [];
  for (const rawToken of text.split(TOKEN_SPLIT_PATTERN)) {
    const token = normalizeTickerToken(rawToken);
    if (!token || !STRICT_TICKER_PATTERN.test(token) || !seedTickerSet.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    matched.push(token);
  }

  return matched.sort();
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

