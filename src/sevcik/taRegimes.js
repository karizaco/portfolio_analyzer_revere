'use strict';

// Classify market context for a Sevcik claim from its TA snapshot.

/**
 * @param {object} snap computeIndicatorSnapshot()
 * @returns {object}
 */
function classifyTrendRegime(snap) {
  const close = Number(snap && snap.close);
  const sma50 = Number(snap && snap.sma50);
  const sma200 = Number(snap && snap.sma200);
  const adx14 = Number(snap && snap.adx14);
  const flags = {
    above_sma200: Number.isFinite(close) && Number.isFinite(sma200) ? close > sma200 : null,
    sma50_above_sma200: Number.isFinite(sma50) && Number.isFinite(sma200) ? sma50 > sma200 : null,
    adx_strong: Number.isFinite(adx14) ? adx14 >= 25 : null,
  };
  let label = 'unknown';
  if (flags.above_sma200 === true && flags.sma50_above_sma200 === true) label = 'uptrend';
  else if (flags.above_sma200 === false && flags.sma50_above_sma200 === false) label = 'downtrend';
  else if (flags.above_sma200 != null || flags.sma50_above_sma200 != null) label = 'mixed';
  return { label, ...flags, adx14: Number.isFinite(adx14) ? adx14 : null };
}

/**
 * @param {object} snap
 * @returns {object}
 */
function classifyVolRegime(snap) {
  const atrPct = Number(snap && snap.atr_pct);
  const bbw = Number(snap && snap.bb_bandwidth);
  let label = 'unknown';
  // ATR% buckets are rough daily equity heuristics.
  if (Number.isFinite(atrPct)) {
    if (atrPct < 0.015) label = 'low';
    else if (atrPct < 0.03) label = 'normal';
    else label = 'high';
  } else if (Number.isFinite(bbw)) {
    if (bbw < 0.08) label = 'low';
    else if (bbw < 0.18) label = 'normal';
    else label = 'high';
  }
  return {
    label,
    atr_pct: Number.isFinite(atrPct) ? atrPct : null,
    bb_bandwidth: Number.isFinite(bbw) ? bbw : null,
  };
}

/**
 * Multi-timeframe confirmation score using daily snapshot only for now.
 * Higher = more agreement with the claimed bias.
 *
 * @param {object} snap
 * @param {string} bias bullish|bearish
 * @returns {object}
 */
function multiTimeframeScore(snap, bias) {
  const direction = bias === 'bearish' ? -1 : bias === 'bullish' ? 1 : 0;
  if (!direction) {
    return { score: null, max_score: 5, components: {}, label: 'no_bias' };
  }
  const close = Number(snap && snap.close);
  const components = {
    above_sma200: null,
    sma50_vs_sma200: null,
    macd_hist: null,
    rsi_side: null,
    volume_confirm: null,
  };
  let score = 0;
  let max = 0;

  function add(key, ok) {
    max += 1;
    if (ok === null || ok === undefined) {
      components[key] = null;
      return;
    }
    components[key] = !!ok;
    if (ok) score += 1;
  }

  if (Number.isFinite(close) && Number.isFinite(Number(snap.sma200))) {
    add('above_sma200', direction > 0 ? close > snap.sma200 : close < snap.sma200);
  } else add('above_sma200', null);

  if (Number.isFinite(Number(snap.sma50)) && Number.isFinite(Number(snap.sma200))) {
    add('sma50_vs_sma200', direction > 0 ? snap.sma50 > snap.sma200 : snap.sma50 < snap.sma200);
  } else add('sma50_vs_sma200', null);

  if (Number.isFinite(Number(snap.macd_hist))) {
    add('macd_hist', direction > 0 ? snap.macd_hist > 0 : snap.macd_hist < 0);
  } else add('macd_hist', null);

  if (Number.isFinite(Number(snap.rsi14))) {
    add('rsi_side', direction > 0 ? snap.rsi14 >= 50 : snap.rsi14 <= 50);
  } else add('rsi_side', null);

  if (Number.isFinite(Number(snap.volume_z20))) {
    add('volume_confirm', snap.volume_z20 >= 0.5);
  } else add('volume_confirm', null);

  let label = 'unknown';
  if (max > 0) {
    const ratio = score / max;
    if (ratio >= 0.8) label = 'strong';
    else if (ratio >= 0.6) label = 'moderate';
    else if (ratio >= 0.4) label = 'weak';
    else label = 'contrary';
  }

  return { score, max_score: max, ratio: max ? score / max : null, components, label };
}

module.exports = {
  classifyTrendRegime,
  classifyVolRegime,
  multiTimeframeScore,
};
