'use strict';

/**
 * What kind of picture is it, from its OCR words? (classifier v1)
 *
 * A HEURISTIC, and labelled as one: it decides which images are worth a
 * paid vision reading and gives a free first answer for the rest. Its
 * precision is measured on a hand-labelled sample per account (plan,
 * Phase 5) before anything relies on it.
 *
 *   portfolio   rows of tickers next to %/$ numbers, with portfolio words
 *   fill        an order confirmation ("Filled", "Avg price")
 *   watchlist   rows of tickers with % changes, no portfolio words
 *   chart       a timeframe legend and a column of prices at the right edge
 *   text_screenshot  lots of words, few numbers
 *   other       anything else
 *
 * The ticker vocabulary is the SEC list (src/normalize/marketTickers.js),
 * used as an ARBITER: it decides what looks like a ticker here, and a symbol
 * it does not know is not "wrong" -- the list is a snapshot.
 */

const { loadMarketTickers } = require('../../normalize/marketTickers');

const CLASSIFIER_VERSION = 'x-classify-1';

const PORTFOLIO_WORDS = /\b(?:portfolio|positions?|holdings?|allocation|market\s+value|total\s+(?:value|return|gain)|equity|avg\.?\s+cost|average\s+cost|cost\s+basis|shares|qty|quantity|unrealized|day'?s?\s+gain|p\s*&\s*l|weight)\b/i;
const FILL_WORDS = /\b(?:filled|order\s+(?:filled|executed|confirmed)|avg\.?\s+(?:fill\s+)?price|limit\s+(?:buy|sell)|market\s+(?:buy|sell)|bought\s+\d|sold\s+\d)\b/i;
const TIMEFRAME = /^(?:1D|D|1W|W|1M|M|1h|2h|4h|1H|4H|5m|15m|30m|65m|5|15|30|65|Daily|Weekly)$/;

/** The vocabulary, minus the words every chart and screen prints. */
const NOT_A_TICKER = new Set([
  'A', 'I', 'O', 'H', 'L', 'C', 'D', 'W', 'M', 'USD', 'ALL', 'ON', 'IT', 'AT', 'TO', 'BE', 'OR', 'SO', 'GO', 'BY', 'UP',
  'NOW', 'VOL', 'ATR', 'RSI', 'EMA', 'SMA', 'MA', 'MACD', 'AVG', 'TOTAL', 'DAY', 'QTY', 'COST', 'BUY', 'SELL',
]);

function tokensOf(words) {
  return (words || []).map((word) => ({
    ...word,
    token: String(word.text || '').replace(/^[$(]+|[),.:;!?]+$/g, ''),
  }));
}

/**
 * Classify an image from its OCR words.
 *
 * @param {object} input
 * @param {Array<{text: string, left: number, top: number, width: number, height: number}>} input.words
 * @param {number} input.width
 * @param {number} input.height
 * @param {Set<string>} [input.market]
 * @returns {{image_class: string, confidence: number, tickers: string[], legend_ticker: string, legend_timeframe: string, features: object}}
 */
function classifyFromOcr(input) {
  const market = input.market || loadMarketTickers();
  const width = input.width || 1;
  const height = input.height || 1;
  const tokens = tokensOf(input.words);
  const text = tokens.map((t) => t.text).join(' ');

  const tickers = [];
  for (const t of tokens) {
    const raw = String(t.text || '');
    const symbol = t.token.toUpperCase();
    if (!/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(t.token)) continue;
    if (NOT_A_TICKER.has(symbol) && !raw.startsWith('$')) continue;
    if (raw.startsWith('$') || market.has(symbol)) tickers.push(symbol);
  }
  const uniqueTickers = [...new Set(tickers)];
  const percents = tokens.filter((t) => /^[+-]?\d{1,3}(?:[.,]\d{1,2})?%$/.test(String(t.text).replace(/[()]/g, ''))).length;
  const dollars = tokens.filter((t) => /^-?\$\d[\d,]*(?:\.\d{1,2})?$/.test(String(t.text))).length;
  const rightPrices = tokens.filter((t) => /^\d{1,5}\.\d{1,2}$/.test(t.token) && t.left > width * 0.85).length;
  const timeframe = tokens.find((t) => TIMEFRAME.test(t.token) && t.top < height * 0.15 && t.left < width * 0.5);
  const legendCandidates = tokens.filter((t) => t.top < height * 0.12 && t.left < width * 0.45
    && /^[A-Z]{1,5}$/.test(t.token) && (market.has(t.token) || String(t.text).startsWith('$')) && !NOT_A_TICKER.has(t.token));
  const words = tokens.filter((t) => /^[A-Za-z]{3,}$/.test(t.token)).length;

  const features = {
    tickers: uniqueTickers.length, percents, dollars, rightPrices, words,
    portfolioWords: PORTFOLIO_WORDS.test(text), fillWords: FILL_WORDS.test(text), timeframe: Boolean(timeframe),
  };
  let imageClass = 'other';
  let confidence = 0.3;
  if (features.fillWords && uniqueTickers.length >= 1) {
    imageClass = 'fill';
    confidence = 0.6;
  } else if (uniqueTickers.length >= 3 && percents + dollars >= 3 && features.portfolioWords) {
    imageClass = 'portfolio';
    confidence = 0.7;
  } else if (uniqueTickers.length >= 4 && percents >= 3) {
    imageClass = 'watchlist';
    confidence = 0.5;
  } else if (rightPrices >= 4 && (features.timeframe || legendCandidates.length)) {
    imageClass = 'chart';
    confidence = 0.6;
  } else if (words >= 40 && percents + dollars + rightPrices < 4) {
    imageClass = 'text_screenshot';
    confidence = 0.5;
  }
  return {
    image_class: imageClass,
    confidence,
    tickers: uniqueTickers,
    legend_ticker: imageClass === 'chart' && legendCandidates.length ? legendCandidates[0].token : '',
    legend_timeframe: imageClass === 'chart' && timeframe ? timeframe.token : '',
    features,
  };
}

module.exports = { CLASSIFIER_VERSION, classifyFromOcr };
