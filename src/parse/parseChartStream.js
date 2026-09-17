'use strict';

// Pure parser for the Qullamaggie-style "position list overlay" that sits in
// the bottom-right corner of a streamed chart frame. The OCR pipeline hands
// us raw OCR text + the region-cropped pixels; this function emits a sorted
// list of tickers that:
//   1. match the strict uppercase ticker shape, AND
//   2. survive the seed-lexicon membership check (no fuzzy correction), AND
//   3. appear more than once in the OCR text for the frame, OR are followed by
//      a price/numeric token — defends against one-off OCR noise on a chart
//      axis label (e.g. "MSFT $412.30" only counts because of the $ price).
//
// This deliberately does NOT reimplement the GRO/TURBO parser — chart-stream
// videos don't have a portfolio summary, just ticker positions.

const { extractTickersFromOcrText, loadSeedLexiconSync, clearTickerScanCache } = require('../normalize/tickerScan');

const PRICE_TOKEN_PATTERN = /\$\s*\d|\d+\.\d|\b(?:high|low|close|target|stop|bid|ask)\b/i;

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
  // Search for the ticker as a whole word; accept up to 4 trailing tokens
  // (the OCR frequently splits dollar prices from the symbol).
  const proximityPattern = new RegExp(
    `\\b${ticker}\\b[^A-Z0-9.]{0,12}(\\$\\s*\\d|\\d+\\.\\d|\\b(?:HIGH|LOW|CLOSE|TARGET|STOP|BID|ASK)\\b)`,
    'i'
  );
  return proximityPattern.test(ocrText);
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
  const candidates = extractTickersFromOcrText(text);
  if (!candidates.length) {
    return {
      confidence: 0,
      parse_status: 'no_seed_tickers',
      position_list: [],
      price_action: '',
      tickers_rejected: 0
    };
  }

  const occurrenceCounts = countTickerOccurrences(text);
  const accepted = [];
  const rejected = [];
  for (const ticker of candidates) {
    const occurrences = occurrenceCounts.get(ticker) || 0;
    const priceNearby = hasPriceNear(text, ticker);
    if (occurrences >= 2 || priceNearby) {
      accepted.push(ticker);
    } else {
      rejected.push(ticker);
    }
  }

  const priceActionHint = lines.find((line) => PRICE_TOKEN_PATTERN.test(line)) || '';

  // Confidence: 1.0 when at least 3 tickers survived AND at least one had a
  // nearby price token; 0.5 when 1–2 survived with no price; 0 otherwise.
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
  parseChartStreamPositionList
};
