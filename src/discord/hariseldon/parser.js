'use strict';

/**
 * A trade ACTION, read out of one of HariSeldon's posts.
 *
 * WHAT HE POSTS
 *
 *   "Long $TSLA `438.60` - 1,000 Shares"                 an equity entry
 *   "Short $TSLA (again) $438.60 - 1,000 Shares"          the same, again
 *   "Added to $NVDA $122.64 avg - 1,500 Shares"           an add
 *   "Exit $TSLA with $1.82 profit per share (500)"        an equity exit
 *   "Exit $NVDA with $3 profit per share"
 *   "Exit /ES with 10 pts profit - still in $SPY PDS"      the ES future
 *
 *   "Short $SPY PDS $730/$720 for $3.08 - 10 Contract"    an option spread
 *   "Long $MSTR CDS $385/$400 - $5.25 - 10 Contracts"
 *   "Long Strangle on $SPY `759.61` - $765 Calls and $752 puts for $3.86"
 *   "I sold the $AMD $500 Calls (again) this time for $8.55"
 *   "Bought back the sold Calls for $4 profit per contract (5 Contract)"
 *
 * THE RULES THAT ARE EASY TO GET WRONG
 *
 * 1. **THE PRICE IS THE FIRST NUMBER AFTER THE TICKER**, and that was
 *    MEASURED rather than assumed: over the entry/exit pairs that state
 *    a profit, the first number after the ticker is within 5 % of the
 *    exit price in 101 of 110 pairs (median 0.50 %), while the second
 *    number is within 5 % in 124 of 481 (median distance 78 %) -- the
 *    second number is the SIZE or a STRIKE.
 *
 * 2. **AN EXIT THAT STATES THE PROFIT AND NO PRICE HAS NO PRICE.**
 *    "Exit $MRNA with $1.32 profit per contract (15)" states the
 *    profit, and the number there is the profit, not a fill.
 *
 * 3. **AN OPTION IS NOT AN EQUITY.** "Short $SPY PDS $730/$720 for
 *    $3.08 - 10 Contract" is a direction on SPY bought through a PUT
 *    DEBIT SPREAD, and the price is the SPREAD's price, which is not
 *    SPY's. Such a message is recorded as an `option` action and is NOT
 *    chained into a position episode, because the episode model prices a
 *    position from the underlying's closes and the two prices are not
 *    the same number.
 *
 * 4. **A MESSAGE MAY CARRY TWO ACTIONS.** "Exit $META with $6.10 profit
 *    from the sold Puts Exit $APP with $2 profit per share" closes two
 *    positions. The split is at the second "Exit".
 *
 * 5. **A TICKER IS INHERITED WHEN THE MESSAGE NAMES NONE.** "Bought back
 *    the sold Calls for $4 profit per contract" and "I added to another
 *    250 Shares" name no ticker, and they belong to the position he was
 *    last talking about.
 *
 * 6. **AN ANNOUNCEMENT IS NOT A TRADE.** He posts "Starting in 10
 *    Minutes: https://x.com/..." before every live session -- 35 of the
 *    messages in the census -- and "I am going to stay long $GOOGL" is
 *    a statement, not a fill.
 */

const { JARGON, loadLexicon } = require('../symbols');

/**
 * A number, with its thousands separators intact.
 *
 * The leading decimal point matters: he writes ".98 profit per share",
 * and a pattern that needs a leading digit reads that as 98 -- which is
 * then taken for the PRICE of the exit instead of the profit.
 */
const NUMBER = /(\d[\d,]*\.?\d*|\.\d+)/g;


/** The words that open a trade. */
const OPEN_LONG = /^\s*long\b/i;
const OPEN_SHORT = /^\s*short\b/i;
const EXIT = /^\s*exit\b/i;
const ADDED = /^\s*(?:i\s+)?added\b/i;
const SOLD = /^\s*(?:i\s+)?sold\b/i;
const BOUGHT_BACK = /^\s*(?:i\s+)?bought\s+back\b/i;
const BOUGHT = /^\s*(?:i\s+)?bought\b/i;

/**
 * The OPTION instruments, and what they are.
 *
 *   PDS   a put debit spread   (a short)
 *   CDS   a call debit spread  (a long)
 *   Strangle  both
 *   Puts  sold puts            (a short)
 *   Calls sold calls            (a long)
 */
const OPTION_WORDS = [
  { pattern: /\bPDS\b/i, kind: 'put debit spread', side: 'short' },
  { pattern: /\bCDS\b/i, kind: 'call debit spread', side: 'long' },
  { pattern: /\bStrangle\b/i, kind: 'strangle', side: '' },
  { pattern: /\bPuts?\b/i, kind: 'puts', side: 'short' },
  { pattern: /\bCalls?\b/i, kind: 'calls', side: 'long' },
];

/**
 * The futures he names, and the symbol they are PRICED by.
 *
 * The slash is his own notation -- "Exit /ES" -- and the symbol is
 * Yahoo's: "ES" on its own is Eversource Energy, and the S&P 500 future
 * is "ES=F".
 */
const FUTURES = new Map([
  ['ES', 'ES=F'],
  ['NQ', 'NQ=F'],
  ['YM', 'YM=F'],
  ['RTY', 'RTY=F'],
  ['CL', 'CL=F'],
  ['GC', 'GC=F'],
]);

/** "at breakeven" -- an exit with no price and no result. */
const BREAKEVEN = /\b(?:at\s+)?breakeven\b/i;

/** "profit per share", "profit per contract", "pts profit", "loss". */
const RESULT = /([+-]?(?:\d[\d,]*\.?\d*|\.\d+))\s*(?:pts?\s+)?(?:profit|loss)(?:\s+per\s+(?:share|contract))?/i;
const RESULT_PER = /([+-]?(?:\d[\d,]*\.?\d*|\.\d+))\s*(?:profit|loss)\s+per\s+(share|contract)/i;

/** "1,000 Shares", "10 Contract", "(500 Shares)", "2,500". */
const SHARES = /(\d[\d,]*)\s*(?:shares?|Shares?)\b/;
const CONTRACTS = /(\d[\d,]*)\s*(?:contracts?|Contracts?)\b/;

/**
 * A ticker, with or without its dollar sign, and the futures' slash.
 *
 * He writes the ticker BOTH ways -- "Exit $TSLA with ..." and "Exit TSLA
 * partial at ..." -- so the bare form is read too, and it is accepted
 * only when the lexicon knows the symbol: without that, "Exit the
 * position" and every other capitalised word in the sentence would be
 * a holding.
 */
const TICKER = /(?<![A-Za-z0-9])\$?\/([A-Z]{1,5})\b|(?<![A-Za-z0-9])\$([A-Z]{1,5})\b|(?<![A-Za-z0-9])([A-Z]{2,5})\b/g;

/** The messages that are announcements, not trades. */
const NOT_A_TRADE = /^(?:starting in|live today|live spaces|here is the recording|today at|video|stream|podcast|join)/i;

/**
 * The numbers in a text, in order.
 *
 * @param {string} text
 * @returns {{value: number, index: number, raw: string, after: string}[]}
 */
function numbers(text) {
  const out = [];
  NUMBER.lastIndex = 0;
  let match;
  while ((match = NUMBER.exec(text)) !== null) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({
      value,
      index: match.index,
      raw: match[0],
      before: text.slice(Math.max(0, match.index - 2), match.index),
      after: text.slice(match.index + match[0].length, match.index + match[0].length + 14),
    });
  }
  return out;
}

/**
 * The ticker of a message, and where the rest of it starts.
 *
 * The equities carry a dollar sign and the futures a slash, and that is
 * what tells them apart: "Long $TSLA" is an equity and "Exit /ES" is the
 * S&P future.
 *
 * @param {string} text
 * @param {Set<string>} [known]  the tickers a bare symbol may be
 * @returns {{ticker: string, kind: string, rest: string}|null}
 */
function findInstrument(text, known) {
  TICKER.lastIndex = 0;
  let match;
  while ((match = TICKER.exec(text)) !== null) {
    const futures = match[1];
    const dollar = match[2];
    const bare = match[3];
    if (futures) {
      const symbol = futures.toUpperCase();
      if (!FUTURES.has(symbol)) continue;
      // The futures are Yahoo's own symbols: "ES" on its own is
      // Eversource Energy, and the S&P future is "ES=F".
      return {
        ticker: FUTURES.get(symbol),
        kind: 'future',
        rest: text.slice(match.index + match[0].length),
      };
    }
    const symbol = (dollar || bare || '').toUpperCase();
    if (!symbol) continue;
    if (JARGON.has(symbol)) continue;
    if (!dollar) {
      // A bare ticker has to be one the lexicon knows, or every
      // capitalised word in the sentence becomes a holding.
      const list = known || loadLexicon();
      if (!list.has(symbol)) continue;
    }
    return { ticker: symbol, kind: 'equity', rest: text.slice(match.index + match[0].length) };
  }
  return null;
}

/**
 * The OPTION instrument a message carries, if any.
 *
 * @param {string} text
 * @returns {{kind: string, side: string}|null}
 */
function findOption(text) {
  for (const option of OPTION_WORDS) {
    if (option.pattern.test(text)) return { kind: option.kind, side: option.side };
  }
  return null;
}

/**
 * The result a message states: the profit or the loss.
 *
 * @param {string} text
 * @returns {{value: number, per: string}|null}
 */
function findResult(text) {
  const per = RESULT_PER.exec(text);
  if (per) {
    const value = Number(per[1].replace(/,/g, ''));
    if (Number.isFinite(value)) {
      return { value: /loss/i.test(per[0]) ? -Math.abs(value) : value, per: per[2].toLowerCase() };
    }
  }
  const match = RESULT.exec(text);
  if (match) {
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return { value: /loss/i.test(match[0]) ? -Math.abs(value) : value, per: '' };
  }
  return null;
}

/**
 * The size a message states: shares or contracts.
 *
 * @param {string} text
 * @returns {{shares: number|null, contracts: number|null}}
 */
function findSize(text) {
  const shares = SHARES.exec(text);
  const contracts = CONTRACTS.exec(text);
  return {
    shares: shares ? Number(shares[1].replace(/,/g, '')) : null,
    contracts: contracts ? Number(contracts[1].replace(/,/g, '')) : null,
  };
}

/**
 * The price of a trade.
 *
 * The FIRST number after the ticker, unless that number is the stated
 * result (rule 2) or the size.
 *
 * @param {string} rest  the text after the ticker
 * @param {number|null} result  the stated result, when there is one
 * @returns {number|null}
 */
/**
 * The price of an OPTION, and it is not the first number.
 *
 * "Short $SPY PDS $730/$720 for $3.08 - 10 Contract" -- the first
 * numbers are the two STRIKES of the spread and the price is the one
 * after "for". "Long $MSTR CDS $385/$400 - $5.25 - 10 Contracts" -- the
 * same. So the option's price is the LAST number before the size.
 *
 * @param {string} rest  the text after the ticker
 * @param {number|null} result  the stated result, when there is one
 * @returns {number|null}
 */
function findOptionPrice(rest, result) {
  const nums = numbers(rest);
  const stated = result && typeof result === 'object' ? result.value : result;
  const usable = nums.filter((candidate) => {
    if (stated !== null && stated !== undefined
      && Math.abs(candidate.value - Math.abs(stated)) < 0.005) return false;
    if (/^\s*[km]?\s*(?:shares?|contracts?)/i.test(candidate.after)) return false;
    if (/\($/.test(candidate.before) && /^\s*\)/.test(candidate.after)) return false;
    return true;
  });
  if (!usable.length) return null;
  return usable[usable.length - 1].value;
}

function findPrice(rest, result) {
  const nums = numbers(rest);
  const stated = result && typeof result === 'object' ? result.value : result;
  for (const candidate of nums) {
    if (stated !== null && stated !== undefined
      && Math.abs(candidate.value - Math.abs(stated)) < 0.005) continue;
    // The size is not a price: "1,000 Shares", "10 Contract", and the
    // "5K Shares" form, where the K rides on the number.
    if (/^\s*[km]?\s*(?:shares?|contracts?)/i.test(candidate.after)) continue;
    // A number in brackets is the size too: "(15)" after a contract
    // count and "(1,000)" after a share count.
    if (/\($/.test(candidate.before) && /^\s*\)/.test(candidate.after)) continue;
    return candidate.value;
  }
  return null;
}

/**
 * Read one post into a trade action, or into nothing.
 *
 * @param {string} content
 * @param {object} [context]
 * @param {string} [context.inheritedTicker]  the ticker of the position
 *   he was last talking about, when this post names none
 * @returns {object[]} the actions in the post
 */
function parsePost(content, context = {}) {
  const text = String(content || '').trim();
  if (!text) return [];
  if (NOT_A_TRADE.test(text)) return [];

  const out = [];

  // A message may carry TWO actions ("Exit $META ... Exit $APP ...").
  // The split is at the second trade verb, and each part is read on its
  // own.
  const parts = splitOnSecondAction(text);
  let inherited = context.inheritedTicker || '';

  for (const part of parts) {
    const action = parseAction(part, inherited, context.known);
    if (!action) continue;
    if (action.ticker) inherited = action.ticker;
    out.push(action);
  }
  return out;
}

/**
 * Split a post at its SECOND trade verb.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitOnSecondAction(text) {
  const verbs = /(?:^|\s)(exit|long|short|added|sold|bought\s+back|bought)\b/gi;
  const hits = [];
  let match;
  while ((match = verbs.exec(text)) !== null) hits.push(match.index);
  if (hits.length < 2) return [text];
  const cut = hits[1];
  return [text.slice(0, cut).trim(), text.slice(cut).trim()].filter(Boolean);
}

/**
 * Read one part into a trade action.
 *
 * @param {string} text
 * @param {string} inheritedTicker
 * @param {Set<string>} [known]  the tickers a bare symbol may be
 * @returns {object|null}
 */
function parseAction(text, inheritedTicker, known) {
  const instrument = findInstrument(text, known);
  const option = findOption(text);
  const result = findResult(text);
  const size = findSize(text);

  // The option leg: a spread, a strangle, or a sold call or put. The
  // ticker may be named ("I sold the $AMD $500 Calls") or inherited
  // ("Bought back the sold Calls").
  const isOptionLeg = Boolean(option)
    && (EXIT.test(text) || SOLD.test(text) || BOUGHT_BACK.test(text) || ADDED.test(text));

  if (isOptionLeg) {
    const ticker = instrument ? instrument.ticker : inheritedTicker;
    if (!ticker) return null;
    const action = EXIT.test(text) || BOUGHT_BACK.test(text) ? 'exit' : 'open';
    return {
      action,
      kind: 'option',
      ticker,
      instrument: option.kind,
      price: instrument ? findOptionPrice(instrument.rest, result) : null,
      size_pct: null,
      size_note: size.shares ? `${size.shares} shares` : size.contracts ? `${size.contracts} contracts` : '',
      stop_price: null,
      stated_result_pct: null,
      stated_result: result ? result.value : null,
      verb: text.split(/\s+/)[0],
      content: text,
    };
  }

  if (EXIT.test(text)) {
    const ticker = instrument ? instrument.ticker : inheritedTicker;
    if (!ticker) return null;
    return {
      action: 'exit',
      kind: instrument ? instrument.kind : 'equity',
      ticker,
      instrument: '',
      price: instrument ? findPrice(instrument.rest, result) : null,
      size_pct: null,
      size_note: size.shares ? `${size.shares} shares` : size.contracts ? `${size.contracts} contracts` : '',
      stop_price: null,
      stated_result_pct: null,
      stated_result: result ? result.value : null,
      verb: 'Exit',
      content: text,
    };
  }

  if (ADDED.test(text)) {
    const ticker = instrument ? instrument.ticker : inheritedTicker;
    if (!ticker) return null;
    return {
      action: 'add',
      kind: instrument ? instrument.kind : 'equity',
      ticker,
      instrument: '',
      price: instrument ? findPrice(instrument.rest, result) : null,
      size_pct: null,
      size_note: size.shares ? `${size.shares} shares` : size.contracts ? `${size.contracts} contracts` : '',
      stop_price: null,
      stated_result_pct: null,
      stated_result: null,
      verb: 'Added',
      content: text,
    };
  }

  if (OPEN_LONG.test(text) || OPEN_SHORT.test(text) || BOUGHT.test(text)) {
    if (!instrument) return null;
    // An open that names an option instrument is an OPTION action: the
    // price is the spread's, so it is not a position price.
    if (option) {
      return {
        action: 'open',
        kind: 'option',
        ticker: instrument.ticker,
        instrument: option.kind,
        price: findOptionPrice(instrument.rest, result),
        size_pct: null,
        size_note: size.shares ? `${size.shares} shares` : size.contracts ? `${size.contracts} contracts` : '',
        stop_price: null,
        stated_result_pct: null,
        stated_result: null,
        verb: OPEN_LONG.test(text) ? 'Long' : OPEN_SHORT.test(text) ? 'Short' : 'Bought',
        content: text,
      };
    }
    return {
      action: 'open',
      kind: instrument.kind,
      ticker: instrument.ticker,
      instrument: '',
      price: findPrice(instrument.rest, result),
      size_pct: null,
      size_note: size.shares ? `${size.shares} shares` : size.contracts ? `${size.contracts} contracts` : '',
      stop_price: null,
      stated_result_pct: null,
      stated_result: null,
      verb: OPEN_LONG.test(text) ? 'Long' : OPEN_SHORT.test(text) ? 'Short' : 'Bought',
      content: text,
    };
  }

  return null;
}

module.exports = {
  ADDED,
  BOUGHT,
  BOUGHT_BACK,
  EXIT,
  FUTURES,
  NOT_A_TRADE,
  OPEN_LONG,
  OPEN_SHORT,
  OPTION_WORDS,
  SOLD,
  findInstrument,
  findOption,
  findOptionPrice,
  findPrice,
  findResult,
  findSize,
  numbers,
  parsePost,
};
