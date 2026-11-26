'use strict';

/**
 * A plechac trade statement, read out of one Discord message.
 *
 * THE UNIT IS THE LINE, AND A LINE MAY HOLD MORE THAN ONE STATEMENT
 *
 * He writes a message as a LIST of statements, one per line:
 *
 *   "Dobral jsem akcie, které dneska trpí
 *    RollsRoyce
 *    Samsung
 *    LEU
 *    BABA"
 *
 *   "Prodal jsem celý SentimelOne
 *    Prodal jsem skoro polovinu PayPal
 *    Nakoupil jsem trochu Pepsi"
 *
 * So the verb of a line is that line's verb, and a line that is only a
 * list of names CONTINUES the verb above it. The shared parser takes the
 * earliest verb in the MESSAGE; this one takes the verb of the LINE, and
 * the subject of the LINE. That is the whole difference between the two,
 * and it is why the parser is this source's own.
 *
 * A LINE MAY HOLD MORE THAN ONE STATEMENT
 *
 * "Drobně jsem dokoupil Uber, Race, MSFT, META, Xiaomi... prodal jsem
 * něco Nebius" is a top-up AND a sale, and the sale is behind the
 * ellipsis. So a line is cut into CLAUSES at the dashes, the ellipses
 * and the sentence ends, and each clause that has a verb of its own is a
 * statement.
 *
 * WHAT A DASH OR AN ELLIPSIS USUALLY IS
 *
 * Usually it introduces an EXPLANATION, and a name in the explanation is
 * not a holding of the trade:
 *
 *   "Zavřel jsem opět trochu B - barrick mining"   the subject is B
 *   "prodal jsem celé ETF SP500 Financials Sector - je tam BRK, JPM,
 *    Visa, Mastercard"                              the subject is the ETF
 *   "Beru ještě trochu NVDA, TSM, ASML, META, MELI, RHM ... takže ve
 *    veřejném i risky portfoliu"                    the subject is the six
 *
 * So a clause WITHOUT a verb is not a statement: it is a gloss, or it is
 * the continuation of the line above.
 *
 * TWO VERBS IN ONE CLAUSE
 *
 * "Zavřel jsem třetinu ZETA a prodal jsem zbytek Gitlab" is a trim of
 * one position and a sale of another, and they are not the same
 * statement. So a clause with more than one verb is cut into RUNS at the
 * verbs, and each run is a statement with its own subject.
 *
 * The cut happens only where the two are actually separate: the text
 * between two verbs has to carry a conjunction or a comma. Otherwise the
 * second verb is part of the first statement -- "Vzal jsem za to první
 * pozice na KLA" is ONE statement about KLA, not two.
 *
 * "BERU" IS THREE DIFFERENT THINGS
 *
 * It is the most common verb in the corpus (34 of 233 messages), and it
 * means three different things:
 *
 *   "Beru SLB a HAL - ropa, services"          a BUY
 *   "Beru ještě trochu NVDA, TSM, ASML"        a BUY, and "ještě" says
 *                                                it is more of what he has
 *   "Beru zisk na Citi Group částečný"         TAKING PROFIT -- a TRIM
 *   "Beru celý profit na Groupon"              TAKING THE WHOLE PROFIT
 *
 * The profit rule is the one that has to be measured: 12 messages pair
 * "beru" or "vzal jsem" with "zisk" or "profit", and every one of them is
 * a REDUCTION. Reading them as buys would publish twelve wrong holdings.
 *
 * THE BOOKS
 *
 * The book is a property of the LINE: "Dobírám na risky portfoliu Uber
 * a Circle | Na hlavním jsem kosmeticky doplnil" puts one name in each.
 */

const { findHoldings } = require('./symbols');
const { ACCOUNT_MAIN, ACCOUNT_RISKY } = require('./sources');

/**
 * A word boundary that works in Czech.
 *
 * `\b` is ASCII: it is a boundary between a WORD character and a
 * non-word one, and "word" means [A-Za-z0-9_]. So `\b` after a word
 * ending in a diacritic is not a boundary at all, and the same bug the
 * Sevcik extractor had is here:
 *
 *   /\bdokup\b/  MATCHES "dokupů"  -- "menších dokupů" is not a top-up
 *   /\bcelé\b/   NEVER MATCHES      -- "celé pozice" ends in a diacritic
 *   /\bmenší\b/  NEVER MATCHES      -- and so does "menší profit"
 *
 * So the boundary here is a Unicode lookaround: not a letter, and not a
 * number, on either side.
 *
 * @param {string} body
 * @param {boolean} [aux]  the verb takes "jsem" / "jsme", before it or
 *   after it. He writes both: "zavřel jsem Sarepta" (18 times) and "na
 *   risky portfoliu jsem zavřel Sarepta" (4 times).
 * @returns {RegExp}
 */
function wordPattern(body, aux = false) {
  const core = `(?:${body})`;
  const inner = aux
    ? `(?:${core}\\s+js(?:em|me)|js(?:em|me)\\s+${core}|${core})`
    : core;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${inner})(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * The verbs, by action.
 *
 * `tense` decides whether the verb is a REALIZED trade in the TALK
 * channel: the trade channel states what he did, so its present-tense
 * verbs are trades ("beru", "dobírám"); the talk channel is commentary,
 * where the same words are opinions, and only a past-tense verb counts.
 *
 * `weak` marks a NOUN that stands for a trade ("Nákup Grab", "Prodej
 * CNRL", "částečné zavření CTRE"). A weak verb never starts a run of its
 * own, so "Vzal jsem za to první pozice na KLA, a přidal vedle ASML" is
 * one statement about KLA and another about ASML, and not three.
 *
 * Every stem here was measured in the corpus. The misspellings are in
 * the table because they are in the corpus: "Přikupuji" (no "o") is how
 * he writes "přikoupuji", six times.
 */
const VERB_TABLE = [
  // --- realized sales -----------------------------------------------------
  { action: 'exit', tense: 'past', stem: 'prodal', aux: true },
  { action: 'exit', tense: 'past', stem: 'prodali', aux: true },
  { action: 'exit', tense: 'past', stem: 'prodávám' },
  { action: 'exit', tense: 'past', stem: 'prodej', weak: true },
  { action: 'exit', tense: 'past', stem: 'zavřel', aux: true },
  { action: 'exit', tense: 'past', stem: 'zavřela', aux: true },
  { action: 'exit', tense: 'present', stem: 'zavírám' },
  { action: 'exit', tense: 'past', stem: 'zavíral', aux: true },
  { action: 'exit', tense: 'past', stem: 'zavření', weak: true },
  { action: 'exit', tense: 'past', stem: 'vyprodal', aux: true },
  { action: 'exit', tense: 'past', stem: 'smazal', aux: true },
  { action: 'exit', tense: 'past', stem: 'odprodal', aux: true },
  { action: 'exit', tense: 'past', stem: 'rozpustil', aux: true },

  // --- realized reductions ------------------------------------------------
  { action: 'trim', tense: 'past', stem: 'zredukoval', aux: true },
  { action: 'trim', tense: 'present', stem: 'redukuji' },
  { action: 'trim', tense: 'present', stem: 'snižuji' },

  // --- realized purchases -------------------------------------------------
  { action: 'open', tense: 'past', stem: 'dobral', aux: true },
  { action: 'open', tense: 'past', stem: 'nakoupil', aux: true },
  { action: 'open', tense: 'past', stem: 'koupil', aux: true },
  { action: 'open', tense: 'past', stem: 'vzal', aux: true },
  { action: 'open', tense: 'past', stem: 'zobnul', aux: true },
  { action: 'open', tense: 'past', stem: 'zaujal', aux: true },
  { action: 'open', tense: 'past', stem: 'založil', aux: true },
  { action: 'open', tense: 'present', stem: 'zakládám' },
  { action: 'open', tense: 'present', stem: 'zaujímám' },
  { action: 'open', tense: 'past', stem: 'nákup', weak: true },
  { action: 'open', tense: 'past', stem: 'první pozic[\\p{L}\\p{N}]*', weak: true },
  { action: 'open', tense: 'past', stem: 'nová pozic[\\p{L}\\p{N}]*', weak: true },
  { action: 'open', tense: 'past', stem: 'první akci[\\p{L}\\p{N}]*', weak: true },
  { action: 'open', tense: 'past', stem: 'poprvé nakupuji', weak: true },
  { action: 'open', tense: 'present', stem: 'beru' },

  // --- top-ups ------------------------------------------------------------
  { action: 'add', tense: 'past', stem: 'dokoupil', aux: true },
  { action: 'add', tense: 'present', stem: 'dokoupuji' },
  { action: 'add', tense: 'present', stem: 'dokupuji' },
  { action: 'add', tense: 'past', stem: 'dokoupil' },
  { action: 'add', tense: 'past', stem: 'dokup', weak: true },
  { action: 'add', tense: 'past', stem: 'přikoupil', aux: true },
  { action: 'add', tense: 'present', stem: 'přikoupuji' },
  { action: 'add', tense: 'present', stem: 'přikupuji' },
  { action: 'add', tense: 'past', stem: 'přikupil' },
  { action: 'add', tense: 'past', stem: 'přikoupení', weak: true },
  { action: 'add', tense: 'present', stem: 'nakupuji' },
  { action: 'add', tense: 'present', stem: 'přidávám' },
  { action: 'add', tense: 'present', stem: 'přidal' },
  { action: 'add', tense: 'past', stem: 'doplnil', aux: true },
  { action: 'add', tense: 'present', stem: 'doplňuji' },
  { action: 'add', tense: 'past', stem: 'nabral', aux: true },
  { action: 'add', tense: 'present', stem: 'nabírám' },
  { action: 'add', tense: 'past', stem: 'přibral', aux: true },
  { action: 'add', tense: 'past', stem: 'navýšil', aux: true },
  { action: 'add', tense: 'present', stem: 'navyšuji' },
  { action: 'add', tense: 'present', stem: 'dobírám' },
  { action: 'add', tense: 'past', stem: 'dobíral', aux: true },
  { action: 'add', tense: 'past', stem: 'přesměroval', aux: true },
  { action: 'add', tense: 'present', stem: 'přesouvám' },
  { action: 'add', tense: 'past', stem: 'dal jsem to do', weak: true },

  // -- the COMMODITY verbs -------------------------------------------------
  //
  // The commodities channel has its own vocabulary, and it is the reason
  // the channel is a source of its own kind: he says "Vstoupil jsem short
  // do sójového oleje" and "Zavřel jsem long na stříbru", and none of
  // those verbs is in the stock list above.
  { action: 'open', tense: 'past', stem: 'vstoupil', aux: true },
  { action: 'open', tense: 'present', stem: 'vstupuji' },
  { action: 'open', tense: 'present', stem: 'vstupuju' },
  { action: 'open', tense: 'past', stem: 'chytil', aux: true },
  { action: 'open', tense: 'present', stem: 'longuji' },
  { action: 'open', tense: 'present', stem: 'longuju' },
  { action: 'open', tense: 'past', stem: 'longoval', aux: true },
  { action: 'open', tense: 'past', stem: 'scalpoval', aux: true },
  { action: 'open', tense: 'past', stem: 'kumuloval', aux: true },
  { action: 'open', tense: 'past', stem: 'otevřel', aux: true },
  { action: 'open', tense: 'past', stem: 'dal', aux: true },
  { action: 'exit', tense: 'past', stem: 'pustil', aux: true },
  { action: 'exit', tense: 'present', stem: 'shortuji' },
  { action: 'exit', tense: 'present', stem: 'shortuju' },
  { action: 'exit', tense: 'past', stem: 'shortoval', aux: true },
  { action: 'exit', tense: 'past', stem: 'likvidoval', aux: true },
  { action: 'exit', tense: 'past', stem: 'zavíral', aux: true },
  { action: 'exit', tense: 'present', stem: 'zavřu' },
];

const VERBS = VERB_TABLE.map((entry) => ({
  action: entry.action,
  tense: entry.tense,
  weak: Boolean(entry.weak),
  pattern: wordPattern(entry.stem, Boolean(entry.aux)),
}));

/**
 * The words that say a line is NOT a trade.
 *
 * A line WITH a trade verb is a trade whatever else it says -- "Redukuji
 * riziko a beru trochu profitu na INTC" contains "riziko" and is a
 * reduction. These markers only stop a line with NO verb from CONTINUING
 * the verb above it: "Přesouvám to do Netflixu ... a koukám dál" is not a
 * sale of Netflix, and "CSU - sázka na to, že velké SAAS přežijí, ale
 * riziko tu vnímám" is not a purchase of Constellation.
 */
const INTENT = wordPattern([
  'sleduji', 'sleduju', 'sledoval', 'sledovala', 'koukám', 'koukat', 'zajímá',
  'zajímám', 'plánuji', 'naplánoval', 'budu', 'budeme', 'budete', 'chci', 'chtěl',
  'chtěla', 'chtějí', 'nevím', 'nevíme', 'nevadí', 'nevadilo', 'věřím', 'věří',
  'obavy', 'obavám', 'riziko', 'risiku', 'risk', 'sázka', 'sázky', 'sázím',
  'teorie', 'výhled', 'čekám', 'očekávám', 'očekávat', 'nejspíš', 'potenciál',
  'zdá', 'myslím', 'doufám', 'hlídám', 'nedoporučuji', 'doporučuji', 'překlápím',
  'hledám', 'hledat', 'vybírám', 'vybrat', 'počkat', 'obchoduji', 'investuji',
  'nemůže', 'nechci', 'nechce', 'kdybych', 'kdyby',
].join('|'));

/** "beru" or "vzal jsem" plus a profit, in the same breath. */
const PROFIT = /(?<![\p{L}\p{N}])(?:zisk[\p{L}\p{N}]*|profit[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu;

/** The whole of it: the position, or the profit of it. */
const WHOLE = wordPattern([
  'celý', 'celá', 'celé', 'celou', 'celého', 'komplet', 'zbytek', 'zbytku', 'úplně',
].join('|'));

/**
 * A PART of it.
 *
 * "Zavřel jsem trochu Samsung, OXY, DELL" closes a part of three
 * positions, and a close of a part is a TRIM, not an exit: the position
 * is still open afterwards.
 */
const PARTIAL = wordPattern([
  'trochu', 'trocha', 'kousek', 'kousku', 'menší', 'část[\\p{L}\\p{N}]*',
  'polovin[\\p{L}\\p{N}]*', 'půlku', 'drob[\\p{L}\\p{N}]*', 'mál[\\p{L}\\p{N}]*',
  'většin[\\p{L}\\p{N}]*', 'lehce',
].join('|'));

/** "Beru půlku z MU a TSM" is taking half of what he has. */
const HALF_OUT = /(?<![\p{L}\p{N}])(?:beru|vzal)(?![\p{L}\p{N}])[^.!?\n]{0,20}(?<![\p{L}\p{N}])půlku\s+z(?![\p{L}\p{N}])/iu;

/** The fractions he writes, in words. */
const FRACTIONS = [
  { pattern: /(?<![\p{L}\p{N}])dvě\s+třetiny(?![\p{L}\p{N}])/iu, value: 2 / 3 },
  { pattern: /(?<![\p{L}\p{N}])polovin[\p{L}\p{N}]*(?![\p{L}\p{N}])/iu, value: 0.5 },
  { pattern: /(?<![\p{L}\p{N}])(?:půlku|půl)(?![\p{L}\p{N}])/iu, value: 0.5 },
  { pattern: /(?<![\p{L}\p{N}])třetin[\p{L}\p{N}]*(?![\p{L}\p{N}])/iu, value: 1 / 3 },
  { pattern: /(?<![\p{L}\p{N}])čtvrtin[\p{L}\p{N}]*(?![\p{L}\p{N}])/iu, value: 0.25 },
  { pattern: /(?<![\p{L}\p{N}])pětin[\p{L}\p{N}]*(?![\p{L}\p{N}])/iu, value: 0.2 },
  { pattern: /(?<![\p{L}\p{N}])šestin[\p{L}\p{N}]*(?![\p{L}\p{N}])/iu, value: 1 / 6 },
];

/** A fraction written as a ratio: "6/15". */
const NUMERIC_FRACTION = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/;

/** The sizes he states without a figure. */
const SIZE_WORDS = [
  'trochu', 'trocha', 'kousek', 'kousku', 'drobně', 'drobný', 'drobek', 'drobu',
  'mini pozice', 'minimální pozice', 'menší pozice', 'malé pozice', 'malá pozice',
  'celé pozice', 'celou pozici', 'celý', 'celá', 'celé', 'lehce', 'lehký příkup',
  'větší pozice', 'na swing', 'swing trade', 'první pozice', 'minimálně',
];

/** A percentage that is a SIZE, and not a RESULT. */
const SIZE_CUE = /(?:portfoli\w*|pozic\w*|velikost\w*|size|%\s*z\s*celku)/i;

/** The books. */
const RISKY = /\brisk\w*/i;
const MAIN = /veřejn\w*|hlavn\w*/i;

/**
 * Where a clause ends: a dash between spaces, a run of dots, or the end
 * of a sentence.
 *
 * "RR.." inside a ticker list is an ellipsis too, and cutting there is
 * harmless -- the name is in front of it.
 */
const CLAUSE = /\s+(?:-|–|—)\s+|\.{2,}|(?<=\p{L})\.\s+/gu;

/**
 * The clauses of a line.
 *
 * @param {string} line
 * @returns {string[]}
 */
function clausesOf(line) {
  const out = [];
  let start = 0;
  let match;
  CLAUSE.lastIndex = 0;
  while ((match = CLAUSE.exec(line)) !== null) {
    const piece = line.slice(start, match.index).trim();
    if (piece) out.push(piece);
    start = match.index + match[0].length;
  }
  const tail = line.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [line.trim()];
}

/**
 * Every verb of a text, in order.
 *
 * @param {string} text
 * @returns {{verb: object, match: RegExpExecArray}[]}
 */
function findVerbs(text) {
  const found = [];
  for (const verb of VERBS) {
    const match = verb.pattern.exec(text);
    if (match) found.push({ verb, match });
  }
  return found.sort((a, b) => a.match.index - b.match.index);
}

/**
 * The verb of a text, and where it is.
 *
 * @param {string} text
 * @returns {{verb: object, match: RegExpExecArray}|null}
 */
function findVerb(text) {
  const found = findVerbs(text);
  return found.length ? found[0] : null;
}

/**
 * The runs of a clause: the statements inside it.
 *
 * A clause with more than one STRONG verb is cut at the verbs, but only
 * where the two are actually separate: the text between two verbs has to
 * carry a conjunction or a comma. Otherwise the second verb belongs to
 * the first statement -- "Vzal jsem za to první pozice na KLA" is ONE
 * statement about KLA, and "první pozice" is a noun inside it.
 *
 * @param {string} clause
 * @returns {{text: string, verb: object, text_verb: string}[]}
 */
function runsOf(clause) {
  const verbs = findVerbs(clause);
  if (!verbs.length) return [];
  const strong = verbs.filter((entry) => !entry.verb.weak);
  if (strong.length < 2) {
    const first = verbs[0];
    return [{ text: clause, verb: first.verb, text_verb: first.match[0], verb_index: first.match.index }];
  }
  const boundaries = [];
  for (let i = 1; i < strong.length; i += 1) {
    const between = clause.slice(strong[i - 1].match.index + strong[i - 1].match[0].length, strong[i].match.index);
    if (!/,|\ba\b/.test(between)) continue;
    boundaries.push(strong[i].match.index);
  }
  if (!boundaries.length) {
    const first = verbs[0];
    return [{ text: clause, verb: first.verb, text_verb: first.match[0], verb_index: first.match.index }];
  }
  const starts = [0, ...boundaries];
  const ends = [...boundaries, clause.length];
  return starts.map((start, index) => {
    const end = ends[index];
    const own = verbs.find((entry) => entry.match.index >= start && entry.match.index < end);
    // A run with no verb of its own is NOT a statement: it is the tail of
    // the previous one ("NBIS držím zbytek" after "IREN jsem zavřel").
    if (!own) return null;
    return {
      text: clause.slice(start, end),
      verb: own.verb,
      text_verb: own.match[0],
      verb_index: own.match.index,
    };
  }).filter(Boolean);
}

/**
 * The words that make a statement a HYPOTHESIS rather than a trade.
 *
 * "Možná bude první nákup MELI" is not a purchase, and "u RR nákup je
 * pro mě ještě brzo" is not one either. A weak verb -- a NOUN standing
 * for a trade -- has to be tested against these, because a strong verb
 * is a realized trade by itself: "Dobral jsem na RISKY portfoliu OKLO a
 * ASTS čistě pokud by mělo dojít k rychlému obratu" is a trade even
 * though it is conditional.
 */
const HYPOTHETICAL = wordPattern([
  'možná', 'kdyby', 'kdybych', 'bych', 'byste', 'by', 'že', 'budu', 'budeme',
  'budete', 'plánuji', 'plánoval', 'chci', 'chtěl', 'chtěla', 'chtějí',
  'uvažuji', 'přemýšlím', 'sleduji', 'sleduju', 'koukám', 'zajímá', 'hledám',
].join('|'));

/**
 * The words that put a speaker in the sentence.
 *
 * The TALK channel is a channel of other people, and the author writes
 * about them there: "LEO končně nakoupil taky NBIS" and "fond koupil 12,41
 * milionu akcií ... čímž se Nebius stal jednou z jeho největších
 * investic" are NOT his trades, and they read exactly like his own.
 *
 * So a past-tense verb in the talk channel is his only when the clause
 * has a first-person marker in it. "IREN jsem nedávno zavřel komplet"
 * has one; the news item does not.
 */
const FIRST_PERSON = wordPattern([
  'jsem', 'jsme', 'mám', 'máme', 'můj', 'chci', 'budu', 'budeme', 'beru',
  'uvažuji', 'plánuji', 'přemýšlím', 'koukám', 'sleduji', 'hledám', 'investuji',
  'píšu', 'řeknu', 'mám',
].join('|'));

/**
 * A verb that carries its own conditional: "přikoupil bych až níž".
 *
 * The conditional has to sit right next to the verb to make it one. A
 * conditional that comes later qualifies the REASONING and not the act:
 * "Dobral jsem ... čistě pokud by mělo dojít" is a trade.
 */
const CONDITIONAL_AFTER = /^(?:\s+bych|\s+byste|\s+byl|\s+byla)\b/iu;

/**
 * An object that is not a name.
 *
 * "už jsem něco zavíral nedávno" closes SOMETHING, and the name in the
 * sentence is the sector he is talking about, not the position. So a
 * verb with an unspecified object in front of it is not a trade about a
 * named holding.
 */
const UNSPECIFIED_OBJECT = /(?:něco|nějak\w*)\s*$/iu;

/**
 * The words that may be LEFT when a line only names holdings.
 *
 * A line with no verb of its own CONTINUES the verb above it, and that
 * is how a list of names is read:
 *
 *   "Dobral jsem akcie, které dneska trpí
 *    RollsRoyce
 *    Samsung
 *    LEU
 *    BABA"
 *
 * But a line with no verb can also be COMMENTARY, and a commentary line
 * must not be read as a continuation:
 *
 *   "KLA mi přijde z čtveřice ASML, KLA, LAM research a AMAT" -- an
 *   opinion about which to buy, and not a purchase.
 *
 * So a continuation has to be a LIST: everything left after the holdings
 * are taken out has to be one of these words, or a figure.
 */
const CONTINUATION_WORDS = new Set([
  'a', 'i', 'do', 'na', 'z', 'od', 'si', 'se', 'mi', 'jsem', 'jsme', 'víc', 'víc',
  'akcie', 'akcií', 'akciemi', 'pozice', 'pozici', 'pozic', 'celé', 'celou',
  'celý', 'celá', 'celého', 'trochu', 'trocha', 'kousek', 'kousku', 'drobně',
  'drobný', 'drobek', 'kus', 'kusy', 'minimální', 'malé', 'malá', 'menší',
  'větší', 'lehce', 'jen', 'ještě', 'méně', 'právě',
]);

/**
 * Is this text nothing but a list of holdings?
 *
 * @param {string} text
 * @param {{index: number, length: number}[]} holdings
 * @returns {boolean}
 */
function isBareList(text, holdings) {
  const chars = [...text];
  for (const holding of holdings) {
    for (let i = holding.index; i < holding.index + holding.length; i += 1) {
      if (i >= 0 && i < chars.length) chars[i] = ' ';
    }
  }
  const words = chars.join('').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  for (const word of words) {
    if (!CONTINUATION_WORDS.has(word.toLowerCase())) return false;
  }
  return true;
}

/**
 * The accounts a line names.
 *
 * @param {string} line
 * @returns {string[]}
 */
function accountsOf(line) {
  const risky = RISKY.test(line);
  const main = MAIN.test(line);
  if (risky && main) return [ACCOUNT_MAIN, ACCOUNT_RISKY];
  if (risky) return [ACCOUNT_RISKY];
  if (main) return [ACCOUNT_MAIN];
  return [];
}

/**
 * The fraction a text states.
 *
 * @param {string} text
 * @returns {number|null}
 */
function fractionOf(text) {
  const ratio = NUMERIC_FRACTION.exec(text);
  if (ratio) {
    const value = Number(ratio[1]) / Number(ratio[2]);
    if (Number.isFinite(value) && value > 0 && value <= 1) return value;
  }
  for (const entry of FRACTIONS) {
    if (entry.pattern.test(text)) return entry.value;
  }
  return null;
}

/**
 * The size a text states: a figure, or a word.
 *
 * @param {string} text
 * @returns {{size_pct: number|null, size_note: string}}
 */
function sizeOf(text) {
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (percent) {
    const after = text.slice(percent.index + percent[0].length, percent.index + percent[0].length + 30);
    const before = text.slice(Math.max(0, percent.index - 30), percent.index);
    if (SIZE_CUE.test(after) || SIZE_CUE.test(before)) {
      const value = Number(percent[1]);
      if (value > 0 && value < 100) return { size_pct: value, size_note: '' };
    }
  }
  const lower = text.toLowerCase();
  for (const word of SIZE_WORDS) {
    if (lower.includes(word)) return { size_pct: null, size_note: word };
  }
  return { size_pct: null, size_note: '' };
}

/**
 * The fill he states: a number with a currency sign.
 *
 * @param {string} text
 * @returns {number|null}
 */
function priceOf(text) {
  const match = /(\d+(?:[.,]\d+)?)\s*\$/.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The result he states: a percentage on a reduction.
 *
 * @param {string} text
 * @returns {number|null}
 */
function resultOf(text) {
  const match = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && Math.abs(value) < 1000 ? value : null;
}

/**
 * The action of a statement, once the three rules have been applied.
 *
 * @param {string} action  the verb's action
 * @param {string} text  the run the statement is in
 * @param {number|null} fraction  the fraction the run states
 * @returns {string}
 */
function actionOf(action, text, fraction) {
  let out = action;
  // "beru zisk na X" and "beru menší profit na X" are a REDUCTION.
  if ((out === 'open' || out === 'add') && PROFIT.test(text)) {
    out = WHOLE.test(text) ? 'exit' : 'trim';
  }
  // "Beru půlku z MU a TSM" is taking half of what he has.
  if (out === 'open' && HALF_OUT.test(text)) out = 'trim';
  // "Zavřel jsem trochu Samsung" closes a PART of three positions.
  if (out === 'exit' && PARTIAL.test(text) && !WHOLE.test(text)) out = 'trim';
  // A close of a PART is a trim, and so is a close of a fraction.
  if (out === 'exit' && fraction !== null && fraction < 1 && !WHOLE.test(text)) out = 'trim';
  return out;
}

/**
 * Read one message.
 *
 * @param {string} content
 * @param {object} [options]
 * @param {Set<string>} [options.known]  the tickers a bare token may be
 * @param {string} [options.kind]  'trades' | 'talk'
 * @returns {object[]} one row per (run, ticker, account)
 */
function parseTradeMessage(content, options = {}) {
  const known = options.known;
  const kind = options.kind || 'trades';
  const rows = [];
  const text = String(content || '');
  if (!text.trim()) return rows;

  let carried = null;
  let account = ACCOUNT_MAIN;

  // The talk channel is a channel of other people. A message there with
  // no first-person marker in it is about somebody else, not about him:
  // "LEO končně nakoupil taky NBIS" and "fond koupil 12,41 milionu akcií"
  // read exactly like his own trades and are not.
  if (kind === 'talk' && !FIRST_PERSON.test(text)) return rows;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // The book the line names; a line that names none keeps the one above.
    const accounts = accountsOf(line);
    if (accounts.length) account = accounts[0];

    const statements = [];
    for (const clause of clausesOf(line)) {
      for (const run of runsOf(clause)) {
        if (kind === 'talk' && run.verb.tense !== 'past') continue;
        statements.push(run);
      }
    }

    if (!statements.length) {
      // No verb of its own: the line CONTINUES the one above, unless it
      // says it is not a trade or it is not a list of names.
      if (!carried || INTENT.test(line)) continue;
      const holdings = findHoldings(line, { known, wholeLine: line });
      if (!holdings.length) continue;
      if (!isBareList(line, holdings)) continue;
      statements.push({ text: line, verb: { action: carried.action }, text_verb: carried.text, verb_index: -1 });
    } else {
      carried = { action: statements[0].verb.action, text: statements[0].text_verb };
    }

    const seen = new Set();
    for (const statement of statements) {
      const clause = statement.text;
      const holdings = findHoldings(clause, { known, wholeLine: line });
      if (!holdings.length) continue;
      // A NOUN that stands for a trade is the subject only when the names
      // follow it: "Nákup Grab" is a purchase and "vidět ještě nižší
      // hodnoty pro nákup" is a comment about buying lower.
      if (statement.verb.weak && statement.verb_index >= 0
        && holdings.some((holding) => holding.index < statement.verb_index)) continue;
      // A weak verb with a hypothesis around it is not a trade.
      if (statement.verb.weak && HYPOTHETICAL.test(clause)) continue;
      // A verb that carries its own conditional is not a trade.
      if (statement.verb_index >= 0) {
        const after = clause.slice(statement.verb_index + statement.text_verb.length);
        if (CONDITIONAL_AFTER.test(after)) continue;
        // "už jsem něco zavíral nedávno" closes something, and the name
        // in the sentence is the sector, not the position.
        if (UNSPECIFIED_OBJECT.test(clause.slice(0, statement.verb_index))) continue;
      }

      const base = statement.verb.action;
      const statedFraction = fractionOf(clause);
      const action = actionOf(base, clause, statedFraction);
      const fraction = action === 'exit' || action === 'trim'
        ? (WHOLE.test(clause) ? 1 : statedFraction)
        : null;
      const size = action === 'open' || action === 'add' ? sizeOf(clause) : { size_pct: null, size_note: '' };
      const price = priceOf(clause);
      const result = action === 'exit' || action === 'trim' ? resultOf(clause) : null;

      const books = accounts.length ? accounts : [account];
      for (const holding of holdings) {
        if (seen.has(holding.ticker)) continue;
        seen.add(holding.ticker);
        for (const book of books) {
          rows.push({
            kind: 'action',
            action,
            ticker: holding.ticker,
            ticker_inferred: false,
            price,
            stop_price: null,
            stop_text: '',
            size_pct: size.size_pct,
            size_note: size.size_note,
            fraction,
            fraction_basis: fraction === null ? '' : (fraction === 1 ? 'all' : 'remaining'),
            stated_result_pct: result,
            atr_multiple: null,
            verb: statement.text_verb,
            account: book,
            content: text,
          });
        }
      }
    }
  }

  return rows;
}

/**
 * Read a channel's messages in order.
 *
 * @param {object[]} messages  `{ content, posted_at, id }`, any order
 * @param {object} [options]
 * @param {Set<string>} [options.known]
 * @param {string} [options.kind]
 * @returns {object[]} one row per (message, run, ticker, account)
 */
function readActionStream(messages, options = {}) {
  const ordered = [...messages].sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
  const out = [];
  for (const message of ordered) {
    for (const row of parseTradeMessage(message.content, options)) {
      out.push({
        ...row,
        message_id: message.id,
        posted_at: message.posted_at,
      });
    }
  }
  return out;
}

module.exports = {
  CLAUSE,
  FRACTIONS,
  INTENT,
  PARTIAL,
  PROFIT,
  SIZE_WORDS,
  VERBS,
  VERB_TABLE,
  WHOLE,
  accountsOf,
  clausesOf,
  findVerb,
  findVerbs,
  parseTradeMessage,
  readActionStream,
  runsOf,
  wordPattern,
};
