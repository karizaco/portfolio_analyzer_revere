'use strict';

// Shared ticker extraction logic used by both the video OCR scanner
// (tickerScan.js) and the Discord pipeline (Python ticker_extraction.py).
//
// Canonical rules:
//   1. Split text on whitespace and punctuation  → token candidates.
//   2. Strip residual non-alphanumeric noise from each token.
//   3. Reject anything that does not match STRICT_TICKER_PATTERN.
//   4. Confirm the token exists in the seed lexicon Set.

const STRICT_TICKER_PATTERN = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;
const TOKEN_SPLIT_PATTERN = /[\s,;:()\[\]{}<>/\\|]+/;
const NORMALIZE_PATTERN = /[^A-Z0-9.]/g;

/**
 * Split raw text into candidate ticker tokens.
 *
 * @param {string} text - Free-form text (e.g. OCR output, Discord message).
 * @returns {string[]} - Non-empty token candidates in original order.
 */
function tokenizeText(text) {
  const str = String(text || '');
  if (!str.trim()) {
    return [];
  }
  const tokens = str.split(TOKEN_SPLIT_PATTERN);
  return tokens.filter(Boolean);
}

/**
 * Strip non-alphanumeric noise from an OCR fragment so "TQQQ." or "TQQQ,"
 * collapses to the same seed match as "TQQQ".
 *
 * @param {string} rawToken
 * @returns {string}
 */
function normalizeTickerToken(rawToken) {
  return String(rawToken || '')
    .toUpperCase()
    .replace(NORMALIZE_PATTERN, '');
}

/**
 * Extract validated ticker symbols from free-form text.
 *
 * @param {string} text - Raw text to scan.
 * @param {Set<string>} lexicon - Set of known-good ticker strings (uppercase).
 * @returns {string[]} - Sorted, deduplicated list of matching tickers.
 */
function extractTickers(text, lexicon) {
  const str = String(text || '');
  if (!str.trim()) {
    return [];
  }

  const seen = new Set();
  const matched = [];

  for (const rawToken of str.split(TOKEN_SPLIT_PATTERN)) {
    const token = normalizeTickerToken(rawToken);
    if (!token) {
      continue;
    }
    if (!STRICT_TICKER_PATTERN.test(token)) {
      continue;
    }
    if (!lexicon.has(token)) {
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

module.exports = {
  STRICT_TICKER_PATTERN,
  TOKEN_SPLIT_PATTERN,
  extractTickers,
  normalizeTickerToken,
  tokenizeText
};
