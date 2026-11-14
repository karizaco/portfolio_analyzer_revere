'use strict';

// What a show says about the MARKET, a SECTOR or a MACRO EVENT.
//
// WHY THIS EXISTS
//
// The two Benzinga shows say things that are not calls on any ticker:
//
//   "the Nasdaq is going to gap up here"
//   "semis are the leadership right now"
//   "CPI on Wednesday is the event of the week"
//   "I would be careful with the consumer names"
//
// `trade_signals` is a TICKER table, so none of these has a home there --
// they carry no ticker of their own. They are the source's own record of
// what the show thinks about the MARKET, and the user's own words describe
// it as "a market recap / sector analysis and preview of next week with
// ideas of some setups".
//
// So they go into `market_readings`, which keeps the same rules the
// signal table keeps:
//
//   * every row carries the EXACT text it was read from, so a claim is
//     always checkable against its evidence;
//   * the claim is tagged by KIND -- a recap of yesterday is not a
//     prediction;
//   * the parser version is on the row, so a re-run can be told apart.
//
// THE VOCABULARY
//
// The sectors are the eleven GICS ones, under the names a trading show
// says them: "semis", "chips", "banks", "oil", "the defensives". Each has
// the ETF it is scored with. The index phrases are the same ones the
// T3Live name finder already maps ("the Qs" -> QQQ).
//
// THE STANCE
//
// A reading's stance is what the words say about the direction, and the
// same negation and hedge rules apply that the signal extractor uses. A
// statement with no direction ("CPI is on Wednesday") is a WATCH, not a
// neutral call.

const DIRECTION_WORDS = {
  bullish: [
    /\b(?:bullish|rall(?:y|ied|ies|ying)|rall(?:y|ies)\b|strength|strong|leading|breakout|outperform(?:ing|s|ed)?|beat(?:ing)?|soar(?:ing|s|ed)|surg(?:e|es|ed|ing)|pop(?:ping|ped)?|ripp(?:ing|ped)?|bounc(?:e|es|ed|ing)|rebound|recover(?:y|ed|ing)?|constructive|advanc(?:e|es|ed|ing)|rally(?:ing)?)\b/i,
    /\bgap(?:s|ping)?\s+up\b/i,
    /\b(?:rose|rising|gained|gaining)\b/i,
    // "up 40 points", "up 550 points", "up 0.69%" -- how a show states
    // an index's move, and the most common form of the claim there is.
    // The NUMBER is what makes it unambiguous: a bare "up" is "pick up".
    // A PERCENT is the same claim in a different unit, and it is the
    // form a per-name move takes ("The SPY was up 0.69%"), where a
    // points count is an index's.
    //
    // THE END IS `(?![\w%])`, NOT `\b`. `%` is not a word character, so
    // `\b` after it never matches and the pattern was DEAD for the
    // percent form it was written for. Same shape as the Czech `\b` bug
    // in the Sevcik vocabulary: `\b` is an ASCII-word boundary and
    // silently fails at anything that is not a letter, digit or `_`.
    /\bup\s+[\d.,]+\s*(?:points?|pts?|%|percent(?:age)?)(?![\w%])/i,
  ],
  bearish: [
    /\b(?:bearish|weak(?:ness|er)?|underperform(?:ing|s|ed)?|laggard(?:s)?|sell(?:ing)?\s+off|selloff|crash(?:ing|ed|es)?|tumble(?:d|ing)?|drop(?:ping|ped|s)?|fall(?:ing|en|s)?|sinking|sank|correction|breakdown|avoid(?:s|ed|ing)?|cautious|caution|hedge(?:d|ing)?|warning|overvalu(?:ed|ation)|bubble|unwind(?:ing)?|retreat(?:ing)?|slump(?:ping|ed)?|tanked|plunge(?:d|ing)?)\b/i,
    /\bgap(?:s|ping)?\s+down\b/i,
    /\bsold\s+off\b/i,
    /\b(?:fell|falling|declin(?:e|ed|ing)|slid(?:e|ing)?)\b/i,
    // `(?![\w%])` and not `\b` -- see the note on the "up" form above.
    /\bdown\s+[\d.,]+\s*(?:points?|pts?|%|percent(?:age)?)(?![\w%])/i,
  ],
};

const NEGATION = /\b(?:not|isn'?t|is\s+not|aren'?t|no\s+longer|don'?t|do\s+not|didn'?t|did\s+not|never|can'?t|cannot|wouldn'?t|would\s+not|won'?t|will\s+not|haven'?t|have\s+not|hasn'?t|has\s+not|without)\s+(?:\w+\s+){0,3}?(?:bullish|bearish|rally|drop|strength|weakness|bull|bear|up|down)\b/i;

/**
 * The subjects a reading can be about, and the ETF it is scored with.
 *
 * The sector names are the ones a trading show says, not the GICS names:
 * "semis", "chips", "banks", "oil", "the defensives", "the consumer".
 */
const SUBJECTS = [
  // -- the market as a whole ------------------------------------------
  // "below-market puts" is not a market reading, and "those stocks are
  // getting the beating" is three stocks, not the market. So the hyphen
  // and the plural are excluded.
  { scope: 'market', subject: 'the market', proxy: 'SPY', pattern: /(?<!-)\b(?:market|markets|tape|equities)\b/i },
  { scope: 'market', subject: 'the Nasdaq', proxy: 'QQQ', pattern: /\b(?:the\s+)?(?:nasdaq|nasdaq\s+100|ndx|the\s+q'?s|q'?qq|qqq)\b/i },
  { scope: 'market', subject: 'the S&P 500', proxy: 'SPY', pattern: /\b(?:the\s+)?(?:s\s*&\s*p\s*500|s\s+and\s+p|sp\b|spx|spy)\b/i },
  { scope: 'market', subject: 'the Russell', proxy: 'IWM', pattern: /\b(?:the\s+)?(?:russell(?:\s+2000)?|small\s+caps?|the\s+rut)\b/i },
  { scope: 'market', subject: 'the Dow', proxy: 'DIA', pattern: /\b(?:the\s+)?(?:dow(?:\s+jones)?|the\s+industrials)\b/i },

  // -- sectors ---------------------------------------------------------
  { scope: 'sector', subject: 'Semiconductors', proxy: 'SMH', pattern: /\b(?:semis?|semiconductors?|chips?|chip\s+stocks?|the\s+chip[s]?)\b/i },
  { scope: 'sector', subject: 'Technology', proxy: 'XLK', pattern: /\b(?:tech(?:nology)?|big\s+tech|the\s+techs?|mag\s*7|magnificent\s+seven|mega\s+caps?)\b/i },
  { scope: 'sector', subject: 'Financials', proxy: 'XLF', pattern: /\b(?:financials?|banks?|the\s+banks?|broker[\s-]dealers?|credit\s+cards?)\b/i },
  { scope: 'sector', subject: 'Energy', proxy: 'XLE', pattern: /\b(?:energy|oil|crude|the\s+oils?|gasoline|natural\s+gas|the\s+energy\b|drillers?|refiners?|upstream|downstream)\b/i },
  { scope: 'sector', subject: 'Healthcare', proxy: 'XLV', pattern: /\b(?:health\s*care|healthcare|biotech(?:s)?|pharma(?:ceuticals?)?|the\s+biotechs?|drugmakers?)\b/i },
  { scope: 'sector', subject: 'Industrials', proxy: 'XLI', pattern: /\b(?:industrials?|aerospace|defense(?:\s+stocks)?|the\s+defense[s]?)\b/i },
  { scope: 'sector', subject: 'Materials', proxy: 'XLB', pattern: /\b(?:materials?|metals?|miners?|the\s+metals?|gold|silver|copper|steel|uranium)\b/i },
  { scope: 'sector', subject: 'Utilities', proxy: 'XLU', pattern: /\b(?:utilities|the\s+utilities|power\s+names?|electric\s+utilities)\b/i },
  { scope: 'sector', subject: 'Real Estate', proxy: 'XLRE', pattern: /\b(?:real\s+estate|reits?|the\s+reits?|housing)\b/i },
  { scope: 'sector', subject: 'Consumer Discretionary', proxy: 'XLY', pattern: /\b(?:consumer\s+discretionary|retail(?:ers)?|the\s+retailers?|autos?)\b/i },
  { scope: 'sector', subject: 'Consumer Staples', proxy: 'XLP', pattern: /\b(?:consumer\s+staples|staples|defensives?|the\s+defensives)\b/i },
  { scope: 'sector', subject: 'Communication Services', proxy: 'XLC', pattern: /\b(?:communication\s+services?|the\s+media\s+names?|telecom(?:s)?)\b/i },

  // -- macro events ------------------------------------------------------
  { scope: 'macro_event', subject: 'CPI', proxy: '', pattern: /\b(?:cpi|consumer\s+price\s+index|inflation)\b/i },
  { scope: 'macro_event', subject: 'the Fed', proxy: '', pattern: /\b(?:the\s+fed|fomc|federal\s+reserve|rate\s+(?:decision|hike|cut)|jerome\s+powell|powell)\b/i },
  { scope: 'macro_event', subject: 'the jobs report', proxy: '', pattern: /\b(?:jobs\s+report|non[\s-]?farm|payrolls|the\s+nfp|unemployment)\b/i },
  { scope: 'macro_event', subject: 'PCE', proxy: '', pattern: /\b(?:pce|personal\s+consumption)\b/i },
  { scope: 'macro_event', subject: 'earnings week', proxy: '', pattern: /\b(?:earnings\s+(?:season|week|calendar)|reporting\s+season)\b/i },
  { scope: 'macro_event', subject: 'the bond market', proxy: 'TLT', pattern: /\b(?:bonds?|treasur(?:ies|y)|the\s+10[\s-]?year|the\s+2[\s-]?year|yields?|rates?|the\s+rates?|the\s+bond\s+market)\b/i },
  { scope: 'macro_event', subject: 'oil', proxy: 'USO', pattern: /\b(?:crude|oil\s+prices?|wti|brent|the\s+oil\b)\b/i },
  { scope: 'macro_event', subject: 'gold', proxy: 'GLD', pattern: /\b(?:gold|the\s+gold\b|precious\s+metals)\b/i },
  { scope: 'macro_event', subject: 'the dollar', proxy: 'UUP', pattern: /\b(?:the\s+dollar|dollar\s+index|dxy|greenback)\b/i },
  { scope: 'macro_event', subject: 'crypto', proxy: 'BTC', pattern: /\b(?:crypto(?:currency)?|bitcoin|btc|ethereum|the\s+coins?)\b/i },
];

/**
 * How close a direction word has to be to the subject to belong to it.
 *
 * YouTube's auto-captions are ROLLING: a line is a two-line display that
 * scrolls, so a caption holds the tail of one thought and the head of the
 * next. "We'll see what happens on General Electric today if I'm able to
 * nail this one. Let's get to some other stocks" is two clauses, and a
 * direction word anywhere in it does not belong to the subject anywhere
 * in it.
 *
 * So the stance is the direction word NEAREST the subject, and only one
 * within this distance counts.
 */
const STANCE_WINDOW_CHARS = 45;

/**
 * The words that are too weak to carry a stance.
 *
 * "I like it" rates the setup, not the direction -- the T3Live extractor
 * measured 1,021 occurrences of it and it is said about shorts as often
 * as about longs. "love" and "prefer" are the same family.
 */
const WEAK_WORDS = new Set(['like', 'love', 'prefer', 'opportunity', 'opportunities', 'want', 'need']);

/**
 * Every direction word in the text, with where it is.
 *
 * @param {string} text
 * @returns {Array<{stance: string, at: number}>}
 */
function directionWords(text) {
  const window = String(text || '');
  const found = [];
  for (const [stance, patterns] of Object.entries(DIRECTION_WORDS)) {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, 'gi');
      let match = regex.exec(window);
      while (match) {
        found.push({ stance, at: match.index, word: match[0] });
        match = regex.exec(window);
      }
    }
  }
  // A weak word is not a direction, whatever the pattern said.
  return found.filter((entry) => !WEAK_WORDS.has(String(entry.word || '').toLowerCase()));
}

/**
 * The stance the words near a subject state, or null when they state none.
 *
 * The NEAREST direction word wins. "the financials are strong but the
 * semiconductors are very weak" is two claims about two subjects, and
 * each subject's stance is the word next to it. Taking every direction
 * word in the window instead makes both subjects 'mixed', which is a
 * reading about nothing.
 *
 * @param {string} text
 * @param {number} [subjectAt] - where the subject is in the text
 * @returns {string|null}
 */
function stanceNear(text, subjectAt, options = {}) {
  const window = String(text || '');
  const at = subjectAt === undefined ? 0 : subjectAt;
  const near = directionWords(window)
    .map((entry) => ({ ...entry, distance: Math.abs(entry.at - at) }))
    .filter((entry) => entry.distance <= STANCE_WINDOW_CHARS);
  if (!near.length) return null;

  const after = near.filter((entry) => entry.at >= at);

  // THE CLAUSE TEST. The direction word and the subject must be in the
  // SAME SENTENCE. "After the subject" is not the same rule, and it is
  // not the right one: the subject is often the OBJECT of the verb
  // ("rates crashed the market", "Treasury rising"), and then its
  // predicate comes BEFORE it. What separates a claim from a stray
  // direction word is not the order but the CLAUSE.
  // THE CLAUSE TEST. The direction word and the subject must be in the
  // same CLAUSE. "After the subject" is not the same rule, and it is not
  // the right one: the subject is often the OBJECT of the verb ("rates
  // crashed the market", "Treasury rising"), and then its predicate
  // comes BEFORE it. What separates a claim from a stray direction word
  // is the clause, not the order.
  //
  // A clause boundary is a full stop, or a comma followed by a
  // conjunction -- ", and yet the S&P 500 was up 40 points" is two
  // clauses, and the "weak" in the first one says nothing about the
  // second.
  const CLAUSE_BREAK = /(?:[.?!]|[,;]\s+(?:and|but|so|yet|then|while|although|though|because|which|that)\b)/i;
  const sameSentence = options.sameClause
    ? near.filter((entry) => {
      const from = Math.min(entry.at, at);
      const to = Math.max(entry.at, at);
      return !CLAUSE_BREAK.test(window.slice(from, to));
    })
    : near;
  if (!sameSentence.length) return null;

  // The predicate FOLLOWS its subject in English: "the financials are
  // strong", "the semiconductors look weak". So a direction word AFTER
  // the subject belongs to it, and one before it belongs to the PREVIOUS
  // subject. Taking the nearest word by character distance gets this
  // wrong -- in "the financials are strong but the semiconductors are
  // very weak", 'strong' is nearer to 'semiconductors' than 'weak' is --
  // so the words after the subject are preferred, and the words before
  // are the fallback.
  //
  // THE `afterOnly` OPTION TURNS THE FALLBACK OFF. The fallback is
  // measured to be the largest single source of wrong readings: a
  // direction word before the subject belongs to the PREVIOUS subject,
  // so "were weak, and yet the S&P 500 was up 40 points" reads as a
  // BEARISH reading on the S&P when the segment says it was up 40
  // points. The cost is a lost reading whenever the speaker's predicate
  // is truncated -- which the caption format does constantly.
  const afterSame = sameSentence.filter((entry) => entry.at >= at);
  let pool;
  if (options.afterOnly) {
    pool = afterSame;
  } else {
    pool = afterSame.length ? afterSame : sameSentence;
  }
  if (!pool.length) return null;

  const closest = Math.min(...pool.map((entry) => entry.distance));
  const at_ = pool.filter((entry) => entry.distance === closest);
  const stances = new Set(at_.map((entry) => entry.stance));

  // A negation reverses the direction it applies to.
  const negated = NEGATION.test(window);
  if (stances.size > 1) return 'mixed';
  const stance = [...stances][0];
  if (!negated) return stance;
  return stance === 'bullish' ? 'bearish' : 'bullish';
}

/**
 * The stance a sentence states, or null when it states none.
 *
 * @param {string} text
 * @returns {string|null}
 */
function stanceOf(text) {
  return stanceNear(text, 0);
}

/**
 * The shortest evidence a reading may have.
 *
 * YouTube's auto-captions cut a sentence into rolling fragments, so a
 * segment can be "sucks like Kanan which is a crypto Miner" -- a piece of
 * a sentence with no claim in it. A reading whose evidence is shorter
 * than this is a fragment, and a fragment is not a reading.
 */
const MIN_EVIDENCE_CHARS = 40;

/**
 * Is the subject inside a quotation?
 *
 * "all the headlines say, 'Oh, rates crashed the market'" is the market's
 * opinion, not the host's. A quote is a REPORTED reading, and it is
 * tagged as one so the outcome analysis leaves it out.
 *
 * @param {string} text
 * @param {number} at - where the subject is
 * @returns {boolean}
 */
function isQuoted(text, at) {
  const window = String(text || '');
  const before = window.slice(0, at);
  // The two quote styles are counted SEPARATELY. A character class with
  // both the straight quote and the closing curly quote counts a straight
  // quote as an opening AND a closing one, so every straight-quoted
  // sentence looked closed.
  const straight = (before.match(/"/g) || []).length;
  const openCurly = (before.match(/“/g) || []).length;
  const closeCurly = (before.match(/”/g) || []).length;
  return (straight % 2 === 1) || (openCurly > closeCurly);
}

/**
 * The readings a transcript states.
 *
 * A reading is a sentence that names a subject (a market, a sector, a
 * macro event) AND a direction. The sentence it came from is kept
 * verbatim.
 *
 * A MIXED reading is not published. "the Nasdaq is down a lot" inside a
 * sentence that also says "I like" is not a mixed view of the Nasdaq; it
 * is a caption fragment with two unrelated halves. A reading that cannot
 * be resolved to one direction says nothing, and publishing it would fill
 * the report with rows that carry no opinion.
 *
 * @param {Array<{text: string, start_sec?: number, end_sec?: number}>} segments
 * @param {object} [options]
 * @param {string} [options.videoId]
 * @param {string} [options.parserVersion]
 * @param {string} [options.section] - the section the reading was made in
 * @returns {Array<object>}
 */
function extractReadings(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const readings = [];

  for (let index = 0; index < list.length; index += 1) {
    const text = String(list[index].text || '');
    if (!text.trim()) continue;
    const evidence = text.replace(/\s+/g, ' ').trim();
    if (evidence.length < MIN_EVIDENCE_CHARS) continue;

    for (const subject of SUBJECTS) {
      const regex = new RegExp(subject.pattern.source, 'gi');
      let match = regex.exec(text);
      while (match) {
        // A QUESTION is not a claim. "What's the most overvalued stock in
        // the S&P 500?" is the host asking, and publishing it as a
        // bearish reading on the index would put a position in a report
        // that nobody took.
        if (text.includes('?')) { match = regex.exec(text); continue; }
        // The stance is the direction word NEAR the subject, so a rolling
        // caption's two halves do not become one mixed reading.
        const stance = stanceNear(text, match.index, options.stanceOptions || {});
        if (stance === 'bullish' || stance === 'bearish') {
          // The section is read for the segment the reading is in, not
          // once for the whole video: a show moves from the recap to the
          // preview, and a reading in the preview is a different kind of
          // claim from one in the recap.
          const section = typeof options.sectionAt === 'function'
            ? options.sectionAt(index)
            : (options.section || '');
          const quoted = isQuoted(text, match.index);
          readings.push({
            video_id: options.videoId || '',
            transcript_id: options.transcriptId || null,
            scope: subject.scope,
            subject: subject.subject,
            proxy_ticker: subject.proxy || '',
            stance,
            claim_kind: quoted ? 'reported' : (section === 'recap' ? 'retrospective' : 'forward'),
            section,
            horizon_text: '',
            event_date: '',
            event_time_sec: Number(list[index].start_sec) || 0,
            segment_start_index: index,
            segment_end_index: index,
            evidence_text: evidence,
            parser_version: options.parserVersion || '',
          });
        }
        match = regex.exec(text);
      }
    }
  }

  // One reading per (subject, stance) per video. A show that says "semis
  // are the leadership" three times says it once, and a reader wants the
  // stance rather than the repetition -- so the FIRST mention is kept,
  // with its sentence as the evidence.
  const seen = new Set();
  return readings.filter((reading) => {
    const key = `${reading.scope}|${reading.subject}|${reading.stance}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  DIRECTION_WORDS,
  MIN_EVIDENCE_CHARS,
  STANCE_WINDOW_CHARS,
  SUBJECTS,
  extractReadings,
  stanceNear,
  stanceOf,
};
