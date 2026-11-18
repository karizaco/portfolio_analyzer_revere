'use strict';

/**
 * The Komar lexicon: which tickers the corpus names, and which
 * capitalised tokens are NOT tickers.
 *
 * WHY THE SEED LEXICON IS NOT ENOUGH
 *
 * The seed lexicon is the project's allow-list, and it was grown from
 * the QMG and Revere position lists. Measured on the Komar corpus
 * (2026-11-17): the corpus names **105** tickers -- the trade log's 26,
 * the market cards' 55 theme leaders and the Summary's 30 holdings --
 * and only **32 of the 105** are in the seed lexicon. So 73 of the
 * corpus's own names would not be recognised at all.
 *
 * Those 73 live in `config/ticker_lexicon_komar.csv`, one row per
 * ticker, with the note saying WHICH of the corpus's artifacts names
 * it. The file is a separate one on purpose: the seed lexicon is the
 * shared allow-list, and the corpus's own names are this source's
 * business.
 *
 * THE WORDS THAT ARE NOT TICKERS
 *
 * The transcripts are a chart lesson as much as a trading call, and the
 * capitalised tokens are mostly the lesson. Measured over the corpus's
 * transcripts: 786 distinct ticker-shaped tokens, of which the
 * frequent ones are a mix of holdings and words:
 *
 *     EMA:797  US:255  EPS:232  IPO:97  ARC:71  ETF:65  ADR:46  VCP:30
 *     OTC:25  NASDAQ:18  FOMO:15  IBD:21  MMTS:19  COVID:12  EMI:11
 *
 * Every one of those was checked against the SEC's own registrant list
 * before being stopped: a token that IS a listed registrant might be a
 * holding, and a token that is NOT one is the word.
 *
 * **"EMI" is the EMA INDICATOR.** The corpus says "the EMI 21" and "the
 * EMI 65" (the moving average), and EMI is a listed registrant (a
 * music company), so it has to be stopped or every chart reference
 * becomes a holding.
 *
 * **"MMTS" is THE AUTHOR'S OWN SCORE**, not a ticker -- he says "from
 * looking at the MMTS" nineteen times.
 *
 * **"ARC" is "ARK Innovation Fund"** (Cathie Wood's ARKK), so it is an
 * ALIAS and not a stop: see `findKomarCompanyNames`.
 *
 * The tokens that LOOKED like words but are the corpus's own holdings
 * are left alone: CCG, ALAP, NB, KC and CRISPR are all real names he
 * holds or discusses, and the measured contexts say so ("CCG is another
 * sister stock", "I'm thinking about ALAP, CRDO", "NB Bancorp", "the
 * same is true for KC, VNET").
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadSeedLexiconSync } = require('../normalize/tickerScan');
const {
  ENGLISH_SYMBOL_STOPLIST,
  findEnglishCompanyNames,
} = require('../t3live/englishNames');

const ROOT = path.resolve(__dirname, '..', '..');
const KOMAR_LEXICON_PATH = path.join(ROOT, 'config', 'ticker_lexicon_komar.csv');

/**
 * The capitalised tokens the Komar corpus uses for something OTHER
 * than a ticker.
 *
 * Every one of these was checked against the SEC's registrant list
 * (measured 2026-11-17): a token that IS a listed registrant might be
 * a holding, so it is not stopped. The shared English stoplist covers
 * the chart and market words the other English sources use (AI, IT,
 * EMA, ATR, RSI, SMA, MA, ...).
 */
const KOMAR_SYMBOL_STOPLIST = new Set([
  ...ENGLISH_SYMBOL_STOPLIST,
  // The market and the lesson, not a holding.
  'ADR', 'ARK', 'CRISPR', 'COVID', 'EPS', 'ETF', 'FOMO', 'IBD', 'IPO',
  'NASDAQ', 'OTC', 'US', 'VCP',
  // The author's own score ("from looking at the MMTS").
  'MMTS',
  // The moving average, misheard as EMI (the music company).
  'EMI',
]);

/**
 * The tickers the Komar corpus names.
 *
 * The seed lexicon plus the corpus's own 73. The result is a Set.
 *
 * @returns {Set<string>}
 */
function loadKomarLexicon() {
  const tickers = new Set(loadSeedLexiconSync().tickerSet);
  if (fs.existsSync(KOMAR_LEXICON_PATH)) {
    const lines = fs.readFileSync(KOMAR_LEXICON_PATH, 'utf8').split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const ticker = line.split(',')[0].trim().toUpperCase();
      if (ticker) tickers.add(ticker);
    }
  }
  return tickers;
}

/**
 * The TERMS the transcription request should favour.
 *
 * This is the corpus's OWN vocabulary, and it is the corpus's own
 * decision: the seed lexicon belongs to the other sources and the
 * Komar corpus does not trade half of it. The list is the corpus's 73
 * tickers -- the names it actually says out loud.
 *
 * WHY IT EXISTS. A ticker is the hardest thing in the corpus for a
 * speech model: "DFDV" is four letters that sound like a word. The
 * provider's own tokenisation split a holding across a boundary --
 * "I bought into DF," | "DV. I see a lot of positive momentum" -- and
 * the holding was then invisible to the extractor. Measured on the
 * 116-transcript corpus, with the lexicon as the judge, ONE real
 * holding was broken this way in 50,884 segment boundaries (the other
 * two candidates were the phrase "go go" and a clean sentence
 * boundary), and the provider's own word list shows the boundary
 * falling BETWEEN two provider tokens -- so the split is the
 * provider's tokenisation, not its endpointing.
 *
 * @returns {string[]}
 */
function loadKomarKeyterms() {
  if (!fs.existsSync(KOMAR_LEXICON_PATH)) return [];
  const lines = fs.readFileSync(KOMAR_LEXICON_PATH, 'utf8').split(/\r?\n/);
  const terms = [];
  for (const line of lines.slice(1)) {
    const ticker = line.split(',')[0].trim().toUpperCase();
    if (ticker) terms.push(ticker);
  }
  return terms;
}

/**
 * The English name finder, with the corpus's own index alias.
 *
 * The shared finder already maps "the Nasdaq" to QQQ and "the S&P" to
 * SPY. This corpus adds one: **"the ARK Innovation Fund"** -- what the
 * ASR writes for ARKK, the fund Cathie Wood runs.
 *
 * The alias needs the WHOLE NAME. A looser one ("the ARC") fired on
 * sentences that are about Cathie Wood rather than about a trade --
 * "Kathy Woods from the ARC, you know, she would do 1,000,000 times
 * better if she would look at charts" -- and turned a remark about a
 * fund manager into 57 setups on ARKK (measured 2026-11-17). A missing
 * setup is better than a false one.
 *
 * @param {string} text
 * @param {object} options
 * @returns {Array<{ticker: string, index: number}>}
 */
function findKomarCompanyNames(text, options = {}) {
  const found = findEnglishCompanyNames(text, options);
  const source = String(text || '');
  const ark = /\b(?:the\s+)?(?:ARK|ARC)\s+Innovation\s+Fund\b/i.exec(source);
  if (ark && !found.some((name) => name.ticker === 'ARKK')) {
    found.push({ ticker: 'ARKK', index: ark.index });
  }
  return found;
}

module.exports = {
  KOMAR_LEXICON_PATH,
  KOMAR_SYMBOL_STOPLIST,
  findKomarCompanyNames,
  loadKomarKeyterms,
  loadKomarLexicon,
};
