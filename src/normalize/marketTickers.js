'use strict';

/**
 * The MARKET's ticker list: every symbol on every US exchange, as the
 * SEC's own registrant file has it.
 *
 * WHY THIS IS SHARED
 *
 * `config/ticker_company_names.csv` is the SEC's `company_tickers.json`
 * in CSV form -- 10,411 tickers, with the registrant name and a
 * normalised form. The file is already in the repository and is
 * already read by `src/sevcik/companyNames.js`, which needs the
 * NAMES.
 *
 * This module is for the readers that need the TICKERS alone, as a
 * vocabulary to ARBITRATE an OCR reading against: "the engine read
 * FCE, and exactly one listed ticker is one edit away" is a question
 * about the market, not about one source's portfolio.
 *
 * **IT IS NOT AN ALLOW-LIST.** The seed lexicon
 * (`config/ticker_lexicon_seed.csv`) is the project's allow-list: what
 * a source's own holdings may be. This list is the whole market: a
 * ticker that is here and not in the seed is a real ticker that
 * another source has not vouched for, and dropping it would lose a
 * holding. So it is used to choose between readings, never to refuse
 * one.
 *
 * **A TICKER THIS LIST DOES NOT KNOW IS STILL A TICKER.** The SEC's
 * file is a snapshot: a company that listed after it was generated is
 * not in it. `XNDD` -- one of the Komar watchlist's own names -- is
 * not. A reader must therefore treat a lexicon miss as "no
 * preference", not as "wrong".
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKET_TABLE_PATH = path.join(ROOT, 'config', 'ticker_company_names.csv');

let cachedTable = null;
let cachedPath = null;

/**
 * The tickers the SEC's registrant file lists.
 *
 * @param {object} [options]
 * @param {string} [options.path] - another table, for a test
 * @returns {Set<string>}
 */
function loadMarketTickers(options = {}) {
  const tablePath = options.path || MARKET_TABLE_PATH;
  if (cachedTable && cachedPath === tablePath) return cachedTable;

  const tickers = new Set();
  if (fs.existsSync(tablePath)) {
    const content = fs.readFileSync(tablePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const comma = line.indexOf(',');
      if (comma <= 0) continue;
      const ticker = line.slice(0, comma).trim().toUpperCase();
      if (ticker) tickers.add(ticker);
    }
  }
  cachedTable = tickers;
  cachedPath = tablePath;
  return tickers;
}

module.exports = { MARKET_TABLE_PATH, loadMarketTickers };
