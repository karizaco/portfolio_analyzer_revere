'use strict';

// The symbols that are NOT holdings, for the Benzinga corpus.
//
// WHY THIS FILE EXISTS
//
// The shared extractor accepts any symbol the lexicon knows, except the
// ones a source's own stoplist names. T3Live has such a list (src/t3live/
// englishNames.js): "AI" is the theme and not C3.ai, "ATR" is the
// indicator and not AptarGroup, "MA" is the moving average and not
// Mastercard.
//
// Benzinga's hosts say the indicators even more often, and the pilot
// published two of them as holdings:
//
//   DMA  "DMA. Held it on a bounce and is running."        (a 20/50-day
//        moving average, read as a ticker)
//   ES   "ES. And when I returned to my room, the stock price
//        had dropped by 100 points."                       (the E-mini S&P
//        future -- an INDEX, not a holding)
//
// A wrong holding in a portfolio report is worse than a missing one, so
// both are stopped here.
//
// THE INDICATORS
//
// Measured over the pilot corpus (2026-11-12), the acronyms a trading
// show says out loud: the moving averages, the momentum oscillators, the
// volatility indices, the macro prints and the corporate-finance terms.
//
// THE FUTURES
//
// An index future is a MARKET position, not a holding. It is stopped
// here and carried in the market readings instead, where it is scored
// against the ETF it tracks.

/** The indicator and acronym tokens that are not tickers. */
const BENZINGA_INDICATOR_STOPLIST = new Set([
  // Moving averages and trend studies
  'DMA', 'SMA', 'EMA', 'WMA', 'VWAP', 'MA', 'HMA', 'DEMA', 'TEMA',
  // Momentum and oscillators
  'RSI', 'MACD', 'ADX', 'ATR', 'CCI', 'ROC', 'MFI', 'WILLR', 'STOCH', 'OBV', 'PPO', 'TRIX',
  // Volatility
  'VIX', 'VVIX', 'SKEW', 'IV', 'IVR', 'PCR', 'HIST', 'HV',
  // Volume and flow
  'OI', 'VOL', 'VOLUME', 'AUM', 'TVL', 'MFLOW', 'CVD',
  // Corporate finance and macro
  'EPS', 'GAAP', 'PEG', 'NAV', 'ROE', 'ROIC', 'ROI', 'TTM', 'YTD', 'YOY', 'QOQ', 'MOOM',
  'FOMC', 'CPI', 'PPI', 'PCE', 'GDP', 'NFP', 'GDP', 'PMI', 'ISM', 'PPI', 'FED', 'UST',
  'ATL', 'ATH', 'PT', 'EPS', 'EBITDA', 'FCF', 'DIV', 'YIELD', 'CPR', 'PCR',
  // Chart shapes and jargon
  'HOD', 'LOD', 'PREMARKET', 'AH', 'MOMENTUM', 'GAP', 'GUAP', 'TRAP',
  // Exchange and venue tokens
  'NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'IEX', 'OPRA', 'CBOE', 'CME', 'COMEX', 'NYMEX',
  // Geography and misc
  'AI', 'UK', 'EU', 'USA', 'US', 'DC', 'SF', 'TV', 'PC', 'AM', 'PM', 'CTO', 'COO', 'IRS', 'CIA',
  'API', 'AR', 'HQ', 'FA', 'LIVE', 'NOW', 'TODAY', 'IPO', 'SEC', 'FDA', 'DOJ', 'IRS',
  'TBD', 'NA', 'AKA', 'ETA', 'TBA',
]);

/**
 * The PEOPLE the hosts address, and the FRAGMENTS of longer words.
 *
 * THE PEOPLE. Benzinga's show brings its analysts on by name, and the
 * names arrive as INITIALS -- and the symbol path publishes on capitals
 * alone, so every two-letter ticker in the lexicon is a candidate for
 * them:
 *
 *   AB  "bring AB in here", "AB you're looking sharp"        (64 signals)
 *   CC  "we've had CC legator on this show a lot of times"   (16)
 *   SE  "sure we're gonna I fine SE on here later too"        (7)
 *   BL  "of my bearish BL process for the market as a whole"  (4)
 *   AG  "resistance right now for our AG"                     (3)
 *   BR  "we're gonna BR Kenny on here too" -- which is "BRING
 *        Kenny"; and "in the BR scheme of things"              (3)
 *   RC  "RC the AL Royal Caribbean" -- the ticker is RCL       (2)
 *   TP  "TP and I sat down sometime in 2003 and decided that
 *        we would write a book"                                (1)
 *
 * Measured over the 725-transcript corpus: **100 published holdings
 * that are people.** "CC" and "AG" are also real tickers, which is
 * exactly why the list is here and not in the lexicon.
 *
 * THE FRAGMENTS. Auto-captions cut a word, and the cut lands on a
 * ticker:
 *
 *   PS  "the S PS in to the upside", "the S PS but gotta hold 85"
 *       -- that is "the S&P", and 38 signals were published on it
 *   GD  "if GD real simple, if GDP growth is 3%"               (1)
 *   ET  "good liquid ET uh uh ETF for AI" -- "ETF", split      (1)
 *   SM  "it SM it for you, it Smooths it for you too"         (2)
 *   MF  "morphic ticker MF which is skyrocketing" -- "Morphic" (2)
 *   OR  "you go into the iwm OR into value stocks" -- "or"    (1)
 *   VC  "sometimes they were the VC money" -- "venture capital" (1)
 *
 * "DT", "GL" and "CV" were left alone: one signal each, and their
 * evidence is too thin to call -- "GL" reads as a real ticker the host
 * bought, and "DT" may be Dynatrace.
 */
const BENZINGA_PEOPLE_AND_FRAGMENTS = new Set([
  // The people the hosts address by their initials.
  'AB', 'AG', 'BL', 'BR', 'CC', 'RC', 'SE', 'TP',
  // Fragments of longer words.
  'PS', 'GD', 'ET', 'SM', 'MF', 'OR', 'VC',
]);

/**
 * The futures and index symbols.
 *
 * They are market positions. Carried as readings, not holdings.
 */
const BENZINGA_FUTURES_SYMBOLS = new Set([
  'ES', 'MES', 'NQ', 'MNQ', 'YM', 'MYM', 'RTY', 'M2K', 'CL', 'MCL', 'NG', 'HO', 'RB',
  'GC', 'MGC', 'SI', 'SIL', 'HG', 'PL', 'PA', 'ZS', 'ZL', 'ZM', 'ZO', 'ZT', 'ZF', 'ZN', 'ZB',
  'VX', 'BTC', 'ETH', 'MBT', 'VXE', 'VXEW',
]);

/**
 * The stoplist the extractor is given.
 *
 * @param {Set<string>} [base] - the source's own stoplist, if it has one
 * @returns {Set<string>}
 */
function benzingaSymbolStoplist(base) {
  const merged = new Set(base || []);
  for (const token of BENZINGA_INDICATOR_STOPLIST) merged.add(token);
  for (const token of BENZINGA_FUTURES_SYMBOLS) merged.add(token);
  for (const token of BENZINGA_PEOPLE_AND_FRAGMENTS) merged.add(token);
  return merged;
}

/**
 * Is this symbol an index future rather than a holding?
 *
 * @param {string} ticker
 * @returns {boolean}
 */
function isFuturesSymbol(ticker) {
  return BENZINGA_FUTURES_SYMBOLS.has(String(ticker || '').toUpperCase());
}

module.exports = {
  BENZINGA_FUTURES_SYMBOLS,
  BENZINGA_INDICATOR_STOPLIST,
  BENZINGA_PEOPLE_AND_FRAGMENTS,
  benzingaSymbolStoplist,
  isFuturesSymbol,
};
