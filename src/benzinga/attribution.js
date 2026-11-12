'use strict';

// Is this claim the HOST's own, or somebody else's opinion that the host
// read out?
//
// WHY THIS FILE EXISTS
//
// Benzinga is a NEWS channel. Its hosts say things like
//
//   "Wedbush's Dan Ives remains very bullish on Tesla"
//   "Morgan Stanley raised its price target on Nvidia to 250 dollars"
//
// and the shared extractor reads both as the HOST'S OWN call. Measured on
// the shared extractor with T3Live's English settings (2026-11-11):
//
//   "Wedbush's Dan Ives remains very bullish on Tesla heading into next
//    week."  ->  TSLA, bullish, forward, confidence 0.83
//
// That is a published holding that nobody at Benzinga made. A portfolio
// report of unchecked claims is worth nothing, and this one would be
// actively wrong: it would attribute an analyst's opinion to the source
// and score it as a prediction.
//
// THE RULE
//
// A claim is REPORTED when somebody other than the speaker is the one
// stating it. The cues are:
//
//   * an explicit attribution  -- "according to", "analysts say"
//   * a THIRD-PERSON subject    -- "Ives remains bullish", "Goldman says"
//   * a price target or a rating -- "raised its price target", "reiterated"
//   * a forecast verb           -- "expects", "projects", "forecasts"
//
// and NOT when the speaker is the one making the statement. "I remain
// bullish", "my price target", "we expect" are the host's own words, and
// the first-person check is what tells the two apart. Without it, the
// rule would flag the host's own calls -- which are the point of the
// source.
//
// A reported claim is NOT DROPPED. It is kept and TAGGED, with
// `claim_kind='reported'`, so the outcome analysis can leave it out of the
// prediction scoring and a reader can still see what was said. The same
// way the pipeline keeps a retrospective claim and tags it.

/**
 * The cues that mark a third party's statement.
 *
 * Each is a RegExp; the first-person check below is applied to the text
 * immediately BEFORE each match, so "I expect" and "my price target" do
 * not fire.
 */
const REPORTED_CUES = [
  /\baccording\s+to\b/i,
  /\banalysts?\b/i,
  /\b(?:wall\s+street|the\s+street)\s+(?:is|are|expect|expects)\b/i,
  /\bprice\s+target\b/i,
  /\b(?:raised|cut|lowered|upgraded|downgraded|reiterated|initiated|set)\b[^.!?]{0,40}\b(?:target|rating|price)\b/i,
  /\b(?:ratings?|consensus|price\s+targets?)\b/i,
  /\breported\b/i,
  /\b(?:expects?|expecting|projects?|projecting|forecast(?:s|ed)?|predicts?|predicted)\b/i,
  /\b(?:said|says|stated|states)\b/i,
  /\b(?:upgrade|downgrade)\w*\b/i,
  // A THIRD-PERSON subject before a sentiment verb: "Ives remains bullish",
  // "Goldman is neutral on". The subject must be a capitalised name that
  // is not the speaker, so "I remain bullish" is not caught here.
  /\b([A-Z][\w.'&-]*(?:\s+[A-Z][\w.'&-]*){0,3})\s+(?:remains?|stays?|is|are|was|were|looks?|sees?)\s+(?:very\s+|extremely\s+|still\s+)?(?:bullish|bearish|neutral|cautious)\b/,
];

/**
 * The first-person markers that make a statement the speaker's own.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isFirstPerson(text) {
  return /\b(?:i|we|my|our|me|us)\b/i.test(String(text || ''));
}

/**
 * Does this window report somebody else's opinion?
 *
 * @param {string} text
 * @returns {{reported: boolean, cue: string}}
 */
function reportedClaim(text) {
  const window = String(text || '');
  if (!window.trim()) return { reported: false, cue: '' };

  for (const cue of REPORTED_CUES) {
    const match = cue.exec(window);
    if (!match) continue;

    // The subject of the cue decides who is speaking. A first-person
    // subject in the words just before the cue means the host is the one
    // making the statement -- "I expect", "my price target", "we remain".
    const before = window.slice(Math.max(0, match.index - 40), match.index);
    if (isFirstPerson(before)) continue;

    // For the third-person-subject cue, the subject itself must not be
    // the speaker. "I remain bullish" is caught by the first-person
    // check above; this covers the capitalised-name form.
    if (cue === REPORTED_CUES[REPORTED_CUES.length - 1]) {
      const subject = match[1] || '';
      if (/^(?:I|We|My|Our)$/.test(subject)) continue;
    }
    return { reported: true, cue: match[0].trim() };
  }
  return { reported: false, cue: '' };
}

/**
 * The tickers a BROKER is named by, so a broker's own name never yields a
 * call on the broker's ticker.
 *
 * "Morgan Stanley raised its price target on Nvidia" must not publish MS.
 */
const BROKER_NAMES = [
  'GS', 'MS', 'JPM', 'BAC', 'C', 'WFC', 'UBS', 'BofA', 'BLK', 'SCHW', 'JEF', 'HSBC', 'DB', 'CS', 'NFS',
];

/**
 * Is this ticker the name of a BROKER in the window?
 *
 * @param {string} text
 * @param {string} ticker
 * @returns {boolean}
 */
function isBrokerMention(text, ticker) {
  const token = String(ticker || '').toUpperCase();
  if (!BROKER_NAMES.includes(token)) return false;
  const window = String(text || '');
  // The broker's own name, spelled out, is the evidence that the sentence
  // is about the broker rather than about a stock.
  const spelled = {
    GS: 'goldman', MS: 'morgan stanley', JPM: 'jpmorgan', BAC: 'bank of america',
    C: 'citigroup', WFC: 'wells fargo', UBS: 'ubs', BofA: 'bank of america', BLK: 'blackrock',
    SCHW: 'schwab', JEF: 'jefferies', HSBC: 'hsbc', DB: 'deutsche bank', CS: 'credit suisse', NFS: 'northfield',
  };
  const name = spelled[token];
  if (name && new RegExp(name, 'i').test(window)) return true;
  return new RegExp(`\\b${token}\\b`).test(window) && /\b(?:analyst|desk|note|research|bank)\b/i.test(window);
}

module.exports = {
  BROKER_NAMES,
  REPORTED_CUES,
  isBrokerMention,
  isFirstPerson,
  reportedClaim,
};
