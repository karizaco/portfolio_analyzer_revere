'use strict';

// Turn a spoken transcript into structured trade signals.
//
// WHAT THIS DOES
//
// A trader says something like:
//
//   "TQQQ, I think the first target is around 78, and if it breaks out
//    above 80 I'm going to add. That's my highest conviction name this week."
//
// and the pipeline wants:
//
//   ticker=TQQQ  bias=bullish  action=add  confidence=high
//   target=78  entry=null  evidence="TQQQ, I think the first target is ..."
//
// THE ONE ABSOLUTE RULE
//
// A signal is only emitted when a TICKER is present in the window.
//
// "I am bullish" says nothing about what to buy, so it is not a signal --
// it is a mood. Emitting it would fill the report with rows that carry no
// actionable information, and a report of mostly-noise rows is worse than an
// empty one.
//
// WHY A DETERMINISTIC PARSER
//
// The extraction is rule-based on purpose. Every rule is a claim about
// English trading language that can be read, argued with, and measured, and
// the same transcript always produces the same signals. A model-based
// extractor would be better at some sentences and worse at others, and
// nothing in the output would say which -- so a reading could not be
// checked against its evidence.
//
// The evidence text is stored with every signal precisely so that a human
// can disagree with a rule and see exactly what the rule saw.
//
// WHAT IS DELIBERATELY NOT INFERRED
//
//   * A price with no ROLE. "$45" next to a ticker is not an entry level
//     unless something said "entry", "buy at" or "target". Guessing a role
//     puts a wrong number in a portfolio report.
//   * A ticker that is a common English word. ON, BE, ARM, NET and TAN are
//     real tickers AND words a speaker uses constantly. A token from that
//     set has to be written in CAPS to count.
//   * A bias from a hedged sentence. "Not bullish any more" is a bearish
//     signal, and "I was bullish but I sold" is mixed -- both are handled
//     explicitly rather than by counting matches.

const {
  ACTION_PATTERNS,
  AMBIGUOUS_TICKER_WORDS,
  BEARISH_PATTERNS,
  BULLISH_PATTERNS,
  BUY_AT_PRICE_PATTERN,
  CONFIDENCE_PATTERNS,
  CURRENT_PRICE_PATTERN,
  HORIZON_PATTERNS,
  MAX_PRICE,
  MIN_PRICE,
  NON_PRICE_CONTEXT,
  PRICE_RANGE_PATTERN,
  PRICE_ROLES,
  PRICE_TOKEN_PATTERN,
  WINDOW_SEGMENTS,
} = require('./signalPatterns');

const { STRICT_TICKER_PATTERN } = require('../normalize/tickerExtraction');

/**
 * The version of the extractor. It is written onto every signal row, so a
 * re-run with a changed parser can be told apart from the previous one.
 */
const PARSER_VERSION = 'sevcik-signals-1';

// A phrase that reverses a direction. "Not bullish" is bearish, and the
// naive pattern match would read "bullish" and call it bullish.
const NEGATION_PATTERNS = [
  /\b(?:not|isn'?t|is\s+not|aren'?t|no\s+longer|don'?t|do\s+not|never)\s+(?:\w+\s+){0,2}?(bullish|bearish|optimistic|pessimistic|long|short)\b/gi,
];

// A phrase that marks a past-tense or hypothetical statement. "I was
// bullish on X" is history, not a call.
const HISTORICAL_PATTERNS = [
  /\b(?:i\s+was|i\s+had\s+been|we\s+were|used\s+to|previously|yesterday|last\s+week|i\s+closed\s+my\s+position\s+in)\b/gi,
];

// A sentence that explicitly disclaims a call.
const DISCLAIMER_PATTERNS = [
  /\b(?:not\s+a\s+recommendation|not\s+financial\s+advice|educational\s+purposes|your\s+own\s+research|do\s+your\s+own\s+due\s+diligence)\b/gi,
];

/**
 * Does this text contain a common English word that is also a ticker?
 *
 * The token is only accepted if it was written in CAPS. "ON" in a
 * transcript is a ticker; "on" is a preposition.
 *
 * THE COMPARISON IS AGAINST THE ORIGINAL TOKEN
 *
 * The earlier version compared the UPPERCASED token with itself, which is
 * always true -- so the CAPS rule never fired, and every ambiguous token
 * was accepted in any casing.
 *
 * That was invisible in English and glaring in Czech. Measured on one
 * real 50-minute Czech stream (2026-11-04): 123 of 881 segments matched a
 * lexicon "ticker", and almost every one was a Czech word fragment:
 *
 *   SE   from "se"      (it)
 *   U    from "u"       (at/in)
 *   P    from "případně" (if)
 *   TER  from "úterý"   (Tuesday)
 *   SI   from "si"      (yourself)
 *
 * So the rule compares the uppercased form against the ORIGINAL, trimmed
 * token: "SE" is accepted, "se" is not.
 *
 * @param {string} token - the raw token, with its original casing
 * @returns {boolean}
 */
function isAmbiguousTokenAccepted(token) {
  const raw = String(token || '').trim();
  const upper = raw.toUpperCase();
  if (!AMBIGUOUS_TICKER_WORDS.has(upper)) return true;
  // CAPS in the source text, and nothing else.
  return raw === upper;
}

/**
 * The tickers in a piece of text, with their positions.
 *
 * The tokenization is done here rather than delegated to
 * `src/normalize/tickerExtraction.js`, for one reason that matters:
 *
 * That module's `STRICT_TICKER_PATTERN` accepts a dotted suffix
 * (`BRK.B`), so a token keeps its trailing period and then fails the
 * pattern -- "TQQQ." is not a ticker to it, and neither is "SPY.". A
 * transcript is full of sentences that END in a period, so every ticker at
 * the end of a sentence would be lost.
 *
 * So the period is stripped here, and only the trailing one: "BRK.B" keeps
 * its dot, because that is part of the symbol.
 *
 * @param {string} text
 * @param {Set<string>} lexicon - the allowed ticker set
 * @returns {Array<{ticker: string, index: number}>}
 */
function findTickers(text, lexicon) {
  const str = String(text || '');
  if (!str.trim()) return [];

  const found = [];
  const seen = new Set();

  const tokenPattern = /[A-Za-z][A-Za-z0-9.]*/g;
  let match;
  while ((match = tokenPattern.exec(str)) !== null) {
    const raw = match[0];
    // Only a TRAILING period is punctuation. A dot in the middle is part of
    // the symbol.
    const token = raw.replace(/\.+$/, '');
    if (!token) continue;

    const upper = token.toUpperCase();
    if (!STRICT_TICKER_PATTERN.test(upper)) continue;
    if (!lexicon.has(upper)) continue;
    if (seen.has(upper)) continue;
    if (!isAmbiguousTokenAccepted(token)) continue;

    seen.add(upper);
    found.push({ ticker: upper, index: match.index });
  }

  return found;
}

/**
 * How strongly does the text lean bullish?
 *
 * @param {string} text
 * @returns {{score: number, matches: number}}
 */
function scoreBullish(text) {
  return scorePatterns(text, BULLISH_PATTERNS);
}

/**
 * How strongly does the text lean bearish?
 *
 * @param {string} text
 * @returns {{score: number, matches: number}}
 */
function scoreBearish(text) {
  return scorePatterns(text, BEARISH_PATTERNS);
}

/**
 * Score a set of weighted patterns against a text.
 *
 * The score is the MAXIMUM weight rather than the sum: a sentence that
 * repeats "bullish" three times is not three times as bullish as one that
 * says it once, and a sum would let repetition overwhelm a contradiction.
 *
 * @param {string} text
 * @param {Array<{pattern: RegExp, weight: number}>} patterns
 * @returns {{score: number, matches: number}}
 */
function scorePatterns(text, patterns) {
  const str = String(text || '');
  let score = 0;
  let matches = 0;
  for (const entry of patterns) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    const found = str.match(regex);
    if (!found || !found.length) continue;
    matches += found.length;
    score = Math.max(score, entry.weight);
  }
  return { score, matches };
}

/**
 * Is the text a negation of a direction?
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasNegation(text) {
  return NEGATION_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(String(text || '')));
}

/**
 * Is the text about something that already happened?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isHistorical(text) {
  return HISTORICAL_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(String(text || '')));
}

/**
 * Is this a disclaimer rather than a call?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isDisclaimer(text) {
  return DISCLAIMER_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(String(text || '')));
}

/**
 * The bias of a window of text.
 *
 * @param {string} text
 * @returns {{bias: string, strength: number}}
 */
function determineBias(text) {
  const bullish = scoreBullish(text);
  const bearish = scoreBearish(text);

  if (!bullish.matches && !bearish.matches) {
    return { bias: 'neutral', strength: 0 };
  }

  // A negated direction flips: "not bullish" is bearish.
  let bullScore = bullish.score;
  let bearScore = bearish.score;
  if (hasNegation(text)) {
    if (bullScore > 0 && bearScore === 0) {
      bearScore = bullScore;
      bullScore = 0;
    } else if (bearScore > 0 && bullScore === 0) {
      bullScore = bearScore;
      bearScore = 0;
    }
  }

  const diff = bullScore - bearScore;
  if (Math.abs(diff) < 0.2) {
    return { bias: bullScore > 0 && bearScore > 0 ? 'mixed' : 'neutral', strength: Math.max(bullScore, bearScore) };
  }
  return {
    bias: diff > 0 ? 'bullish' : 'bearish',
    strength: Math.max(bullScore, bearScore),
  };
}

/**
 * The action a window describes, with its strength.
 *
 * @param {string} text
 * @returns {{action: string, strength: number}}
 */
function determineAction(text) {
  let best = { action: '', strength: 0 };
  for (const entry of ACTION_PATTERNS) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    if (!regex.test(String(text || ''))) continue;
    if (entry.weight > best.strength) {
      best = { action: entry.action, strength: entry.weight };
    }
  }
  return best;
}

/**
 * Does this action state a direction by itself?
 *
 * "Going short" and "going long" say which way the speaker expects the
 * price to move, so they carry their own bias and do not need a separate
 * directional word. "Selling" and "trimming" imply a bearish expectation
 * about the name being sold; "buying" and "adding" imply a bullish one.
 *
 * This is what lets "I am going to short TQQQ" be a signal without the
 * word "bearish" appearing anywhere in the sentence.
 *
 * @param {string} action
 * @returns {boolean}
 */
function actionImpliesDirection(action) {
  return ['buy', 'add', 'sell', 'trim', 'short', 'cover'].includes(String(action || ''));
}

/**
 * The bias an action implies on its own.
 *
 * @param {string} action
 * @returns {string} 'bullish' | 'bearish' | ''
 */
function actionBias(action) {
  if (['buy', 'add'].includes(action)) return 'bullish';
  if (['sell', 'trim', 'short'].includes(action)) return 'bearish';
  if (action === 'cover') return 'bullish';
  return '';
}

/**
 * The stated confidence level, with its strength.
 *
 * @param {string} text
 * @returns {{level: string, strength: number}}
 */
function determineConfidence(text) {
  let best = { level: '', strength: 0 };
  for (const entry of CONFIDENCE_PATTERNS) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    if (!regex.test(String(text || ''))) continue;
    if (entry.weight > best.strength) {
      best = { level: entry.level, strength: entry.weight };
    }
  }
  return best;
}

/**
 * The stated horizon.
 *
 * @param {string} text
 * @returns {string}
 */
/**
 * The horizon of a call, when one is stated.
 *
 * The MOST SPECIFIC horizon wins, not the first one that matches. The
 * two are different: "Let's talk about Tesla today ... this is a swing
 * trade" states "today" first and means a swing, and a first-match-wins
 * search called it intraday.
 *
 * @param {string} text
 * @returns {string}
 */
function determineHorizon(text) {
  let best = { horizon: '', specificity: 0 };
  for (const entry of HORIZON_PATTERNS) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    if (!regex.test(String(text || ''))) continue;
    if (entry.specificity > best.specificity) {
      best = { horizon: entry.horizon, specificity: entry.specificity };
    }
  }
  return best.horizon;
}

/**
 * Parse a price token into a number.
 *
 * @param {string} token
 * @returns {number|null}
 */
function parsePrice(token) {
  const cleaned = String(token || '').replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  if (value < MIN_PRICE || value > MAX_PRICE) return null;
  return value;
}

/**
 * The prices in a window, each with the role it was given.
 *
 * A price's role comes from the words that INTRODUCE it, looked for in a
 * short stretch of text before it. A price with no role is not recorded --
 * a wrong role is worse than a missing price.
 *
 * @param {string} text
 * @returns {Array<{role: string, value: number, low: number, high: number}>}
 */
function findPrices(text) {
  const str = String(text || '');
  const found = [];
  const seen = new Set();

  // Ranges first, so the two numbers inside one are not also read singly.
  //
  // The 'g' flag is REQUIRED here: a non-global regex's exec() always
  // returns the same match, so the loop would never end.
  const rangeRegex = new RegExp(PRICE_RANGE_PATTERN.source, `${PRICE_RANGE_PATTERN.flags}g`);
  let rangeMatch;
  while ((rangeMatch = rangeRegex.exec(str)) !== null) {
    const low = parsePrice(rangeMatch[1]);
    const high = parsePrice(rangeMatch[2]);
    if (low === null || high === null) continue;
    const role = roleBefore(str, rangeMatch.index);
    if (!role) continue;
    const key = `${role}:${low}:${high}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      role,
      value: (low + high) / 2,
      low: Math.min(low, high),
      high: Math.max(low, high),
    });
  }

  const priceRegex = new RegExp(PRICE_TOKEN_PATTERN.source, PRICE_TOKEN_PATTERN.flags);
  let priceMatch;
  while ((priceMatch = priceRegex.exec(str)) !== null) {
    const raw = priceMatch[0];
    // A number inside a range was already handled.
    if (isInsideRange(str, priceMatch.index, priceMatch[0].length)) continue;

    const value = parsePrice(raw);
    if (value === null) continue;

    // The context is the word IMMEDIATELY before the number, not the words
    // anywhere before it. A wider window rejects ordinary speech: "I am
    // going to buy at 75" contains "am", and "am" is a time marker.
    if (isNonPriceContext(str, priceMatch.index)) continue;

    const role = roleBefore(str, priceMatch.index);
    if (!role) continue;

    const key = `${role}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ role, value, low: value, high: value });
  }

  return found;
}

/**
 * Is this number part of a range that was already read?
 *
 * @param {string} text
 * @param {number} index - the number's start offset
 * @param {number} length - the number's length
 * @returns {boolean}
 */
function isInsideRange(text, index, length) {
  const rangeRegex = new RegExp(PRICE_RANGE_PATTERN.source, `${PRICE_RANGE_PATTERN.flags}g`);
  let match;
  while ((match = rangeRegex.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (index >= start && index + length <= end) return true;
  }
  return false;
}

/**
 * Is the number at `index` in a context where it is not a price?
 *
 * Only the word IMMEDIATELY before the number is examined. A wider window
 * gives false positives on ordinary speech -- "I am going to buy at 75"
 * contains "am", and "am" is in the list because "10 am" is a time.
 *
 * @param {string} text
 * @param {number} index - the number's start offset
 * @returns {boolean}
 */
function isNonPriceContext(text, index) {
  // The word before the number: up to 12 characters of word characters,
  // then the word's start.
  const before = text.slice(0, index);
  const match = before.match(/([A-Za-z]+)\s*$/);
  if (!match) return false;
  return NON_PRICE_CONTEXT.test(match[1]);
}

/**
 * The role of the price at `index`, from the words before it.
 *
 * Two ways a price gets its role:
 *
 *   a keyword     "my target is 78", "the entry point is 45"
 *   a construction "I am going to buy TQQQ at 75" -- the verb and the
 *                 number are separated by the ticker, so no keyword
 *                 connects them
 *
 * The construction is checked FIRST, because it is the more specific
 * evidence: "target is 78" after "buy at 75" is two different prices, and
 * the one the verb introduces is the entry.
 *
 * AND THE ROLE MUST BE THE CLOSEST ONE. The keywords are tried in the
 * order they are declared, but that order is NOT the order they appear in
 * the text: "I am going to buy TSLA at 240, my target is 280. The stop
 * loss is 225" has "target" before "stop", so a first-match-wins search
 * labelled the STOP price 225 a target -- and the stop was lost.
 *
 * So every role's match position is compared, and the one whose keyword
 * is CLOSEST to the price wins.
 *
 * @param {string} text
 * @param {number} index
 * @returns {string} the role, or '' when the price has none
 */
function roleBefore(text, index) {
  const before = text.slice(0, index);

  // The construction: a buy verb, a short run of words, then "at" at the
  // very end of what precedes the price.
  if (BUY_AT_PRICE_PATTERN.test(before)) return 'entry';

  // The construction: where the price is NOW. This is the reference a
  // stated target is compared against, so it is recorded -- but it is not
  // an entry or a target, and it is not written into the signal's own
  // price columns.
  if (CURRENT_PRICE_PATTERN.test(before)) return 'current';

  // The window is short on purpose: a role belongs to the price it
  // introduces, not to the price three clauses later.
  const windowStart = Math.max(0, before.length - 60);
  const window = before.slice(windowStart);

  let best = { role: '', distance: Infinity };
  for (const entry of PRICE_ROLES) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    let match;
    while ((match = regex.exec(window)) !== null) {
      // The distance from the role's keyword to the price. The keyword
      // that sits closest to the price is the one that introduced it.
      const distance = window.length - match.index;
      if (distance < best.distance) {
        best = { role: entry.role, distance };
      }
      if (!regex.global) break;
    }
  }

  return best.role;
}

/**
 * A one-line summary of why the signal fired.
 *
 * @param {string} text
 * @param {string} ticker
 * @returns {string}
 */
function summarizeRationale(text, ticker) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 220) return cleaned;
  const index = cleaned.indexOf(ticker);
  if (index === -1) return `${cleaned.slice(0, 217)}...`;
  const start = Math.max(0, index - 60);
  const end = Math.min(cleaned.length, index + 160);
  return `${start > 0 ? '...' : ''}${cleaned.slice(start, end)}${end < cleaned.length ? '...' : ''}`;
}

/**
 * The confidence score of a signal.
 *
 * The score is the STRENGTH OF THE LANGUAGE, not a model's opinion. Four
 * things contribute:
 *
 *   the direction's own weight   "I am very bullish" vs "bullish"
 *   the action's weight            "I am going to buy" vs "bullish"
 *   the stated confidence          "high conviction" vs "maybe"
 *   the specificity                a stated target or entry is a more
 *                                 concrete claim than a bare opinion
 *
 * The DIRECTION and the STATED CONFIDENCE are both statements of how strong
 * the speaker believes the call is, so the two are combined by taking the
 * STRONGER of them -- not by adding them. Adding them would let "maybe I am
 * bullish" score higher than "I am bullish", because "maybe" is a low
 * confidence marker AND a direction word.
 *
 * The result is in [0, 1]. It is comparable between signals, which is all
 * the report needs.
 *
 * @param {object} parts
 * @returns {{score: number, label: string}}
 */
function scoreConfidence(parts) {
  // How strongly the speaker believes the call.
  const conviction = Math.max(parts.strength || 0, parts.actionStrength || 0);

  let score = conviction * 0.8;
  if (parts.hasPrice) score += 0.1;

  // A stated confidence CAPS the score. "Maybe I am bullish" is a weaker
  // claim than "I am bullish", even though both contain the word -- and
  // adding the two together would make the hedged sentence score HIGHER.
  const statedLevel = parts.confidenceLevel || '';
  if (statedLevel === 'low') score = Math.min(score, 0.45);
  if (statedLevel === 'high') score = Math.min(1, score + 0.15);

  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));

  let label = 'low';
  if (score >= 0.75) label = 'high';
  else if (score >= 0.45) label = 'medium';

  return { score, label };
}

/**
 * Does a stated target imply a direction?
 *
 * A target is a price the price is expected to move TOWARD, and in trading
 * language a TARGET IS AN UPSIDE TARGET -- the downside level is called a
 * stop, or a breakdown, and the vocabulary here already reads those as
 * their own role. So:
 *
 *   a target ABOVE the current price   -> bullish
 *   a target BELOW the current price   -> bearish
 *   a target with NO current price     -> bullish
 *
 * The last case is the convention, not a guess: "the first target is 78"
 * with no price to compare it against is still an upside target, because
 * "my target is 42" on a $45 stock is not how anyone states a downside
 * level.
 *
 * @param {{low: number, high: number}} target
 * @param {Array<{role: string, value: number, low: number, high: number}>} prices
 * @returns {string} 'bullish' | 'bearish' | ''
 */
function targetImpliesBias(target, prices) {
  const current = prices.find((price) => price.role === 'current');
  const targetLevel = (target.low + target.high) / 2;
  if (!current) return 'bullish';
  const reference = current.value;
  if (!Number.isFinite(reference) || reference <= 0) return 'bullish';
  if (targetLevel > reference) return 'bullish';
  if (targetLevel < reference) return 'bearish';
  return '';
}

/**
 * The runs of text a ticker owns.
 *
 * THE MODEL
 *
 * A transcript is a linear sequence, and a name belongs to the speech that
 * FOLLOWS it until the next name. So the transcript is scanned once, and
 * the text is cut into runs, each owned by one ticker.
 *
 *   "Let's talk about Tesla, TSLA. I am going to buy TSLA at 240,
 *    my target is 280. The stop loss is 225. Now for Nvidia, NVDA.
 *    I am bearish on it. The target is 120."
 *
 * is cut as:
 *
 *   TSLA  "Let's talk about Tesla, TSLA. I am going to buy TSLA at 240,
 *          my target is 280. The stop loss is 225."
 *   NVDA  "Now for Nvidia, NVDA. I am bearish on it. The target is 120."
 *
 * WHY NOT A WINDOW
 *
 * A window around each mention was tried first, and it blended two calls
 * into one: the TSLA entry price and the NVDA target ended up on the
 * same row, and the TSLA row carried NVDA's price. A wrong price on a
 * real holding is worse than a missing one, so the window was replaced.
 *
 * WHY THE CARRY-BACK IS OWNED BY THE NEW NAME
 *
 * The text BEFORE a ticker in its own segment belongs to that ticker:
 * "I am going to buy TSLA at 240" -- "I am going to buy" introduces TSLA.
 * So the first ticker of a segment owns the run-up to it.
 *
 * @param {Array<{text: string}>} segments
 * @param {Set<string>} lexicon
 * @returns {Array<{ticker: string, pieces: Array<{index: number, text: string}>, segmentStart: number, segmentEnd: number}>}
 */
function buildTickerRuns(segments, lexicon) {
  const runs = [];
  let open = null;

  const closeRun = () => {
    if (!open) return;
    open.text = open.pieces.map((piece) => piece.text).join(' ');
    runs.push(open);
    open = null;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const text = String(segments[index].text || '');
    const tickers = findTickers(text, lexicon);

    if (!tickers.length) {
      // A segment with no name continues the run that is open.
      if (open && text.trim()) {
        open.pieces.push({ index, text });
        open.segmentEnd = index;
      }
      continue;
    }

    for (let k = 0; k < tickers.length; k += 1) {
      // The first ticker of a segment owns the run-up to it; every other
      // ticker owns the text from itself to the next one.
      const pieceStart = k === 0 ? 0 : tickers[k].index;
      const pieceEnd = k + 1 < tickers.length ? tickers[k + 1].index : text.length;
      const piece = text.slice(pieceStart, pieceEnd);
      if (!piece.trim()) continue;

      if (!open || open.ticker !== tickers[k].ticker) {
        closeRun();
        open = {
          ticker: tickers[k].ticker,
          pieces: [],
          segmentStart: index,
          segmentEnd: index,
          text: '',
        };
      }
      open.pieces.push({ index, text: piece });
      open.segmentEnd = index;
    }
  }

  closeRun();
  return runs;
}

/**
 * Split a run where the speaker CHANGED HIS MIND.
 *
 * A run can hold two calls about one name: "I am bullish on TSLA" and
 * "actually I am going to short TSLA". Those are two calls at two
 * moments, and publishing them as one "mixed" row loses the timeline.
 *
 * So the run is split at a segment where the direction CONFLICTS with
 * the direction already established. A segment that adds no direction of
 * its own ("the stop loss is 225") does NOT split the run -- it belongs
 * to the call before it.
 *
 * @param {object} run
 * @returns {Array<object>} the runs, split where the direction changed
 */
function splitRunOnDirectionChange(run) {
  if (run.pieces.length < 2) return [run];

  const parts = [];
  let current = null;
  let established = '';

  for (const piece of run.pieces) {
    const candidate = pieceDirection(piece.text);

    if (candidate && established && candidate !== established) {
      parts.push(current);
      current = null;
    }
    if (candidate) established = candidate;

    if (!current) {
      current = {
        ticker: run.ticker,
        pieces: [],
        segmentStart: piece.index,
        segmentEnd: piece.index,
        text: '',
      };
    }
    current.pieces.push(piece);
    current.segmentEnd = piece.index;
  }

  if (current) parts.push(current);
  return parts.map((part) => ({
    ...part,
    text: part.pieces.map((piece) => piece.text).join(' '),
  }));
}

/**
 * The direction a piece of text states, if any.
 *
 * An explicit direction word wins; an action that states a direction
 * ("going short") is the fallback.
 *
 * @param {string} text
 * @returns {string} 'bullish' | 'bearish' | ''
 */
function pieceDirection(text) {
  const bias = determineBias(text);
  if (bias.bias === 'bullish' || bias.bias === 'bearish') return bias.bias;
  if (bias.bias === 'mixed') return '';
  return actionBias(determineAction(text).action);
}

/**
 * Merge signals that are the SAME call seen through overlapping windows.
 *
 * A stream names a ticker, then keeps talking about it. Every mention
 * opens a window, and two mentions three segments apart produce two
 * windows that overlap -- and therefore two rows for one call. The
 * earlier version published three rows for one TSLA call, each with a
 * slightly different score, which made the aggregate report say TSLA
 * was called three times.
 *
 * Two signals are the SAME call when:
 *
 *   they are about the SAME ticker, and
 *   their segment windows OVERLAP, and
 *   they say the SAME thing -- the same bias and the same action
 *
 * The last condition matters: a speaker can change their mind about one
 * name inside a video, and "I am bullish NVDA" followed by "actually I am
 * shorting NVDA" is two calls, not one. Those must survive.
 *
 * The surviving row is the one with the MOST information -- the most
 * prices, then the highest confidence -- because that is the reading that
 * carries the most of the call. The evidence text of the merged row is
 * the union of the evidence, so nothing that was said is lost.
 *
 * @param {Array<object>} signals
 * @returns {Array<object>}
 */
function mergeOverlappingSignals(signals) {
  if (!Array.isArray(signals) || signals.length < 2) return signals || [];

  const byTicker = new Map();
  for (const signal of signals) {
    if (!byTicker.has(signal.ticker)) byTicker.set(signal.ticker, []);
    byTicker.get(signal.ticker).push(signal);
  }

  const merged = [];

  for (const group of byTicker.values()) {
    // The groups are in the order the signals were produced, which is the
    // order they were spoken in. Sorting by start index keeps that true
    // after a group is reordered by the merge below.
    const ordered = [...group].sort((a, b) => a.segment_start_index - b.segment_start_index);

    const kept = [];
    for (const signal of ordered) {
      const twin = kept.find((other) => isSameCall(other, signal));
      if (!twin) {
        kept.push({ ...signal });
        continue;
      }
      mergeInto(twin, signal);
    }
    merged.push(...kept);
  }

  // The signals come back out in the order they were spoken.
  return merged.sort((a, b) => a.event_time_sec - b.event_time_sec
    || a.segment_start_index - b.segment_start_index
    || a.ticker.localeCompare(b.ticker));
}

/**
 * Are these two signals the same call, seen through overlapping windows?
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isSameCall(a, b) {
  if (a.ticker !== b.ticker) return false;
  if (a.bias !== b.bias) return false;
  if (a.action !== b.action) return false;
  const overlap = Math.min(a.segment_end_index, b.segment_end_index)
    - Math.max(a.segment_start_index, b.segment_start_index);
  return overlap >= 0;
}

/**
 * Fold one signal into another, keeping the richer information.
 *
 * @param {object} target - the signal being kept
 * @param {object} extra - the signal being folded in
 * @returns {void}
 */
function mergeInto(target, extra) {
  const targetPrices = priceCount(target);
  const extraPrices = priceCount(extra);

  if (extraPrices > targetPrices) {
    target.entry_price = extra.entry_price;
    target.target_price_low = extra.target_price_low;
    target.target_price_high = extra.target_price_high;
    target.stop_price = extra.stop_price;
  }

  // The stronger reading wins the score, whichever row it came from.
  if (extra.confidence_score > target.confidence_score) {
    target.confidence_score = extra.confidence_score;
    target.confidence_label = extra.confidence_label;
  }
  if (!target.horizon_text && extra.horizon_text) {
    target.horizon_text = extra.horizon_text;
  }

  // The window grows to cover both, and the evidence is the union -- so
  // nothing that was said is lost by the merge.
  target.segment_start_index = Math.min(target.segment_start_index, extra.segment_start_index);
  target.segment_end_index = Math.max(target.segment_end_index, extra.segment_end_index);
  target.evidence_text = mergeEvidence(target.evidence_text, extra.evidence_text);
}

/**
 * How many prices does a signal carry?
 *
 * @param {object} signal
 * @returns {number}
 */
function priceCount(signal) {
  let count = 0;
  if (signal.entry_price !== null && signal.entry_price !== undefined) count += 1;
  if (signal.target_price_low !== null && signal.target_price_low !== undefined) count += 1;
  if (signal.stop_price !== null && signal.stop_price !== undefined) count += 1;
  return count;
}

/**
 * Two evidence texts, joined without repeating the shared part.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function mergeEvidence(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (right.includes(left)) return right;
  if (left.includes(right)) return left;
  return `${left} ${right}`;
}

/**
 * Extract the trade signals from a transcript.
 *
 * @param {object} options
 * @param {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null}>} options.segments
 * @param {Set<string>} options.lexicon - the allowed ticker set
 * @param {string} [options.videoId]
 * @param {number} [options.transcriptId]
 * @returns {Array<object>} the signals
 */
function extractSignals(options) {
  const segments = Array.isArray(options.segments) ? options.segments : [];
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set(options.lexicon || []);
  if (!segments.length || !lexicon.size) return [];

  const runs = buildTickerRuns(segments, lexicon);
  const signals = [];

  for (const rawRun of runs) {
    // A run can hold two calls about one name, if the speaker changed his
    // mind inside it. Those are two calls at two moments.
    for (const run of splitRunOnDirectionChange(rawRun)) {
      const windowText = run.text;
      if (!windowText.trim()) continue;

      const biasResult = determineBias(windowText);
      const actionResult = determineAction(windowText);
      const confidenceResult = determineConfidence(windowText);
      const horizon = determineHorizon(windowText);
      const prices = findPrices(windowText);

      const entry = prices.find((price) => price.role === 'entry');
      const target = prices.find((price) => price.role === 'target');
      const stop = prices.find((price) => price.role === 'stop');

      // The bias is the stronger of the readings: an explicit direction
      // word, or the direction the action implies. "I am bullish and I am
      // trimming" is bullish; "I am going to short it" is bearish without
      // the word ever appearing.
      let bias = biasResult.bias;
      let strength = biasResult.strength;
      if (bias === 'neutral') {
        bias = actionBias(actionResult.action) || 'neutral';
        strength = actionResult.strength;
      } else if (bias !== 'mixed' && actionBias(actionResult.action)
        && actionBias(actionResult.action) !== bias) {
        // The word and the action disagree: "bullish, so I sold". That is a
        // mixed signal, not a bullish one.
        bias = 'mixed';
        strength = Math.max(strength, actionResult.strength);
      }

      // A stated TARGET with no other direction is a bullish call. "The
      // first target is around 78" says the price is expected to REACH 78,
      // which is a claim that it goes UP.
      //
      // This is not a guess about the speaker's intent: a target is by
      // definition a price the price is expected to move TOWARD, and the
      // direction of the move is what the target's position implies.
      if (bias === 'neutral' && target) {
        const implied = targetImpliesBias(target, prices);
        if (implied) {
          bias = implied;
          strength = 0.6;
        }
      }

      // A signal needs a DIRECTION. A bare action with no direction is not
      // a call: "I sold TQQQ last week" has an action and a ticker and no
      // opinion about where it is going, and "I am buying groceries" is not
      // a trade at all.
      //
      // The one exception is an action that IS a direction: "going short",
      // "going long" and "selling" all state which way the speaker expects
      // the price to move, so they carry their own bias.
      if (bias === 'neutral' && !actionImpliesDirection(actionResult.action)) continue;

      // History is not a call, and a disclaimer is not a call.
      if (isHistorical(windowText) && !actionResult.action) continue;
      if (isDisclaimer(windowText)) continue;

      const { score, label } = scoreConfidence({
        strength,
        actionStrength: actionResult.strength,
        confidenceLevel: confidenceResult.level,
        hasPrice: Boolean(entry || target || stop),
      });

      const evidenceText = windowText.replace(/\s+/g, ' ').trim();

      signals.push({
        video_id: options.videoId || '',
        transcript_id: options.transcriptId || null,
        segment_start_index: run.segmentStart,
        segment_end_index: run.segmentEnd,
        event_time_sec: Number(segments[run.segmentStart] ? segments[run.segmentStart].start_sec : 0) || 0,
        ticker: run.ticker,
        action: actionResult.action,
        bias,
        strength,
        confidence_label: label,
        confidence_score: score,
        entry_price: entry ? entry.value : null,
        target_price_low: target ? target.low : null,
        target_price_high: target ? target.high : null,
        stop_price: stop ? stop.value : null,
        horizon_text: horizon,
        rationale: summarizeRationale(windowText, run.ticker),
        evidence_text: evidenceText,
        parser_version: PARSER_VERSION,
      });
    }
  }

  return mergeOverlappingSignals(signals);
}

module.exports = {
  PARSER_VERSION,
  buildTickerRuns,
  determineAction,
  determineBias,
  determineConfidence,
  determineHorizon,
  extractSignals,
  findPrices,
  findTickers,
  isAmbiguousTokenAccepted,
  isDisclaimer,
  isHistorical,
  mergeOverlappingSignals,
  parsePrice,
  scoreConfidence,
  splitRunOnDirectionChange,
};
