'use strict';

// Find company names in an ENGLISH transcript.
//
// WHY THIS IS DIFFERENT FROM czechNames.js
//
// The Czech name finder (`src/sevcik/czechNames.js`) uses a POSITION-BASED
// rule: a capitalised word is only a name candidate when it is NOT the first
// word of its sentence, because Czech capitalises every sentence-initial word.
//
// English does NOT capitalise every sentence-initial word (beyond the
// normal sentence-start capitalisation rule). So the Czech rule would
// INCORRECTLY drop names at sentence starts:
//
//   "Apple is breaking out today" → "Apple" dropped (sentence start)
//   "Nvidia looks extended" → "Nvidia" dropped (sentence start)
//
// In English, the evidence for a company name is simpler:
//
//   1. The token starts with a capital letter and is not all-lowercase.
//   2. It is not a common English word or trading term that happens to be
//      capitalised (the ENGLISH stop-word list).
//   3. It matches a company name in the company names table.
//
// THE CAPS SYMBOL PATH
//
// English traders say tickers out loud in CAPS: "I'm looking at NVDA here",
// "AAPL is setting up". These are found by the SYMBOL path in
// `signalExtractor.js`, not by this module. This module handles mixed-case
// names like "Apple", "Nvidia", "Amazon".
//
// In English, there is no need for the confirmed-symbols gate on the CAPS
// path -- English speakers saying "NVDA" reliably means the ticker, unlike
// Czech speech where CAPS fragments appear in every sentence.
//
// STOP WORDS
//
// Trading English has its own ambiguous vocabulary: "Long", "Short", "Open",
// "Close", "Volume", "Market" are capitalised in trading transcripts and are
// also real words. These are excluded explicitly.

const { matchCompanyName } = require('../sevcik/companyNames');

/**
 * English words that are capitalised in trading contexts but are NOT company
 * names. Every entry was observed in trading video transcripts.
 *
 * The trading direction words ("Long", "Short") are the most important: they
 * appear dozens of times per video and are NEVER company names.
 */
const ENGLISH_STOP_WORDS = new Set([
  // Direction / trading vocabulary
  'long', 'short', 'buy', 'sell', 'hold', 'cover', 'add', 'trim',
  'bullish', 'bearish', 'neutral',
  // Market structure
  'open', 'close', 'high', 'low', 'market', 'volume', 'float', 'spread',
  'gap', 'level', 'zone', 'area', 'line', 'trend', 'channel', 'range',
  'support', 'resistance', 'breakout', 'breakdown', 'reversal',
  // Time
  'today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'morning', 'afternoon', 'evening',
  'week', 'month', 'quarter', 'year',
  // Prices and quantities
  'price', 'target', 'stop', 'entry', 'exit', 'profit', 'loss',
  'risk', 'reward', 'size', 'position', 'shares', 'contracts', 'options',
  'calls', 'puts', 'strike', 'expiry',
  // Show vocabulary
  'actionable', 'swing', 'trade', 'ideas', 'club', 'morning', 'show',
  'live', 'stream', 'watch', 'chat',
  // Common English words that happen to be short and capitalized
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'must',
  'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'my',
  'we', 'our', 'they', 'their', 'he', 'she', 'him', 'her', 'his',
  'what', 'when', 'where', 'why', 'how', 'which', 'who', 'whose',
  'not', 'no', 'yes', 'so', 'very', 'just', 'like', 'as', 'if',
  'then', 'than', 'up', 'down', 'out', 'off', 'over', 'under', 'back',
  'right', 'left', 'here', 'there', 'now', 'still', 'already', 'also',
  'even', 'only', 'both', 'all', 'each', 'some', 'any', 'more', 'most',
  // T3Live host names are not company names
  'sami', 'scott', 'derreck', 'derrick', 'adam', 'michael', 'redler', 'abusaad',
  // PEOPLE are not companies. "Trump" resolved to DJT (Trump Media) and
  // "an AI engineer from OpenAI" resolved to AI; in market talk the
  // president, the Fed chair and a CEO are named far more often than any
  // stock that carries their name.
  'trump', 'biden', 'powell', 'yellen', 'musk', 'elon', 'jensen', 'huang',
  'zuckerberg', 'bezos', 'cook', 'jobs', 'dimon', 'saylor', 'cathie', 'wood',
]);

/**
 * Acronyms that English speech-to-text always writes in CAPITALS and that
 * are also listed tickers. In a caption they are the word, not the stock:
 * "AI" is the theme (not C3.ai), "ATR" the indicator (not AptarGroup), "PM"
 * the time of day. Measured against the 10,489-ticker lexicon.
 *
 * ETFs that ARE the subject when said (GLD, SLV, USO, UNG) are NOT here.
 */
const ENGLISH_SYMBOL_STOPLIST = new Set([
  'AI', 'IT', 'USA', 'UK', 'EU', 'DC', 'SF', 'TV', 'PC', 'AM', 'PM', 'DD',
  'CTO', 'COO', 'IRS', 'CIA', 'API', 'AR', 'HQ', 'FA', 'RSI', 'SMA', 'EMA',
  'ATR', 'TOP', 'ALL', 'NOW', 'RUN', 'MAX', 'MIN', 'LIVE', 'XRP', 'SOL',
  // "the 200 MA", "20 MA on the daily" -- the moving average, not
  // Mastercard. 38 swing-show signals were MA before this row.
  'MA',
]);

/**
 * Index and market phrases, and the ETF a call on them is scored with.
 *
 * Scott Redler's 630 Club is mostly index commentary -- "the Qs", "the
 * S&P", "the Russell" -- and the auto-captions write "the Qs" as "the cues".
 * The matched phrase is the evidence; the ETF is the tradeable proxy.
 */
const ENGLISH_INDEX_ALIASES = [
  { pattern: /\bthe\s+(?:Q's|Qs|QQQs|cues|queues)\b/gi, ticker: 'QQQ' },
  { pattern: /\b(?:the\s+)?Nasdaq(?:\s+100|\s+composite)?\b/gi, ticker: 'QQQ' },
  { pattern: /\bS\s*&\s*P(?:\s*500)?\b|\bS\s+and\s+P(?:\s*500)?\b|\bSPX\b/gi, ticker: 'SPY' },
  { pattern: /\b(?:the\s+)?Russell(?:\s+2000)?\b/g, ticker: 'IWM' },
  { pattern: /\bthe\s+Dow(?:\s+Jones)?\b/gi, ticker: 'DIA' },
];

/**
 * Is this token a capitalised company name candidate in an English transcript?
 *
 * The token is a candidate when:
 *   - It starts with an uppercase letter, AND
 *   - It is not all-uppercase (all-uppercase is handled by the SYMBOL path), AND
 *   - It is not in the English stop-word list, AND
 *   - It is at least 3 characters long
 *
 * @param {string} token
 * @returns {boolean}
 */
/**
 * The phrases in which a company's word is NOT the company.
 *
 * A company whose name is also a piece of trading vocabulary cannot be
 * rejected on the word alone -- the word IS the company most of the time.
 * It has to be rejected on what FOLLOWS it.
 *
 * "Iron" is how traders say IREN (it is named beside NBIS and CIFR in the
 * corpus, and the hosts trade its options), so the word has to resolve.
 * But "iron condor" and "iron butterfly" are OPTIONS STRATEGIES and "Iron
 * Man" is a triathlon. Measured over the corpus: of 39 "iron" mentions in
 * the Benzinga transcripts, 30 are one of those phrases; of 1,164 in the
 * T3Live transcripts, 222 are.
 *
 * Each entry is `name -> the words that may not follow it`. The test is on
 * the text AFTER the token, so a phrase is rejected and a bare mention of
 * the company is not.
 */
const ENGLISH_PHRASE_COLLISIONS = new Map([
  ['iron', /^\s+(?:condors?|butterfl(?:y|ies)|fl(?:y|ies)|man|out|it\s+out)\b/i],
]);

/**
 * Is this token the first word of a phrase in which it is not a company?
 *
 * @param {string} spoken
 * @param {string} text the whole text the token came from
 * @param {number} index where the token starts in that text
 * @returns {boolean}
 */
function isPhraseCollision(spoken, text, index) {
  const rule = ENGLISH_PHRASE_COLLISIONS.get(spoken.toLowerCase());
  if (!rule) return false;
  return rule.test(text.slice(index + spoken.length));
}

function isEnglishNameCandidate(token) {
  if (!token || token.length < 3) return false;
  // Must start with a capital letter
  if (!/^[A-Z]/.test(token)) return false;
  // All-uppercase tokens are handled by the SYMBOL path
  if (token === token.toUpperCase() && /^[A-Z]{2,}$/.test(token)) return false;
  const lower = token.toLowerCase();
  if (ENGLISH_STOP_WORDS.has(lower)) return false;
  return true;
}

// matchCompanyName scans the 10k-row name table on every call, and an
// English transcript capitalises the same few hundred words over and over
// (every sentence start). The answer depends only on the word and the
// lexicon, so it is cached per lexicon object.
const matchCache = new WeakMap();
const NO_LEXICON = {};

function cachedMatch(spoken, options) {
  const owner = options && options.lexicon ? options.lexicon : NO_LEXICON;
  let cache = matchCache.get(owner);
  if (!cache) {
    cache = new Map();
    matchCache.set(owner, cache);
  }
  if (!cache.has(spoken)) cache.set(spoken, matchCompanyName(spoken, options));
  return cache.get(spoken);
}

/**
 * The candidate company names in an English transcript.
 *
 * Unlike the Czech finder, this does NOT exclude sentence-start tokens.
 * In English, "Apple is setting up nicely" is a valid name occurrence even
 * though "Apple" starts the sentence.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Set<string>} [options.lexicon] - the tickers that may be reported
 * @param {string} [options.tablePath]
 * @returns {Array<{ticker: string|null, spoken: string, index: number, viaAlias: boolean, ambiguous: string[]}>}
 */
function findEnglishCompanyNames(text, options = {}) {
  const str = String(text || '');
  if (!str.trim()) return [];

  const found = [];
  const seen = new Set();

  // Index phrases first: "the Qs", "the S&P". Each phrase resolves to its
  // ETF directly, without the company-name table.
  const lexicon = options.lexicon instanceof Set ? options.lexicon : null;
  for (const alias of ENGLISH_INDEX_ALIASES) {
    const regex = new RegExp(alias.pattern.source, alias.pattern.flags);
    let aliasMatch;
    while ((aliasMatch = regex.exec(str)) !== null) {
      if (lexicon && !lexicon.has(alias.ticker)) break;
      found.push({
        ticker: alias.ticker,
        spoken: aliasMatch[0],
        index: aliasMatch.index,
        viaAlias: true,
        ambiguous: [],
        matched: aliasMatch[0].toLowerCase(),
      });
    }
  }
  for (const entry of found) seen.add(entry.spoken.toLowerCase().replace(/^the\s+/, ''));

  // Title-cased tokens: starts with a capital, followed by lowercase letters.
  // Includes hyphens and apostrophes for names like "Berkshire-Hathaway".
  //
  // ADJACENT PAIRS ARE TRIED FIRST, because a two-word name is a name.
  // "Goldman Sachs" is one company; read as two words it is "Goldman" (which
  // the SEC list also carries inside "goldman sachs physical gold etf") and
  // "Sachs" on its own, and neither word identifies the company. The same is
  // true of "Wells Fargo", "Bank of America" and "Morgan Stanley".
  //
  // The pair is only used when it RESOLVES and the single words do not, so a
  // pair never shadows a name that already works on its own.
  const tokenPattern = /[A-Z][a-z][\p{L}\p{N}'-]{0,20}/gu;
  const tokens = [];
  let match;
  while ((match = tokenPattern.exec(str)) !== null) {
    tokens.push({ spoken: match[0].replace(/['-]+$/, ''), index: match.index });
  }

  const accepted = new Set();
  const push = (entry) => {
    const key = entry.spoken.toLowerCase();
    if (accepted.has(key)) return;
    accepted.add(key);
    found.push(entry);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const { spoken, index } = tokens[i];
    if (!isEnglishNameCandidate(spoken)) continue;

    // A name inside a FIXED PHRASE is not that name. "Iron" is how traders
    // say IREN, and "iron condor" is an options strategy -- so a company
    // that shares its word with a piece of trading vocabulary has to be
    // rejected on the words that FOLLOW it, not on the word itself.
    if (isPhraseCollision(spoken, str, index)) continue;

    const next = tokens[i + 1];
    const adjacent = next
      && /^\s/.test(str.slice(index + spoken.length, next.index))
      && isEnglishNameCandidate(next.spoken);

    if (adjacent) {
      const pair = `${spoken} ${next.spoken}`;
      const resolvedPair = cachedMatch(pair, options);
      if (resolvedPair.ticker) {
        push({
          ticker: resolvedPair.ticker,
          spoken: pair,
          index,
          viaAlias: resolvedPair.viaAlias,
          ambiguous: resolvedPair.ambiguous,
          matched: resolvedPair.matched,
        });
        // The second word is part of the name, so it is not also a candidate
        // on its own.
        accepted.add(next.spoken.toLowerCase());
        i += 1;
        continue;
      }
    }

    const key = spoken.toLowerCase();
    if (accepted.has(key)) continue;

    const resolved = cachedMatch(spoken, options);
    push({
      ticker: resolved.ticker,
      spoken,
      index,
      viaAlias: resolved.viaAlias,
      ambiguous: resolved.ambiguous,
      matched: resolved.matched,
      // THE PROPOSED TICKER OF AN UNCONFIRMED NAME. `matchCompanyName`
      // reports it so the confirmed table can be GROWN from what the
      // corpus says; dropping it here left every survey reporting
      // thousands of capitalised words with no way to tell a company
      // from a filler word. A candidate with no proposal is just a
      // capitalised word; one WITH a proposal is a row worth reading.
      candidate: resolved.candidate || '',
      candidateName: resolved.candidateName || '',
    });
  }

  return found;
}

module.exports = {
  ENGLISH_INDEX_ALIASES,
  ENGLISH_PHRASE_COLLISIONS,
  ENGLISH_STOP_WORDS,
  isPhraseCollision,
  ENGLISH_SYMBOL_STOPLIST,
  findEnglishCompanyNames,
  isEnglishNameCandidate,
};
