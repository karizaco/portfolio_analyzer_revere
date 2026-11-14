'use strict';

/**
 * The O'Connell setup headings: what they say and what they mean.
 *
 * WHAT A SETUP IS
 *
 * A setup is the author's stated intent: a ticker, the kind of setup he
 * is watching, a direction where he states one, and the thesis in his
 * own words. It is NOT a position -- it is what he said he was looking
 * at, whether or not he ever took it. The positions live in the
 * position log; the setups live in the headings.
 *
 * THE HEADING SHAPES
 *
 * Measured over the 302 documents in the corpus, 743 headings carry a
 * ticker and a label, and they take two shapes:
 *
 *     AVGO → 200D SMA Reclaim           the arrow form
 *     NU - Nu Holdings Ltd               the dash form
 *
 * and the label may end with a direction:
 *
 *     QFIN - Qifu Technology - Long
 *     DELL → VAHm Breakout → Long
 *
 * THE TWO RULES THAT KEEP THE NOISE OUT
 *
 * The headings are read out of the PDF's TEXT LAYER, which is exact --
 * the headings are real text, unlike the prose. But the text layer also
 * carries the sheet's own labels, and a scan of the corpus found 151
 * headings beginning "VAHm", 40 beginning "10D" and 10 beginning
 * "9/21", all of them screener column names rather than setups.
 *
 * Two rules reject them:
 *
 *   1. The SIZE. Every setup heading is 16.1 points -- the third-level
 *      heading of the newsletter. The screener labels are inside table
 *      images and never reach the text layer at all, and the two
 *      headings that do match the shape at 23 and 24 points are a
 *      section heading ("TLT - Long-Term Treasury ETF") and an article
 *      title ("NVDA -4.99% into Elite 8 Earnings!").
 *
 *   2. The TICKER IS UPPERCASE. The screener labels are not tickers:
 *      "VAHm", "POCm", "VALm" are camel case, and every real ticker in
 *      the corpus is capitals. That one rule removes the screener noise
 *      on its own.
 */

/** The font size of a setup heading, in points. */
const SETUP_HEADING_SIZE = 16.1;

/** How far a heading's size may sit from the measured one. */
const SETUP_HEADING_SIZE_TOLERANCE = 1.2;

/** The font size of a section heading, in points. */
const SECTION_HEADING_SIZE = 19.6;

/** The sections a setup can be found under. */
const SECTIONS = Object.freeze({
  'EOD Trade Blotter & Position Log': 'trade_blotter',
  'Focus List': 'focus_list',
  'Position Log': 'position_log',
  'Technical Trading - Watchlist LINKED HERE': 'technical_trading',
  'Technical Trading - Watchlist': 'technical_trading',
  'Watchlist': 'watchlist',
});

/**
 * The vocabulary of setups.
 *
 * The labels are his own words, and the corpus has a vocabulary. Measured
 * over the 743 setup headings, the leading words are: Power (24),
 * Relative (15), Russell (15), Earnings (17), PEG (12), Bullish (9),
 * Rescheduling (7), Cannabis (8), Rocket (6), AI (6), Event-Driven (4),
 * Mean (7), High (7), 52wk (10), and the moving-average lengths 5D,
 * 10D, 20D, 200D.
 *
 * The mapping is by keyword and is applied to the LABEL, longest
 * keyword first, so "Power Earnings Gap" wins over "Earnings".
 */
const SETUP_VOCABULARY = [
  { kind: 'cannabis_rescheduling', terms: ['reschedul', 'cannabis', 'dea', 'alj'] },
  { kind: 'power_earnings_gap', terms: ['power earnings gap', 'peg', 'earnings gap'] },
  { kind: 'relative_strength', terms: ['relative strength', 'rs ', 'relative'] },
  { kind: 'index_inclusion', terms: ['russell', 'index inclusion', 's&p rebalance', 'rebalance'] },
  { kind: 'price_cycle', terms: ['vahm', 'vahy', 'valm', 'value area'] },
  { kind: 'point_of_control', terms: ['pocm', 'vpoc', 'point of control'] },
  { kind: 'moving_average', terms: ['200d', '100d', '150d', '50d', '20d', '10d', '5d', 'sma', 'ema'] },
  { kind: 'fifty_two_week', terms: ['52wk', '52 week', '52-week'] },
  { kind: 'breakout', terms: ['breakout', 'break out'] },
  { kind: 'base', terms: ['carving out a base', 'base', 'cup', 'consolidat'] },
  { kind: 'earnings', terms: ['earnings', 'eps', 'guidance'] },
  { kind: 'trend', terms: ['bullish', 'bearish', 'trend', 'momentum'] },
  { kind: 'mean_reversion', terms: ['mean reversion', 'mean'] },
  { kind: 'event_driven', terms: ['event-driven', 'event driven', 'catalyst'] },
  { kind: 'sector', terms: ['ai ', 'china', 'semis', 'robot', 'quantum'] },
];

/** The directions a setup may state. */
const DIRECTIONS = Object.freeze({
  BEARISH: 'short',
  BULLISH: 'long',
  LONG: 'long',
  SHORT: 'short',
});

/**
 * The shape a ticker has to have.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isTickerShape(token) {
  return /^[A-Z][A-Z0-9]{0,5}([.\-][A-Z0-9]{1,3})?$/.test(String(token || ''));
}

/**
 * A setup heading, parsed.
 *
 * @param {string} text
 * @returns {{ticker: string, label: string, direction: string}|null} null when
 *   the text is not a setup heading.
 */
function parseSetupHeading(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const match = /^([A-Z][A-Z0-9.\-]{0,7})\s*(?:→|->|—|–|-)\s*(.+)$/.exec(raw);
  if (!match) return null;

  const ticker = match[1];
  if (!isTickerShape(ticker)) return null;

  let label = match[2].trim();
  let direction = '';

  // The direction, where he states one, is at the END: "Qifu Technology -
  // Long", "VAHm Breakout → Long".
  const directionMatch = /\s*(?:→|->|—|–|-)\s*(LONG|SHORT|BULLISH|BEARISH)\s*$/i.exec(label);
  if (directionMatch) {
    direction = DIRECTIONS[directionMatch[1].toUpperCase()] || '';
    label = label.slice(0, directionMatch.index).trim();
  }

  if (!label) return null;
  return { direction, label, ticker };
}

/**
 * The kind of setup a label describes.
 *
 * @param {string} label
 * @returns {string} '' when the label is not in the vocabulary
 */
function setupKindFor(label) {
  const text = ` ${String(label || '').toLowerCase()} `;
  let best = null;
  let bestLength = 0;
  for (const entry of SETUP_VOCABULARY) {
    for (const term of entry.terms) {
      if (!text.includes(term)) continue;
      if (term.length > bestLength) {
        bestLength = term.length;
        best = entry.kind;
      }
    }
  }
  return best || '';
}

/**
 * The section a heading belongs to.
 *
 * @param {string} text
 * @returns {string} '' when the heading is not a known section
 */
function sectionFor(text) {
  const raw = String(text || '').trim();
  if (SECTIONS[raw]) return SECTIONS[raw];
  for (const [name, id] of Object.entries(SECTIONS)) {
    if (raw.toLowerCase().includes(name.toLowerCase())) return id;
  }
  return '';
}

module.exports = {
  DIRECTIONS,
  SECTIONS,
  SECTION_HEADING_SIZE,
  SETUP_HEADING_SIZE,
  SETUP_HEADING_SIZE_TOLERANCE,
  SETUP_VOCABULARY,
  isTickerShape,
  parseSetupHeading,
  sectionFor,
  setupKindFor,
};
