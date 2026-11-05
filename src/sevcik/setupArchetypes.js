'use strict';

// Map Sevcik claim text into coarse TA archetypes.

const ARCHETYPES = [
  'breakout',
  'pullback',
  'range_break',
  'mean_reversion',
  'support_resistance',
  'continuation',
  'gap',
  'unknown',
];

/**
 * @param {object} claim
 * @param {object} [ctx]
 * @param {object} [ctx.gap]
 * @param {object} [ctx.snap]
 * @returns {object}
 */
function classifySetupArchetype(claim, ctx = {}) {
  const text = [
    claim && claim.evidence_text,
    claim && claim.rationale,
    claim && claim.horizon_text,
    claim && claim.action,
  ].filter(Boolean).join(' \n ').toLowerCase();

  const scores = Object.fromEntries(ARCHETYPES.map((k) => [k, 0]));

  if (/\bgap|\bgab|mezera/.test(text) || (ctx.gap && ctx.gap.gap_talk)) scores.gap += 3;
  if (/breakout|průraz|pruraz|break out|break-out|vyražen|vyrazen/.test(text)) scores.breakout += 3;
  if (/pullback|korekce|stažení|stazeni|retest|návrat|navrat/.test(text)) scores.pullback += 3;
  if (/range|konsolid|boční|bocni|sideways|kanál|kanal/.test(text)) scores.range_break += 2;
  if (/mean reversion|návrat k průměru|navrat k prumeru|překoupen|prekoup|přeprod|preprod|oversold|overbought/.test(text)) {
    scores.mean_reversion += 3;
  }
  if (/support|resistance|supportu|rezisten|odpor|hladina|supportní|resistenc/.test(text)) {
    scores.support_resistance += 3;
  }
  if (/pokrač|pokrac|continuation|trend drží|trend drzi|stále long|stale long|stále short|stale short/.test(text)) {
    scores.continuation += 2;
  }

  // Soft TA context boosts.
  const snap = ctx.snap || {};
  if (Number.isFinite(Number(snap.bb_bandwidth)) && snap.bb_bandwidth < 0.08) scores.breakout += 1;
  if (Number.isFinite(Number(snap.rsi14))) {
    if (snap.rsi14 >= 70 || snap.rsi14 <= 30) scores.mean_reversion += 1;
    if (snap.rsi14 > 55 && snap.rsi14 < 70) scores.continuation += 1;
  }
  if (ctx.gap && ctx.gap.has_gap) scores.gap += 2;

  let best = 'unknown';
  let bestScore = 0;
  for (const key of ARCHETYPES) {
    if (key === 'unknown') continue;
    if (scores[key] > bestScore) {
      bestScore = scores[key];
      best = key;
    }
  }
  if (bestScore <= 0) best = 'unknown';

  return {
    archetype: best,
    score: bestScore,
    scores,
  };
}

module.exports = {
  ARCHETYPES,
  classifySetupArchetype,
};
