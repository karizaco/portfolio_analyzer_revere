'use strict';

/**
 * Which tokens of a plechac message are HOLDINGS.
 *
 * WHY THIS IS NOT THE SHARED FINDER
 *
 * `src/discord/symbols.js` finds tickers in an ENGLISH channel, and its
 * rules are right for English. Two of them are wrong for Czech, and both
 * were measured on this corpus:
 *
 * 1. A CAPITAL LETTER IS THE HEAD OF A CZECH WORD. "Nákup", "Přidávám",
 *    "Líbí", "Zavřel", "V risky portfoliu" all start with a capital, so a
 *    capitals scan finds N, P, L, Z and V where there is no ticker. The
 *    boundary here is UNICODE-AWARE: a capitals token must not be followed
 *    by a letter in any script, so "Cítím" does not yield a C.
 * 2. THE CZECH CONJUNCTION "A" IS A CAPITAL LETTER. "A ještě AMZN" is "and
 *    also AMZN", and A is a real ticker (Agilent). So a single letter is
 *    only ever a holding when it is on this source's measured list.
 *
 * THE THREE KINDS OF SUBJECT
 *
 *   name       a company he names ("Samsung", "Intelu", "Constelation")
 *   symbol     a capitals token that is NOT the symbol Yahoo wants
 *               (BRK -> BRK-B, RR -> RR.L, RHM.XETRA -> RHM.DE)
 *   commodity  a commodity he names ("zlato", "pšenice") and the ETF it is
 *               scored with
 *
 * A name and a symbol are both what HE said, and they are kept apart from
 * the market's spelling, which is the third thing.
 *
 * THE JARGON LIST IS SHARED, AND THE SOURCE'S OWN
 *
 * The shared jargon list ("TP", "SMA", "ATH", "USD", "ETF", "AI") is the
 * vocabulary of a trading channel and it is the same in every language.
 * Measured on this corpus: the eight extra actions the other channels
 * produced were mostly `TP`, `SMA`, `RRR`, `VS`, `PC`, `UK`, `NA` and
 * `EU` -- and the first two are on the shared list already.
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadLexicon, JARGON } = require('../symbols');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const NAMES_PATH = path.join(ROOT, 'config', 'ticker_names_plechac.csv');

/**
 * A capitals token, with a UNICODE-AWARE right boundary.
 *
 * The right boundary is what stops "Cítím" yielding a C and "Nákup"
 * yielding an N: the next character is a letter, in any script.
 *
 * THE TOKEN MAY CARRY THE VENDOR'S EXCHANGE SUFFIX, and that is a fix
 * that came out of a measurement. The broker writes "IGLN.UK" and
 * "NGAS.UK", and a token that stopped at the dot read only the TAIL --
 * so "IGLN.UK" was published as the holding "UK" (which Yahoo resolves
 * to Ucommune International), and "NGAS.UK" as "UK" too.
 */
const TOKEN = /(?<![A-Za-z0-9$])(\$?)([A-Z]{1,5}(?:[.\-][A-Z]{1,5})?)(?![L\p{N}])/gu;

/**
 * Single letters that ARE holdings in this corpus.
 *
 * Measured: "S" is SentinelOne (he writes it as "S - Sentinel One" and
 * as "Kousek LEU a S") and "B" is Barrick Mining ("trochu B - barrick
 * mining"). Every other single capital in the corpus is the head of a
 * Czech word or of an English abbreviation.
 */
const SINGLE_LETTER_HOLDINGS = new Set(['S', 'B']);

/**
 * Capitals tokens that are NEVER holdings here.
 *
 * Measured, one by one, in the message each came from:
 *
 *   AI      "AI boom", "AI agenti" -- the theme, not C3.ai
 *   ATH     "10 % od ATH" -- all-time high
 *   DCA     "Taky beru DCA na GRAB" -- dollar-cost averaging
 *   MSCI    "IQQW - MSCI world" -- the index, named
 *   IBKR    "Na IBRK jsem zavřel akcie PBR, CSCO" -- the BROKER
 *   IBRK    his spelling of the same broker
 *   METU    ambiguous: he writes META for Meta Platforms ten times, and
 *           METU is a real leveraged ETF. Left out rather than guessed.
 *   RISKY   "v RISKY portfoliu" -- the book, not a holding
 *   SAAS    Czech "software as a service"
 *   ALO     "statistiky na ALO koukám" -- Alocano, the broker
 *   XTB     "u XTB převážně Cisco" -- the broker
 *   SP      "Nasdaq (SP až později)" -- the S&P, as an index
 *   NL      "ASML na .NL" -- the Dutch exchange suffix
 *   LS      "pst před veřejností na LS" -- not a holding
 *   REIT    "jinak na REIT je ještě podle mě stejně brzo" -- a sector
 *   WTI     "nevypadá na ropě WTI" -- the oil benchmark, named
 *   VS      "VS na extrému" -- "velcí spekulanti", the COT large-specator
 *           position. Thirty mentions in the commodities channel, and not
 *           one of them a holding.
 *   RRR     "dobrý RRR 1:1" -- the risk-reward ratio
 *   SMC     "v rámci SMC vlákna" -- Smart Money Concepts
 *   HODL    "nástup do HODL pozic" -- the holding slang
 *   BE      "jsme na BE" -- break-even, the same reading the shared
 *           parser gives it
 *   PC      "kdybych byl u PC" -- a broker, named
 */
const NOT_HOLDINGS = new Set([
  'AI', 'ATH', 'DCA', 'ETF', 'MSCI', 'IBKR', 'IBRK', 'METU', 'RISKY', 'SAAS',
  'ALO', 'XTB', 'SP', 'NL', 'LS', 'REIT', 'WTI', 'VS', 'RRR', 'SMC', 'HODL',
  'BE', 'PC',
]);

/** A Czech trailing vowel, for the case ending on a written name. */
const CZECH_VOWEL = /[aeiouáéíóúůěý]$/u;

let tableCache = null;

/**
 * Split a CSV line that may contain quoted fields.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

/**
 * The name forms a table entry answers to.
 *
 * A written name carries a Czech case ending ("Intelu", "Grabu"), so the
 * entry answers to the form itself and to that form without its trailing
 * vowel. The second form only ever matches when it is IN the table, so the
 * lookup cannot invent a name.
 *
 * @param {string} spoken
 * @returns {string[]}
 */
function nameForms(spoken) {
  const forms = [spoken];
  const without = spoken.replace(CZECH_VOWEL, '');
  if (without && without !== spoken) forms.push(without);
  return forms;
}

/**
 * The source's own confirmed names, symbols and commodities.
 *
 * @returns {{names: Map<string, string>, symbols: Map<string, string>,
 *   commodities: Set<string>, namePatterns: {pattern: RegExp, ticker: string,
 *   kind: string}[]}}
 */
function loadPlechacTable() {
  if (tableCache) return tableCache;
  const names = new Map();
  const symbols = new Map();
  const commodities = new Set();
  const namePatterns = [];
  const text = fs.readFileSync(NAMES_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cells = splitCsvLine(line);
    if (cells.length < 3) continue;
    const spoken = cells[0].trim();
    const ticker = cells[1].trim().toUpperCase();
    const kind = cells[2].trim().toLowerCase();
    if (!spoken || !ticker) continue;
    if (kind === 'symbol') {
      symbols.set(spoken.toUpperCase(), ticker);
      continue;
    }
    if (kind === 'commodity') {
      commodities.add(spoken.toLowerCase());
    }
    names.set(spoken.toLowerCase(), ticker);
    for (const form of nameForms(spoken.toLowerCase())) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      namePatterns.push({
        pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'),
        ticker,
        kind: kind === 'commodity' ? 'commodity' : 'name',
      });
    }
  }
  tableCache = { names, symbols, commodities, namePatterns };
  return tableCache;
}

/**
 * Find the holdings a text names.
 *
 * @param {string} text  the text to read
 * @param {object} [options]
 * @param {Set<string>} [options.known]  the tickers a bare token may be
 * @param {string} [options.wholeLine]  the line the text was cut from. A
 *   single letter is only a holding when the WHOLE line confirms it, which
 *   is how "S - Sentinel One" is read: the dash cuts the subject off, and
 *   the name behind the dash is what says what S is.
 * @returns {{ticker: string, index: number, length: number, kind: string}[]}
 *   in order of first appearance
 */
function findHoldings(text, options = {}) {
  const known = options.known || loadLexicon();
  const table = loadPlechacTable();
  const source = String(text || '');
  const whole = options.wholeLine === undefined ? source : String(options.wholeLine);
  const out = [];
  const seen = new Set();

  const add = (ticker, index, length, kind) => {
    if (!ticker || seen.has(ticker)) return;
    seen.add(ticker);
    out.push({ ticker, index, length, kind });
  };

  // 1. The names he writes. These come first: a name is his own claim
  //    about what a holding is, and it is the only evidence for a name
  //    that is not a US listing at all.
  //
  //    A name that is a SINGLE LETTER confirms that letter for the whole
  //    line, even when the dash put it behind the subject:
  //    "Moje první pozice v S - Sentinel One" -- the subject is "S", and
  //    the name behind the dash is what says what S is.
  const confirmedLetters = new Set();
  for (const entry of table.namePatterns) {
    const match = entry.pattern.exec(source);
    if (match) add(entry.ticker, match.index, match[0].length, entry.kind);
    if (entry.ticker.length !== 1) continue;
    if (entry.pattern.test(whole)) confirmedLetters.add(entry.ticker);
  }

  // 2. The capitals tokens.
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(source)) !== null) {
    const dollar = match[1] === '$';
    const token = match[2];
    if (NOT_HOLDINGS.has(token) || JARGON.has(token)) continue;
    if (table.symbols.has(token)) {
      add(table.symbols.get(token), match.index, match[0].length, 'symbol');
      continue;
    }
    if (!dollar) {
      if (token.length === 1) {
        // A single letter is a holding only on the measured list, only
        // when the line confirms it, and only when it does not open a
        // Czech phrase ("A ještě AMZN").
        if (!SINGLE_LETTER_HOLDINGS.has(token)) continue;
        if (!confirmedLetters.has(token)) continue;
        const after = source.slice(match.index + token.length).trimStart();
        if (/^\p{L}/u.test(after)) continue;
      }
      if (!known.has(token)) continue;
    }
    add(token, match.index, match[0].length, 'symbol');
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * The tokens a text holds that no table resolved.
 *
 * This is how the source's own tables grow: a capitals token that is not
 * in the shared lexicon and not in the source's table is reported, and a
 * reader can go and look at the message it came from.
 *
 * @param {string} text
 * @param {Set<string>} known
 * @returns {string[]}
 */
function findUnknownCapitals(text, known) {
  const table = loadPlechacTable();
  const out = [];
  const source = String(text || '');
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(source)) !== null) {
    const token = match[2];
    if (match[1] === '$' || token.length < 2) continue;
    if (NOT_HOLDINGS.has(token) || JARGON.has(token)) continue;
    if (table.symbols.has(token) || known.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * The market's ticker for the broker's own spelling.
 *
 * The broker writes the exchange it trades on -- "RHM XETRA",
 * "IDUS.LSE" -- and Yahoo writes its own name for the same exchange
 * ("RHM.DE", "IDUS.L"). One instrument is one holding, and the record
 * has to say so once.
 *
 * The broker writes the exchange with a SPACE where the table writes it
 * with a dot, so both spellings are tried.
 *
 * @param {string} brokerTicker
 * @returns {string}
 */
function marketTickerOf(brokerTicker) {
  const table = loadPlechacTable();
  const key = String(brokerTicker || '').toUpperCase().trim();
  if (table.symbols.has(key)) return table.symbols.get(key);
  const dotted = key.replace(/\s+/g, '.');
  if (table.symbols.has(dotted)) return table.symbols.get(dotted);
  return key;
}

module.exports = {
  NOT_HOLDINGS,
  SINGLE_LETTER_HOLDINGS,
  findHoldings,
  findUnknownCapitals,
  loadPlechacTable,
  marketTickerOf,
};
