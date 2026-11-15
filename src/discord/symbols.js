'use strict';

/**
 * Which tokens of a Discord message are TICKERS.
 *
 * WHY THE OLD EXTRACTION WAS UNUSABLE
 *
 * `tools/discord_pipeline/import_channel.py` upper-cases the whole message
 * and then matches every 2-5 letter run. So "on", "at", "of" and "to" became
 * ON, AT, OF and TO -- and the status page's top "ticker" was ON.
 *
 * THE RULES
 *
 * 1. The ORIGINAL case decides. A ticker is written in capitals; the words
 *    around it are not. Nothing is upper-cased before matching.
 * 2. `$TICKER` is always a ticker.
 * 3. A bare capitals token must be KNOWN: in the lexicon, or observed in a
 *    slot where only a ticker can stand (a portfolio line, "Bought X").
 * 4. Trading jargon in capitals (LOD, VWAP, HOD ...) is never a ticker.
 * 5. "BE" is Bloom Energy AND break-even. "stop to BE" / "closing at BE" is
 *    break-even; "Bought BE" is the stock.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEXICON_PATH = path.join(ROOT, 'config', 'ticker_lexicon_sevcik.csv');

/** Capitals that are jargon or plain words, measured on the corpus. */
const JARGON = new Set([
  'LOD', 'HOD', 'VWAP', 'EOD', 'ORB', 'ATH', 'ATR', 'EMA', 'SMA', 'DMA', 'WMA', 'RSI', 'RS',
  'NAAIM', 'COT', 'HVC', 'MAU', 'FOMC', 'FOMO', 'CPI', 'PPI', 'GDP', 'PCE', 'NFP', 'FED',
  'ETF', 'IPO', 'ADR', 'EPS', 'YTD', 'ROI', 'PM', 'AH', 'ER', 'PT', 'SL', 'TP', 'PNL', 'USD',
  'AI', 'US', 'USA', 'CEO', 'CFO', 'IMO', 'FYI', 'LOL', 'TLDR', 'DONT', 'MAG', 'RG',
  'NOT', 'IF', 'THE', 'TO', 'DO', 'NEW', 'DAY', 'YOU', 'HAVE', 'VERY', 'ONLY', 'MUST', 'STAY',
  'SUPER', 'TRADE', 'STUDY', 'REAL', 'RUN', 'AND', 'FOR', 'ARE', 'BUT', 'ALL', 'ANY', 'CAN',
  'OUT', 'ONE', 'TWO', 'OK', 'NO', 'YES', 'IT', 'IS', 'IN', 'ON', 'AT', 'OF', 'OR', 'SO', 'AS',
  'BY', 'UP', 'GO', 'MY', 'WE', 'HE', 'AM', 'AN', 'II', 'III',
]);

/** A capitals token: optional `$`, 1-5 letters, not inside a longer word. */
const TOKEN = /(?<![A-Za-z0-9$])(\$?)([A-Z]{1,5})(?![A-Za-z0-9])/g;

/** "BE" as break-even: after a preposition or "stop", and not in a list. */
const BREAK_EVEN_BEFORE = /(?:\b(?:at|to|near|below|above|under|around|is|stop|stops|for)\s+)$/i;

let lexiconCache = null;

/**
 * The ticker lexicon (the SEC list plus the project's seed).
 *
 * @returns {Set<string>}
 */
function loadLexicon() {
  if (lexiconCache) return lexiconCache;
  const out = new Set();
  const text = fs.readFileSync(LEXICON_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const cell = line.split(',')[0].trim().toUpperCase();
    if (!cell || cell.startsWith('#') || cell === 'TICKER') continue;
    out.add(cell);
  }
  lexiconCache = out;
  return out;
}

/**
 * Find the tickers of a message, in order of first appearance.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Set<string>} [options.known]  the tickers a bare token may be
 * @param {boolean} [options.slot]  the text is a slot only a ticker can fill
 *   (a portfolio line), so a token needs no lexicon to vouch for it
 * @returns {{index: number, ticker: string, dollar: boolean}[]}
 */
function findTickers(text, options = {}) {
  const known = options.known || loadLexicon();
  const out = [];
  const seen = new Set();
  const source = String(text || '');
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(source)) !== null) {
    const dollar = match[1] === '$';
    const ticker = match[2];
    if (seen.has(ticker)) continue;
    if (!dollar) {
      if (JARGON.has(ticker)) continue;
      // A single capital is a word ("I", "A") far more often than X or U.
      if (ticker.length === 1 && !options.slot) continue;
      if (!options.slot && !known.has(ticker)) continue;
      if (ticker === 'BE' && BREAK_EVEN_BEFORE.test(source.slice(0, match.index))) continue;
    }
    seen.add(ticker);
    out.push({ dollar, index: match.index, ticker });
  }
  return out;
}

/**
 * The capitals tokens a bare match REJECTED because nothing vouched for them.
 * The survey of these is how the known set is grown from evidence.
 *
 * @param {string} text
 * @param {Set<string>} known
 * @returns {string[]}
 */
function findUnknownCapitals(text, known) {
  const out = [];
  const source = String(text || '');
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(source)) !== null) {
    const ticker = match[2];
    if (match[1] === '$' || ticker.length < 2) continue;
    if (JARGON.has(ticker) || known.has(ticker)) continue;
    out.push(ticker);
  }
  return out;
}

module.exports = { JARGON, findTickers, findUnknownCapitals, loadLexicon };
