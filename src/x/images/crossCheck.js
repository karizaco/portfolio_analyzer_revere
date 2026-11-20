'use strict';

/**
 * Does the OCR of the same image corroborate a vision row?
 *
 * The vision model is a second READER, not an oracle: a holding it reports
 * goes into the scored data only when the image's own OCR words support it.
 * That is the project's rule for every reader of pixels -- two independent
 * readings have to agree before anything is written as fact
 * (tools/resolveUndatedDates.js, the Komar watchlist's three-scale vote).
 *
 *   ticker  appears among the OCR tokens exactly, OR is one edit away from
 *           an OCR token AND is a ticker the market list knows (OCR drops and
 *           confuses single glyphs; the market arbitrates which repair is real)
 *   number  its digits appear in the OCR text (a weight of "12.4%" needs
 *           "124" somewhere in the OCR's digit runs)
 *
 * A row that fails is kept, flagged `row_verified = 0` with the reason, and
 * left out of scoring.
 */

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * The OCR tokens and digit runs of an image.
 *
 * @param {Array<{text: string}>} words
 * @returns {{tokens: Set<string>, digits: string}}
 */
function ocrEvidence(words) {
  const tokens = new Set();
  const digitRuns = [];
  for (const word of words || []) {
    const text = String(word.text || '');
    for (const part of text.toUpperCase().split(/[^A-Z0-9.]+/)) {
      const clean = part.replace(/^\.+|\.+$/g, '');
      if (clean) tokens.add(clean);
    }
    const digits = text.replace(/[^0-9]/g, '');
    if (digits) digitRuns.push(digits);
  }
  return { tokens, digits: ` ${digitRuns.join(' ')} ` };
}

/**
 * @param {string} ticker
 * @param {{tokens: Set<string>}} evidence
 * @param {Set<string>} market
 * @returns {'exact'|'near'|''}
 */
function verifyTicker(ticker, evidence, market) {
  const symbol = String(ticker || '').toUpperCase().replace(/^\$/, '');
  if (!symbol) return '';
  if (evidence.tokens.has(symbol)) return 'exact';
  if (!market || !market.has(symbol)) return '';
  for (const token of evidence.tokens) {
    if (/^[A-Z]{1,6}$/.test(token) && editDistanceAtMostOne(token, symbol)) return 'near';
  }
  return '';
}

/**
 * @param {string} printed - the number as the model says it is printed
 * @param {{digits: string}} evidence
 * @returns {boolean}
 */
function verifyNumber(printed, evidence) {
  const digits = String(printed || '').replace(/[^0-9]/g, '');
  if (!digits) return true; // nothing claimed, nothing to verify
  if (digits.length < 2) return evidence.digits.includes(digits);
  return evidence.digits.includes(digits);
}

const NUMBER_FIELDS = ['weight_pct_text', 'market_value_text', 'shares_text', 'avg_cost_text', 'gain_pct_text'];

/**
 * Verify one vision row.
 *
 * @param {object} row - a positions[] entry of the vision reading
 * @param {Array<{text: string}>} words - the OCR words of the same image
 * @param {Set<string>} market
 * @returns {{verified: boolean, detail: string}}
 */
function verifyRow(row, words, market) {
  const evidence = ocrEvidence(words);
  const tickerMatch = verifyTicker(row.ticker, evidence, market);
  const failedNumbers = NUMBER_FIELDS.filter((field) => !verifyNumber(row[field], evidence));
  const parts = [];
  if (!tickerMatch) parts.push(`ticker ${row.ticker} not in the OCR`);
  else if (tickerMatch === 'near') parts.push('ticker one edit from an OCR token');
  if (failedNumbers.length) parts.push(`numbers not in the OCR: ${failedNumbers.join(', ')}`);
  return { verified: Boolean(tickerMatch) && failedNumbers.length === 0, detail: parts.join('; ') };
}

/**
 * A printed number as a value: "$12,345.67" -> 12345.67, "-3.4%" -> -3.4.
 *
 * @param {string} printed
 * @returns {number|null}
 */
function parsePrinted(printed) {
  const text = String(printed || '').trim();
  if (!text) return null;
  const negative = /^-|^\(.*\)$|−/.test(text);
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

module.exports = { NUMBER_FIELDS, editDistanceAtMostOne, ocrEvidence, parsePrinted, verifyNumber, verifyRow, verifyTicker };
