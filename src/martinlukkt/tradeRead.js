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

const NOT_A_TICKER = new Set([
  'THE', 'AND', 'FOR', 'YOU', 'THIS', 'THAT', 'EMA', 'LOD', 'HOD', 'USD',
  'ETF', 'ADR', 'NASDAQ', 'AMEX', 'INC',
]);

/**
 * Uppercase ticker-shaped tokens in one caption line.
 *
 * Auto-captions capitalise a heard symbol and leave the rest in sentence
 * case, so the capitals are the evidence. "ACHL would be the entry" yields
 * ACHL. "EMA" is the indicator label, not a holding.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tickersIn(text) {
  const found = String(text || '').match(/\b[A-Z]{2,5}\b/g) || [];
  return [...new Set(found.filter((token) => !NOT_A_TICKER.has(token)))];
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
    let tickers = tickersIn(rows[i].text);
    let tickerFrom = 'segment';
    const next = rows[i + 1];
    if (!tickers.length && next) {
      const gap = Number(next.start_sec) - Number(rows[i].start_sec);
      const close = !Number.isFinite(gap) || gap <= 20;
      if (close) {
        tickers = tickersIn(next.text);
        if (tickers.length) tickerFrom = 'next_segment';
      }
    }
    out.push({
      ...read,
      evidence_text: String(rows[i].text || '').trim(),
      segment_index: i,
      start_sec: rows[i].start_sec,
      ticker: tickers[0] || '',
      ticker_from: tickers.length ? tickerFrom : '',
    });
  }
  return out;
}

module.exports = {
  readSegment,
  readTrades,
  tickersIn,
};
