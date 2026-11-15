'use strict';

/**
 * A trade ACTION, read out of one Discord message.
 *
 *   "Bought 5% of FIGR through Pre-market high 40.60, stop today's low 38.30"
 *   "10% trim of DELL 239.13 9x ATR from the 50sma"
 *   "covered another third of my LITE shares 761.51"
 *   "Stopped on AMD 570.36"
 *
 * WHAT IS READ
 *
 *   the action    open / add / trim / exit / stop_out -- or a stop UPDATE,
 *                 which is not a trade
 *   the ticker    the first one, plus any written beside it ("MU SNDK 10%
 *                 trim on both"). A ticker in a later remark is NOT the
 *                 subject: "Bought AAOZ ... (AAOI failed at resistance)"
 *   the size      "5%" of the ACCOUNT on an entry
 *   the fraction  "half", "a third", "20%" of the POSITION on a trim
 *   the price     the fill he states, and the stop he states
 *
 * THE RULES THAT ARE EASY TO GET WRONG
 *
 * 1. THE EARLIEST VERB IS THE ACTION. "Bought 5% SQQQ back at 50.63 (was
 *    stopped this morning)" is a purchase. A priority order (stop-out first)
 *    would read it as a stop-out.
 * 2. AN INTENT IS NOT A TRADE. "Watching OKLO on the short side", "looking to
 *    add", "will look for adds later" describe a trade that has not happened.
 * 3. "CLOSED" WITH A FRACTION IS A TRIM. "closed half", "covered a piece".
 * 4. A NUMBER IS A PRICE ONLY WHERE A PRICE CAN STAND. "50sma", "7x ATR",
 *    "6/20 setup", "5min" and "3%" are not prices. A bare integer is a price
 *    only right after a ticker or a price word ("at 173", "stop 18").
 * 5. A PERCENT ON A TRIM IS OF THE POSITION, except where he says otherwise
 *    ("Trimmed another 1% (of portfolio) of ARM"). Drendel also writes small
 *    trims in portfolio points without saying so ("Trimmed 4% from MU"); that
 *    case is marked `ambiguous` and resolved against the position's known
 *    size, never guessed here.
 */

const { findTickers, JARGON } = require('./symbols');

/** "BE" as break-even: after a preposition or "stop", and not in a list. */
const BREAK_EVEN_BEFORE = /(?:\b(?:at|to|near|below|above|under|around|is|stop|stops|for)\s+)$/i;

const NOT_A_TRADE = /@everyone|daily\s+recap|weekly\s+recap|recap\s*&|watch\s?list|set\s?ups?\s*:|universe\s+list|\bportfolio\b.*:/i;

/** Words that turn the verb after them into something that has not happened. */
const INTENT = /\b(?:watching|watch|looking|look|will|would|might|may|if|want|wanting|eyeing|eyes\s+on|plan(?:ning)?|considering|thinking|waiting|wait|could|should|not\s+going\s+to|won't|wont|don't|dont|do\s+not|unless|until|hoping|ideally|potential(?:ly)?|maybe|need(?:s)?\s+to)\b[^.!?\n]*$/i;

const FRACTION_WORDS = [
  { pattern: /\b(?:two[\s-]thirds|2\/3)\b/i, value: 2 / 3 },
  { pattern: /\b(?:half|1\/2|50\s*%)\b/i, value: 0.5 },
  { pattern: /\b(?:third|1\/3)\b/i, value: 1 / 3 },
  { pattern: /\b(?:quarter|fourth|1\/4)\b/i, value: 0.25 },
  { pattern: /\b(?:fifth|1\/5(?:th)?)\b/i, value: 0.2 },
];

const REST = /\b(?:rest|remaining|remainder|last(?:\s+(?:piece|bit|of|small))?|all(?:\s+of)?|everything|entire|full)\b/i;
const PARTIAL = /\b(?:piece|some|partial|part|a\s+bit|portion|adds?)\b/i;

/**
 * The verbs, by action. `books` limits a verb to the channels where it IS a
 * verb: "long" opens a trade in the long book and is a noun everywhere else.
 */
const VERBS = [
  { action: 'stop_out', pattern: /\b(?:stopped(?:\s+out)?|got\s+stopped|stop(?:ped)?\s+out|stopping\s+out)\b/i },
  { action: 'exit', pattern: /\b(?:closed|closing|close\s+out|exited|exiting|out\s+of)\b/i },
  { action: 'exit', pattern: /\b(?:cut|sold|selling|sell|covered|covering|cover|exits?\b)\b/i },
  { action: 'trim', pattern: /\b(?:trim(?:med|ming|s)?|took\s+off|taking\s+off|take\s+off|reduc(?:ed|ing)|peel(?:ed|ing)?|tooks?\s+(?:some|a|another|the)\b)\b/i },
  { action: 'add', pattern: /\b(?:add(?:ed|ing|s)?|bought\s+more|buying\s+more|building\s+into|re-?entered|adding\s+back|put\s+\S+\s+back)\b/i },
  { action: 'open', pattern: /\b(?:bought|buying|starter|started|starting|entered|entering|tried|trying|put|went\s+(?:long|short|back)|took|taking|take)\b/i },
  { action: 'open', books: ['long'], pattern: /\blong(?:ed|s)?\b(?!\s*(?:term|as\b|way|time|side|set\s?ups?|watch|run|weekend|ago|enough|list))/i },
  { action: 'open', books: ['short'], pattern: /\bshort(?:ed|ing)?\b(?!\s*(?:term|side|set\s?ups?|watch|interest|squeeze|list|covering))/i },
];

const STOP_WORD = /\b(?:stop|stops|sotp|stpo)\b|\bvs\.?\b/i;
const STOP_UPDATE = /\b(?:stop|stops|sotp)\b/i;

/** A number where a price can stand (see rule 4). */
const NUMBER = /(?<![\w./$,+-])(\$?)(\d{1,5}(?:\.\d{1,4})?)(?![\w%/]|\.\d|,\d|\s*(?:%|x\b|sma|ema|dma|wma|min\b|mins\b|day|week|month|pts?\b|risk|r\b))/gi;
const PRICE_CUE = /(?:\b(?:at|@|stop|stops|sotp|vs\.?|to|through|thru|above|below|under|over|near|from|around|of|high|low|lows|highs|hod|lod)\s*\$?|\$)$/i;
const TICKER_BEFORE = /(?<![A-Za-z])[A-Z]{1,5}\s*$/;

const RESULT = /([+-]\s?\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*(loss|gain|profit|winner|loser)/i;
const ATR = /(\d+(?:\.\d+)?)\s*x\s*ATR/i;
const NOT_SIZE_AFTER = /^\s*(?:trade\s+risk|portfolio\s+risk|port(?:folio|oflio)?\s+risk|risk|stop|loss|gain|profit|winner|loser|move|gap|up\b|down\b|higher|lower|trade\b)/i;

/**
 * The prices a text states, in order.
 *
 * @param {string} text
 * @returns {{index: number, value: number}[]}
 */
function findPrices(text) {
  const out = [];
  NUMBER.lastIndex = 0;
  let match;
  while ((match = NUMBER.exec(text)) !== null) {
    const value = Number(match[2]);
    if (!(value > 0)) continue;
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const decimal = match[2].includes('.');
    const cued = match[1] === '$' || PRICE_CUE.test(before) || TICKER_BEFORE.test(before);
    if (!decimal && !cued) continue;
    out.push({ index: match.index, value });
  }
  return out;
}

/**
 * Is this message a trade about the ticker in the first slot?
 *
 *   "CRWD - Bought today on the undercut and reclaim"   yes: the dash opens
 *                                                       the trade, and the
 *                                                       verb is 6 words in
 *   "NAAIM ... the dip was bought so aggressively"      no: a commentary
 *                                                       sentence mentions a
 *                                                       past action
 *   "Trim OKLO down to runner"                          yes
 *   "CRWV"                                             no: a bare name
 *
 * The test is deliberately narrow, because the failure it prevents is a
 * FALSE ACTION on a ticker the message only mentions.
 *
 * @param {string} text
 * @param {Set<string>} known
 * @returns {string[]} the subject tickers, empty when the message is not one
 */
function slotTickers(text, known) {
  const found = findTickers(text, { known, slot: true });
  if (!found.length) return [];
  const first = found[0];
  const after = text.slice(first.index + first.ticker.length + (first.dollar ? 1 : 0));
  if (after.trim().length < 8) return [];
  // A single capital is a word ("I", "A") in these channels; the portfolio
  // post is read by its own parser, which knows the real one-letter names.
  if (first.ticker.length === 1 && !first.dollar) return [];
  const before = text.slice(0, first.index).trim();
  if (before && !/^[-–—:,.]+$/.test(before)) {
    // "Bought 5% SQQQ": the verb and the size sit before the name.
    if (!/^[^.!?\n]{0,30}$/.test(before)) return [];
    if (!/\b(?:bought|buy|buying|sold|sell|selling|cut|cutting|trimmed|trim|trimming|closed|closing|covered|covering|added|adding|stops|stopped|short|long|put|took|taking|start|started|entry|entered|exited|covering|position)\b/i.test(before)) return [];
  }
  const body = after.replace(/^(?:\s*[-–—:.]\s*|\s+)/, '');
  // A leading ticker is a subject only when the message says something it
  // did: a trade verb, a side, or a size/stop line.
  const opener = /^.{0,10}\b(?:bought|buy|buying|sold|sell|selling|cut|cutting|trimmed|trim|trimming|closing|closed|close|covered|covering|adding|added|add|stops|stopped|short|long|position|size|exit|at|to|from|under|above|through|vs)\b/i;
  if (!opener.test(body)) return [];
  const out = [first.ticker];
  for (let index = 1; index < found.length && out.length < 4; index += 1) {
    const previous = found[index - 1];
    const gap = text.slice(previous.index + previous.ticker.length + (previous.dollar ? 1 : 0), found[index].index);
    if (!/^[\s,&/+$]*(?:and\s+)?\$?$/i.test(gap)) break;
    out.push(found[index].ticker);
  }
  return out;
}

/**
 * The ticker a sentence names right after a position verb: "Long ARKK 58.58",
 * "$NVDA short 114.30", "strter short in UAMY 18.50".
 *
 * The corpus's single-stock trades are NOT in the lexicon (ARKK, MSTZ, GDX,
 * SILJ, SARK, SQQQ are not US registrants), so a known-ticker-only search
 * throws away the trade's subject entirely.
 *
 * @param {string} text
 * @param {Set<string>} known
 * @returns {string[]} the first match, empty when the sentence names none
 */
/**
 * The words a case-insensitive search would pick up as a ticker.
 *
 * "I just bought small $HOOD" has "I" and "small" before the ticker, and
 * both are written in a way a case-insensitive search cannot tell from a
 * ticker written in lower case ("TOOK A 5% intc POSITION").
 */
const WORDS = new Set([
  'a', 'an', 'the', 'my', 'i', 'we', 'it', 'he', 'she', 'they', 'you', 'and', 'or', 'but',
  'small', 'some', 'more', 'back', 'half', 'rest', 'bit', 'piece', 'another', 'of', 'on',
  'in', 'at', 'to', 'up', 'down', 'out', 'off', 'only', 'just', 'got', 'going', 'still',
  'position', 'size', 'starter', 'entry', 'add', 'added', 'adding', 'bought', 'sold',
  'long', 'short', 'trim', 'trimmed', 'closed', 'covered', 'stopped', 'stop',
]);

function verbTickers(text, known) {
  const pattern = /\b(?:long|short(?:ed|ing)?|buy|bought|sell|sold|entry|entered|starter|take|took|taking|short\s+position)\s+(?:a\s+|an\s+|some\s+|the\s+|back\s+|back\s+on\s+|more\s+)?(\$?)([A-Za-z]{1,5})(?![A-Za-z])/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const dollar = match[1] === '$';
    const raw = match[2];
    const ticker = raw.toUpperCase();
    if (ticker === 'BE' && BREAK_EVEN_BEFORE.test(text.slice(0, match.index))) continue;
    if (JARGON.has(ticker)) continue;
    if (raw.length === 1 && !dollar) continue;
    if (WORDS.has(raw.toLowerCase())) continue;
    // A lower-case word is a ticker only when the lexicon knows it.
    if (raw !== raw.toUpperCase() && !known.has(ticker)) continue;
    return [ticker];
  }
  // A name he does not have in the lexicon sits right behind its verb: the
  // corpus's own stocks (TSLL, IONZ, SARK, MSTZ) are not US registrants, so
  // a lexicon-only search would drop the trade's subject entirely. A size
  // and a filler word sit between the verb and the name ("Bought 4% AAOZ
  // at 9.76", "Bought 5% SQQQ back at 50.63"), so the name is the FIRST
  // capitals token after the verb.
  const loose = /\b(?:trimmed|trimming|trim|closed|closing|covered|covering|added|adding|bought|sold|selling|stopped|stop)\b([^.!?\n]{0,24}?)\$?([A-Z]{2,5})(?![A-Za-z])/g;
  let looseMatch;
  while ((looseMatch = loose.exec(text)) !== null) {
    const ticker = looseMatch[2];
    // The gap must not hold another name, or the name is further along.
    if (/[A-Z]{2,5}/.test(looseMatch[1])) continue;
    if (ticker === 'BE' && BREAK_EVEN_BEFORE.test(text.slice(0, looseMatch.index))) continue;
    if (JARGON.has(ticker)) continue;
    return [ticker];
  }
  return [];
}

/**
 * The tickers a message is ABOUT.
 *
 * The message either opens with the ticker in a SLOT ("Trim OKLO down to
 * runner", "$NVDA short 114.30"), or it names one beside a verb ("Bought 5%
 * of FIGR through ..."). A message that does neither is commentary that
 * mentions a verb, and it has no subject.
 *
 * @param {string} text
 * @param {Set<string>} [known]
 * @returns {string[]}
 */
function subjectTickers(text, known) {
  const slot = slotTickers(text, known);
  if (slot.length) return slot;
  const verb = verbTickers(text, known);
  if (verb.length) return verb;
  const found = findTickers(text, { known });
  return found.length ? [found[0].ticker] : [];
}

/**
 * Read one message.
 *
 * @param {string} content
 * @param {object} [options]
 * @param {string} [options.book]  'trading' | 'long' | 'short'
 * @param {Set<string>} [options.known]
 * @returns {object} `kind` is 'action', 'stop_update', 'intent', 'other'
 */
function parseTradeMessage(content, options = {}) {
  const text = String(content || '').replace(/[*_`]/g, '');
  const book = options.book || 'trading';
  const tickers = subjectTickers(text, options.known);
  const base = {
    action: '',
    atr_multiple: null,
    fraction: null,
    fraction_basis: '',
    kind: 'other',
    price: null,
    size_pct: null,
    stated_result_pct: null,
    stop_price: null,
    stop_text: '',
    tickers,
    verb: '',
  };
  if (!text.trim() || NOT_A_TRADE.test(text)) return base;

  const atr = ATR.exec(text);
  if (atr) base.atr_multiple = Number(atr[1]);

  // Rule 1: the earliest verb.
  let best = null;
  for (const verb of VERBS) {
    if (verb.books && !verb.books.includes(book)) continue;
    const match = verb.pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) best = { action: verb.action, index: match.index, word: match[0] };
  }

  // The stop he states, wherever it is.
  const stopMatch = STOP_WORD.exec(text);
  const prices = findPrices(text);
  const stopIndex = stopMatch ? stopMatch.index : -1;
  // "stopped" is the verb, not a stop level.
  const stopIsVerb = best && best.action === 'stop_out' && stopMatch && stopMatch.index === best.index;
  if (stopMatch && !stopIsVerb) {
    const after = prices.find((price) => price.index > stopIndex);
    base.stop_price = after ? after.value : null;
    base.stop_text = text.slice(stopIndex, stopIndex + 60).split(/[\n.!?](?:\s|$)/)[0].trim();
  }

  if (!best) {
    // No verb: the message may still be an intent ("Watching OKLO on the
    // short side"), and it is not a trade either way.
    if (INTENT.test(text) || /\b(?:was|were|is|are|has|been)\s+(?:bought|sold|closed|covered|trimmed|stopped)\b/i.test(text)) {
      base.kind = 'intent';
      return base;
    }
    if (STOP_UPDATE.test(text)) base.kind = 'stop_update';
    return base;
  }

  base.verb = best.word.toLowerCase();
  const sentenceStart = Math.max(text.lastIndexOf('.', best.index), text.lastIndexOf('\n', best.index)) + 1;
  const before = text.slice(sentenceStart, best.index);
  const through = text.slice(sentenceStart, best.index + best.word.length);
  // An INTENT, or a sentence describing what happened rather than what he did:
  // "Watching OKLO on the short side", "the dip was bought so aggressively".
  if (INTENT.test(before) || /\b(?:was|were|is|are|has|been|gets?|got|became|becomes)\s+(?:bought|sold|closed|covered|trimmed|stopped|short(?:ed|ing)?|long(?:ed|ing)?)\b/i.test(through)) {
    base.kind = 'intent';
    return base;
  }
  // "MSTR is a short here" / "CVNA my only short at the moment": the noun.
  if (/\b(?:is|are|was|were|became|gets|becomes)\s+(?:a\s+|an\s+|the\s+|my\s+|our\s+)?short\b/i.test(before)) {
    base.kind = 'other';
    return base;
  }

  let action = best.action;
  // "put" is a verb only as "put ... on": "Put 5% back onto SEDG".
  if (/^put$/i.test(best.word)) {
    if (!/\bput\b[^.\n]{0,40}\b(?:on|onto)\b/i.test(text)) {
      if (STOP_UPDATE.test(text)) base.kind = 'stop_update';
      return base;
    }
    action = /\bback\b/i.test(text) ? 'add' : 'open';
  }

  // The fraction, for the actions that take something off.
  const tail = text.slice(best.index);
  if (action === 'exit' || action === 'trim') {
    const word = FRACTION_WORDS.find((entry) => entry.pattern.test(tail));
    const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text);
    const rest = REST.test(tail) && !/\b(?:another|more)\b[^.\n]{0,12}%/i.test(tail);
    const percentIsResult = percent && RESULT.test(text.slice(Math.max(0, percent.index - 2)))
      && /^(?:[+-]|\d+(?:\.\d+)?\s*%\s*(?:loss|gain|profit))/i.test(text.slice(Math.max(0, percent.index - 1)).trim());
    if (word && !(rest && /\b(?:rest|remaining)\s+(?:of\s+)?(?:the\s+)?(?:half|third|quarter)/i.test(tail))) {
      base.fraction = word.value;
      base.fraction_basis = /\boriginal\b/i.test(tail) ? 'original' : 'remaining';
      action = 'trim';
    } else if (percent && !percentIsResult && Number(percent[1]) < 100
      && !NOT_SIZE_AFTER.test(text.slice(percent.index + percent[0].length))) {
      base.fraction = Number(percent[1]) / 100;
      if (/\bportfolio\b|\bport\b/i.test(text.slice(percent.index, percent.index + 40))) base.fraction_basis = 'portfolio';
      else if (/\boriginal\b/i.test(tail)) base.fraction_basis = 'original';
      else if (book === 'trading' && Number(percent[1]) < 10 && !/\bremaining\b/i.test(tail)) base.fraction_basis = 'ambiguous';
      else base.fraction_basis = 'remaining';
      action = 'trim';
    } else if (rest) {
      action = 'exit';
    } else if (action === 'trim' || PARTIAL.test(tail)) {
      action = 'trim';
    }
  }

  // The size of an entry: the first percent that is a size.
  if (action === 'open' || action === 'add') {
    const sizes = /(\d+(?:\.\d+)?)\s*%/g;
    let match;
    while ((match = sizes.exec(text)) !== null) {
      if (stopIndex >= 0 && match.index > stopIndex && !stopIsVerb) break;
      if (/[+-]\s?$/.test(text.slice(0, match.index))) continue;
      const after = text.slice(match.index + match[0].length);
      // "10% trade risk" is a RISK figure; "10% position size" is a size.
      if (NOT_SIZE_AFTER.test(after) && !/^(?:\s*(?:size|position|position\s+size|of\s+(?:the\s+)?(?:portfolio|account|account\s+size|equity)))/i.test(after)) continue;
      base.size_pct = Number(match[1]);
      break;
    }
    if (base.size_pct === null) {
      // "small size", "small 5% starter", "tiny position" -- a size word with
      // no figure is a size he states without quantifying it.
      const word = FRACTION_WORDS.find((entry) => entry.pattern.test(text));
      if (word && /\b(?:size|position|starter)\b/i.test(text)) {
        base.fraction = word.value;
        base.fraction_basis = 'full_size';
      } else if (/\b(?:tiny|small|minimal)\s+(?:size|position|starter)\b|\bsmall\s+size\b|\bsmall\s+(?:position|starter)\b/i.test(text)) {
        base.size_pct = 0;
        base.size_note = 'unquantified';
      }
    }
  }

  const result = RESULT.exec(text);
  if (result && (action === 'exit' || action === 'stop_out' || action === 'trim')) {
    const value = result[1] !== undefined
      ? Number(result[1].replace(/\s/g, ''))
      : Number(result[2]) * (/loss|loser/i.test(result[3]) ? -1 : 1);
    if (Number.isFinite(value) && Math.abs(value) < 1000) base.stated_result_pct = value;
  }

  // The fill: the first price that is not the stop.
  const fill = prices.find((price) => stopIsVerb || stopIndex < 0 || price.index < stopIndex);
  base.price = fill ? fill.value : null;

  // A size written behind the entry: "position now 15%", "10% position size",
  // "position currently 15%". A fill is a price; a size is a percent.
  if (base.size_pct === null) {
    const trailing = /(?:position|size)\s+(?:now|currently|at|is|=)?\s*(\d+(?:\.\d+)?)\s*%/i.exec(text)
      || /(\d+(?:\.\d+)?)\s*%\s*(?:position|size)\b/i.exec(text)
      || /(?:position|size)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/i.exec(text);
    if (trailing && Number(trailing[1]) > 0 && Number(trailing[1]) < 100) {
      base.size_pct = Number(trailing[1]);
    }
  }

  base.action = action;
  base.kind = 'action';
  return base;
}

/**
 * Read a channel's messages in order, carrying the subject forward.
 *
 * A trader's follow-up names no ticker: "stop LOD", "411.41 more trimmed",
 * "78.55 just closed it off". Its subject is the ticker of the message before
 * it. That inference is bounded in time and MARKED, so a reader can tell a
 * stated ticker from an inherited one.
 *
 * @param {object[]} messages  `{ content, posted_at, id }`, any order
 * @param {object} [options]
 * @param {string} [options.book]
 * @param {Set<string>} [options.known]
 * @param {number} [options.carryHours]
 * @returns {object[]} one row per (message, ticker) that is an action or a stop update
 */
function readActionStream(messages, options = {}) {
  const carryMs = (options.carryHours ?? 6) * 3600000;
  const ordered = [...messages].sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
  const out = [];
  let last = { at: 0, tickers: [] };
  for (const message of ordered) {
    const parsed = parseTradeMessage(message.content, options);
    const at = new Date(message.posted_at).getTime();
    let tickers = parsed.tickers;
    let inferred = false;
    if (!tickers.length && (parsed.kind === 'action' || parsed.kind === 'stop_update')
      && last.tickers.length && at - last.at <= carryMs) {
      tickers = last.tickers.slice(0, 1);
      inferred = true;
    }
    if (parsed.tickers.length) last = { at, tickers: parsed.tickers };
    if (parsed.kind !== 'action' && parsed.kind !== 'stop_update') continue;
    for (const ticker of tickers) {
      out.push({
        ...parsed,
        content: message.content,
        message_id: message.id,
        posted_at: message.posted_at,
        ticker,
        ticker_inferred: inferred,
      });
    }
    if (!tickers.length) {
      out.push({
        ...parsed,
        content: message.content,
        message_id: message.id,
        posted_at: message.posted_at,
        ticker: '',
        ticker_inferred: false,
      });
    }
  }
  return out;
}

module.exports = { findPrices, parseTradeMessage, readActionStream, subjectTickers };
