'use strict';

/**
 * Repair a ticker the PROVIDER split across a boundary.
 *
 * WHAT THE MEASUREMENT SAID
 *
 * The Komar corpus's transcripts were checked against the corpus's own
 * lexicon, boundary by boundary: a ticker is BROKEN when the two
 * halves of it fall on either side of a boundary and neither half is a
 * ticker itself. Over the 116 transcripts' 50,884 boundaries that
 * produced three candidates, and only one of them is real:
 *
 *   "I bought into DF," | "DV. I see a lot of positive momentum"
 *
 * The other two are ordinary speech -- the phrase "go go", and a clean
 * sentence boundary after "QS" -- and the guards below reject both.
 *
 * THE CAUSE, AND WHY IT MATTERS WHERE THE FIX GOES
 *
 * Twenty videos were re-transcribed with the provider's WORD LIST
 * kept, and the word list settles it. The provider carries "df" and
 * "dv" as TWO WORDS, and the boundary falls between them. So this is
 * the provider's TOKENISATION -- it wrote the punctuation too ("DF,"
 * and "DV.") -- and NOT its endpointing, which never cut a word in
 * 2,863 measured boundaries.
 *
 * That matters because it decides what can fix it:
 *
 *   - A JOIN IN THE SEGMENTER cannot. There is no whole word to
 *     recover; the provider never wrote one.
 *   - A REQUEST-LEVEL TERMS HINT does -- and it was measured. With the
 *     corpus's own tickers sent as terms, the provider wrote "dfdv" as
 *     ONE word and the transcript reads "I bought into DFDV." But it
 *     also invented a ticker out of ordinary speech: "in not" came
 *     back as "INVZ". A fix that trades a lost holding for an invented
 *     one is not a fix, and the project's rule is that a wrong holding
 *     is worse than a missing one.
 *   - A LEXICON-DRIVEN JOIN here does, and it cannot invent anything:
 *     the joined form has to BE a ticker the corpus knows.
 *
 * WHY THIS IS NOT IN THE SHARED MODULE
 *
 * The join needs the corpus's own tickers to decide, and the corpus's
 * tickers are the source's business: the shared normaliser is used by
 * the Czech, English and Benzinga corpora, and a shared join would
 * have to know every corpus's vocabulary. So the rule lives here, in
 * the Komar's own module, and the shared code is untouched.
 */

/**
 * A ticker-shaped fragment, as the provider wrote it.
 *
 * The provider writes a ticker in CAPITALS and an ordinary word in
 * lower case, and that difference is the first guard: "go go" is not
 * "GOGO" and must not be joined into it.
 */
const LEFT_FRAGMENT = /^[A-Z][A-Z0-9]{0,4}$/;
const RIGHT_FRAGMENT = /^[A-Z][A-Z0-9]{0,5}$/;

/**
 * Strip the punctuation a provider puts around a token.
 *
 * @param {string} token
 * @returns {string}
 */
function stripPunctuation(token) {
  return String(token || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

/**
 * The punctuation a token ends with -- the provider's sentence stop.
 *
 * @param {string} token
 * @returns {string}
 */
function trailingPunctuation(token) {
  const match = /[^A-Za-z0-9]+$/.exec(String(token || ''));
  return match ? match[0] : '';
}

/**
 * The alphanumeric core of a token.
 *
 * @param {string} token
 * @returns {string}
 */
function core(token) {
  return String(token || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Repair the tickers the provider split across a boundary.
 *
 * The segments are NOT mutated: the stored transcript is the provider's
 * record and stays exactly as it was written. The repaired segments
 * are what the extractor reads, and the repaired token is in the
 * EVIDENCE, so a reader can see what was joined.
 *
 * @param {object[]} segments - the transcript's segments
 * @param {object} options
 * @param {Set<string>} options.lexicon - the tickers that may be reported
 * @returns {{segments: object[], repairs: object[]}}
 */
function rejoinBrokenTickers(segments, options = {}) {
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set();
  const list = Array.isArray(segments) ? segments : [];
  const repairs = [];
  if (!lexicon.size || list.length < 2) return { repairs, segments: list.slice() };

  const out = list.map((segment) => ({ ...segment }));
  for (let index = 0; index + 1 < out.length; index += 1) {
    const left = out[index];
    const right = out[index + 1];
    const leftText = String(left.text || '');
    const rightText = String(right.text || '');
    if (!leftText.trim() || !rightText.trim()) continue;

    const leftTokens = leftText.trim().split(/\s+/);
    const rightTokens = rightText.trim().split(/\s+/);
    const rawLast = leftTokens[leftTokens.length - 1];
    const rawFirst = rightTokens[0];
    const lastToken = stripPunctuation(rawLast);
    const firstToken = stripPunctuation(rawFirst);
    if (!LEFT_FRAGMENT.test(lastToken) || !RIGHT_FRAGMENT.test(firstToken)) continue;

    // Neither half may be a ticker itself: a boundary after "QS" is a
    // sentence boundary, and joining it would invent a holding.
    if (lexicon.has(core(lastToken)) || lexicon.has(core(firstToken))) continue;

    const joined = core(lastToken) + core(firstToken);
    if (!lexicon.has(joined)) continue;

    // The joined ticker must not already be in the segment -- otherwise
    // the repair would double the holding.
    if (core(leftText).includes(joined)) continue;

    // The provider's sentence stop travels with the ticker, so the
    // evidence still reads as a sentence.
    leftTokens[leftTokens.length - 1] = joined + trailingPunctuation(rawFirst);
    rightTokens.shift();
    out[index] = { ...left, text: leftTokens.join(' ') };
    out[index + 1] = { ...right, text: rightTokens.join(' ') };
    repairs.push({
      joined,
      segment_index: index,
      was: `${lastToken} | ${firstToken}`,
    });
  }

  return { repairs, segments: out };
}

module.exports = {
  rejoinBrokenTickers,
};
