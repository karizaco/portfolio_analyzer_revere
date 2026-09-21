'use strict';

// Pure parser for the Qullamaggie-style "position list overlay" that sits in
// the bottom-right corner of a streamed chart frame. The OCR pipeline hands
// us raw OCR text + the region-cropped pixels; this function emits a sorted
// list of tickers that:
//   1. match the strict uppercase ticker shape, AND
//   2. EITHER survive the seed-lexicon membership check OR have a price token
//      nearby (so a large hard lexicon is not required — any ticker-shaped
//      token that appears alongside a price/%/value is accepted), AND
//   3. appear at least once in the OCR text for the frame.
//
// This deliberately does NOT reimplement the GRO/TURBO parser — chart-stream
// videos don't have a portfolio summary, just ticker positions.

const { extractTickersFromOcrText, loadSeedLexiconSync, clearTickerScanCache } = require('../normalize/tickerScan');
const { STRICT_TICKER_PATTERN } = require('../normalize/tickerExtraction');

// Matches OCR-split prices:  $ 412.50  ($ split from digits by whitespace)
// Also matches:  $412.50,  412.50,  HIGH/LOW/CLOSE/TARGET/STOP/BID/ASK
const PRICE_TOKEN_PATTERN = /\$\s*\d+(?:\.\d+)?|\d+\.\d+|\b(?:high|low|close|target|stop|bid|ask)\b/i;

// Matches a percentage sign or a +/- value in the OCR text
const PERCENT_PATTERN = /[+-]\d+(?:\.\d+)?%/;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function countTickerOccurrences(ocrText) {
  const counts = new Map();
  for (const token of String(ocrText || '').split(/[\s,;:()\[\]{}<>/\\|]+/)) {
    const cleaned = String(token || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned) continue;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  }
  return counts;
}

function hasPriceNear(ocrText, ticker) {
  if (!ocrText) return false;
  // Search for the ticker as a whole word; accept up to 12 trailing chars
  // (the OCR frequently splits dollar prices from the symbol, e.g. "GOVX | +1827%").
  const proximityPattern = new RegExp(
    `\\b${ticker}\\b[^A-Z0-9.]{0,12}(\\$\\s*\\d|\\d+\\.\\d|\\b(?:HIGH|LOW|CLOSE|TARGET|STOP|BID|ASK)\\b|[+-]\\d+(?:\\.\\d+)?%)`,
    'i'
  );
  return proximityPattern.test(ocrText);
}

// Extract ALL ticker-shaped tokens from OCR text (ignores lexicon).
// Used as the primary extraction so we don't miss tickers not in the seed lexicon.
function extractAllTickerCandidates(ocrText) {
  const tokens = String(ocrText || '').split(/[\s,;:()\[\]{}<>/\\|]+/);
  const seen = new Set();
  const results = [];
  for (const token of tokens) {
    const cleaned = String(token || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (STRICT_TICKER_PATTERN.test(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

function parseChartStreamPositionList({ ocr } = {}) {
  const text = normalizeWhitespace(ocr && ocr.text ? ocr.text : '');
  const lines = Array.isArray(ocr && ocr.lines) ? ocr.lines : [];

  if (!text) {
    return {
      confidence: 0,
      parse_status: 'no_ocr',
      position_list: [],
      price_action: '',
      tickers_rejected: 0
    };
  }

  clearTickerScanCache();
  const lexicon = loadSeedLexiconSync();

  // Primary extraction: ALL ticker-shaped tokens (no lexicon filter)
  const allCandidates = extractAllTickerCandidates(text);
  // Secondary extraction: lexicon-filtered candidates (for confidence scoring)
  const lexiconCandidates = extractTickersFromOcrText(text);

  if (!allCandidates.length) {
    return {
      confidence: 0,
      parse_status: 'no_ticker_shapes',
      position_list: [],
      price_action: '',
      tickers_rejected: 0
    };
  }

  const occurrenceCounts = countTickerOccurrences(text);
  const accepted = [];
  const rejected = [];
  for (const ticker of allCandidates) {
    const occurrences = occurrenceCounts.get(ticker) || 0;
    const priceNearby = hasPriceNear(text, ticker);
    const inLexicon = lexicon.tickers.includes(ticker);
    // Accept if: in lexicon OR has a price/percent token nearby.
    // Price-nearby is the primary signal — it catches real tickers not in lexicon.
    if (inLexicon || priceNearby) {
      accepted.push(ticker);
    } else {
      rejected.push(ticker);
    }
  }

  const priceActionHint = lines.find((line) => PRICE_TOKEN_PATTERN.test(line)) || '';

  // Confidence: 1.0 when at least 3 tickers accepted AND at least one had a
  // price-nearby signal; 0.5 when 1–2 accepted; 0 otherwise.
  let confidence = 0;
  if (accepted.length >= 3 && accepted.some((t) => hasPriceNear(text, t))) {
    confidence = 1;
  } else if (accepted.length >= 1) {
    confidence = 0.5;
  }

  return {
    confidence,
    parse_status: accepted.length ? 'ok' : 'no_position_list',
    position_list: accepted.sort(),
    price_action: priceActionHint || '',
    tickers_rejected: rejected.length
  };
}

module.exports = {
  hasPriceNear,
  parseChartStreamPositionList,
  extractAllTickerCandidates
};
