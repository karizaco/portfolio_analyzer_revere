'use strict';

/**
 * Martin Klass's calls, read out of Czech.
 *
 * WHAT THIS SOURCE IS
 *
 * Two channels of his own server, and they are two DIFFERENT kinds of
 * thing:
 *
 *   `trading`      his own trading commentary. Mostly education, and
 *                   occasionally a call: "Tento instrument se nachází v
 *                   down trendu, takže směr obchodování je jasný" (the
 *                   EUR/USD is in a downtrend, so the direction of the
 *                   trade is clear).
 *   `investování`  a DAILY digest of the earnings -- 938 messages, and
 *                   every one of them reports what ALREADY HAPPENED:
 *                   "📉 Ambarella se potýká s nedostatkem paměťových
 *                   čipů, akcie výrazně klesají".
 *
 * So the two channels are the two CLAIM KINDS the project already has:
 *
 *   forward    an expectation about what has not happened yet -- SCORED
 *   reported   a result that has already happened -- recorded, not scored
 *
 * A reported claim cannot be scored, and that is not a limitation of
 * this reader: the price has already moved by the time the claim is
 * written. It is the same rule the Benzinga source follows for "Wedbush's
 * Dan Ives remains very bullish".
 *
 * WHY THE TENSE IS THE WHOLE PROBLEM
 *
 * Czech marks the tense on the VERB, and the same word carries both:
 * "cena ropy lítá nahoru a dolů" (the price flies up and down) is a
 * description, while "ropa určitě prorazí výše" (the oil will certainly
 * break higher) is a call. So the reading is: a subject, a direction
 * word, and a marker of whether the sentence is about the future.
 *
 * THE DIRECTION WORDS, AND THE TWO THAT ARE NOT DIRECTIONS
 *
 * "roste" and "klesá" in the PRESENT tense describe what is happening
 * now ("Akcie UnitedHealth posílily o téměř 9 %" -- the shares rose
 * nearly 9 %), and they are the mark of a REPORTED claim. In the
 * FUTURE tense they are a call ("cenou ropy čekám růst" -- I expect the
 * oil price to rise).
 */

const { matchCompanyName } = require('../../sevcik/companyNames');
const { SUBJECT_PATTERNS } = require('./subjects');

/**
 * The BULLISH vocabulary.
 *
 * "rovnat" and "prorazit" are the two that carry most of his calls: a
 * price that "prorazí výše" (breaks higher) and one that "rovnat bude"
 * (will move up).
 */
const BULLISH_WORDS = [
  'rovnat', 'prorazil', 'prorázet', 'prorůst', 'poroste', 'odrazit', 'odrazí',
  'výše', 'výšší', 'růst', 'růstu', 'růstová', 'vzestup', 'vzhůru', 'nahoru',
  'přidat', 'nakupovat', 'nakoupit', 'koupit', 'long', 'bullish', 'podpoří',
  'vyšší', 'zlepší', 'výborně', 'profit', 'profitable', 'vzrostly', 'vzrostla',
  'vzrostlo', 'rostou', 'posílily', 'prorazily', 'překonal', 'překonala',
  'překonalo', 'silný růst', 'růstové', 'nejnižší cen', 'watchlistu',
  'do portfolia', 'do mého portfolia', 'bych rád přidal', 'bych rád koupil',
];

/** The BEARISH vocabulary. */
const BEARISH_WORDS = [
  'pokles', 'poklesu', 'klesá', 'klesají', 'klesat', 'propad', 'propadu',
  'propadají', 'padají', 'oslabují', 'oslabit', 'nižší', 'dolů', 'short',
  'bearish', 'prodat', 'prodávat', 'ztrátu', 'spekulovat', 'výprodej',
  'ochraňující', 'tlakem', 'slabší', 'pod tlakem', 'do down trendu',
  'down trendu', 'negativní', 'příliš', 'přehodnocen',
];

/**
 * The EXPECTATION vocabulary: the words that make a sentence about what
 * has NOT happened yet.
 *
 * It is a STRICT list, and it has to be. His digest headlines carry the
 * companies' own forward-looking language -- "slabší výhled posílá akcie
 * dolů", "Vedení nyní očekává upravené tržby" -- and a loose list reads
 * the COMPANY's guidance as HIS call. So "výhled" and "očekávat" are not
 * in it, and what is in it is what HE says he expects or wants.
 */
const FUTURE_WORDS = [
  'čekám', 'čekají', 'očekávám', 'očekáváme', 'bude', 'budeme', 'budou',
  'může', 'můžeme', 'mohou', 'mohl', 'mohla', 'pravděpodobně', 'myslím',
  'myslíme', 'plánuji', 'plánuju', 'počítám', 'předpokládám', 'chci',
  'hodlám', 'doporučuji', 'vyplatí', 'věřím', 'hledám', 'sleduji',
  'půjde', 'půjdou', 'sáhne', 'dostane', 'přijde', 'dotkne', 'prorazí',
  'prolomí', 'ustojí', 'vzroste', 'vystoupí', 'klesne', 'propadne',
  'rozšiřuje', 'zavedu', 'nakoupit', 'koupit', 'vystoupá', 'podpoří',
  'přidal', 'přidala', 'přidám', 'přidávám', 'přidávat', 'dodal',
  'dodám', 'kupoval', 'kupovali', 'nakoupím', 'chystám', 'doplním', 'doplnit',
  'vydělám', 'utržím', 'vyberu', 'vybrat',
];

/**
 * The REPORTED markers: the words that say the thing already happened.
 */
const REPORTED_WORDS = [
  'reportoval', 'reportovala', 'výsledky', 'výsledků', 'tržby', 'zisk', 'zisku',
  'klesají', 'klesala', 'klesalo', 'vzrostly', 'vzrostla', 'vzrostlo', 'posílily',
  'posílil', 'dnes', 'včera', 'za Q3', 'za Q4', 'za FY', 'před marketem',
  'premarket', 'pre-market', 'před otevřením', 'oznámila', 'oznámil', 'akcie klesaly',
];

/** The ticker, with its dollar sign: "$UNH". */
const TICKER = /(?<![A-Za-z0-9$])\$([A-Z]{1,5})(?![A-Za-z0-9])/g;

/** A headline in bold -- the digest's title. */
const HEADLINE = /\*\*([^*]+)\*\*/;

/** The words that mean a direction is stated and not merely implied. */
const STRONG_DIRECTION = /(?:rovn|proraz|prorůst|poroste|odraz|kles|pokles|propad|spekulovat|příležitost koupit)/i;

/** The shared matcher's answers, cached per phrase. */
const nameCache = new Map();

/**
 * The ticker a company NAME refers to, cached.
 *
 * @param {string} phrase
 * @param {Set<string>} [lexicon]
 * @returns {{ticker: string|null, matched: string}}
 */
function matchCompanyCached(phrase, lexicon) {
  if (nameCache.has(phrase)) return nameCache.get(phrase);
  const resolved = matchCompanyName(phrase, { lexicon });
  const value = { ticker: resolved.ticker, matched: resolved.matched };
  nameCache.set(phrase, value);
  return value;
}

/**
 * The subject of a sentence.
 *
 * Three ways, in the order they are tried:
 *
 *   1. a CAPS ticker he wrote ("$UNH");
 *   2. a commodity, an index or a currency pair in Czech ("zlato");
 *   3. a company NAME ("Ambarella", "CrowdStrike"), through the shared
 *      matcher, which is the market's own registrant file.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Set<string>} [options.lexicon]
 * @returns {{subject: string, proxy: string, scope: string, matched: string}|null}
 */
function findSubject(text, options = {}) {
  TICKER.lastIndex = 0;
  let match;
  while ((match = TICKER.exec(text)) !== null) {
    const ticker = match[1].toUpperCase();
    if (ticker.length < 2) continue;
    return { subject: ticker, proxy: ticker, scope: 'stock', matched: `$${ticker}`, index: match.index };
  }

  for (const entry of SUBJECT_PATTERNS) {
    const hit = entry.pattern.exec(text);
    if (!hit) continue;
    return {
      subject: hit[0],
      proxy: entry.subject.proxy,
      scope: entry.subject.scope,
      matched: hit[0],
      index: hit.index,
    };
  }

  // A company name, through the SHARED matcher. It is a PHRASE and not
  // one word -- "Super Micro Computer" and "Hewlett Packard" are two
  // words each -- so the windows are tried longest first, and only the
  // capitalised ones are tried at all: a lowercase Czech word is not a
  // company name.
  //
  // The search is capped at the first sixty words and its answers are
  // cached, because the shared matcher walks the market's whole
  // registrant file on every call and a digest message is three hundred
  // words long.
  const words = String(text || '').split(/\s+/).slice(0, 60);
  const clean = words.map((raw) => raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  for (let size = 4; size >= 1; size -= 1) {
    for (let start = 0; start + size <= clean.length; start += 1) {
      const slice = clean.slice(start, start + size);
      if (!slice.length) continue;
      if (!slice.every((word) => word && /^\p{Lu}/u.test(word))) continue;
      const phrase = slice.join(' ');
      const resolved = matchCompanyCached(phrase, options.lexicon);
      if (resolved.ticker) {
        const at = text.indexOf(phrase);
        return {
          subject: resolved.matched || phrase,
          proxy: resolved.ticker,
          scope: 'stock',
          matched: resolved.matched || phrase,
          index: at < 0 ? 0 : at,
        };
      }
    }
  }
  return null;
}

/**
 * The direction a sentence states.
 *
 * @param {string} text
 * @returns {{stance: string, word: string, index: number}|null}
 */
function findDirection(text) {
  const bull = findWord(text, BULLISH_WORDS);
  const bear = findWord(text, BEARISH_WORDS);
  if (bull && bear) {
    // Both directions in one sentence: the sentence does not pick a
    // side, and a reading that does not pick a side is not a direction.
    return { stance: 'mixed', word: `${bull.word} / ${bear.word}`, index: Math.min(bull.index, bear.index) };
  }
  if (bull) return { stance: 'bullish', word: bull.word, index: bull.index };
  if (bear) return { stance: 'bearish', word: bear.word, index: bear.index };
  return null;
}

/**
 * The direction NEAREST a subject.
 *
 * A message that names two companies carries a direction for each, and
 * the one nearest the subject is the one that belongs to it.
 *
 * @param {string} text
 * @param {number} subjectIndex
 * @returns {{stance: string, word: string, index: number}|null}
 */
function findDirectionNear(text, subjectIndex) {
  const bull = findWord(text, BULLISH_WORDS);
  const bear = findWord(text, BEARISH_WORDS);
  const at = typeof subjectIndex === 'number' ? subjectIndex : 0;
  // The direction has to be NEAR the subject. A digest message names a
  // company and then talks about several others, and a direction word
  // from a later paragraph is not a claim about this one. Measured on
  // the corpus: the readings this drops are the ones with no claim about
  // the subject at all -- "Velkou pozornost vyvolalo oznámení spolupráce
  // se společností Microsoft" is not a call on Microsoft whatever word
  // the next paragraph happens to use.
  const MAX_DISTANCE = 150;
  // ... and it must be in the SENTENCE the subject is in. A digest
  // message is a paragraph per company and the sentences after it talk
  // about other things: "Velkou pozornost vyvolalo oznámeni spoluprace
  // se spolecnosti Microsoft, ktere bude vyuzivat cloudove sluzby pro AI
  // infrastrukturu. Rust trzeb pak pokracuje." -- the last sentence is
  // not a call on Microsoft.
  const sentenceOf = (index) => {
    const before = text.slice(0, index);
    const start = Math.max(
      before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'),
      before.lastIndexOf('\n'), before.lastIndexOf(';'),
    );
    const rest = text.slice(index);
    const ends = ['.', '!', '?', '\n', ';'].map((mark) => rest.indexOf(mark)).filter((v) => v >= 0);
    const end = ends.length ? index + Math.min(...ends) : text.length;
    return { start: start + 1, end };
  };
  const near = (hit) => (hit ? { ...hit, distance: Math.abs(hit.index - at) } : null);
  const b = near(bull);
  const r = near(bear);
  if (!b && !r) return null;
  if (b && r) {
    // Two directions at the SAME distance is a sentence that does not
    // pick a side.
    if (b.distance === r.distance) {
      return { stance: 'mixed', word: `${b.word} / ${r.word}`, index: Math.min(b.index, r.index) };
    }
    return b.distance < r.distance
      ? { stance: 'bullish', word: b.word, index: b.index }
      : { stance: 'bearish', word: r.word, index: r.index };
  }
  const best = b
    ? (r && r.distance < b.distance
      ? { stance: 'bearish', word: r.word, index: r.index, distance: r.distance }
      : { stance: 'bullish', word: b.word, index: b.index, distance: b.distance })
    : { stance: 'bearish', word: r.word, index: r.index, distance: r.distance };
  if (best.distance > MAX_DISTANCE) return null;
  // The direction has to be in the subject's own sentence.
  const subjectSentence = sentenceOf(at);
  const bestSentence = sentenceOf(best.index);
  if (bestSentence.start < subjectSentence.start || bestSentence.end > subjectSentence.end) return null;
  return { stance: best.stance, word: best.word, index: best.index };
}

/**
 * The first of a word list in a text.
 *
 * The boundary is UNICODE-AWARE, because Czech words carry diacritics.
 *
 * @param {string} text
 * @param {string[]} words
 * @returns {{index: number, word: string}|null}
 */
function findWord(text, words) {
  let best = null;
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    const hit = pattern.exec(text);
    if (hit && (!best || hit.index < best.index)) best = { index: hit.index, word: hit[0].toLowerCase() };
  }
  return best;
}

/**
 * Is the sentence about the future?
 *
 * @param {string} text
 * @returns {string} 'forward' | 'reported'
 */
function claimKindOf(text) {
  const future = findWord(text, FUTURE_WORDS);
  const reported = findWord(text, REPORTED_WORDS);
  if (future && (!reported || future.index < reported.index)) return 'forward';
  if (reported) return 'reported';
  return 'reported';
}

/**
 * The horizon he states.
 *
 * @param {string} text
 * @returns {{horizon: string, text: string}}
 */
function horizonOf(text) {
  if (/intradenn|intraday|denně|každý den|dnes/i.test(text)) return { horizon: 'intraday', text: 'intradenně' };
  if (/swing|střednědob/i.test(text)) return { horizon: 'swing', text: 'swing' };
  if (/týden|tyden|týdne/i.test(text)) return { horizon: '1w', text: 'týden' };
  if (/měsíc|mesic/i.test(text)) return { horizon: '1m', text: 'měsíc' };
  if (/dlouhodob|investic/i.test(text)) return { horizon: 'long', text: 'dlouhodobě' };
  return { horizon: '', text: '' };
}

/**
 * Read one post into a reading, or into nothing.
 *
 * @param {string} content
 * @param {object} [context]
 * @param {string} [context.channel]  which channel it came from
 * @param {Set<string>} [context.lexicon]
 * @returns {object[]} the readings in the post
 */
function parsePost(content, context = {}) {
  const text = String(content || '').trim();
  if (!text) return [];

  // ONE reading per message, and the HEADLINE decides the subject.
  //
  // The digest's headline is the claim and the body is the explanation,
  // so the subject of the message is the company of its headline. Reading
  // the body as a second reading is what put "AMD" on a message about
  // AST SpaceMobile, and it is why the first version of this reader had
  // a message yield two readings with two different directions.
  const headline = HEADLINE.exec(text);
  let subject = null;
  if (headline) {
    const head = headline[1];
    const found = findSubject(head, { lexicon: context.lexicon });
    if (found) {
      // The headline's index is relative to the HEADLINE, and the
      // direction is searched in the whole message -- so the offset has
      // to be added or the two are compared against each other.
      const offset = headline.index + headline[0].indexOf(head);
      subject = { ...found, index: offset + found.index };
    }
  }
  if (!subject) subject = findSubject(text, { lexicon: context.lexicon });
  if (!subject) return [];

  // The direction is the one NEAREST the subject, so a mention of another
  // name later in the body cannot steal it.
  const direction = findDirectionNear(text, subject.index);
  if (!direction) return [];
  if (direction.stance === 'mixed') return [];

  const kind = claimKindOf(text);
  const horizon = horizonOf(text);
  return [{
    parser_version: context.parser_version || '',
    source_name: context.source_name || 'martinklass',
    message_id: context.message_id || 0,
    discord_message_id: context.discord_message_id || '',
    posted_at: context.posted_at || '',
    as_of_date: String(context.posted_at || '').slice(0, 10),
    channel: context.channel || '',
    scope: subject.scope,
    subject: subject.subject,
    proxy_ticker: subject.proxy,
    stance: direction.stance,
    claim_kind: kind,
    horizon: horizon.horizon,
    horizon_text: horizon.text,
    confidence: STRONG_DIRECTION.test(text) ? 'high' : 'medium',
    evidence_text: text.replace(/\s+/g, ' ').trim().slice(0, 600),
  }];
}

module.exports = {
  BULLISH_WORDS,
  BEARISH_WORDS,
  FUTURE_WORDS,
  REPORTED_WORDS,
  claimKindOf,
  findDirection,
  findDirectionNear,
  findSubject,
  findWord,
  horizonOf,
  parsePost,
};
