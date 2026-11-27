'use strict';

/**
 * The instruments Martin Klass talks about, in Czech.
 *
 * WHY A TABLE AND NOT A NAME MATCHER ALONE
 *
 * He writes the COMPANY NAME for a listed stock ("Ambarella", "Dell",
 * "CrowdStrike") and the CZECH WORD for a commodity ("zlato", "stříbro",
 * "ropa", "pšenice") and the INDEX NAME for the market ("S&P 500",
 * "NASDAQ"). The company names go through the SHARED matcher
 * (`src/sevcik/companyNames.js`), which is the market's own registrant
 * file, and only the commodities and the indices need a table of their
 * own.
 *
 * THE CZECH FORMS ARE WRITTEN OUT, because the case ending changes the
 * word: "zlato" is "zlatem" in the instrumental and "zlata" in the
 * genitive, and "ropa" is "ropy", "ropu" and "ropě".
 *
 * THE COMMODITIES ARE SCORED WITH THEIR ETFs, and that is a choice
 * with a consequence: GLD is not the gold price, it is the gold MINERS'
 * equity. A call on gold is a call on GLD here, and the report says so.
 */

/**
 * @typedef {object} Subject
 * @property {string[]} forms  the ways he writes it
 * @property {string} proxy    the tradeable instrument it is scored with
 * @property {string} scope    market | commodity | crypto | fx | stock
 * @property {string} note
 */

/** @type {Subject[]} */
const SUBJECTS = [
  {
    forms: ['zlato', 'zlatu', 'zlata', 'zlatem', 'zlato/zlato'],
    proxy: 'GLD',
    scope: 'commodity',
    note: 'gold, through the SPDR Gold Shares',
  },
  {
    forms: ['stříbro', 'stříbru', 'stříbra', 'stříbře'],
    proxy: 'SLV',
    scope: 'commodity',
    note: 'silver, through the iShares Silver Trust',
  },
  {
    forms: ['ropa', 'ropy', 'ropu', 'ropě', 'ropa WTI', 'WTI'],
    proxy: 'USO',
    scope: 'commodity',
    note: 'crude, through the United States Oil Fund',
  },
  {
    forms: ['pšenice', 'pšenici', 'pšenicí'],
    proxy: 'WEAT',
    scope: 'commodity',
    note: 'wheat, through the Teucrium Wheat Fund',
  },
  {
    forms: ['BTC', 'bitcoin', 'bitcoinu'],
    proxy: 'BTC-USD',
    scope: 'crypto',
    note: 'bitcoin',
  },
  {
    forms: ['SOL'],
    proxy: 'SOL-USD',
    scope: 'crypto',
    note: 'solana',
  },
  {
    forms: ['S&P 500', 'SPX', 'index S&P 500', 'akciový index S&P 500'],
    proxy: 'SPY',
    scope: 'market',
    note: 'the S&P 500, through the SPDR',
  },
  {
    forms: ['NASDAQ', 'Nasdaq', 'index NASDAQ', 'akciový index NASDAQ'],
    proxy: 'QQQ',
    scope: 'market',
    note: 'the Nasdaq, through the Invesco QQQ',
  },
  {
    forms: ['USDX', 'dolarový index', 'index dolaru'],
    proxy: 'DX-Y.NYB',
    scope: 'market',
    note: 'the dollar index',
  },
  {
    forms: ['EUR/USD', 'EURUSD'],
    proxy: 'EURUSD=X',
    scope: 'fx',
    note: 'the euro',
  },
  {
    forms: ['GBP/USD', 'GBPUSD'],
    proxy: 'GBPUSD=X',
    scope: 'fx',
    note: 'the pound',
  },
  {
    forms: ['USD/JPY', 'USDJPY'],
    proxy: 'USDJPY=X',
    scope: 'fx',
    note: 'the yen',
  },
  {
    forms: ['AUD/USD', 'AUDUSD'],
    proxy: 'AUDUSD=X',
    scope: 'fx',
    note: 'the aussie',
  },
  {
    forms: ['AUD/NZD', 'AUDNZD'],
    proxy: 'AUDNZD=X',
    scope: 'fx',
    note: 'the aussie against the kiwi',
  },
  {
    forms: ['AUD/CAD', 'AUDCAD'],
    proxy: 'AUDCAD=X',
    scope: 'fx',
    note: 'the aussie against the loonie',
  },
  {
    forms: ['USD/TRY', 'USDTRY'],
    proxy: 'USDTRY=X',
    scope: 'fx',
    note: 'the Turkish lira',
  },
];

/**
 * The subject patterns, longest first so "AUD/CAD" wins over "AUD".
 *
 * @type {{pattern: RegExp, subject: Subject}[]}
 */
const SUBJECT_PATTERNS = (() => {
  const out = [];
  for (const subject of SUBJECTS) {
    for (const form of subject.forms) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out.push({
        // The boundary is UNICODE-AWARE: Czech words carry diacritics and
        // an ASCII \b does not stop after "zlatem".
        pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'),
        subject,
      });
    }
  }
  out.sort((a, b) => b.subject.forms.length - a.subject.forms.length
    || b.pattern.source.length - a.pattern.source.length);
  return out;
})();

module.exports = {
  SUBJECTS,
  SUBJECT_PATTERNS,
};
