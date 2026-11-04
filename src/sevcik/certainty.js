'use strict';

// How CERTAIN the speaker is, read off the language he used.
//
// WHY THIS IS SEPARATE FROM THE SIGNAL EXTRACTOR
//
// The extractor asks "what did he CALL?". This module asks "how sure did
// he say it?". The two are different questions, and the second one is
// what makes a setup evaluable: a level he called with "velmi silný
// signál" is a different claim from a level he called with "nevím".
//
// THE VOCABULARY IS MEASURED, NOT GUESSED
//
// The corpus is 12 real streams, 10,847 segments. Every phrase below was
// counted in it, and the counts are the evidence that the phrase carries
// the meaning it is given here:
//
//   silný / silnější / silnou       55   "a stronger signal"
//   velmi silný / velmi silná        26   "very strong"
//   jasný / jasné                    68   "clear"  -- but 66 of the 68 are
//                                          fillers ("Jasně." = "Of course")
//   pravděpodobnost                  91   "probability"
//   procent (a number)              33   "percent"
//   stoprocent                       10   "one hundred percent"
//   podmíněný / podmíněná            14   "conditional"
//   50 na 50                         14   "even odds"
//   patov                            2   "dead heat"
//   nevím                            95   "I don't know"
//   jistota                           3   "certainty"
//
// WHY "JASNÝ" IS NOT A CONFIDENCE MARKER
//
// "Jasný" appears 68 times and 66 of them are the Czech filler "Jasně!"
// -- "Of course!" -- in chat replies and acknowledgements. Only two are
// about a signal. So the word is a certainty marker only when it is
// next to the trading vocabulary: "jasný signál", "jasný long".
//
// WHY "STOPROCENT" IS NOT CERTAINTY EITHER
//
// He says "stoprocentně" 10 times, and NINE of them are in a sentence
// that DISCLAIMS it:
//
//   "Není to žádná stoprocentní jistota, nikdy to nebyla. Je to jenom
//    počítání pravděpodobnosti."
//   ("It is not a 100% certainty, never was. It is only counting
//    probability.")
//
// So the word is checked for a negation, and a negated "stoprocent" is
// evidence of his actual position: he believes every call is a
// probability, not a certainty. That is the most honest statement in
// the corpus about how he himself frames his calls, and it belongs in
// the scale rather than being thrown away.
//
// THE SCALE
//
// Six levels, from the language he uses:
//
//   certain      "stoprocentně" (not negated), "jistota"
//   high         "velmi silný signál", "silnější signál", "obrovská
//                pravděpodobnost"
//   conditional  "podmíněný long" -- the call stands but only under a
//                condition
//   even         "50 na 50", "patová" -- he says it is a coin flip
//   low          "nevím", "asi", "pravděpodobně"
//   unknown      nothing said -- the call carried no certainty language
//
// CONDITIONAL IS NOT WEAKER THAN EVEN
//
// A conditional call ("if it holds this level, long") is a WEAKER claim
// than an even-odds call ("it's 50/50") in one sense -- it is gated --
// but it is a MORE ACTIONABLE one: the speaker has stated exactly what
// he is waiting for. And the corpus shows he uses "podmíněný" as the
// DEFAULT form of a live setup, not as an apology for a weak one:
// "Takže to 10 Amazon nevypadá špatně, pokud se dostane nad tuto úroveň,
// Long. Prvikce je Long, podmíněná, pokud se dostane nad tuhletu horní
// hranu kanálu."
//
// So "conditional" is its own level rather than a point on a scale
// between high and low. A scale that forced it onto that line would
// have to call it either better or worse than a coin flip, and the
// corpus does not support either.
//
// CERTAINTY IS NOT DIRECTION
//
// "nevím" appears 95 times, and most of them are about the DIRECTION
// ("nevím, kam půjdou akcie" -- "I don't know where the stocks will
// go"), not about the strength of a call. So a "nevím" lowers the
// certainty of the DIRECTION it sits next to, and the module reports
// that separately from the certainty of the setup as a whole.

/**
 * The certainty markers, with the level each one states.
 *
 * `specificity` breaks ties the same way `HORIZON_PATTERNS` does: two
 * markers of different strength in one sentence, and the more specific
 * one wins.
 */
const CERTAINTY_MARKERS = [
  // -- CERTAIN -------------------------------------------------------
  {
    level: 'certain',
    specificity: 1.0,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])stoprocent[\p{L}\p{N}]*/iu,
    note: '"stoprocentne" -- 100%. Checked for a negation: he also uses it to deny that any call is a certainty.',
  },
  {
    level: 'certain',
    specificity: 0.9,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])(?:jistot\w*|jist\w*)/iu,
    note: '"jistota" -- certainty. Rare (3 in the corpus) and often negated.',
  },

  // -- HIGH ----------------------------------------------------------
  {
    level: 'high',
    specificity: 0.9,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])(?:velmi\s+siln[\p{L}\p{N}]*|siln[\p{L}\p{N}]*\s+sign[aá]l|sign[aá]l\s+siln[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu,
    note: '"velmi silny signal" -- a very strong signal. 26 in the corpus.',
  },
  {
    level: 'high',
    specificity: 0.85,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])silnější(?![\p{L}\p{N}])/iu,
    note: '"silnejsi" -- STRONGER than before. The comparative says the setup is confirmed, not merely asserted.',
  },
  {
    level: 'high',
    specificity: 0.8,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])obrovsk[\p{L}\p{N}]*\s+pravděpodobn[\p{L}\p{N}]*|(?<![\p{L}\p{N}])pravděpodobn[\p{L}\p{N}]*\s+obrovsk[\p{L}\p{N}]*/iu,
    note: '"obrovska pravdepodobnost" -- an enormous probability.',
  },
  {
    level: 'high',
    specificity: 0.7,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])jasn[\p{L}\p{N}]*\s+(?:sign[aá]l|long|short|predikc\w*|setup\w*|kan[aá]l)(?![\p{L}\p{N}])/iu,
    note: '"jasny signal" -- a clear signal. Only counted next to the trading vocabulary: 66 of the 68 "jasny" are the filler "Jasne!".',
  },

  // -- CONDITIONAL ---------------------------------------------------
  {
    level: 'conditional',
    specificity: 0.8,
    kind: 'condition',
    pattern: /(?<![\p{L}\p{N}])podmín[\p{L}\p{N}]*/iu,
    note: '"podmineny" -- conditional. 14 in the corpus, and it is his default form for a live setup.',
  },

  // -- EVEN ----------------------------------------------------------
  {
    level: 'even',
    specificity: 0.8,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])50\s*(?:na|to)\s*50(?![\p{L}\p{N}])/iu,
    note: '"50 na 50" -- even odds. 14 in the corpus.',
  },
  {
    level: 'even',
    specificity: 0.75,
    kind: 'assertion',
    pattern: /(?<![\p{L}\p{N}])patov[\p{L}\p{N}]*/iu,
    note: '"patova" -- a dead heat.',
  },

  // -- LOW -----------------------------------------------------------
  {
    level: 'low',
    specificity: 0.7,
    kind: 'hedge',
    pattern: /(?<![\p{L}\p{N}])nevím(?![\p{L}\p{N}])/iu,
    note: '"nevim" -- I do not know. 95 in the corpus. It states the DIRECTION is unknown, not that the setup is weak.',
  },
  {
    level: 'low',
    specificity: 0.6,
    kind: 'hedge',
    pattern: /(?<![\p{L}\p{N}])pravděpodobně(?![\p{L}\p{N}])/iu,
    note: '"pravdepodobne" -- probably.',
  },
  {
    level: 'low',
    specificity: 0.55,
    kind: 'hedge',
    pattern: /(?<![\p{L}\p{N}])asi(?![\p{L}\p{N}])/iu,
    note: '"asi" -- approximately / probably. Common as a filler, so it is the weakest hedge.',
  },
  {
    level: 'low',
    specificity: 0.55,
    kind: 'hedge',
    pattern: /(?<![\p{L}\p{N}])myslím si(?![\p{L}\p{N}])/iu,
    note: '"myslim si" -- I think.',
  },
];

/**
 * The words that NEGATE a certainty marker.
 *
 * The measured case is the important one: "Není to žádná stoprocentní
 * jistota, nikdy to nebyla" -- "It is not a 100% certainty, never was".
 * Without this, the sentence would read as the strongest confidence in
 * the corpus.
 */
const NEGATION_PATTERNS = [
  /(?<![\p{L}\p{N}])(?:není|není|nejsem|nejsme|nikdy|žádn[\p{L}\p{N}]*|nebyl[\p{L}\p{N}]*|nebyla[\p{L}\p{N}]*|nebylo[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu,
];

/**
 * The certainty levels, in descending order of how much they claim.
 */
const CERTAINTY_LEVELS = ['certain', 'high', 'conditional', 'even', 'low', 'unknown'];

/**
 * A number that states a probability, with the number itself.
 *
 * "pravděpodobnost 40%" is a stated probability, and it is a fact about
 * the speech -- it is what the speaker said -- so it is recorded as
 * such rather than being folded into a band.
 */
const PROBABILITY_PATTERN = /(\d{1,3})\s*(?:%|procent(?:a|ech|ech)?)/i;

/**
 * Read the certainty out of a piece of text.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.allowNegatedCertain] - keep a negated
 *   "stoprocent" as a marker of the speaker's position (default true)
 * @returns {{
 *   level: string,
 *   confidence: number,
 *   marker: string,
 *   negated: boolean,
 *   probability: number|null,
 *   direction_uncertain: boolean,
 *   markers: Array<{level: string, marker: string, kind: string, negated: boolean}>,
 * }}
 */
function readCertainty(text, options = {}) {
  const { allowNegatedCertain = true } = options;
  const str = String(text || '');

  const markers = [];
  let probability = null;

  for (const entry of CERTAINTY_MARKERS) {
    const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
    const match = regex.exec(str);
    if (!match) continue;

    const negated = isNegated(str, match.index);
    // A negated "certain" marker is not certainty. It is the speaker
    // saying he does not believe in certainty -- which is a POSITION,
    // and it is reported, but it is not the highest band.
    if (negated && entry.level === 'certain') {
      markers.push({
        level: 'low',
        marker: match[0].trim(),
        kind: 'disclaimer',
        negated: true,
      });
      continue;
    }
    if (negated && !allowNegatedCertain) continue;

    markers.push({
      level: entry.level,
      marker: match[0].trim(),
      kind: entry.kind,
      negated,
      specificity: entry.specificity,
    });
  }

  const probMatch = PROBABILITY_PATTERN.exec(str);
  if (probMatch) {
    const value = Number(probMatch[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) probability = value;
  }

  // The STRONGEST marker wins, except that a negated certainty does not
  // beat an honest one.
  const ranked = [...markers].sort((a, b) => {
    const ai = CERTAINTY_LEVELS.indexOf(a.level);
    const bi = CERTAINTY_LEVELS.indexOf(b.level);
    if (ai !== bi) return ai - bi;
    return (b.specificity || 0) - (a.specificity || 0);
  });
  const best = ranked[0] || null;

  const level = best ? best.level : 'unknown';
  const negated = Boolean(best && best.negated);

  return {
    level,
    confidence: certaintyConfidence(level),
    marker: best ? best.marker : '',
    negated,
    probability,
    // "nevim kde" is about the DIRECTION, and it is the speaker's own
    // admission that he does not know which way it goes.
    direction_uncertain: /(?<![\p{L}\p{N}])nevím(?![\p{L}\p{N}])/i.test(str),
    markers,
  };
}

/**
 * The numeric weight of a certainty level, in [0, 1].
 *
 * The values are ORDINAL and not probabilities. "conditional" is not a
 * point between "high" and "even" -- it is its own thing -- so the
 * numbers are the order, and the gaps are not meaningful distances.
 *
 * @param {string} level
 * @returns {number}
 */
function certaintyConfidence(level) {
  // Spread the scale so "unknown" is not near "conditional", and a
  // conditional call (stated trigger) ranks above a coin-flip.
  switch (level) {
    case 'certain': return 0.95;
    case 'high': return 0.85;
    case 'conditional': return 0.72;
    case 'even': return 0.50;
    case 'low': return 0.28;
    case 'unknown': return 0.12;
    default: return 0.12;
  }
}

/**
 * Is the marker at this index negated?
 *
 * The negation has to be NEARBY -- in the same clause -- because a
 * negation three sentences away belongs to a different statement.
 *
 * @param {string} text
 * @param {number} index - the marker's start offset
 * @returns {boolean}
 */
function isNegated(text, index) {
  // The window: the 60 characters before the marker, stopping at a
  // SENTENCE boundary.
  //
  // A COMMA does not end the clause. The measured sentence is:
  //
  //   "Není to žádná stoprocentní jistota, nikdy to nebyla."
  //
  // and splitting on the comma would put "Není to žádná" in one clause
  // and "stoprocentní jistota" in the next -- so the negation would be
  // invisible, and the sentence would read as the strongest confidence
  // in the corpus. It is the strongest DISCLAIMER.
  //
  // A sentence boundary (a period, a question mark, an exclamation mark)
  // does end it: a negation in the previous sentence is not about this
  // one.
  const before = String(text || '').slice(Math.max(0, index - 60), index);
  const clause = before.split(/[.!?…\n]/).pop() || '';
  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(clause)) return true;
  }
  return false;
}

/**
 * The certainty of a SETUP, which is the strongest certainty stated
 * anywhere in the setup's own text.
 *
 * A setup is a piece of speech with several sentences, and it is
 * COMMON for a later sentence to qualify an earlier one ("I am bullish
 * on it... actually, I don't know where it goes from here"). So the
 * setup's certainty is the strongest marker in it, and the hedge is
 * recorded separately -- a setup that says "clear signal" and then
 * "I don't know" is a strong setup with an uncertain direction, and
 * collapsing the two would lose that.
 *
 * @param {string} text
 * @returns {object} the same shape as `readCertainty`
 */
function readSetupCertainty(text) {
  const single = readCertainty(text);
  if (single.markers.length <= 1) return single;

  // Take the strongest, but keep the hedges visible.
  const best = single.markers.reduce((acc, marker) => {
    if (!acc) return marker;
    const ai = CERTAINTY_LEVELS.indexOf(marker.level);
    const bi = CERTAINTY_LEVELS.indexOf(acc.level);
    if (ai < bi) return marker;
    if (ai > bi) return acc;
    return (marker.specificity || 0) > (acc.specificity || 0) ? marker : acc;
  }, null);

  const hedges = single.markers.filter((marker) => marker.kind === 'hedge');

  return {
    ...single,
    level: best.level,
    confidence: certaintyConfidence(best.level),
    marker: best.marker,
    negated: Boolean(best.negated),
    hedged: hedges.length > 0,
    hedges: hedges.map((hedge) => hedge.marker),
  };
}

module.exports = {
  CERTAINTY_LEVELS,
  CERTAINTY_MARKERS,
  PROBABILITY_PATTERN,
  certaintyConfidence,
  isNegated,
  readCertainty,
  readSetupCertainty,
};
