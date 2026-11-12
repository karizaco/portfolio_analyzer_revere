'use strict';

// The direction an OPTIONS position implies.
//
// WHY THIS FILE EXISTS
//
// The shared extractor reads an action verb and takes its direction:
// "selling" is a sell, and a sell is bearish. That is right for shares
// and wrong for options:
//
//   "On CoreWeave I'm going to sell some puts here at the 80 strike."
//
// Selling a put is a BULLISH position -- the seller is paid to buy the
// stock at the strike and is happy to own it there. The shared extractor
// published it as a bearish CRWV call (measured 2026-11-11), which is a
// published holding that is exactly backwards.
//
// The Drift -- Adam Mesh and Tom Sosnoff's show -- is an OPTIONS show, so
// this is not a rare sentence there. It is the show's normal vocabulary.
//
// THE RULES
//
//   sell / short puts              bullish
//   buy puts                       bearish
//   sell / short calls             bearish
//   buy calls                      bullish
//   bull put spread                bullish
//   bear put spread                bearish
//   bull call spread               bullish
//   bear call spread               bearish
//   iron condor / straddle         neutral
//   covered call (sell a call)     bearish
//
// A strike price is not an entry price: "at the 80 strike" is where the
// option is written, not where the stock is bought. The shared extractor
// has no way to know that, so the price roles are corrected here too.

/**
 * The options constructions and the direction each one implies.
 *
 * Order matters: the more specific constructions come first, so a "bull
 * put spread" is not read as a plain "put" sale.
 */
const OPTIONS_PATTERNS = [
  { kind: 'bull_put_spread', direction: 'bullish', pattern: /\bbull(?:ish)?\s+put\s+spread\b/i },
  { kind: 'bear_put_spread', direction: 'bearish', pattern: /\bbear(?:ish)?\s+put\s+spread\b/i },
  { kind: 'bull_call_spread', direction: 'bullish', pattern: /\bbull(?:ish)?\s+call\s+spread\b/i },
  { kind: 'bear_call_spread', direction: 'bearish', pattern: /\bbear(?:ish)?\s+call\s+spread\b/i },
  { kind: 'iron_condor', direction: 'neutral', pattern: /\biron\s+condor\b/i },
  { kind: 'straddle', direction: 'neutral', pattern: /\bstraddle\b/i },
  { kind: 'short_strangle', direction: 'neutral', pattern: /\bshort(?:ing)?\s+(?:a\s+)?strangle\b/i },
  { kind: 'covered_call', direction: 'bearish', pattern: /\bcovered\s+call\b/i },
  { kind: 'cash_secured_put', direction: 'bullish', pattern: /\bcash[\s-]secured\s+puts?\b/i },
  {
    kind: 'sell_put',
    direction: 'bullish',
    // The option word must be NEXT to the verb. "I sold calls on NVDA to
    // finance the put" is a call sale, not a put sale, and a looser
    // pattern reads the "put" at the end of the sentence and calls it a
    // bullish put sale.
    pattern: /\b(?:sell(?:ing)?|sold|short(?:ing)?|write(?:ting)?|writing)\s+(?:\w+\s+){0,3}?puts?\b/i,
  },
  {
    kind: 'buy_put',
    direction: 'bearish',
    pattern: /\b(?:buy(?:ing)?|bought|purchase(?:d)?)\s+(?:\w+\s+){0,3}?puts?\b/i,
  },
  {
    kind: 'sell_call',
    direction: 'bearish',
    pattern: /\b(?:sell(?:ing)?|sold|short(?:ing)?|write(?:ting)?|writing)\s+(?:\w+\s+){0,3}?calls?\b/i,
  },
  {
    kind: 'buy_call',
    direction: 'bullish',
    pattern: /\b(?:buy(?:ing)?|bought|purchase(?:d)?)\s+(?:\w+\s+){0,3}?calls?\b/i,
  },
];

/**
 * The direction the options language in this window implies.
 *
 * @param {string} text
 * @returns {{direction: string, kind: string}|null}
 */
function optionsDirection(text) {
  const window = String(text || '');
  if (!window.trim()) return null;
  for (const { kind, direction, pattern } of OPTIONS_PATTERNS) {
    if (pattern.test(window)) return { direction, kind };
  }
  return null;
}

/**
 * Is this window about OPTIONS at all?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isOptionsText(text) {
  return /\b(?:puts?|calls?|options?|strike|expiry|premium|delta|gamma|vega|iv|skew|volatility)\b/i.test(String(text || ''));
}

module.exports = {
  OPTIONS_PATTERNS,
  isOptionsText,
  optionsDirection,
};
