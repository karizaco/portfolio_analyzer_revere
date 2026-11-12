'use strict';

// Merge the mentions of one ticker in one post into ONE claim.
//
// WHY A POST IS THE UNIT
//
// The author can come back to the same ticker twice in one Market Pulse.
// Scoring each mention separately would count one call as two correlated
// wins or losses -- and it would inflate the hit rate, because the second
// mention is usually the author elaborating on the first.
//
// So a claim is one (post, ticker) pair.
//
// AND A CONFLICTING POST IS NOT SCORED AT ALL
//
// When the same post is bullish and bearish on the same name, there is no
// single call to score. The call is reported as conflicting and left out
// of the numbers, rather than being resolved by a rule the report would
// then have to defend.
//
// This is the same rule the T3Live outcomes tool applies, and it is in a
// module of its own so it can be tested without running the tool.

/**
 * @param {Array<object>} signals
 * @returns {{claims: Array<object>, conflicting: Array<object>}}
 */
function toAsymClaims(signals) {
  const groups = new Map();
  for (const signal of signals || []) {
    const key = `${signal.video_id}|${signal.ticker}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }

  const claims = [];
  const conflicting = [];
  for (const rows of groups.values()) {
    const biases = new Set(rows.map((row) => row.bias));
    if (biases.size > 1) {
      conflicting.push({
        video_id: rows[0].video_id,
        ticker: rows[0].ticker,
        biases: [...biases],
      });
      continue;
    }
    // The strongest reading carries the confidence and the evidence: a
    // mention with a price and a high confidence is the one that says what
    // the call was.
    const best = rows.slice()
      .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0))[0];
    claims.push({ ...best, mentions: rows.length });
  }
  return { claims, conflicting };
}

module.exports = {
  toAsymClaims,
};