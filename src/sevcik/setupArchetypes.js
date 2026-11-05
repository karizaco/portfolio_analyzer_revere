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
  const gap = ctx.gap || {};
  // Gap archetype requires linguistic gap talk AND a real market gap.
  // Tiny opens or silent gaps must not dominate the taxonomy.
  const linguisticGap = !!(gap.gap_talk || gap.linguistic_gap_setup || /\bgap|\bgab|mezera/.test(text));
  const realGap = gap.real_gap === true || (gap.has_gap === true && Math.abs(Number(gap.gap_pct) || 0) >= 0.015);
  if (linguisticGap && realGap) scores.gap += 4;
  else if (linguisticGap) scores.gap += 1; // mention only, weak

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

  // Soft TA context boosts (never enough alone to force gap).
  const snap = ctx.snap || {};
  if (Number.isFinite(Number(snap.bb_bandwidth)) && snap.bb_bandwidth < 0.08) scores.breakout += 1;
  if (Number.isFinite(Number(snap.rsi14))) {
    if (snap.rsi14 >= 70 || snap.rsi14 <= 30) scores.mean_reversion += 1;
    if (snap.rsi14 > 55 && snap.rsi14 < 70) scores.continuation += 1;
  }

  let best = 'unknown';
  let bestScore = 0;
  for (const key of ARCHETYPES) {
    if (key === 'unknown') continue;
    if (scores[key] > bestScore) {
      bestScore = scores[key];
      best = key;
    }
  }
  // Hard gate: never crown gap without both language + real gap.
  if (best === 'gap' && !(linguisticGap && realGap)) {
    scores.gap = 0;
    best = 'unknown';
    bestScore = 0;
    for (const key of ARCHETYPES) {
      if (key === 'unknown' || key === 'gap') continue;
      if (scores[key] > bestScore) {
        bestScore = scores[key];
        best = key;
      }
    }
    if (bestScore <= 0) best = 'unknown';
  }
  if (bestScore <= 0) best = 'unknown';

  return {
    archetype: best,
    score: bestScore,
    scores,
    gap_qualified: !!(linguisticGap && realGap),
    linguistic_gap: linguisticGap,
    real_gap: realGap,
  };
}

module.exports = {
  ARCHETYPES,
  classifySetupArchetype,
};
