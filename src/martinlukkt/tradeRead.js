'use strict';

// A trade he STATED, read out of a caption segment.
//
// This is not the Discord message parser. A caption is a fragment ("I bought"
// in one segment, the ticker in the next), and the Discord parser expects one
// dense message with the ticker in a slot. The rules that transfer are the
// ones that were measured to be easy to get wrong there:
//
//   the earliest verb is the action
//   an intent is not a trade ("if I have to short", "would like to short")
//   a number is a price only next to a price word ("stop was the day low"
//   has no number; "a 2% stop" is a percent, not a price)
//
// WHAT COUNTS
//
// A first-person statement. "I bought the breakout" is a trade he took.
// "I'm going to short this one" is a trade he is stating now. "the short
// entry" and "you still bought there" are not his.

const { findPrices } = require('../discord/tradeActions');
const { JARGON } = require('../discord/symbols');

/** Words that make the verb after them something that has not happened. */
const INTENT_BEFORE = /\b(?:if|unless|until|would\s+like|like\s+to|want(?:ing)?\s+to|looking\s+to|might|may|could|should|watching|consider(?:ing)?|explain|thinking(?:\s+about)?|afraid)\b/i;

/**
 * A negation of the verb that follows it.
 *
 * "I'm not shorting IWM" is not a short. This is separate from INTENT_BEFORE,
 * which is about the FUTURE ("I'm going to short"); this is about a trade he
 * says he did NOT take. Only a negation that sits IMMEDIATELY before the
 * verb counts, so "I was not able to buy, so I shorted X" keeps its short.
 */
const NEGATED = /\b(?:not|never|no longer|n't)\s*$/i;

const FIRST_PERSON = /\b(?:i|i'm|im|i’ve|i've)\b/i;

const VERBS = [
  { action: 'stop_out', side: '', pattern: /\b(?:got\s+stopped|stopped\s+out|was\s+stopped)\b/i },
  { action: 'exit', side: '', pattern: /\b(?:covered|covering|sold|selling|closed|closing)\b/i },
  { action: 'trim', side: '', pattern: /\b(?:trimmed|trimming|reduc(?:ed|ing)\s+(?:my\s+)?exposure)\b/i },
  // "short" and "long" are nouns in a trading sentence as often as they are
  // verbs: "for a short entry", "this AAP long", "the long side". The guard
  // is the same one the Discord reader uses, plus "entry" and "position",
  // which the corpus needed.
  {
    action: 'open',
    side: 'short',
    pattern: /\bshort(?:ed|ing)?\b(?!\s*(?:term|entry|side|set\s?ups?|watch|interest|squeeze|list|covering|position|thesis|idea))/i,
  },
  {
    action: 'open',
    side: 'long',
    pattern: /\b(?:bought|buying)\b/i,
  },
  {
    action: 'open',
    side: 'long',
    pattern: /\blong(?:ed|s)?\b(?!\s*(?:term|as\b|way|time|side|set\s?ups?|watch|run|weekend|ago|enough|list|entry|position|thesis|idea|and|but))/i,
  },
];

/** A capitals token: 2-5 letters, standing on its own. */
const TOKEN = /(?<![A-Za-z0-9$])([A-Z]{2,5})(?![A-Za-z0-9])/g;

/**
 * The capitals tokens of a text, with the jargon and the two-word names out.
 *
 * A capitals token that is the first word of a NAME ("SK Hynix", "Rocket
 * Lab") is not a symbol. The next word starts with a capital and then a
 * lower-case letter, and the whole phrase is a company.
 *
 * @param {string} text
 * @returns {{index: number, ticker: string}[]}
 */
function capitalTokens(text) {
  const out = [];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(text)) !== null) {
    if (JARGON.has(match[1])) continue;
    const rest = text.slice(match.index + match[1].length);
    if (/^\s+[A-Z][a-z]/.test(rest)) continue;
    out.push({ index: match.index, ticker: match[1] });
  }
  return out;
}

/**
 * The ticker a trade is ABOUT.
 *
 * The rule is ADJACENCY, not order. Measured on the corpus: taking the first
 * capitals token in the segment published "VWAP" (an indicator), "SK" out of
 * "SK Hynix" (a company), and "IWM" out of "the weakness of IWM" (the
 * market he was watching, not the name he traded). The name that belongs to
 * the verb is the one beside it.
 *
 * So: the token right AFTER the verb wins; failing that, the token right
 * BEFORE it.
 *
 * @param {string} text
 * @param {number} verbIndex - where the verb starts
 * @param {number} verbLength
 * @returns {string}
 */
function subjectTicker(text, verbIndex, verbLength) {
  const tokens = capitalTokens(text);
  if (!tokens.length) return '';
  const after = tokens.filter((token) => token.index >= verbIndex + verbLength);
  const before = tokens.filter((token) => token.index < verbIndex);
  const chosen = after.length ? after[0] : (before.length ? before[before.length - 1] : null);
  return chosen ? chosen.ticker : '';
}

/**
 * The first-person trade in one segment, or null.
 *
 * @param {string} text
 * @returns {{action: string, side: string, kind: string, verb: string, price: number|null, stop_price: number|null}|null}
 */
function readSegment(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || !FIRST_PERSON.test(raw)) return null;

  let best = null;
  for (const verb of VERBS) {
    const match = verb.pattern.exec(raw);
    if (!match) continue;
    if (!best || match.index < best.index) {
      best = { action: verb.action, side: verb.side, index: match.index, word: match[0] };
    }
  }
  if (!best) return null;

  const before = raw.slice(0, best.index);
  if (INTENT_BEFORE.test(before)) return null;
  if (NEGATED.test(before)) return null;
  // "you still bought" is not his, even if "I" appears elsewhere.
  if (/\byou\b/i.test(before) && !/\bi\b/i.test(before)) return null;

  const goingTo = /\b(?:going\s+to|gonna|plan(?:ning)?\s+to)\s*$/i.test(before);
  const prices = findPrices(raw);
  const stopAt = raw.search(/\bstop\b/i);
  const stopPrice = stopAt === -1 ? null : (prices.find((price) => price.index > stopAt) || {}).value || null;
  const entry = prices.find((price) => stopAt === -1 || price.index < stopAt);

  return {
    action: best.action,
    kind: goingTo ? 'plan' : 'action',
    price: entry ? entry.value : null,
    side: best.side,
    stop_price: stopPrice,
    subject: subjectTicker(raw, best.index, best.word.length),
    verb: best.word.toLowerCase(),
  };
}

/**
 * Uppercase ticker-shaped tokens in one caption line.
 *
 * Auto-captions capitalise a heard symbol and leave the rest in sentence
 * case, so the capitals are the evidence. "ACHL would be the entry" yields
 * ACHL. The shared jargon list refuses the indicator labels ("EMA",
 * "VWAP", "LOD"), which are never holdings, and the two-word names ("SK
 * Hynix") are refused by the same rule the subject uses.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tickersIn(text) {
  return capitalTokens(text).map((token) => token.ticker);
}

/**
 * Trades across a transcript, with the ticker taken from the next segment
 * when this one does not name it.
 *
 * Measured: "I bought" and "ACHL would be the entry" are adjacent segments
 * a few seconds apart. A ticker more than 20 seconds later belongs to a
 * different remark and is not attached.
 *
 * @param {{text: string, start_sec?: number}[]} segments
 * @returns {object[]}
 */
function readTrades(segments) {
  const rows = Array.isArray(segments) ? segments : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const read = readSegment(rows[i].text);
    if (!read) continue;
    let ticker = read.subject || '';
    let tickerFrom = 'segment';
    const next = rows[i + 1];
    if (!ticker && next) {
      const gap = Number(next.start_sec) - Number(rows[i].start_sec);
      const close = !Number.isFinite(gap) || gap <= 20;
      if (close) {
        const candidates = tickersIn(next.text);
        if (candidates.length) {
          ticker = candidates[0];
          tickerFrom = 'next_segment';
        }
      }
    }
    out.push({
      ...read,
      evidence_text: String(rows[i].text || '').trim(),
      segment_index: i,
      start_sec: rows[i].start_sec,
      ticker,
      ticker_from: ticker ? tickerFrom : '',
    });
  }
  return out;
}

module.exports = {
  readSegment,
  readTrades,
  tickersIn,
};
