'use strict';

/**
 * David Monoszon's calls, read out of Czech.
 *
 * WHAT A READING IS
 *
 * He trades the INDEX FUTURES intraday and he does not publish a
 * position list and does not publish a size -- only "třetinovým size",
 * "malý size". So this is not another position source. What it is: a
 * TAPE of calls about indexes, sector ETFs and commodities, and those
 * calls can be SCORED against the proxy and against the index.
 *
 * THE HARD PART IS NOT THE SUBJECT, IT IS THE TENSE
 *
 * "long" and "short" are nouns in Czech and they do not conjugate, so
 * the TENSE of a call is carried by the verb around it. Measured over
 * his 4,500 messages, **179** carry a subject and a direction word in
 * the same sentence, and the rest of this module is about deciding which
 * of those 179 are about the FUTURE.
 *
 * The distinction that matters:
 *
 *   FORWARD       "pokud uvidím nástup kupců na spx 6700, tak se přidám"
 *                 "budu vyhledávat setup na short"
 *                 "XLP ... by mohl být pěkný mean reversion long"
 *   RETROSPECTIVE "Tenhle TLT long byl krásně docekany swing trade"
 *                 "dnes byl krásný long na GC"
 *                 "takže před CPI jsem přepnul na zlato"
 *
 * A retrospective call is not a prediction and is not scored. A forward
 * call is scored from the close on the day he wrote it.
 *
 * "BY" IS NOT A PAST TENSE
 *
 * "to by byl bearish scénář" is a SCENARIO, not a fact, and the same
 * goes for "abych změnil na bearish". Czech writes the conditional
 * with "by", so a past form right after a "by" is conditional and the
 * rule says so. Without that, nine of his best calls land in the
 * retrospective bucket.
 *
 * A REGIME IS NOT A CALL
 *
 * "v bull marketu nečekám až na tick na target", "po ukončení bear
 * marketu 2022 byl první pullback", "takto šlo koupit čínu po ukončení
 * bear marketu". A "bull market" or a "bear run" is a description of a
 * regime or of history, and it carries no call. So a direction word
 * followed by "market", "run" or "cyklus" is skipped.
 *
 * "SHORT COVERING" IS A SQUEEZE, AND A SQUEEZE IS UP
 *
 * "short covering rally" is a rally caused by shorts covering, so it is
 * BULLISH -- and the two words must be read together, because "short"
 * on its own says the opposite.
 *
 * THE LEVEL HE NAMED IS KEPT, AND IT IS NOT THE ENTRY
 *
 * "abych změnil na bearish, potřeboval bych vidět spx uzavírat pod
 * 6550" names a level. The project's price model enters at the CLOSE
 * on the message's date, so the level is recorded as the evidence of
 * what he was watching and the close is the entry. Saying so is the
 * point: a reader who wants the level has it.
 */

const { SUBJECT_PATTERNS } = require('./subjects');

/**
 * The BULLISH vocabulary, and the case endings Czech adds to it.
 *
 * "long" -> "longu" ("do longu"), "longa", "longem".
 */
const BULLISH_WORDS = [
  'long', 'longu', 'longa', 'longem', 'longí', 'longů',
  'bullish', 'bull', 'bullí',
  'koupit', 'koupím', 'kupce', 'kupců', 'nakupovat',
  'nakoupit', 'růst', 'růstu', 'růstem', 'vzestup', 'výš', 'výše',
  'přidám', 'přidat', 'upside',
];

/** The BEARISH vocabulary, with the case endings. */
const BEARISH_WORDS = [
  'short', 'shortu', 'shorta', 'shortem', 'shortí', 'shortů',
  'bearish', 'bear', 'medvědí',
  'prodat', 'prodávat', 'prodejci', 'prodejů', 'pokles', 'poklesu',
  'poklesem', 'shortovat', 'zkrátit',
];

/**
 * The words that make a direction word a REGIME rather than a call.
 *
 * "bull marketu", "bear marketu", "bull run", "bear run", "bull
 * cyklus" -- a description of the tape, not a call on it.
 */
const REGIME_AFTER = /^(?:market\w*|run\w*|cykl\w*|režim\w*|fáze\w*)$/iu;

/**
 * The FUTURE and CONDITIONAL vocabulary.
 *
 * These are the verbs that carry a call forward in time.
 */
const FUTURE_WORDS = [
  'bude', 'budu', 'budeme', 'budou', 'budete',
  'může', 'můžeme', 'můžete', 'mohou', 'mohl', 'mohla', 'mohli', 'mohu',
  'bych', 'bychom', 'by šel', 'aby', 'abych', 'pokud', 'kdyby', 'když', 'dokud',
  'otevřu', 'zavřu', 'udělám', 'vydělám', 'přijde', 'dojde', 'půjde',
  'očekávám', 'očekávat', 'čekám', 'počítám', 'plánuji', 'plánuju', 'chci',
  'hledám', 'sleduji', 'vyhledávat', 'vyhledat', 'myslím', 'myslíme',
  'vypadá', 'pravděpodobně', 'vyplatí', 'doporučuji',
  'mám v plánu', 'dal bych', 'dovolím', 'vrátím', 'pohledám',
];

/**
 * The PAST vocabulary.
 *
 * "dnes" and "včera" are NOT here: "dnes bych raději short" is a call
 * about today and "dnes byl krásný long" is a fact about today, and
 * only "byl" tells them apart. The past PARTICIPLES are here because
 * they carry the tense on their own: "vzal jsem long", "měl jsem
 * short", "přepnul jsem na zlato".
 */
const PAST_WORDS = [
  'byl', 'byla', 'bylo', 'byli', 'byly',
  'vzal', 'vzala', 'měl', 'měla', 'mělo', 'udělal', 'shortnul', 'neshortnul',
  'dal', 'dala', 'prodal', 'vybral', 'vybrala', 'koupil', 'nakoupil',
  'skončil', 'zavřel', 'otevřel', 'odebral', 'přepnul', 'dostal', 'bral',
  'minulý', 'minulé', 'minulého', 'loni', 'předchozí', 'předchozího',
  'ode dne', 'čtvrtletí',
];

/**
 * The PRESENT vocabulary: a LIVE position, not a call.
 *
 * "dnes uzavírám třetinu BTAL longu", "kdyz jsem ted short z toho PPI
 * open", "intradenní long by se tady měl vybrat profit". These are
 * positions he HOLDS, and a position he holds is not a prediction --
 * the project scores a call from the close on the day he wrote it, and a
 * live position has already had its move.
 *
 * They are recorded as `present`, so a reader can see them, and they are
 * NOT scored.
 */
const PRESENT_WORDS = [
  'uzav\u00edr\u00e1m', 'uzaviram', 'obchoduju', 'obchoduji', 'dr\u017e\u00edm', 'drzim',
  'm\u00e1m', 'mam', 'vybrat', 'vybral', 'sni\u017euji', 'sni\u017euju', 'nastupuji',
  'scalpoval', 'scalpuji', 'beru', 'sed\u00edm', 'sedim',
];

/**
 * The NEGATED forms of the verbs: a negation REVERSES the direction.
 *
 * "určitě bych dnes nesp\u011bchal do longu" is not a long -- it is the
 * refusal of one. The list is explicit because the Czech prefix "ne"
 * also starts words that are not negations ("nedávno", "něco",
 * "nebo").
 */
const NEGATIONS = [
  'nesp\u011bchal', 'nesp\u011bch\u00e1m', 'nebudu', 'nebude', 'nebudeme',
  'nem\u00e1m', 'nem\u016f\u017ee', 'nem\u016f\u017eeme', 'nechci', 'nechce',
  'nepujde', 'neodebral', 'nevstoup\u00edm', 'nevstupuji', 'nebere', 'neberu',
  'nesm\u00ed', 'nem\u016f\u017eu', 'ne\u0161el', 'ne\u0161la', 'neudel\u00e1m',
  'neudelal', 'nenastoupili', 'nenastoupí', 'nepřijde', 'nesahá',
  'nesáhla', 'neděje',
];

/**
 * The OPTIONS vocabulary, and the direction it implies.
 *
 * "já budu nakupovat put spready na SPX 6580" is a BEARISH call on SPX,
 * and reading the "nakupovat" as bullish gets it exactly wrong. Buying
 * a put spread is bearish; buying a call spread is bullish. The rule is
 * the same one the Benzinga source uses for its options show.
 */
const OPTION_SPREADS = [
  { pattern: /\bput\s+spread/iu, stance: 'bearish' },
  { pattern: /\bcall\s+spread/iu, stance: 'bullish' },
];

/**
 * How far the direction may sit from the instrument and still belong to
 * it. Measured in CHARACTERS, because a Czech word is longer than an
 * English one and a word count would be a language-specific constant.
 *
 * THE WINDOW DEPENDS ON HOW MANY DIRECTIONS THE SENTENCE HAS.
 *
 * With ONE direction word there is nothing for it to be confused with,
 * so the window is generous: "XLP se blíží k měsíční lince a k cenové úrovni,
 * kdy již 2x nastoupili kupci, tohle by mohl být pěkný mean reversion long" is a call on XLP and the
 * direction is 105 characters from the instrument.
 *
 * With TWO or more, the direction must HANG OFF the instrument, and the
 * window is tight: "směrem dolu je výrazně méně prostoru než směrem nahoru na SPX, takže
 * vaše profity budou výrazně menší z shortování než z longů" has two, and the one
 * that is nearest SPX is not the one the sentence means.
 */
const ATTACHMENT_CHARS_ONE = 150;
const ATTACHMENT_CHARS_MANY = 45;

/**
 * The intensifiers: "silně bullish", "monstrozní pravděpodobnost".
 */
const STRONG_WORDS = [
  'silně', 'silnější', 'jasně', 'jasný', 'určitě', 'bezpečně',
  'vysokou', 'monstrozní', 'razantně', 'skutečně', 'paradní',
];

/** The horizon vocabulary, and the horizon each word means. */
const HORIZONS = [
  { pattern: /\b(?:intraday|intradenně|intradenní|intradenn)\b/iu, horizon: 'intraday', text: 'intraday' },
  { pattern: /\b(?:swing|swingový|swingové|swingu|swing trade)\b/iu, horizon: 'swing', text: 'swing' },
  { pattern: /\b(?:týden|týdne|týdnů|týdenní|týdenní linka|tyden|tydenni)\b/iu, horizon: '1w', text: 'týden' },
  { pattern: /\b(?:měsíc|měsíce|měsíců|měsíční|mesic|mesice)\b/iu, horizon: '1m', text: 'měsíc' },
  { pattern: /\b(?:rok|roku|roční|ročně)\b/iu, horizon: '1y', text: 'rok' },
];

/** A price level: four or five digits, which is where an index level is. */
const LEVEL = /\b(\d{4,5})\b/g;

/**
 * Split a message into sentences.
 *
 * Czech writes sentences with a full stop, and a newline is a line
 * break in a chat message, so both end a sentence.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return String(text || '')
    .split(/[\n.!?;]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Find every occurrence of a word list in a text.
 *
 * The boundary is UNICODE-AWARE, because Czech words carry diacritics
 * and an ASCII `\b` would not stop after "růst" or "může".
 *
 * @param {string} text
 * @param {string[]} words
 * @returns {{index: number, word: string}[]} in order of appearance
 */
function findWords(text, words) {
  const out = [];
  const source = String(text || '');
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    let match;
    while ((match = pattern.exec(source)) !== null) {
      out.push({ index: match.index, word: match[0].toLowerCase() });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Find the direction words in a sentence, and say which way each points.
 *
 * @param {string} sentence
 * @returns {{index: number, stance: string, word: string}[]}
 */
function findDirections(sentence) {
  const out = [];
  const bull = findWords(sentence, BULLISH_WORDS);
  const bear = findWords(sentence, BEARISH_WORDS);

  // "short covering" is a squeeze, and a squeeze is up: the two words
  // are read together, because "short" alone says the opposite.
  // The Czech case ending rides on the noun: "short coveringu",
  // "short coveringy". A "\bcovering\b" would miss both and read the
  // "short" on its own -- the opposite of what the phrase means.
  const covering = /\bshort\s+covering\w*/iu.exec(sentence);
  if (covering) {
    out.push({ index: covering.index, stance: 'bullish', word: 'short covering' });
  }

  for (const hit of bull) {
    const after = sentence.slice(hit.index + hit.word.length).trimStart();
    // The word is taken WITHOUT its punctuation: "bull cyklu," is a
    // regime, and a pattern anchored at the end of the word does not
    // match a word that still carries a comma.
    const next = /^([^\s,.;:!?()]+)/u.exec(after);
    // "bull marketu" is a regime, not a call.
    if (next && REGIME_AFTER.test(next[1])) continue;
    out.push({ index: hit.index, stance: 'bullish', word: hit.word });
  }
  for (const hit of bear) {
    // A "short" that is part of "short covering" was already read as a
    // squeeze.
    if (covering && hit.index >= covering.index && hit.index < covering.index + covering[0].length) continue;
    const after = sentence.slice(hit.index + hit.word.length).trimStart();
    const next = /^([^\s,.;:!?()]+)/u.exec(after);
    if (next && REGIME_AFTER.test(next[1])) continue;
    out.push({ index: hit.index, stance: 'bearish', word: hit.word });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Decide whether a sentence is about the future or about what happened.
 *
 * The NEAREST marker to the direction word decides, and a "by" before a
 * past form makes the past form conditional.
 *
 * @param {string} sentence
 * @param {number} directionIndex
 * @returns {string} 'forward' | 'retrospective' | ''
 */
function claimKindOf(sentence, directionIndex) {
  const conditional = /\bby\s+(?:byl|byla|bylo|byli)\b/iu.exec(sentence);
  const future = findWords(sentence, FUTURE_WORDS);
  const past = findWords(sentence, PAST_WORDS).filter((hit) => {
    if (!conditional) return true;
    // The past form that follows a "by" is part of the conditional.
    return !(hit.index > conditional.index && hit.index < conditional.index + conditional[0].length);
  });

  const present = findWords(sentence, PRESENT_WORDS);

  // The marker that GOVERNS the direction word is the one BEFORE it:
  // "dnes uzavírám třetinu BTAL longu a budu sledovat" is a LIVE
  // position ("uzavírám ... longu"), and the "budu" that follows it
  // governs the next clause ("budu sledovat"), not the position.
  //
  // So the decision walks backwards from the direction word and takes
  // the first marker it meets; when there is none before it, it takes
  // the first one after it.
  const before = (hits) => hits
    .filter((hit) => hit.index < directionIndex)
    .sort((a, b) => b.index - a.index)[0] || null;
  const after = (hits) => hits
    .filter((hit) => hit.index > directionIndex)
    .sort((a, b) => a.index - b.index)[0] || null;

  // ALL the markers in one list, so the one that GOVERNS the direction
  // word is chosen by POSITION and not by which list it came from.
  const markers = [
    ...future.map((hit) => ({ ...hit, kind: 'forward' })),
    ...past.map((hit) => ({ ...hit, kind: 'retrospective' })),
    ...present.map((hit) => ({ ...hit, kind: 'present' })),
  ];
  const governing = before(markers) || after(markers);
  if (!governing) return '';
  return governing.kind;
}

/**
 * The horizon a sentence states.
 *
 * @param {string} sentence
 * @returns {{horizon: string, text: string}}
 */
function horizonOf(sentence) {
  for (const entry of HORIZONS) {
    if (entry.pattern.test(sentence)) return { horizon: entry.horizon, text: entry.text };
  }
  return { horizon: '', text: '' };
}

/**
 * Every subject occurrence in a sentence.
 *
 * @param {string} sentence
 * @returns {{subject: object, index: number}[]}
 */
function subjectOccurrences(sentence) {
  const out = [];
  for (const entry of SUBJECT_PATTERNS) {
    const pattern = new RegExp(entry.pattern.source, entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`);
    let match;
    while ((match = pattern.exec(sentence)) !== null) {
      out.push({ subject: entry.subject, index: match.index });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The direction that belongs to a subject.
 *
 * The direction ATTACHES to the instrument, so it is the one NEAREST to
 * it: "v momentě kdy by to dnes prodejci vzali pod 6220 tak bullish
 * teze padá" is a BEARISH call on SPX, because "prodejci" is the word
 * that hangs off "SPX" and "bullish teze" is the thesis falling.
 *
 * Two directions at the SAME distance are a MIXED reading: the sentence
 * does not pick a side, and a reading that does not pick a side is not
 * a direction.
 *
 * @param {number} subjectIndex
 * @param {{index: number, stance: string, word: string}[]} directions
 * @returns {{stance: string, index: number, word: string}|null}
 */
function stanceFor(subjectIndex, directions, sentence = '') {
  if (!directions.length) return null;
  const ranked = directions
    .map((direction) => ({ ...direction, distance: Math.abs(direction.index - subjectIndex) }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];

  // The direction must ATTACH to the instrument: a direction word four
  // clauses away is about something else. The window is generous when
  // the sentence carries ONE direction (there is nothing to confuse it
  // with) and tight when it carries several.
  const window = directions.length === 1 ? ATTACHMENT_CHARS_ONE : ATTACHMENT_CHARS_MANY;
  if (nearest.distance > window) return null;

  const rival = ranked.find((direction) => direction !== nearest && direction.distance === nearest.distance);
  if (rival) {
    return { stance: 'mixed', index: nearest.index, word: `${nearest.word} / ${rival.word}` };
  }

  // The options vocabulary flips the direction: "nakupovat put spready"
  // is a bearish call, whatever the verb says.
  const around = sentence.slice(Math.max(0, nearest.index - 30), nearest.index + 40);
  for (const option of OPTION_SPREADS) {
    if (option.pattern.test(around)) {
      return { stance: option.stance, index: nearest.index, word: `${nearest.word} (options)` };
    }
  }

  // A negation reverses the direction: "nespechal do longu" is not a
  // long.
  const before = sentence.slice(Math.max(0, nearest.index - 25), nearest.index);
  for (const negation of NEGATIONS) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${negation}(?![\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(before)) {
      return {
        stance: nearest.stance === 'bullish' ? 'bearish' : 'bullish',
        index: nearest.index,
        word: `${nearest.word} (negated)`,
      };
    }
  }

  return { stance: nearest.stance, index: nearest.index, word: nearest.word };
}

/**
 * The subject nearest a direction word in a sentence.
 *
 * @param {string} sentence
 * @param {number} directionIndex
 * @returns {{subject: object, index: number}|null}
 */
function nearestSubject(sentence, directionIndex) {
  let best = null;
  for (const entry of subjectOccurrences(sentence)) {
    const distance = Math.abs(entry.index - directionIndex);
    if (!best || distance < best.distance) best = { ...entry, distance };
  }
  return best;
}

/**
 * The price level nearest the subject, when he named one.
 *
 * @param {string} sentence
 * @param {number} subjectIndex
 * @returns {string}
 */
function levelOf(sentence, subjectIndex) {
  let best = null;
  LEVEL.lastIndex = 0;
  let match;
  while ((match = LEVEL.exec(sentence)) !== null) {
    const distance = Math.abs(match.index - subjectIndex);
    if (!best || distance < best.distance) {
      best = { value: match[1], distance };
    }
  }
  return best ? best.value : '';
}

/**
 * Read the calls out of one message.
 *
 * @param {string} text
 * @param {object} [context]
 * @param {string} [context.messageId]
 * @param {string} [context.postedAt]
 * @returns {object[]} the readings, one per (subject, stance, kind) in the message
 */
function parseMessage(text, context = {}) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const sentences = splitSentences(source);
  const readings = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const directions = findDirections(sentence);
    if (!directions.length) continue;

    const subjects = subjectOccurrences(sentence);
    if (!subjects.length) continue;

    for (const direction of directions) {
      // The direction ATTACHES to the instrument it is nearest to, and
      // to ONE instrument: "makro trhy: bondy ... pod tydenni linku ZB,
      // TLT ma jeste kousek ... a mohl by tam byt zajimavy swing long"
      // is a call on TLT, and the ZB is the thing being defended.
      const occurrence = nearestSubject(sentence, direction.index);
      if (!occurrence) continue;

      // The whole list of directions goes in, because the WINDOW depends
      // on how many of them the sentence carries -- and because the
      // direction that belongs to the instrument is the one NEAREST to
      // it, not the one this loop happens to be on.
      const stance = stanceFor(occurrence.index, directions, sentence);
      if (!stance) continue;

      const kind = claimKindOf(sentence, stance.index);
      if (!kind) continue;

      const key = `${occurrence.subject.spoken}|${stance.stance}|${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const horizon = horizonOf(sentence);
      const strong = findWords(sentence, STRONG_WORDS).length > 0;

      readings.push({
        parser_version: context.parser_version || '',
        source_name: context.source_name || 'monoszon',
        message_id: context.message_id || 0,
        discord_message_id: context.discord_message_id || '',
        posted_at: context.posted_at || '',
        as_of_date: String(context.posted_at || '').slice(0, 10),
        scope: occurrence.subject.scope,
        subject: occurrence.subject.spoken,
        proxy_ticker: occurrence.subject.proxy,
        stance: stance.stance,
        claim_kind: kind,
        horizon: horizon.horizon,
        horizon_text: horizon.text,
        level: levelOf(sentence, occurrence.index),
        confidence: strong ? 'high' : 'medium',
        evidence_text: sentence,
      });
    }
  }
  return readings;
}

module.exports = {
  BULLISH_WORDS,
  BEARISH_WORDS,
  FUTURE_WORDS,
  HORIZONS,
  NEGATIONS,
  OPTION_SPREADS,
  PAST_WORDS,
  PRESENT_WORDS,
  REGIME_AFTER,
  STRONG_WORDS,
  claimKindOf,
  findDirections,
  findWords,
  horizonOf,
  levelOf,
  nearestSubject,
  parseMessage,
  stanceFor,
  subjectOccurrences,
  splitSentences,
};
