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
//
// THE CZECH VOCABULARY
//
// The channel is Czech, and the first version of this file was English
// only. Measured on the 12-stream corpus (10,847 segments), the English
// patterns fired on NOTHING:
//
//   bias      0 segments
//   action    2 segments ("hold")
//   horizon   0 segments
//
// So the extractor was reading Czech and understanding none of it. The
// Czech patterns below were built from the corpus, and every count is the
// number of segments the pattern fires on:
//
//   "do Longu" / "do Long"      89   the direction, and it is the DOMINANT
//                                   construction -- "půjde do Longu" is how
//                                   he states a bullish call
//   "do shortu" / "do Short"    49   the bearish construction
//   "poklesový"                  62   a falling channel -- the DIRECTION
//                                   is in the channel's slope
//   "rostoucí"                    4   a rising channel
//   "kanál"                     384   the LEVEL, and the thing he calls
//                                   a setup
//   "odraz"                             the bounce off a level
//   "zóna"                      33   the zone
//   "podmíněný"                  14   the conditional call
//
// THE TRANSCRIPTION WRITES "LONG" TWO WAYS
//
// The Czech audio renders "long" as "Long" and as "Lon" -- "to je 50 do
// Lon, 50 do shortu" -- and the transcript carries both spellings. So
// every direction pattern accepts "Lon" as well as "Long", because a
// pattern that only accepted one spelling would miss half the calls.
//
// WHAT HE DOES NOT SAY
//
// There is no "target" in this corpus. The word "cíl" (target) appears
// TWICE, and both are about a GOAL ("aby se to uměli sami bez země" --
// "so that they can learn it themselves without going to the ground"), not
// a price. And there is no "stop loss": "stop" appears 15 times, and 13
// of them are inside "stoprocentně" (one hundred percent) or in a
// metaphor about a red button.
//
// So the price roles are LEVELS, not entry/target/stop, and the role
// table below says so. That is the SPEAKER'S vocabulary, not a
// limitation of the parser: he says "if it holds this level", and
// inventing a target price he never stated would put a number into a
// portfolio report that the video does not support.

/**
 * Directional language, and the bias it implies.
 *
 * `weight` is how strongly the phrase implies the bias. The weights are
 * used for the confidence score, not for the bias itself -- a phrase with
 * weight 1.0 ("I am very bullish on X") is a stronger statement than one
 * with weight 0.5 ("I like X").
 */
const BULLISH_PATTERNS = [
  { pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)\s+(?:very\s+|extremely\s+|really\s+)?(?:bullish|long|optimistic)(?![\p{L}\p{N}])/giu, weight: 1.0 },
  { pattern: /(?<![\p{L}\p{N}])very\s+bullish(?![\p{L}\p{N}])/giu, weight: 1.0 },
  { pattern: /(?<![\p{L}\p{N}])bullish(?![\p{L}\p{N}])/giu, weight: 0.8 },
  // "I like it" is a WEAK bullish reading. Measured on the T3Live swing
  // corpus (1,021 occurrences) it is said about short setups as often as
  // long ones -- it rates the setup, not the direction -- so it must not be
  // able to cancel a stated trigger ("looking lower ... stop above").
  { pattern: /(?<![\p{L}\p{N}])(?:i\s+like|i\s+love|love)\s+(?:this|it)?\s*(?![\p{L}\p{N}])/giu, weight: 0.3 },
  { pattern: /(?<![\p{L}\p{N}])(?:strong|high)\s+conviction(?![\p{L}\p{N}])/giu, weight: 1.0 },
  { pattern: /(?<![\p{L}\p{N}])(?:going|going to go|gonna go)\s+long(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { pattern: /(?<![\p{L}\p{N}])(?:want to|plan to|looking to)\s+(?:be\s+)?long(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])(?:adding|add)\s+(?:to|more)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])(?:buy|buying|picking up|accumulating)\s+(?:it|this|some|up)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])(?:upside|upside potential|room to run)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])(?:breakout|breaking out|bounce|rebound)\s+(?:is\s+)?(?:here|now|about to)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])i\s+(?:think|believe|feel)\s+(?:this|it|that)\s+(?:is\s+)?(?:going to|will)\s+(?:go|run|higher)(?![\p{L}\p{N}])/giu, weight: 0.7 },

  // -- THE CZECH DIRECTION ------------------------------------------
  //
  // IMPORTANT: Czech word tails use \p{L}, never \w.
  // \w is ASCII-only even under the /u flag, so "poklesov\w*"
  // stops before the "ý" in "poklesový" and the whole pattern
  // fails. Measured 2026-11-06 on "máme poklesový kanál".
  //
  // "do Longu" is the construction, and it is the dominant one: 89
  // segments. The bare "Long" is much weaker, because he says "Long" as
  // a noun all the time -- "longový kanál" (a rising channel) is a
  // description of the CHART, not a call.
  { pattern: /(?<![\p{L}\p{N}])do\s+lon(?:gu|ů|em|g)?(?![\p{L}\p{N}])/giu, weight: 0.9 },
  // Chart-state / setup language that IS a direction (measured 2026-11-06).
  // "nachystaný do Lon", "tlačen do Longu", "v Longu", "longový kanál".
  { pattern: /(?<![\p{L}\p{N}])(?:nachystan\p{L}*|tlačen\p{L}*|tlačí)\s+do\s+lon(?:gu|ů|em|g)?(?![\p{L}\p{N}])/giu, weight: 0.85 },
  { pattern: /(?<![\p{L}\p{N}])(?:longov|lonov)\p{L}*\s+kan[aá]l\p{L}*/giu, weight: 0.65 },
  { pattern: /(?<![\p{L}\p{N}])(?:v|ve)\s+longu(?![\p{L}\p{N}])/giu, weight: 0.55 },
  { pattern: /(?<![\p{L}\p{N}])stoupajíc\p{L}*\s+kan[aá]l\p{L}*/giu, weight: 0.65 },

  { pattern: /(?<![\p{L}\p{N}])(?:půjde|pujde|půjdem|půjdu|jde|jdem|jdeme|jdou|pojde|pojdem)\s+do\s+lon(?:gu|ů|em|g)?(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])lo(?:ng|ngu|ngů)\s+(?:směr|strana|variant)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  // The channel's slope states the direction without the word "long":
  // "mám poklesový kanál" (a falling channel) is bearish, and it is 62
  // segments.
  { pattern: /(?<![\p{L}\p{N}])rostouc\p{L}*\s+kan[aá]l\p{L}*/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])rostouc\p{L}*\s+trh\p{L}*/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])(?:půjde|pujde|pojde)\s+n[ií]ž\w*/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])(?:prorazí|prorazi|průraz|prolom)\w*\s+n[ií]ž\w*/giu, weight: 0.7 },

  // -- THE ENGLISH SWING-TRADE STRUCTURE (T3Live) ---------------------
  //
  // A swing idea is stated as a TRIGGER and a STOP, and the direction is in
  // which side each is on: "long over 52, stop under this bar's low" or
  // "short under 158, stop over 178". Counted over 208 Actionable Swing
  // transcripts (2026-11-09, rolling cues collapsed):
  //
  //   long over / long above      445     short under / short below   490
  //   stop under / stop below    1620     stop over / stop above       832
  //   over that bar's high        150     under that bar's low         103
  //   higher lows                 108     lower highs / lower lows      94
  //   double bottom                70     double top                    69
  //   looking higher               28     looking lower                 31
  //
  // "I like it" (1,021) is NOT a direction here: he says it about short
  // setups as often as long ones, so the trigger and the stop decide.
  //
  // A bar trigger is only a trigger when it is not the stop: "stop under
  // this bar's low" belongs to a LONG.
  { pattern: /(?<![\p{L}\p{N}])long\s+(?:over|above)(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { pattern: /(?<![\p{L}\p{N}])(?:over\s+here\s+long|long\s+here)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])stop\s+(?:under|below)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<!stop\s)(?<![\p{L}\p{N}])(?:over|above)\s+(?:that|this|the)\s+bar'?s\s+high(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])looking\s+higher(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])higher\s+lows?(?![\p{L}\p{N}])/giu, weight: 0.5 },
  { pattern: /(?<![\p{L}\p{N}])double\s+bottom(?![\p{L}\p{N}])/giu, weight: 0.6 },
];

/**
 * A COMPLETED trade, in the past tense.
 *
 * WHY THIS IS SEPARATE FROM THE ACTION PATTERNS
 *
 * "I sold some" and "I'm selling some" are different claims. The first is a
 * trade that is DONE; the second is one being made now. The action patterns
 * deliberately match both -- the action itself is real either way, and the
 * report wants to know what the speaker did with the name.
 *
 * But the DIRECTION is different. "I sold some" says nothing about where the
 * price goes next; the trade is over. "I'm selling some" says the speaker
 * expects it down.
 *
 * Measured on the T3Live corpus (2026-11-09, 3,190 signals), 258 signals had
 * a completed sale as their ONLY direction evidence -- no live statement and
 * no forward-looking word -- and 144 of those were published as FORWARD claims
 * and scored as if they were predictions. The clearest one:
 *
 *   "I'm still in Tesla. Tesla did not give me a reason to get out of it.
 *    Tesla was a great trade. ... I used my tier system. I sold some."
 *
 * which was published as a bearish TSLA. The speaker was long, bullish about
 * the name, and describing a tiered exit.
 *
 * So a completed trade is a HISTORICAL marker: it does not establish a
 * direction, and it makes the window retrospective rather than forward.
 */
const COMPLETED_TRADE_PATTERNS = [
  // "I sold it", "I sold some", "they sold out"
  /(?<![\p{L}\p{N}])(?:i|we|he|she|they)\s+(?:sold|sold\s+out|sold\s+some|sold\s+all|sold\s+my|sold\s+it|sold\s+this)(?![\p{L}\p{N}])/giu,
  // "I trimmed it", "I exited", "I covered", "I bought it"
  /(?<![\p{L}\p{N}])(?:i|we|he|she|they)\s+(?:trimmed|trimmed\s+it|trimmed\s+some|exited|exited\s+it|covered|covered\s+it|bought|bought\s+it|bought\s+some|added|added\s+to)(?![\p{L}\p{N}])/giu,
];

/**
 * A trade that was DONE, stated in the past tense.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isCompletedTrade(text) {
  const str = String(text || '');
  return COMPLETED_TRADE_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(str));
}

const BEARISH_PATTERNS = [
  { pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)\s+(?:very\s+|extremely\s+|really\s+)?(?:bearish|short|bearish)(?![\p{L}\p{N}])/giu, weight: 1.0 },
  { pattern: /(?<![\p{L}\p{N}])very\s+bearish(?![\p{L}\p{N}])/giu, weight: 1.0 },
  { pattern: /(?<![\p{L}\p{N}])bearish(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])(?:i\s+hate|i\s+dislike|don'?t\s+like|do not like)\s+(?:this|it)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])going\s+short(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { pattern: /(?<![\p{L}\p{N}])(?:want to|plan to|looking to)\s+(?:be\s+)?short(?![\p{L}\p{N}])/giu, weight: 0.8 },
  // The past-tense forms ("sold", "trimmed") are NOT here: a completed
  // trade is history, and it does not state where the price goes next.
  // See COMPLETED_TRADE_PATTERNS. "exit" stays, because it is not reliably
  // past tense -- "I'm going to exit it" is a live statement.
  { pattern: /(?<![\p{L}\p{N}])(?:selling|trimming|exiting|exit)\s+(?:it|this|some|out|my|all)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])downside(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])(?:breakdown|breaking down|lower)\s+(?:is\s+)?(?:here|now|about to)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])i\s+(?:think|believe|feel)\s+(?:this|it|that)\s+(?:is\s+)?(?:going to|will)\s+(?:go|run|lower|drop)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])short\s+it(?![\p{L}\p{N}])/giu, weight: 0.8 },

  // -- THE CZECH DIRECTION ------------------------------------------
  //
  // "do shortu" is 49 segments, and the transcription writes it both
  // "shortu" and "short".
  { pattern: /(?<![\p{L}\p{N}])do\s+short(?:u|ů)?(?![\p{L}\p{N}])/giu, weight: 0.9 },
  // Falling channel = bearish (was wrongly in BULLISH_PATTERNS before 2026-11-06).
  { pattern: /(?<![\p{L}\p{N}])poklesov\p{L}*\s+kan[aá]l\p{L}*/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])klesajíc\p{L}*\s+kan[aá]l\p{L}*/giu, weight: 0.7 },

  { pattern: /(?<![\p{L}\p{N}])(?:půjde|pujde|půjdem|půjdu|jde|jdem|jdeme|jdou|pojde|pojdem)\s+do\s+short(?:u|ů)?(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])shortov\p{L}*\s+(?:směr|strana|variant|kan[aá]l\p{L}*)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  // "do shortu" and the falling channel are the same statement, and the
  // channel carries it on its own: "máme poklesový kanál, že pokud
  // neudrží" -- "we have a falling channel, that if it does not hold".
  { pattern: /(?<![\p{L}\p{N}])do\s+short(?:u|ů)?\s+pokud(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { pattern: /(?<![\p{L}\p{N}])(?:short\w*|short)\s+(?:variant|scénář\w*|scenar\w*)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  // A rejection of a level is bearish: "bylo odmítnuto" (it was
  // rejected).
  { pattern: /(?<![\p{L}\p{N}])(?:bylo\s+odmítnut\p{L}*|odmítnut\p{L}*\s+tahl\w*\s+z[oó]na)(?![\p{L}\p{N}])/giu, weight: 0.6 },

  // -- THE ENGLISH SWING-TRADE STRUCTURE (T3Live) ---------------------
  //
  // The mirror of the bullish block; the counts are listed there.
  // "a broken chart ... lower highs and lower lows" is how a bearish chart
  // is described on the shows (42 x "broken" in the swing corpus).
  { pattern: /(?<![\p{L}\p{N}])short\s+(?:under|below)(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { pattern: /(?<![\p{L}\p{N}])(?:under\s+here\s+short|short\s+here)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { pattern: /(?<![\p{L}\p{N}])stop\s+(?:over|above)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<!stop\s)(?<![\p{L}\p{N}])(?:under|below)\s+(?:that|this|the)\s+bar'?s\s+low(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])looking\s+lower(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { pattern: /(?<![\p{L}\p{N}])lower\s+(?:highs?|lows)(?![\p{L}\p{N}])/giu, weight: 0.5 },
  { pattern: /(?<![\p{L}\p{N}])double\s+top(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])(?:broken\s+chart|chart\s+is\s+broken|it'?s\s+broken|broken\s+as\s+hell)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { pattern: /(?<![\p{L}\p{N}])break(?:ing)?\s*down\s+(?:under|below)(?![\p{L}\p{N}])/giu, weight: 0.7 },
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
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+buy(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:i'?ll|i will|i want to|we'?ll|we will|we want to)\s+buy(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:going to|gonna)\s+buy(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:buying|purchasing|picking up|accumulating)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:long|going long)\s+(?:it|this|that|here)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { action: 'add', pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)?\s*(?:adding|add)\s+(?:to|more)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'add', pattern: /(?<![\p{L}\p{N}])added\s+(?:to|more)(?![\p{L}\p{N}])/giu, weight: 0.8, completed: true },
  { action: 'add', pattern: /(?<![\p{L}\p{N}])(?:scaling|scaling in|adding more)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+sell(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:i'?ll|i will|i want to|we'?ll|we will)\s+sell(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:going to|gonna)\s+sell(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:selling)\s+(?:it|this|some|my|all|out)(?![\p{L}\p{N}])/giu, weight: 0.7 },
  // "I sold it" is a COMPLETED trade. The action is still recorded -- the
  // report wants to know what the speaker did with the name -- but it is
  // history, so it does not imply a direction. See COMPLETED_TRADE_PATTERNS.
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:sold)\s+(?:it|this|some|my|all|out)(?![\p{L}\p{N}])/giu, weight: 0.7, completed: true },
  { action: 'trim', pattern: /(?<![\p{L}\p{N}])(?:trimming|trim\s+it|trim\s+some)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'trim', pattern: /(?<![\p{L}\p{N}])(?:trimmed)(?![\p{L}\p{N}])/giu, weight: 0.8, completed: true },
  { action: 'short', pattern: /(?<![\p{L}\p{N}])(?:shorting|short it|going short|want to short)(?![\p{L}\p{N}])/giu, weight: 0.9 },
  // "I am going to short NVDA" -- the same construction as "going to buy",
  // and without it the single most direct way of saying a bearish call
  // reads as no call at all.
  { action: 'short', pattern: /(?<![\p{L}\p{N}])(?:i'?m|i am|we'?re|we are)\s+(?:going to|gonna|about to)\s+short(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'short', pattern: /(?<![\p{L}\p{N}])(?:i'?ll|i will|i want to|we'?ll|we will)\s+short(?![\p{L}\p{N}])/giu, weight: 0.9 },
  { action: 'short', pattern: /(?<![\p{L}\p{N}])(?:going to|gonna)\s+short(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'cover', pattern: /(?<![\p{L}\p{N}])(?:covering|cover it)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'cover', pattern: /(?<![\p{L}\p{N}])covered(?![\\p{L}\\p{N}])/giu, weight: 0.8, completed: true },
  { action: 'hold', pattern: /(?<![\p{L}\p{N}])(?:holding|keeping|keeping it|not selling)(?![\p{L}\p{N}])/giu, weight: 0.6 },
  { action: 'watch', pattern: /(?<![\p{L}\p{N}])(?:watching|watch for|watching for|keeping an eye)(?![\p{L}\p{N}])/giu, weight: 0.5 },

  // -- THE CZECH ACTIONS --------------------------------------------
  //
  // He does not say "I am going to buy". He says what the setup IS, and
  // the setup IS a direction: "do Longu", "do shortu". So the Czech
  // actions are the setup verbs:
  //
  //   "mám tady predikci"     I have a prediction here   -> new
  //   "budeme čekat"          we will wait               -> watch
  //   "přidám"                I will add                 -> add
  //   "prodat"                to sell                    -> sell
  //   "odebrat"               to take off                -> trim
  //
  // The DIRECTION is not an action here -- it is the bias, and the two
  // are recorded separately, exactly as in English.
  // Measured 2026-11-06: he states a buy as "kupuje"/"dokupuje"/"kupovat"/
  // "sázím na" far more often than as "do Longu". Without these, a video
  // full of "Berkshire dokupuje Alphabet" and "jestli kupovat Google"
  // produced ZERO signals.
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:dokupuje|dokoupil|dokoupím|dokoupit|přikupuje|přikoupil)(?![\p{L}\p{N}])/giu, weight: 0.85 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:kupuje|koupil|koupím|koupit|kupovat|nakupuje|nakoupil|nakoupit)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:sázím|sází|vsadil|vsadím)\s+na(?![\p{L}\p{N}])/giu, weight: 0.75 },
  { action: 'buy', pattern: /(?<![\p{L}\p{N}])(?:budu\s+obchodovat|obchoduji|otevírám\s+(?:long|lon)|otevřel\s+(?:long|lon))(?![\p{L}\p{N}])/giu, weight: 0.7 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:prodává|prodal|prodám|prodat|prodávat|vyprodává|vyprodal)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:uzavírám|uzavřel|zavírám\s+pozici)(?![\p{L}\p{N}])/giu, weight: 0.75 },
  { action: 'short', pattern: /(?<![\p{L}\p{N}])(?:shortuje|shortnul|shortovat)(?![\p{L}\p{N}])/giu, weight: 0.85 },
  { action: 'watch', pattern: /(?<![\p{L}\p{N}])budeme\s+čekat(?![\p{L}\p{N}])/giu, weight: 0.5 },
  { action: 'watch', pattern: /(?<![\p{L}\p{N}])(?:počkám|pockam|počkáme|pockame|čekám|cekám|čekáme|cekame)(?![\p{L}\p{N}])/giu, weight: 0.5 },
  { action: 'add', pattern: /(?<![\p{L}\p{N}])(?:přidám|pridam|přidáme|pridame|dokupím|dokupim)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'sell', pattern: /(?<![\p{L}\p{N}])(?:prodat|prodám|prodame|prodej|prodat)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'trim', pattern: /(?<![\p{L}\p{N}])(?:odebrat|odberu|ubrat|uberu|částečně\s+prodat)(?![\p{L}\p{N}])/giu, weight: 0.8 },
  { action: 'hold', pattern: /(?<![\p{L}\p{N}])(?:držím|drzim|mám\s+držen\w*|nechám\s+držet)(?![\p{L}\p{N}])/giu, weight: 0.6 },
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
  { level: 'high', weight: 1.0, pattern: /(?<![\p{L}\p{N}])(?:very\s+confident|high\s+conviction|strong\s+conviction|very\s+bullish|very\s+bearish|absolutely|definitely|certainly)(?![\p{L}\p{N}])/gi },
  { level: 'high', weight: 0.9, pattern: /(?<![\p{L}\p{N}])(?:i\s+am\s+confident|i'?m\s+confident|confident\s+that)(?![\p{L}\p{N}])/gi },
  { level: 'medium', weight: 0.6, pattern: /(?<![\p{L}\p{N}])(?:fairly\s+confident|pretty\s+confident|moderately)(?![\p{L}\p{N}])/gi },
  { level: 'low', weight: 0.3, pattern: /(?<![\p{L}\p{N}])(?:maybe|perhaps|possibly|might|not\s+sure|unsure|i\s+think|i\s+guess|if\s+i\s+had\s+to\s+guess)(?![\p{L}\p{N}])/gi },

  // -- THE CZECH CONFIDENCE -----------------------------------------
  //
  // The stated confidence is the CZECH certainty scale, which is measured
  // in `certainty.js`. The patterns here are the ones that map onto the
  // extractor's three-level label.
  //
  //   high    "velmi silny signal", "silnejsi" -- a stronger signal
  //   medium  "pravdepodobne", "50 na 50" -- probable, or even odds
  //   low     "nevim" -- I do not know
  { level: 'high', weight: 1.0, pattern: /(?<![\p{L}\p{N}])(?:velmi\s+siln\w*\s+sign[aá]l|silnější\s+sign[aá]l|silnější)(?![\p{L}\p{N}])/gi },
  { level: 'high', weight: 0.8, pattern: /(?<![\p{L}\p{N}])jasn\w*\s+sign[aá]l(?![\p{L}\p{N}])/gi },
  { level: 'medium', weight: 0.6, pattern: /(?<![\p{L}\p{N}])pravděpodobn\w*(?![\p{L}\p{N}])/gi },
  { level: 'medium', weight: 0.6, pattern: /(?<![\p{L}\p{N}])50\s*(?:na|to)\s*50(?![\p{L}\p{N}])/gi },
  { level: 'low', weight: 0.3, pattern: /(?<![\p{L}\p{N}])nevím(?![\p{L}\p{N}])/gi },
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
  { horizon: 'position', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])(?:long[- ]term|for\s+the\s+long\s+term|hold\s+this|over\s+the\s+next\s+months?|position\s+trade)(?![\p{L}\p{N}])/gi },
  { horizon: 'swing', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])(?:swing\s+trade|swing\s+setup|over\s+the\s+next\s+(?:few\s+)?(?:days|week|weeks))(?![\p{L}\p{N}])/gi },
  { horizon: 'intraday', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])(?:intraday|by\s+the\s+close|before\s+the\s+close|this\s+session|today'?s\s+trade)(?![\p{L}\p{N}])/gi },

  // Weaker horizons -- the speaker said when, not how long.
  { horizon: 'intraday', specificity: 0.5, pattern: /(?<![\p{L}\p{N}])(?:today|in\s+the\s+day|this\s+week)(?![\p{L}\p{N}])/gi },
  { horizon: 'swing', specificity: 0.5, pattern: /(?<![\p{L}\p{N}])(?:swing|next\s+day|tomorrow)(?![\p{L}\p{N}])/gi },

  // -- THE CZECH HORIZONS --------------------------------------------
  //
  // He states a horizon in Czech:
  //
  //   "do týdne"     within a week
  //   "do dvou týdnů" within two weeks
  //   "do měsíce"   within a month
  //   "do týdnů"     over weeks
  //   "na příští týden" next week
  //   "dneska"      today
  //
  // The week count is parsed by a separate pattern, because "do týdne"
  // (one week) and "do tří týdnů" (three weeks) are the same phrase with
  // a number in it, and a pattern that only matched one of them would
  // report every horizon as a week.
  { horizon: 'intraday', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])(?:dneska|dnes|dnem\s+do\s+konce)(?![\p{L}\p{N}])/gi },
  { horizon: 'swing', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])(?:na\s+příští\s+týden|na\s+pristi\s+tyden|příští\s+týden|pristi\s+tyden)(?![\p{L}\p{N}])/gi },
  { horizon: 'swing', specificity: 0.8, pattern: /(?<![\p{L}\p{N}])do\s+(?:jednoho|dvou|tří|čtyř|pěti|šesti|sedmi|osmi|devíti|desíti)\s+(?:týdn\w*|dn\w*|měsíc\w*)(?![\p{L}\p{N}])/gi },
  { horizon: 'swing', specificity: 0.7, pattern: /(?<![\p{L}\p{N}])do\s+týdn\w*(?![\p{L}\p{N}])/gi },
  { horizon: 'position', specificity: 0.9, pattern: /(?<![\p{L}\p{N}])do\s+(?:jednoho|dvou|tří|čtyř|pěti|šesti|sedmi|osmi|devíti|desíti)\s+měsíc\w*/gi },
  { horizon: 'position', specificity: 0.7, pattern: /(?<![\p{L}\p{N}])do\s+měsíc\w*(?![\p{L}\p{N}])/gi },
  { horizon: 'position', specificity: 0.6, pattern: /(?<![\p{L}\p{N}])(?:dlouhodob\w*|investičn\w*\s+horizont\w*)(?![\p{L}\p{N}])/gi },
];

/**
 * Price roles, and the words that introduce them.
 *
 * The role is what makes a price usable. "$45" after "target" is a target;
 * "$45" after "entry" is an entry. A bare "$45" next to a ticker is a price
 * with no role, and it is NOT recorded as an entry -- guessing a role would
 * put a wrong number in a portfolio report, and a wrong number in a
 * portfolio report is worse than a missing one.
 *
 * THE CZECH CHANNEL HAS NO TARGETS
//
// Measured on the corpus: "cíl" (target) appears TWICE and both are about
// a GOAL, not a price. "stop" appears 15 times and 13 of them are inside
// "stoprocentně" (one hundred percent) or in a metaphor about a red
// button. There is no "vstup" (entry) price either -- the 6 occurrences
// are about "investiční vstup" (an investment entry) and "vstupní částky"
// (an entry amount), never a price to buy at.
//
// What he DOES say is a LEVEL, and it is said constantly:
//
//   "kanál"        384   the channel -- and its edges are the levels
//   "úroveň"              the level
//   "odraz"               the bounce off it
//   "zóna"          33   the zone
//   "hranice"             the edge
//   "podmíněná, pokud se dostane nad tuhletu horní hranu kanálu"
//     ("conditional, if it gets above this upper edge of the channel")
//
// So the role is LEVEL, and the level's ROLE is its own kind: an UPPER
// edge is a breakout level, a LOWER edge is a support level, and the
// direction the level implies is the call.
//
// The user said it directly: "levels, not targets -- yes, that is his
// problem, not yours". A target price he never stated must not appear in
// a portfolio report.
 */
const PRICE_ROLES = [
  { role: 'entry', pattern: /(?<![\p{L}\p{N}])(?:entry|entry\s+point|buy\s+point|buying\s+point|buy\s+at|buy\s+around|buy\s+below|buy\s+under|entering\s+at|get\s+in\s+at)(?![\p{L}\p{N}])/gi },
  { role: 'target', pattern: /(?<![\p{L}\p{N}])(?:target|price\s+target|tp(?![\p{L}\p{N}])|take\s+profit|taking\s+profit|goal\s+is|aiming\s+for|looking\s+for|upside\s+target)(?![\p{L}\p{N}])/gi },
  { role: 'stop', pattern: /(?<![\p{L}\p{N}])(?:stop|stop\s+loss|stop\s+at|invalidation|invalidat\w*|breakdown\s+below|below\s+which)(?![\p{L}\p{N}])/gi },
  { role: 'support', pattern: /(?<![\p{L}\p{N}])(?:support|support\s+level|holding\s+above|bounce\s+off)(?![\p{L}\p{N}])/gi },
  { role: 'resistance', pattern: /(?<![\p{L}\p{N}])(?:resistance|resistance\s+level|breaking\s+above|through\s+the\s+level)(?![\p{L}\p{N}])/gi },

  // -- THE SWING-TRADE TRIGGER AND STOP (English) -----------------------
  //
  // The swing shows state a trade as "long over 525, stop under 478": the
  // number after "over" is the TRIGGER the price has to clear, and the number
  // after "under" is where the idea is dead. They never say "entry" or "buy
  // at", so without these rows every one of those prices was dropped -- a
  // price with no role is not recorded.
  //
  // The trigger is recorded as an ENTRY, because that is what it is: the
  // price the position is taken at. The stop is a stop.
  //
  // The lookbehind keeps the two apart. "stop under 478" must be a stop, not
  // a short trigger, and "stop over 178" (the stop on a short) must be a stop
  // too. The trigger rows therefore refuse a price that "stop" introduced.
  { role: 'entry', pattern: /(?<!stop\s)(?<![\p{L}\p{N}])(?:long|buy|buying)\s+over(?![\p{L}\p{N}])/gi },
  { role: 'entry', pattern: /(?<!stop\s)(?<![\p{L}\p{N}])(?:short|sell|selling)\s+under(?![\p{L}\p{N}])/gi },
  { role: 'stop', pattern: /(?<![\p{L}\p{N}])stop\s+(?:under|below|over|above)(?![\p{L}\p{N}])/gi },

  // -- THE CZECH LEVELS ---------------------------------------------
  //
  // The UPPER edge of a channel is where a breakout is confirmed, and
  // the LOWER edge is where a support holds. He says which one he means
  // with "horní" (upper) and "dolní" (lower).
  { role: 'resistance', pattern: /(?<![\p{L}\p{N}])horní\s+(?:hran\w*\s+)?(?:kan[aá]l\w*|úrov[ěe]n\w*|hran\w*)/gi },
  { role: 'support', pattern: /(?<![\p{L}\p{N}])dolní\s+(?:hran\w*\s+)?(?:kan[aá]l\w*|úrov[ěe]n\w*|hran\w*)/gi },
  { role: 'support', pattern: /(?<![\p{L}\p{N}])(?:podp[oě]r\w*\s+)?(?:úrov[ěe]n\w*|úrovn\w*|hran\w*|zona\w*|z[oó]na)\s+(?:zespod\w*|níž\w*|dole)(?![\p{L}\p{N}])/gi },
  { role: 'resistance', pattern: /(?<![\p{L}\p{N}])(?:úrov[ěe]n\w*|úrovn\w*|hran\w*|zona\w*|z[oó]na)\s+(?:naho[oř]\w*|vyš\w*|vzh[oů]ru)(?![\p{L}\p{N}])/gi },
  { role: 'support', pattern: /(?<![\p{L}\p{N}])(?:nákupní\s+z[oó]na|z[oó]na\s+pro\s+n[aá]kup\w*)(?![\p{L}\p{N}])/gi },
  { role: 'resistance', pattern: /(?<![\p{L}\p{N}])(?:prodejní\s+z[oó]na)(?![\p{L}\p{N}])/gi },
  // The bounce itself: "odraz o této úrovni" (a bounce off this level).
  { role: 'support', pattern: /(?<![\p{L}\p{N}])odraz\w*\s+(?:o|od|na|z)\s+(?:t[ée]hle?\s*|t[ée]hl\w*\s+)?(?:[a-zěščřžýáíé]*\s+)?(?:úrov[ěe]n\w*|úrovn\w*|hran\w*|kan[aá]l\w*)/gi },
  { role: 'resistance', pattern: /(?<![\p{L}\p{N}])prolom\w*\s+(?:přes|skrz|za)\s+(?:t[ée]hle?\s*)?(?:úrov[ěe]n\w*|úrovn\w*|hran\w*)/gi },
  // A LEVEL, unqualified -- the generic case, and the one that fires
  // most. "odraz od úrovně 1334" (a bounce from the level of 1334).
  { role: 'level', pattern: /(?<![\p{L}\p{N}])(?:úrov[ěe]n\w*|úrovn\w*|hran\w*|z[oó]na\w*|kan[aá]l\w*|cena\w*)(?<![\p{L}\p{N}])(?:\s+(?:a\s+|pro\s+)?(?:t[ée]hle?\s*)?(?:úrov[ěe]n\w*|úrovn\w*|hran\w*|kan[aá]l\w*))*?/gi },
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
const BUY_AT_PRICE_PATTERN = /(?<![\p{L}\p{N}])(?:buy|buying|purchas\w+|accumulating|picking\s+up|get|getting|long|entering|entry)\b[^.!?]{0,30}?(?<![\p{L}\p{N}])at\b\s*$/i;

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
const CURRENT_PRICE_PATTERN = /(?<![\p{L}\p{N}])(?:trading\s+at|sitting\s+at|is\s+at|are\s+at|at\s+now|right\s+now|price\s+is|price\s+of)\b[^.!?]{0,20}?$/i;

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
const PRICE_TOKEN_PATTERN = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,4})?|\d{1,3}(?:,\d{3})*\.\d{1,4}|\b\d{1,5}(?![\p{L}\p{N}])/g;

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
const NON_PRICE_CONTEXT = /(?<![\p{L}\p{N}])(?:percent|pct|per\s+cent|am|pm|ocf|ytd|day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|second|seconds|cpm|apm|volume|shares?|oz|ounce)(?![\p{L}\p{N}])/i
  // The Czech words that sit in front of a number and mean it is not a
  // price. Measured on the corpus:
  //
  //   "50 na 50"        an even-odds statement
  //   "40%"             a probability
  //   "do týdne"        a horizon ("within a week")
  //   "5 procent"       a probability
  //
  // A number after "do týdne" is a WEEK COUNT, and recording it as a
  // price would put 5 into a portfolio report as an entry level.
  || /(?<![\p{L}\p{N}])(?:procent\w*|na\s+50|týdn\w*|měsíc\w*|let(?![\p{L}\p{N}])|letem|lety|hodin\w*|minut\w*|sekund\w*|bod\w*|bodů|čas\w*)\s*$/i;

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
