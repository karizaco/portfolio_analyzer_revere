'use strict';

// The vocabulary a spoken trade commentary is parsed with.
//
// WHY A SEPARATE FILE
//
// The signal extractor is the part of this pipeline that decides what a
// sentence MEANS, and every decision it makes is a claim about English
// trading language. Keeping the vocabulary here means the claims can be
// read, argued with, and measured in one place -- and it means a change to
// the vocabulary is a change to the extractor, which the parser_version on
// every signal row records.
//
// The vocabulary is deliberately CONSERVATIVE. A pattern that fires on
// ordinary speech turns every video into a wall of false signals, and a
// signal wall is worse than no signal: the report's whole value is that a
// signal means something.
//
// The one rule that is absolute: a pattern never fires without a TICKER in
// the same window. "I am bullish" says nothing about what to buy, so it is
// not a signal.

/**
 * Directional language, and the bias it implies.
 *
 * `weight` is how strongly the phrase implies the bias. The weights are
 * used for the confidence score, not for the bias itself -- a phrase with
 * weight 1.0 ("I am very bullish on X") is a stronger statement than one
 * with weight 0.5 ("I like X").
 */
const BULLISH_PATTERNS = [
  { pattern: /\b(?:i'?m|i am|we'?re|we are)\s+(?:very\s+|extremely\s+|really\s+)?(?:bullish|long|optimistic)\b/gi, weight: 1.0 },
  { pattern: /\bvery\s+bullish\b/gi, weight: 1.0 },
  { pattern: /\bbullish\b/gi, weight: 0.8 },
  { pattern: /\b(?:i\s+like|i\s+love|love)\s+(?:this|it)?\s*\b/gi, weight: 0.5 },
  { pattern: /\b(?:strong|high)\s+conviction\b/gi, weight: 1.0 },
  { pattern: /\b(?:going|going to go|gonna go)\s+long\b/gi, weight: 0.9 },
  { pattern: /\b(?:want to|plan to|looking to)\s+(?:be\s+)?long\b/gi, weight: 0.8 },
  { pattern: /\b(?:adding|added|add)\s+(?:to|more)\b/gi, weight: 0.8 },
  { pattern: /\b(?:buy|buying|picking up|accumulating)\s+(?:it|this|some|up)\b/gi, weight: 0.7 },
  { pattern: /\b(?:upside|upside potential|room to run)\b/gi, weight: 0.7 },
  { pattern: /\b(?:breakout|breaking out|bounce|rebound)\s+(?:is\s+)?(?:here|now|about to)\b/gi, weight: 0.6 },
  { pattern: /\bi\s+(?:think|believe|feel)\s+(?:this|it|that)\s+(?:is\s+)?(?:going to|will)\s+(?:go|run|higher)\b/gi, weight: 0.7 },
];

const BEARISH_PATTERNS = [
  { pattern: /\b(?:i'?m|i am|we'?re|we are)\s+(?:very\s+|extremely\s+|really\s+)?(?:bearish|short|bearish)\b/gi, weight: 1.0 },
  { pattern: /\bvery\s+bearish\b/gi, weight: 1.0 },
  { pattern: /\bbearish\b/gi, weight: 0.8 },
  { pattern: /\b(?:i\s+hate|i\s+dislike|don'?t\s+like|do not like)\s+(?:this|it)\b/gi, weight: 0.6 },
  { pattern: /\bgoing\s+short\b/gi, weight: 0.9 },
  { pattern: /\b(?:want to|plan to|looking to)\s+(?:be\s+)?short\b/gi, weight: 0.8 },
  { pattern: /\b(?:selling|sold|trimming|trimmed|exiting|exit)\s+(?:it|this|some|out|my|all)\b/gi, weight: 0.8 },
  { pattern: /\bdownside\b/gi, weight: 0.6 },
  { pattern: /\b(?:breakdown|breaking down|lower)\s+(?:is\s+)?(?:here|now|about to)\b/gi, weight: 0.6 },
  { pattern: /\bi\s+(?:think|believe|feel)\s+(?:this|it|that)\s+(?:is\s+)?(?:going to|will)\s+(?:go|run|lower|drop)\b/gi, weight: 0.7 },
  { pattern: /\bshort\s+it\b/gi, weight: 0.8 },
];

/**
 * The action a sentence describes, if any.
 *
 * The action is a SEPARATE question from the bias: "I would sell my TQQQ
 * here" is a bearish action on a bullish thesis (a trim), and "I am bullish
 * but I sold" is a bearish action with a bullish bias. Both readings are
 * possible, so both are recorded and the bias is what the report sorts on.
 */
const ACTION_PATTERNS = [
  // The "I am going to buy" form needs its own pattern: the general
  // "going to" form below does not cover the "I am" prefix, and "I am going
  // to buy" is the single most common way a trade intent is spoken.
  { action: 'buy', pattern: /\b(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+buy\b/gi, weight: 0.9 },
  { action: 'buy', pattern: /\b(?:i'?ll|i will|i want to|we'?ll|we will|we want to)\s+buy\b/gi, weight: 0.9 },
  { action: 'buy', pattern: /\b(?:going to|gonna)\s+buy\b/gi, weight: 0.8 },
  { action: 'buy', pattern: /\b(?:buying|purchasing|picking up|accumulating)\b/gi, weight: 0.7 },
  { action: 'buy', pattern: /\b(?:long|going long)\s+(?:it|this|that|here)\b/gi, weight: 0.7 },
  { action: 'add', pattern: /\b(?:i'?m|i am|we'?re|we are)?\s*(?:adding|added|add)\s+(?:to|more)\b/gi, weight: 0.8 },
  { action: 'add', pattern: /\b(?:scaling|scaling in|adding more)\b/gi, weight: 0.8 },
  { action: 'sell', pattern: /\b(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+sell\b/gi, weight: 0.9 },
  { action: 'sell', pattern: /\b(?:i'?ll|i will|i want to|we'?ll|we will)\s+sell\b/gi, weight: 0.9 },
  { action: 'sell', pattern: /\b(?:going to|gonna)\s+sell\b/gi, weight: 0.8 },
  { action: 'sell', pattern: /\b(?:selling|sold)\s+(?:it|this|some|my|all|out)\b/gi, weight: 0.7 },
  { action: 'trim', pattern: /\b(?:trimming|trimmed|trim\s+it|trim\s+some)\b/gi, weight: 0.8 },
  { action: 'short', pattern: /\b(?:shorting|short it|going short|want to short)\b/gi, weight: 0.9 },
  // "I am going to short NVDA" -- the same construction as "going to buy",
  // and without it the single most direct way of saying a bearish call
  // reads as no call at all.
  { action: 'short', pattern: /\b(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+short\b/gi, weight: 0.9 },
  { action: 'short', pattern: /\b(?:i'?ll|i will|i want to|we'?ll|we will)\s+short\b/gi, weight: 0.9 },
  { action: 'short', pattern: /\b(?:going to|gonna)\s+short\b/gi, weight: 0.8 },
  { action: 'cover', pattern: /\b(?:covering|cover it|covered)\b/gi, weight: 0.8 },
  { action: 'hold', pattern: /\b(?:holding|keeping|keeping it|not selling)\b/gi, weight: 0.6 },
  { action: 'watch', pattern: /\b(?:watching|watch for|watching for|keeping an eye)\b/gi, weight: 0.5 },
];

/**
 * Words that mark a stated CONFIDENCE level.
 *
 * The confidence of a signal is not the model's opinion of the speaker -- it
 * is the strength of the language the speaker used. "I am very bullish"
 * states more than "maybe I like it", and the report needs to be able to
 * tell those apart.
 */
const CONFIDENCE_PATTERNS = [
  { level: 'high', weight: 1.0, pattern: /\b(?:very\s+confident|high\s+conviction|strong\s+conviction|very\s+bullish|very\s+bearish|absolutely|definitely|certainly)\b/gi },
  { level: 'high', weight: 0.9, pattern: /\b(?:i\s+am\s+confident|i'?m\s+confident|confident\s+that)\b/gi },
  { level: 'medium', weight: 0.6, pattern: /\b(?:fairly\s+confident|pretty\s+confident|moderately)\b/gi },
  { level: 'low', weight: 0.3, pattern: /\b(?:maybe|perhaps|possibly|might|not\s+sure|unsure|i\s+think|i\s+guess|if\s+i\s+had\s+to\s+guess)\b/gi },
];

/**
 * The horizon of a call, when one is stated.
 *
 * `specificity` breaks the tie when two horizons are both stated. It is
 * NOT the order the patterns are declared in, because that order is not
 * the order the words appear in:
 *
 *   "Let's talk about Tesla today. ... Over the next few days, this is a
 *    swing trade."
 *
 * A first-match-wins search read "today" and called it intraday, while
 * the call was explicitly a swing. "swing trade" and "long term" name a
 * horizon; "today" only says when the speaker is speaking, and a stream
 * is always spoken today.
 */
const HORIZON_PATTERNS = [
  // Explicit horizons -- the speaker named the horizon.
  { horizon: 'position', specificity: 0.9, pattern: /\b(?:long[- ]term|for\s+the\s+long\s+term|hold\s+this|over\s+the\s+next\s+months?|position\s+trade)\b/gi },
  { horizon: 'swing', specificity: 0.9, pattern: /\b(?:swing\s+trade|swing\s+setup|over\s+the\s+next\s+(?:few\s+)?(?:days|week|weeks))\b/gi },
  { horizon: 'intraday', specificity: 0.9, pattern: /\b(?:intraday|by\s+the\s+close|before\s+the\s+close|this\s+session|today'?s\s+trade)\b/gi },

  // Weaker horizons -- the speaker said when, not how long.
  { horizon: 'intraday', specificity: 0.5, pattern: /\b(?:today|in\s+the\s+day|this\s+week)\b/gi },
  { horizon: 'swing', specificity: 0.5, pattern: /\b(?:swing|next\s+day|tomorrow)\b/gi },
];

/**
 * Price roles, and the words that introduce them.
 *
 * The role is what makes a price usable. "$45" after "target" is a target;
 * "$45" after "entry" is an entry. A bare "$45" next to a ticker is a price
 * with no role, and it is NOT recorded as an entry -- guessing a role would
 * put a wrong number in a portfolio report, and a wrong number in a
 * portfolio report is worse than a missing one.
 */
const PRICE_ROLES = [
  { role: 'entry', pattern: /\b(?:entry|entry\s+point|buy\s+point|buying\s+point|buy\s+at|buy\s+around|buy\s+below|buy\s+under|entering\s+at|get\s+in\s+at)\b/gi },
  { role: 'target', pattern: /\b(?:target|price\s+target|tp\b|take\s+profit|taking\s+profit|goal\s+is|aiming\s+for|looking\s+for|upside\s+target)\b/gi },
  { role: 'stop', pattern: /\b(?:stop|stop\s+loss|stop\s+at|invalidation|invalidat\w*|breakdown\s+below|below\s+which)\b/gi },
  { role: 'support', pattern: /\b(?:support|support\s+level|holding\s+above|bounce\s+off)\b/gi },
  { role: 'resistance', pattern: /\b(?:resistance|resistance\s+level|breaking\s+above|through\s+the\s+level)\b/gi },
];

/**
 * The construction "buy it at 45".
 *
 * The keyword list above cannot catch this on its own, because the words
 * between the verb and the number are the TICKER: "I am going to buy TQQQ
 * at 75" has no "buy at" in it -- there is "buy TQQQ at".
 *
 * So the whole construction is matched as one thing: a buy verb, then a
 * short run of words, then "at", then the number. The run of words is
 * bounded so that the verb has to be the one that introduces THIS price.
 */
const BUY_AT_PRICE_PATTERN = /\b(?:buy|buying|purchas\w+|accumulating|picking\s+up|get|getting|long|entering|entry)\b[^.!?]{0,30}?\bat\b\s*$/i;

/**
 * The construction "it is trading at 45".
 *
 * This is the CURRENT price, and it is the reference a stated target is
 * compared against: "TQQQ is at 45, first target is 78" says the price is
 * expected to go UP.
 *
 * It is distinguished from the "buy at 45" construction by the VERB. A
 * buy construction is an entry; a trading construction is where the price
 * is now.
 */
const CURRENT_PRICE_PATTERN = /\b(?:trading\s+at|sitting\s+at|is\s+at|are\s+at|at\s+now|right\s+now|price\s+is|price\s+of)\b[^.!?]{0,20}?$/i;

/**
 * A price, as it is written in speech.
 *
 * Spoken prices come in several shapes:
 *   $45.50          with a dollar sign
 *   45.50           bare, with a decimal
 *   45              bare, whole
 *   $1,234          with a thousands separator
 *   45 to 48        a range
 *
 * A whole number without a decimal is ambiguous -- it is also a year, a
 * count, or a time. So a bare whole number only counts as a price when a
 * PRICE ROLE introduces it, and a price with a decimal or a dollar sign
 * counts on its own.
 */
const PRICE_TOKEN_PATTERN = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?|\d{1,3}(?:,\d{3})*\.\d{1,4}|\b\d{1,5}\b/g;

/**
 * Words that mean a number is NOT a price.
 *
 * These are the contexts in which a number is a count, a year, a time, or a
 * percentage -- and a number in one of them is never recorded as an entry
 * or a target.
 *
 * The test is on the word IMMEDIATELY BEFORE the number, not on the words
 * anywhere before it. A wider window gives false positives on ordinary
 * speech: "I am going to buy at 75" contains "am", and "am" is in this
 * list because "10 am" is a time -- but "I am" is not.
 */
const NON_PRICE_CONTEXT = /\b(?:percent|pct|per\s+cent|am|pm|ocf|ytd|day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|second|seconds|cpm|apm|volume|shares?|oz|ounce)\b/i;

/**
 * A range of prices, as it is written: "45 to 48", "45-48", "$45 - $48".
 *
 * BOTH numbers are captured. The lower one is group 1 and the upper one is
 * group 2, so a caller can tell which end of the range it is holding.
 */
const PRICE_RANGE_PATTERN = /(\$?\d{1,5}(?:\.\d{1,4})?)\s*(?:to|-|–|—)\s*(\$?\d{1,5}(?:\.\d{1,4})?)/i;

/**
 * How many segments around a ticker mention are read as part of the same
 * thought.
 *
 * Spoken commentary spreads a single idea over a couple of sentences:
 * "So let's talk about TQQQ. I think the first target is around 78. If it
 * breaks out I'm going to add." The price is three segments after the
 * ticker, so a window of one would find the ticker and never the price.
 */
const WINDOW_SEGMENTS = 2;

/**
 * The minimum number of segments a window must span to be considered.
 */
const MIN_WINDOW_SEGMENTS = 1;

/**
 * The plausible price range for a US equity.
 *
 * A price outside this is a number that was not a price -- a time, a year,
 * a quantity of something -- and recording it would put a nonsense entry
 * level into a portfolio report.
 */
const MIN_PRICE = 0.5;
const MAX_PRICE = 100000;

/**
 * English words that are ALSO plausible ticker shapes.
 *
 * The seed lexicon contains ON, BE, ARM, NET and TAN -- all real tickers,
 * and all words a speaker uses constantly. A lexicon hit alone is therefore
 * not enough: a token from this list has to be written in CAPS in the
 * transcript to count, because that is how a ticker is written and how a
 * word is not.
 *
 * This list is separate from the lexicon on purpose: it says nothing about
 * which tickers are real, only about which words are ambiguous.
 */
const AMBIGUOUS_TICKER_WORDS = new Set([
  'ON', 'BE', 'ARM', 'NET', 'TAN', 'IT', 'IN', 'IS', 'BE', 'DO', 'GO',
  'NO', 'SO', 'AT', 'BY', 'IF', 'AN', 'AS', 'OR', 'MY', 'WE', 'US', 'HE',
  'AM', 'UP', 'NOW', 'ALL', 'ANY', 'BIG', 'BUY', 'SELL', 'HOLD', 'GET',
  'SET', 'TOP', 'NEW', 'OLD', 'YES', 'MAN', 'WAR', 'CASH', 'FUND', 'TECH',
  'BANK', 'CAT', 'DOG', 'BOX', 'KEY', 'MAP', 'ONE', 'TWO', 'TEN', 'DAY',
  'WEEK', 'YEAR', 'LONG', 'SHORT', 'ADD', 'OUT', 'HI', 'LOW', 'WIN',
  'RUN', 'CAR', 'ICE', 'GAP', 'JAM', 'LOT', 'MAD', 'PAN', 'RAW', 'SAP',
  'SEA', 'VIA', 'ZEN', 'ZOO', 'BAD', 'BED', 'BIT', 'BUS', 'CAP', 'DIVE',
  'EPIC', 'FAST', 'FISH', 'FLY', 'GAS', 'GRID', 'HELP', 'IDEA', 'JAVA',
  'JUMP', 'KEEN', 'LAMP', 'LEAN', 'LOOP', 'MAIN', 'MINT', 'MOON', 'NICE',
  'OPEN', 'PACK', 'QUIT', 'RAID', 'RUSH', 'SAFE', 'TASK', 'VAST', 'VOTE',
  'WAVE', 'YARD', 'ZERO', 'ZONE', 'AD', 'AI', 'AR', 'EP', 'GM', 'IBM',
  'IT', 'LE', 'MU', 'ON', 'PG', 'SAP', 'T', 'TX', 'X',
]);

module.exports = {
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
  MIN_WINDOW_SEGMENTS,
  NON_PRICE_CONTEXT,
  PRICE_RANGE_PATTERN,
  PRICE_ROLES,
  PRICE_TOKEN_PATTERN,
  WINDOW_SEGMENTS,
};
