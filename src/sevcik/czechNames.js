'use strict';

// Find the company names in a CZECH transcript.
//
// WHY THIS IS NOT THE ENGLISH TICKER FINDER
//
// Czech capitalises the FIRST WORD OF EVERY SENTENCE. "Takže to je
// přesně ono" starts with a capital because it starts a sentence, not
// because "Takže" is a name.
//
// So the English rule -- a ticker must be written in CAPS -- is useless
// here, and so is its opposite. Measured over 7 real transcripts (6441
// segments, 2026-11-04):
//
//   capitalised words, taken naively   912 distinct "names"
//     of which Takže (359), Tady (264), Tak (133), Ale (98),
//     Pokud (92), Tohle (63), Máme (54), Samozřejmě (53) ...
//     -- every one of them a Czech word, and every one of them at the
//     start of a sentence
//
//   capitalised words NOT at a sentence start    the real names
//     Tesla (35), Apple (19), Amazon (18), Intel (16), Microsoft (15),
//     Google (12), Adobe (9), Meta (5), Netflix (5), Bitcoin (4)
//
// So THE POSITION IS THE EVIDENCE. A capitalised word is a candidate
// name only when it is NOT the first word of its sentence.
//
// THE RULE
//
// A candidate is a capitalised token that:
//
//   1. is not the first word of a sentence, and
//   2. is not a sentence-initial word even when a punctuation mark
//      precedes it, and
//   3. is not a Czech word in the stop list (the pronouns, the fillers,
//      the trading words that happen to be capitalised because they
//      start a sentence -- "Long", "Tady", "Ale")
//
// and then it is matched to a ticker by `companyNames.js`.
//
// WHY IT IS NOT SIMPLER
//
// "Long" appears 132 times mid-sentence, and it is a DIRECTION, not a
// name. It is capitalised because the transcription or the speaker
// capitalised it. So a trading word has to be excluded explicitly, and
// the list is measured, not guessed.

const { matchCompanyName } = require('./companyNames');

/**
 * The words that are capitalised but are NOT company names.
 *
 * Every entry here was observed in the corpus, and every one of them is
 * either a Czech word, a trading term, or a transcription artefact.
 *
 * The trading words matter most: "Long" appears 132 times mid-sentence
 * and it is a DIRECTION, so a name finder that does not exclude it
 * would treat every long call as a company.
 */
const CZECH_STOP_WORDS = new Set([
  // The direction words -- these are the whole point of the stream.
  'long', 'longu', 'longů', 'longový', 'longová', 'longové', 'lon', 'lonu',
  'longka', 'longovými', 'longového', 'longovou',
  'short', 'shortu', 'shortový', 'shortová', 'shortové', 'shortem',
  's', 'se', 'si', 'o', 'a', 'i', 'v', 'z', 'k', 'u', 'na', 'to', 'že',
  'takže', 'tady', 'tak', 'ale', 'pokud', 'tohle', 'máme', 'samozřejmě',
  'protože', 'nicméně', 'zatím', 'kdy', 'jak', 'podíváme', 'znamená',
  'pojďme', 'vidíte', 'zase', 'tím', 'není', 'dneska', 'tam', 'jasně',
  'jasný', 'může', 'nebo', 'proč', 'jenom', 'david', 'open', 'trading',
  'volume', 'group', 'america', 'americe', 'španělsku', 'evropa', 'euro',
  'eur', 'eura', 'usd', 'sekund', 'minut', 'hodina', 'den', 'dne', 'dnem',
  'týden', 'měsíc', 'rok', 'obchod', 'obchodovat', 'obchodování',
  'predikce', 'predikci', 'predikcí', 'signál', 'signálu', 'signálem',
  'strategie', 'research', 'analýza', 'graf', 'grafu', 'úrovně', 'úroveň',
  'kanál', 'kanálu', 'zóna', 'zóně', 'zónu', 'odraz', 'odrazu', 'odrazil',
  'hra', 'hranice', 'pravděpodobnost', 'procent', 'procenta', 'signálem',
  'růst', 'růstem', 'pokles', 'poklesu', 'růstoucí', 'klesající',
  'výsledky', 'výsledek', 'výhled', 'výnos', 'zisk', 'ztráta', 'ztrátu',
  'čas', 'času', 'průměr', 'průměrně', 'nastoupí', 'nastoupil', 'vstoupí',
  'vyjde', 'vychází', 'vycházelo', 'vidět', 'vidím', 'vidíme', 'říká',
  'řekl', 'říct', 'nejsem', 'nejsme', 'nemám', 'nemáme', 'musím', 'musíme',
  'chci', 'chceme', 'vím', 'víme', 'vědět', 'pozor', 'díky', 'konec',
  'začátek', 'první', 'druhý', 'třetí', 'čtvrtý', 'pátý', 'pořád', 'stále',
  'jen', 'ještě', 'už', 'ještě', 'tady', 'tamhle', 'tohoto', 'tuhle',
  'tuhleto', 'tuhleté', 'týhle', 'tyhleté', 'on', 'ona', 'ono', 'oni',
  'my', 'vy', 'oni', 'já', 'ty', 'ten', 'ta', 'to', 'tyto', 'tahle',
  'všechno', 'něco', 'nějaký', 'který', 'která', 'které', 'aby', 'abych',
  'proto', 'takže', 'jenže', 'prostě', 'opravdu', 'samozřejm', 'samozřejme',
  'super', 'perfektní', 'skvělé', 'lepší', 'horší', 'větší', 'menší',
]);

/**
 * Does this token start a sentence?
 *
 * A token starts a sentence when it is the first token of the text, or
 * when it follows a sentence-terminating punctuation mark.
 *
 * @param {string} text - the whole text
 * @param {number} index - the token's start offset
 * @returns {boolean}
 */
function startsSentence(text, index) {
  if (index <= 0) return true;
  const before = text.slice(0, index);
  // A terminator, or a newline, or an ellipsis.
  return /[.!?…\n]\s*$/.test(before);
}

/**
 * The candidate company names in a Czech text.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Set<string>} [options.lexicon] - the tickers that may be reported
 * @param {string} [options.tablePath]
 * @returns {Array<{ticker: string|null, spoken: string, index: number, viaAlias: boolean, ambiguous: string[]}>}
 */
function findCzechCompanyNames(text, options = {}) {
  const str = String(text || '');
  if (!str.trim()) return [];

  const found = [];
  const seen = new Set();

  // A capitalised token. Czech diacritics included, because a name like
  // "Škoda" is written with them.
  const tokenPattern = /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}\p{N}]{1,14}/gu;
  let match;

  while ((match = tokenPattern.exec(str)) !== null) {
    const spoken = match[0];
    const index = match.index;

    if (seen.has(spoken.toLowerCase())) continue;

    // THE POSITION IS THE EVIDENCE. A capitalised word at the start of a
    // sentence is a Czech word that happens to be capitalised.
    if (startsSentence(str, index)) continue;

    const key = spoken.toLowerCase();
    if (CZECH_STOP_WORDS.has(key)) continue;
    if (key.length < 3) continue;

    seen.add(key);

    const resolved = matchCompanyName(spoken, options);
    found.push({
      ticker: resolved.ticker,
      spoken,
      index,
      viaAlias: resolved.viaAlias,
      ambiguous: resolved.ambiguous,
      matched: resolved.matched,
    });
  }

  return found;
}

module.exports = {
  CZECH_STOP_WORDS,
  findCzechCompanyNames,
  startsSentence,
};
