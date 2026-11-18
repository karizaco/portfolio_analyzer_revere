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

/** Words that make the verb after them something that has not happened. */
const INTENT_BEFORE = /\b(?:if|unless|until|would\s+like|like\s+to|want(?:ing)?\s+to|looking\s+to|might|may|could|should|watching|consider(?:ing)?|explain|thinking(?:\s+about)?)\b/i;

const FIRST_PERSON = /\b(?:i|i'm|im|i’ve|i've)\b/i;

const VERBS = [
  { action: 'stop_out', side: '', pattern: /\b(?:got\s+stopped|stopped\s+out|was\s+stopped)\b/i },
  { action: 'exit', side: '', pattern: /\b(?:covered|covering|sold|selling|closed|closing)\b/i },
  { action: 'trim', side: '', pattern: /\b(?:trimmed|trimming|reduc(?:ed|ing)\s+(?:my\s+)?exposure)\b/i },
  { action: 'open', side: 'short', pattern: /\b(?:short(?:ed|ing)?|shorts)\b/i },
  { action: 'open', side: 'long', pattern: /\b(?:bought|buying|long(?:ed)?)\b/i },
];

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
    verb: best.word.toLowerCase(),
  };
}

module.exports = {
  readSegment,
};
