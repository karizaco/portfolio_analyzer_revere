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
const { sanitizePricesForTicker } = require('./priceSanity');
const { readCertainty, certaintyConfidence } = require('./certainty');


const { STRICT_TICKER_PATTERN } = require('../normalize/tickerExtraction');
const { collapseRollingCues, sourceIndexOf } = require('../transcript/transcriptNormalize');
const { findCzechCompanyNames } = require('./czechNames');
const { loadConfirmedNames, stemName, isDeniedSpokenStem } = require('./companyNames');

/**
 * The version of the extractor. It is written onto every signal row, so a
 * re-run with a changed parser can be told apart from the previous one.
 */
// 5 (2026-11-09): rolling YouTube caption cues are collapsed before the run
// model sees them; negation is scoped to its phrase; "I like it" weight
// reduced to 0.3; English swing-trade trigger/stop patterns added;
// pieceDirection has a minimum-strength gate.
const PARSER_VERSION = 'sevcik-signals-6';

// A phrase that reverses a direction. "Not bullish" is bearish, and the
// naive pattern match would read "bullish" and call it bullish.
const NEGATION_PATTERNS = [
  /\b(?:not|isn'?t|is\s+not|aren'?t|no\s+longer|don'?t|do\s+not|never)\s+(?:\w+\s+){0,2}?(bullish|bearish|optimistic|pessimistic|long|short)\b/gi,
];

// A phrase that marks a past-tense or hypothetical statement. "I was
// bullish on X" is history, not a call.
const HISTORICAL_PATTERNS = [
  /\b(?:i\s+was|i\s+had\s+been|we\s+were|used\s+to|previously|yesterday|last\s+week|i\s+closed\s+my\s+position\s+in)\b/gi,
  // Czech retrospective / review language -- a past call being graded, not a new one.
  /(?<![\p{L}\p{N}])(?:minule|minul[aáéý]|včera|předtím|dříve|před\s+týdnem|před\s+týdny)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:už\s+jsme\s+(?:to\s+)?říkal[ai]?|už\s+jsme\s+říkali|jak\s+jsme\s+říkali|říkali\s+jsme)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:predikce\s+(?:vyšl[aáo]|nevyšl[aáo]|byla\s+přesn[aá]|byla\s+velmi\s+přesn[aá]))(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:predikce\s+byla|tahle\s+ta\s+predikce\s+byla|byla\s+to\s+přesná\s+predikce)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:vyšla\s+(?:přesně|velmi\s+přesně|s\s+chlupama))(?![\p{L}\p{N}])/giu,
];

/**
 * Patterns that mark a claim as a RETROSPECTIVE review of an old prediction,
 * even when some forward language is also present.
 */
const RETROSPECTIVE_PATTERNS = [
  /(?<![\p{L}\p{N}])(?:predikce\s+(?:vyšl|nevyšl|zneplatn|byla\s+stará)|vyšla\s+přesně|nevyšla|zneplatněn)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:minule|už\s+jsme\s+(?:to\s+)?říkal)(?![\p{L}\p{N}])/giu,
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
 * TWO PATHS, AND BOTH ARE NEEDED
 *
 * The channel is Czech and the speaker says company NAMES -- "Tesla",
 * "Apple", "Amazon" -- not symbols. The symbol path below finds a symbol,
 * which works for the handful of times he says one out loud ("SPCX",
 * "NVDA", "PSX"). The NAME path finds the rest.
 *
 * Measured on the 12-stream corpus: the symbol path matched 25,136
 * tokens and produced ZERO signals, because the direction and price
 * vocabulary was English and the Czech speech matched none of it. The
 * name path matched 269 names across the same corpus.
 *
 * So the names come first, and the symbols are added for the tokens the
 * names did not already cover.
 *
 * WHY THE SYMBOL TOKENIZATION IS NOT DELEGATED
 *
 * `src/normalize/tickerExtraction.js`'s `STRICT_TICKER_PATTERN` accepts a
 * dotted suffix (`BRK.B`), so a token keeps its trailing period and then
 * fails the pattern -- "TQQQ." is not a ticker to it, and neither is
 * "SPY.". A transcript is full of sentences that END in a period, so
 * every ticker at the end of a sentence would be lost. So the period is
 * stripped here, and only the trailing one: "BRK.B" keeps its dot,
 * because that is part of the symbol.
 *
 * @param {string} text
 * @param {Set<string>} lexicon - the allowed ticker set
 * @param {object} [options]
 * @param {Set<string>|null} [options.confirmedSymbols] - the tickers that
 *   may be read as a SPOKEN SYMBOL. When given, a symbol token has to be
 *   in this set to count. The Sevcik source passes the confirmed table,
 *   because its lexicon has 10,485 tickers and one-letter SEC registrants
 *   match ordinary Czech words. When it is NOT given, every symbol in the
 *   lexicon counts -- which is the right behaviour for a small, curated
 *   lexicon.
 * @param {Function} [options.nameFinderFn] - optional replacement for the
 *   default Czech name finder. Receives `(text, { lexicon })` and returns
 *   an array of `{ ticker, index, ... }` objects in the same shape as
 *   `findCzechCompanyNames`. Use this to inject an English name finder for
 *   English-language sources (e.g. T3Live) where the Czech sentence-start
 *   exclusion rule would incorrectly drop names at sentence starts.
 * @returns {Array<{ticker: string, index: number}>}
 */
function findTickers(text, lexicon, options = {}) {
  const str = String(text || '');
  if (!str.trim()) return [];

  const found = [];
  const seen = new Set();

  // -- THE NAMES -----------------------------------------------------
  //
  // By default, use the Czech name matcher (position-based: a capitalised
  // word that is NOT the first word of its sentence is a candidate). An
  // alternative finder can be supplied via options.nameFinderFn for English
  // sources where the sentence-start exclusion is wrong (e.g. T3Live).
  const nameFinder = typeof options.nameFinderFn === 'function'
    ? options.nameFinderFn
    : findCzechCompanyNames;
  for (const name of nameFinder(str, { lexicon })) {
    if (!name.ticker) continue;
    if (seen.has(name.ticker)) continue;
    seen.add(name.ticker);
    found.push({ ticker: name.ticker, index: name.index });
  }

  // -- "JP MORGAN" IS JPMORGAN, NOT MORGAN STANLEY --------------------
  //
  // The name finder cannot form the pair, because its token pattern
  // starts with a capital followed by a lower-case letter and "JP" is
  // all capitals -- so "Morgan" alone reaches the confirmed row
  // `morgan -> MS`. Measured over the corpora: **82 of T3Live's 113 MS
  // signals** and 2 of Sevcik's 3 name "JP Morgan" (the Czech ASR
  // writes "GP Morgan").
  //
  // THE REMAP IS BY THE NAME IN THE TEXT, so it is right even when the
  // ticker was mis-resolved, and it belongs HERE -- in the shared
  // layer -- because the name resolution is a property of the NAME and
  // not of the source: a swing-trading show says "JP Morgan" too.
  //
  // It is NOT the broker's-attribution rule, and it must not be
  // confused with it. "Goldman Sachs looks like it could take off" is
  // the host's own call on the stock in a trading show, and 88 of
  // T3Live's GS signals are exactly that. Only the RESOLUTION is
  // wrong here, not the claim.
  if (/\b(?:jp\s*morgan|jpmorgan|gp\s*morgan)\b/i.test(str)) {
    for (const entry of found) {
      if (entry.ticker !== 'MS') continue;
      entry.ticker = 'JPM';
      seen.delete('MS');
      seen.add('JPM');
    }
  }

  // -- THE SYMBOLS ---------------------------------------------------
  //
  // A symbol has to be CONFIRMED as one, by the same curated table that
  // confirms a name. An unconfirmed symbol is not a symbol.
  //
  // This gate is not a nicety. The Sevcik lexicon has 10,485 tickers, and
  // without the gate the symbol path matched the SEC's one-letter and
  // two-letter registrants in ordinary Czech speech:
  //
  //   P   "předtím"   A   "a"    SE  "se"   EL  "el"   TAK  "tak"
  //
  // Measured on the corpus, 187 distinct symbols matched in three
  // videos, and the top of the list was M:906, E:778, A:629, V:558 --
  // every one of them a Czech letter or word, not a company.
  //
  // So the symbol path is restricted to the confirmed table, which is
  // the record of what was actually heard said as a symbol.
  const confirmedSymbols = options.confirmedSymbols instanceof Set
    ? options.confirmedSymbols
    : null;
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
    // THE SYMBOL PATH ALSO RESPECTS THE DENIED STEMS. A confirmed row
    // whose SPOKEN FORM is a Czech word -- "roku" -> ROKU, "eli" -> LLY
    // -- is in the confirmed-symbol set by its own spelling, and the
    // symbol path would otherwise publish it on every use of the word.
    if (isDeniedSpokenStem(token)) continue;
    if (isDeniedSpokenStem(upper)) continue;
    // The symbol itself has to be a CONFIRMED symbol, when the caller
    // has a confirmed set.
    if (confirmedSymbols && !confirmedSymbols.has(upper)) continue;
    // English auto-captions write a spoken ticker in capitals ("IWM",
    // "BHC") and ordinary words in sentence case. With a 10k lexicon and
    // no confirmed-symbol gate, "for" becomes FOR. A caller that sets
    // requireCapsSymbols keeps only tokens the transcript itself wrote
    // in capitals, and drops one-letter tokens (A, I, Q) that are words.
    if (options.requireCapsSymbols) {
      if (token.length < 2 || token !== token.toUpperCase()) continue;
    }
    // Acronyms the speech-to-text always writes in capitals and that are
    // ALSO tickers: "AI" (the theme, not C3.ai), "ATR" (the indicator, not
    // AptarGroup). The caller passes the list, because it is a property of
    // the language, not of the engine.
    if (options.symbolStoplist instanceof Set && options.symbolStoplist.has(upper)) continue;

    seen.add(upper);
    found.push({ ticker: upper, index: match.index });
  }

  return found.sort((a, b) => a.index - b.index);
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
 * The weight of a negated direction. "Not bullish" counts as bearish, but
 * weaker than the word "bearish" (0.8): it denies one direction more than
 * it asserts the other. So "not bullish ... very bullish" stays bullish.
 */
const NEGATED_DIRECTION_WEIGHT = 0.6;

/**
 * The negated direction phrases in a text, with their spans.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, negates: 'bullish'|'bearish'}>}
 */
function findNegatedDirections(text) {
  const str = String(text || '');
  const found = [];
  for (const pattern of NEGATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(str)) !== null) {
      const word = String(match[1] || '').toLowerCase();
      const negates = ['bullish', 'optimistic', 'long'].includes(word) ? 'bullish' : 'bearish';
      found.push({ start: match.index, end: match.index + match[0].length, negates });
    }
  }
  return found;
}

/**
 * The text with the given spans replaced by spaces (positions preserved).
 *
 * @param {string} text
 * @param {Array<{start: number, end: number}>} spans
 * @returns {string}
 */
function blankSpans(text, spans) {
  const chars = String(text || '').split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < chars.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
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
 * Is this window reviewing a past prediction rather than making a live call?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isRetrospective(text) {
  const str = String(text || '');
  if (isHistorical(str)) return true;
  return RETROSPECTIVE_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(str));
}

/**
 * @param {string} text
 * @returns {'forward'|'retrospective'}
 */
function claimKindFor(text) {
  return isRetrospective(text) ? 'retrospective' : 'forward';
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
  // A negated direction counts for the OTHER side, and ONLY the negated
  // words do. The earlier rule flipped the whole window whenever a negation
  // appeared anywhere in it, so "the picture is not bullish ... BHC is very
  // very very bullish" -- two statements about two names -- read as BEARISH
  // on BHC. Now "not bullish" is taken out of the text and scored as one
  // bearish phrase, and "very bullish" is still scored as bullish.
  const str = String(text || '');
  const negated = findNegatedDirections(str);
  const remaining = negated.length ? blankSpans(str, negated) : str;

  const bullish = scoreBullish(remaining);
  const bearish = scoreBearish(remaining);

  let bullScore = bullish.score;
  let bearScore = bearish.score;
  for (const phrase of negated) {
    if (phrase.negates === 'bullish') bearScore = Math.max(bearScore, NEGATED_DIRECTION_WEIGHT);
    else bullScore = Math.max(bullScore, NEGATED_DIRECTION_WEIGHT);
  }

  if (!bullish.matches && !bearish.matches && !negated.length) {
    return { bias: 'neutral', strength: 0 };
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
  const str = String(text || '');
  let best = { action: '', strength: 0, completed: false };
  for (const entry of ACTION_PATTERNS) {
    const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`;
    const regex = new RegExp(entry.pattern.source, flags);
    let match;
    let affirmed = false;
    while ((match = regex.exec(str)) !== null) {
      if (match[0] === '') { regex.lastIndex += 1; continue; }
      // "I wouldn't be buying", "not selling" -- the action is denied.
      if (isNegatedAction(str, match.index)) continue;
      affirmed = true;
      break;
    }
    if (!affirmed) continue;
    if (entry.weight > best.strength) {
      best = { action: entry.action, strength: entry.weight, completed: Boolean(entry.completed) };
    }
  }
  return best;
}

/**
 * Is the action that starts at `index` negated by the words just before it?
 *
 * English only: Czech negates with a prefix ("nekupuje"), which the action
 * patterns' own boundaries already refuse.
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isNegatedAction(text, index) {
  const before = text.slice(Math.max(0, index - 40), index);
  return /(?:\b(?:not|never|no\s+longer)|n't)\s+(?:\w+\s+){0,2}$/i.test(before);
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
 * A COMPLETED trade does not. "I sold it" is a trade that is over, and it
 * says nothing about where the price goes next -- the action is still
 * recorded, but it carries no direction.
 *
 * @param {string} action
 * @param {boolean} [completed] - the action was stated in the past tense
 * @returns {boolean}
 */
function actionImpliesDirection(action, completed = false) {
  if (completed) return false;
  return ['buy', 'add', 'sell', 'trim', 'short', 'cover'].includes(String(action || ''));
}

/**
 * The bias an action implies on its own.
 *
 * @param {string} action
 * @param {boolean} [completed] - the action was stated in the past tense
 * @returns {string} 'bullish' | 'bearish' | ''
 */
function actionBias(action, completed = false) {
  if (completed) return '';
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

  let score = conviction * 0.55;
  if (parts.hasPrice) score += 0.08;

  // Czech certainty vocabulary (same scale as setups) spreads the mass that
  // used to collapse almost everything into "medium".
  const czech = parts.czechCertainty || null;
  if (czech && czech.level && czech.level !== 'unknown') {
    const mapped = Number(czech.confidence);
    if (Number.isFinite(mapped)) {
      score = Math.max(score, mapped * 0.9);
      score = (score * 0.45) + (mapped * 0.55);
    }
  }

  // A stated English confidence CAPS/boosts the score.
  const statedLevel = parts.confidenceLevel || '';
  if (statedLevel === 'low') score = Math.min(score, 0.40);
  if (statedLevel === 'high') score = Math.min(1, Math.max(score, 0.78) + 0.05);
  if (statedLevel === 'medium') score = Math.max(score, 0.48);

  // Structural floor/ceiling when only a bare direction word is present.
  if (!statedLevel && !(czech && czech.level && czech.level !== 'unknown' && czech.level !== 'stated')) {
    score = Math.min(score, 0.58);
  }
  if (czech && czech.level === 'stated') {
    score = Math.max(0.34, Math.min(score, 0.50));
  }
  if (czech && czech.direction_uncertain) {
    score = Math.min(score, 0.36);
  }

  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));

  let label = 'low';
  if (score >= 0.70) label = 'high';
  else if (score >= 0.42) label = 'medium';

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
// How many ticker-less segments may trail a run before it is closed.
// Unbounded continuation produced multi-minute evidence blobs that mixed names.
const MAX_RUN_GAP_SEGMENTS = 6;
// Hard cap on segments owned by one run before a forced split.
const MAX_RUN_SEGMENTS = 14;

function buildTickerRuns(segments, lexicon, options = {}) {
  const runs = [];
  let open = null;
  let gap = 0;

  const closeRun = () => {
    if (!open) return;
    open.text = open.pieces.map((piece) => piece.text).join(' ');
    runs.push(open);
    open = null;
    gap = 0;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const text = String(segments[index].text || '');
    const tickers = findTickers(text, lexicon, options);

    if (!tickers.length) {
      // A short ticker-less tail may continue the open run; beyond that, close.
      if (open && text.trim()) {
        gap += 1;
        if (gap > MAX_RUN_GAP_SEGMENTS || open.pieces.length >= MAX_RUN_SEGMENTS) {
          closeRun();
        } else {
          open.pieces.push({ index, text });
          open.segmentEnd = index;
        }
      }
      continue;
    }
    gap = 0;

    for (let k = 0; k < tickers.length; k += 1) {
      // The first ticker of a segment owns the run-up to it; every other
      // ticker owns the text from itself to the next one.
      const pieceStart = k === 0 ? 0 : tickers[k].index;
      const pieceEnd = k + 1 < tickers.length ? tickers[k + 1].index : text.length;
      const piece = text.slice(pieceStart, pieceEnd);
      if (!piece.trim()) continue;

      if (!open || open.ticker !== tickers[k].ticker || open.pieces.length >= MAX_RUN_SEGMENTS) {
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
  // A change of mind is stated firmly. A WEAK reading -- "I like it" (0.3)
  // inside a short setup -- is not one; with one caption line per piece
  // (rolling cues collapsed) such readings split a single T3Live idea into
  // three fragments that then conflicted with each other.
  const bias = determineBias(text);
  if ((bias.bias === 'bullish' || bias.bias === 'bearish') && bias.strength >= SPLIT_MIN_STRENGTH) return bias.bias;
  if (bias.bias === 'mixed') return '';
  const action = determineAction(text);
  return action.strength >= SPLIT_MIN_STRENGTH ? actionBias(action.action, action.completed) : '';
}

/** The weakest direction reading that can split a run (see pieceDirection). */
const SPLIT_MIN_STRENGTH = 0.5;

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
  const rawSegments = Array.isArray(options.segments) ? options.segments : [];
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set(options.lexicon || []);
  if (!rawSegments.length || !lexicon.size) return [];

  // YouTube auto-captions repeat every line (see collapseRollingCues). Undo
  // that here, where every source reads its segments, and report segment
  // indices in the STORED numbering via source_index. A clean transcript
  // (Deepgram, manual) passes through unchanged.
  const segments = collapseRollingCues(rawSegments);

  const runs = buildTickerRuns(segments, lexicon, options);
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
      const prices = sanitizePricesForTicker(run.ticker, findPrices(windowText));

      const entry = prices.find((price) => price.role === 'entry');
      // Prefer explicit target; Czech streams often only mark generic levels.
      const target = prices.find((price) => price.role === 'target')
        || prices.find((price) => price.role === 'level')
        || prices.find((price) => price.role === 'resistance')
        || prices.find((price) => price.role === 'support');
      const stop = prices.find((price) => price.role === 'stop');

      // The bias is the stronger of the readings: an explicit direction
      // word, or the direction the action implies. "I am bullish and I am
      // trimming" is bullish; "I am going to short it" is bearish without
      // the word ever appearing.
      //
      // A COMPLETED action implies no direction at all: "I sold it" is a
      // trade that is over, so it cannot be the evidence for where the price
      // goes next.
      const actionDirection = actionBias(actionResult.action, actionResult.completed);
      let bias = biasResult.bias;
      let strength = biasResult.strength;
      if (bias === 'neutral') {
        bias = actionDirection || 'neutral';
        strength = actionResult.strength;
      } else if (bias !== 'mixed' && actionDirection && actionDirection !== bias) {
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
      if (bias === 'neutral' && !actionImpliesDirection(actionResult.action, actionResult.completed)) continue;
      // Mixed / unknown direction is speech, not a scorable prediction.
      if (bias === 'mixed') continue;

      // English history with no action is not a call. Czech retrospective
      // language is TAGGED via claim_kind rather than dropped -- otherwise
      // a single "minule" in the window deletes a live setup description.
      if (isHistorical(windowText) && !actionResult.action
        && !actionImpliesDirection(actionResult.action, actionResult.completed)) continue;
      if (isDisclaimer(windowText)) continue;

      const czechCertainty = readCertainty(windowText);
      const { score, label } = scoreConfidence({
        strength,
        actionStrength: actionResult.strength,
        confidenceLevel: confidenceResult.level,
        hasPrice: Boolean(entry || target || stop),
        czechCertainty,
      });

      const evidenceText = windowText.replace(/\s+/g, ' ').trim();

      const kind = claimKindFor(windowText);

      // Pure retrospective reviews are kept for speech-ledger analysis, but
      // tagged so market outcomes can ignore them.
      signals.push({
        video_id: options.videoId || '',
        transcript_id: options.transcriptId || null,
        segment_start_index: sourceIndexOf(segments, run.segmentStart),
        segment_end_index: sourceIndexOf(segments, run.segmentEnd),
        event_time_sec: Number(segments[run.segmentStart] ? segments[run.segmentStart].start_sec : 0) || 0,
        ticker: run.ticker,
        action: actionResult.action,
        bias,
        strength,
        claim_kind: kind,
        confidence_label: label,
        confidence_score: score,
        entry_price: entry ? entry.value : null,
        target_price_low: target ? target.low : null,
        target_price_high: target ? target.high : null,
        stop_price: stop ? stop.value : null,
        horizon_text: horizon,
        rationale: summarizeRationale(windowText, run.ticker),
        evidence_text: evidenceText,
        // THE VERSION IS THE CALLER'S TO STATE. The engine is shared by
        // every source, so the engine's own constant named only what the
        // SEVCIK vocabulary produced -- and the T3Live and Benzinga
        // extractors wrote their rows under it. That is not cosmetic: the
        // shared runner's purge deletes the rows of a superseded version,
        // so a mislabelled row is a row the purge cannot see.
        parser_version: options.parserVersion || PARSER_VERSION,
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
  claimKindFor,
  isHistorical,
  isRetrospective,
  mergeOverlappingSignals,
  parsePrice,
  scoreConfidence,
  splitRunOnDirectionChange,
};
