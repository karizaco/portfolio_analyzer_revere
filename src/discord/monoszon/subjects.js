'use strict';

/**
 * The instruments David Monoszon talks about, and what each is scored with.
 *
 * WHY A TABLE AND NOT A TICKER FINDER
 *
 * He does not name stocks. He names INDEX FUTURES and the ETFs around
 * them, and he names them in the tradeable spelling rather than the
 * index's: "NQ" is the Nasdaq 100 future and "SPX" is the S&P 500
 * future, and neither is a thing a price provider will price.
 *
 * So the table carries THREE things per row: what he SAID, what it IS
 * (the scope), and what it is SCORED WITH (the proxy). The proxy is the
 * tradeable instrument that stands for it -- QQQ for the Nasdaq 100,
 * SPY for the S&P 500, GLD for gold.
 *
 * THE COUNTS ARE MEASURED, NOT ASSUMED
 *
 * Over his 4,500 messages (2025-07 .. 2026-11) the instrument words are:
 *
 *   NQ 224, SPX 105, ES 85, BTC 57, QQQ 37, TLT 35, SPY 29, MSFT 24,
 *   NVDA 18, BTAL 16, NWOG 14, IWM 13, MSTR 13, PDBC 12, RTY 12,
 *   GC 11, NDOG 11, GLD 9, ZB 8
 *
 *   zlato 57, ropa 25 + ropy 13 + ropu 10 + ropě 6, indexy 60,
 *   futures 58, stříbro 4, bitcoin 1, plyn 1
 *
 * and the words that LOOK like instruments but are not:
 *
 *   ATH 93, FVG 66, AI 47, VIX 28, EMA 28, NY 25, SL 24, NFP 23,
 *   CPI 23, USD 21, TF 21, PPI 19, BE 15, ICT 14, DXY 12, CTA 9,
 *   USA 9, FED 8, FOMO 8, ZB 8, IPO 8
 *
 * The last group is JARGON and it is the source's own list: "ATH" is
 * the all-time high, "FVG" is the ICT fair-value gap, "SL" is the stop
 * loss, "ZB" is the bond future. A ticker finder that took them would
 * publish an "ATH holding" on 93 messages.
 *
 * THE CZECH FORMS ARE WRITTEN OUT
 *
 * A commodity is named in words and the case ending changes the STEM:
 * "zlato" (nominative) becomes "zlatu" (locative) and "zlata"
 * (genitive). A stem comparison would need a rule of its own, so the
 * forms are written out -- 60 rows in all, and every one of them is a
 * form that occurs in the corpus.
 */

/**
 * @typedef {object} Subject
 * @property {string} spoken   what he wrote
 * @property {string} proxy    the tradeable instrument it is scored with
 * @property {string} scope    market | sector | commodity | crypto | bond | stock
 * @property {string} kind     index | etf | future | commodity | crypto | stock
 * @property {string} note     why, and where it was seen
 */

/** @type {Subject[]} */
const SUBJECTS = [
  // --- the index futures, and the ETFs that stand for them ---------------
  { spoken: 'NQ', proxy: 'QQQ', scope: 'market', kind: 'index', note: 'Nasdaq 100 future, 224 mentions' },
  { spoken: 'NWOG', proxy: 'QQQ', scope: 'market', kind: 'index', note: 'the NQ weekly contract, 14 mentions' },
  { spoken: 'NDOG', proxy: 'QQQ', scope: 'market', kind: 'index', note: 'the NQ daily contract, 11 mentions' },
  { spoken: 'MNQ', proxy: 'QQQ', scope: 'market', kind: 'index', note: 'the Micro NQ' },
  { spoken: 'ES', proxy: 'SPY', scope: 'market', kind: 'index', note: 'S&P 500 future, 85 mentions' },
  { spoken: 'MES', proxy: 'SPY', scope: 'market', kind: 'index', note: 'the Micro ES' },
  { spoken: 'SPX', proxy: 'SPY', scope: 'market', kind: 'index', note: 'S&P 500 future, 105 mentions' },
  { spoken: 'RTY', proxy: 'IWM', scope: 'market', kind: 'index', note: 'Russell 2000 future, 12 mentions' },
  { spoken: 'YM', proxy: 'DIA', scope: 'market', kind: 'index', note: 'Dow future' },
  { spoken: 'DJI', proxy: 'DIA', scope: 'market', kind: 'index', note: 'Dow index' },
  { spoken: 'NDX', proxy: 'QQQ', scope: 'market', kind: 'index', note: 'Nasdaq 100 index' },

  // --- the ETFs he trades around them ------------------------------------
  { spoken: 'QQQ', proxy: 'QQQ', scope: 'market', kind: 'etf', note: '37 mentions' },
  { spoken: 'SPY', proxy: 'SPY', scope: 'market', kind: 'etf', note: '29 mentions' },
  { spoken: 'IWM', proxy: 'IWM', scope: 'market', kind: 'etf', note: '13 mentions' },
  { spoken: 'DIA', proxy: 'DIA', scope: 'market', kind: 'etf', note: '' },
  { spoken: 'SMH', proxy: 'SMH', scope: 'sector', kind: 'etf', note: 'semiconductors' },
  { spoken: 'SOXX', proxy: 'SMH', scope: 'sector', kind: 'etf', note: 'semiconductors' },
  { spoken: 'XLE', proxy: 'XLE', scope: 'sector', kind: 'etf', note: 'energy' },
  { spoken: 'XLF', proxy: 'XLF', scope: 'sector', kind: 'etf', note: 'financials' },
  { spoken: 'XLP', proxy: 'XLP', scope: 'sector', kind: 'etf', note: 'staples' },
  { spoken: 'XLU', proxy: 'XLU', scope: 'sector', kind: 'etf', note: 'utilities' },
  { spoken: 'XLV', proxy: 'XLV', scope: 'sector', kind: 'etf', note: 'healthcare' },

  // --- the bonds ----------------------------------------------------------
  { spoken: 'TLT', proxy: 'TLT', scope: 'market', kind: 'etf', note: 'the long bond, 35 mentions' },
  { spoken: 'ZB', proxy: 'TLT', scope: 'market', kind: 'future', note: 'the bond future, 8 mentions; TLT stands for it' },
  { spoken: 'BTAL', proxy: 'BTAL', scope: 'market', kind: 'etf', note: 'the bond ETF, 16 mentions' },

  // --- the commodities ----------------------------------------------------
  { spoken: 'zlato', proxy: 'GLD', scope: 'commodity', kind: 'commodity', note: 'gold, 57 mentions' },
  { spoken: 'zlatu', proxy: 'GLD', scope: 'commodity', kind: 'commodity', note: 'gold, locative' },
  { spoken: 'zlata', proxy: 'GLD', scope: 'commodity', kind: 'commodity', note: 'gold, genitive' },
  { spoken: 'zlatem', proxy: 'GLD', scope: 'commodity', kind: 'commodity', note: 'gold, instrumental' },
  { spoken: 'GC', proxy: 'GLD', scope: 'commodity', kind: 'future', note: 'the gold future, 11 mentions' },
  { spoken: 'GLD', proxy: 'GLD', scope: 'commodity', kind: 'etf', note: 'the gold ETF, 9 mentions' },
  { spoken: 'stříbro', proxy: 'SLV', scope: 'commodity', kind: 'commodity', note: 'silver, 4 mentions' },
  { spoken: 'stříbru', proxy: 'SLV', scope: 'commodity', kind: 'commodity', note: 'silver, locative' },
  { spoken: 'stříbra', proxy: 'SLV', scope: 'commodity', kind: 'commodity', note: 'silver, genitive' },
  { spoken: 'SI', proxy: 'SLV', caseSensitive: true, scope: 'commodity', kind: 'future', note: 'the silver future' },
  { spoken: 'SLV', proxy: 'SLV', scope: 'commodity', kind: 'etf', note: 'the silver ETF' },
  { spoken: 'ropa', proxy: 'USO', scope: 'commodity', kind: 'commodity', note: 'crude, 25 mentions' },
  { spoken: 'ropy', proxy: 'USO', scope: 'commodity', kind: 'commodity', note: 'crude, genitive' },
  { spoken: 'ropu', proxy: 'USO', scope: 'commodity', kind: 'commodity', note: 'crude, accusative' },
  { spoken: 'ropě', proxy: 'USO', scope: 'commodity', kind: 'commodity', note: 'crude, locative' },
  { spoken: 'ropy', proxy: 'USO', scope: 'commodity', kind: 'commodity', note: 'crude' },
  { spoken: 'CL', proxy: 'USO', scope: 'commodity', kind: 'future', note: 'the crude future' },
  { spoken: 'PDBC', proxy: 'PDBC', scope: 'commodity', kind: 'etf', note: 'the copper ETF, 12 mentions' },
  { spoken: 'GDX', proxy: 'GDX', scope: 'commodity', kind: 'etf', note: 'the gold miners ETF' },

  // --- the crypto ---------------------------------------------------------
  { spoken: 'BTC', proxy: 'BTC-USD', scope: 'crypto', kind: 'crypto', note: 'bitcoin, 57 mentions' },
  { spoken: 'bitcoin', proxy: 'BTC-USD', scope: 'crypto', kind: 'crypto', note: 'bitcoin' },

  // --- the few individual stocks ------------------------------------------
  { spoken: 'MSFT', proxy: 'MSFT', scope: 'stock', kind: 'stock', note: '24 mentions' },
  { spoken: 'NVDA', proxy: 'NVDA', scope: 'stock', kind: 'stock', note: '18 mentions' },
  { spoken: 'MSTR', proxy: 'MSTR', scope: 'stock', kind: 'stock', note: '13 mentions' },
];

/**
 * The words that look like instruments and are not.
 *
 * Measured over the corpus; each one is counted beside what it means.
 * The list is the source's own, because a ticker finder that took them
 * would publish an "ATH holding" on 93 messages and an "FVG holding" on
 * 66.
 */
const NOT_SUBJECTS = new Set([
  'ATH', 'FVG', 'AI', 'VIX', 'EMA', 'NY', 'SL', 'NFP', 'CPI', 'USD', 'TF',
  'PPI', 'BE', 'ICT', 'DXY', 'CTA', 'USA', 'FED', 'FOMO', 'IPO', 'GTO',
  'LOD', 'HOD', 'VWAP', 'EOD', 'RSI', 'ATR', 'SMA', 'WMA', 'DMA', 'RS',
  'FOMC', 'GDP', 'PCE', 'P&L', 'PNL', 'TP', 'YTD', 'EPS', 'IPO', 'ADR',
  'ETF', 'OPCE', 'OPCI',
]);

/**
 * The subject patterns, longest first so "NWOG" wins over "NQ" and
 * "zlata" over "zlato".
 *
 * "SI" IS MATCHED CASE-SENSITIVELY, and that is not a detail.
 *
 * In Czech "si" is the reflexive pronoun -- "něco si přej",
 * "přál bych si" -- and a case-INSENSITIVE "SI" matched it on
 * **421** messages and published the silver future as the subject of
 * sentences about nothing at all. He writes the silver future in
 * capitals (once in the corpus) and the pronoun in lower case (421
 * times), so the capitals are the rule.
 *
 * EVERY OTHER SUBJECT IS MATCHED IN BOTH CASES, because he writes them
 * in both cases and the lower-case form is the instrument and not a
 * word:
 *
 *   NQ  224 caps / 111 lower    SPX  105 / 173    QQQ  37 / 17
 *   SPY  29 / 24                BTC  57 / 21     MSFT 24 / 23
 *   NVDA 18 / 14                ES  85 / 4       RTY  12 / 2
 *   TLT  35 / 4                 PDBC 12 / 10     MSTR 13 / 3
 *   XLP  6 / 2                  XLF  5 / 2       GLD  9 / 2
 *
 * The measurement that produced those counts is `probe_subjects_case.js`
 * in the session's scratch directory; it prints the lower-case hits with
 * the sentence they came from, and every one of them is the instrument.
 *
 * @type {{pattern: RegExp, subject: Subject}[]}
 */
const SUBJECT_PATTERNS = (() => {
  const out = [];
  for (const subject of SUBJECTS) {
    const escaped = subject.spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = subject.caseSensitive ? 'u' : 'iu';
    out.push({
      // The boundary is UNICODE-AWARE: "zlato" must not match inside
      // "zlatou", and "ES" must not match inside "ESPA".
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags),
      subject,
    });
  }
  out.sort((a, b) => b.subject.spoken.length - a.subject.spoken.length);
  return out;
})();

module.exports = {
  NOT_SUBJECTS,
  SUBJECTS,
  SUBJECT_PATTERNS,
};
