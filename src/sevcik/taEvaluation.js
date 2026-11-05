'use strict';

// TA evaluation orchestration over scored Sevcik claims.
// Pure-ish: price series are injected via provider; summarization is local.

const { alignClaimEvent } = require('./eventAlignment');
const { barsThrough, computeIndicatorSnapshot } = require('./taIndicators');
const { classifyTrendRegime, classifyVolRegime, multiTimeframeScore } = require('./taRegimes');
const { evaluateGapAroundDate, looksLikeGapTalk } = require('./gapEvaluator');
const { classifySetupArchetype } = require('./setupArchetypes');
const { simulateRTrade } = require('./rMultipleSim');
const { evaluateWalkForward } = require('./walkForward');
const {
  alignedReturn,
  directionHit,
  shiftIsoDate,
  simpleReturn,
  yahooSymbolFor,
} = require('./outcomeAnalysis');

const FEATURE_VERSION = 'sevcik-ta-1';

/**
 * @param {Array<object>} claims normalized claims with upload_date/bias/ticker/...
 * @param {object} provider must implement getOhlcvSeries(symbol, from, to)
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function evaluateClaimsWithTa(claims, provider, opts = {}) {
  const weekDays = Number(opts.weekDays) || 7;
  const monthDays = Number(opts.monthDays) || 30;
  const asOfDate = opts.asOfDate || new Date().toISOString().slice(0, 10);
  const list = Array.isArray(claims) ? claims : [];

  const aligned = list.map((claim, index) => {
    const alignment = alignClaimEvent(claim);
    return {
      ...claim,
      source: claim.source || 'signal',
      source_row_id: claim.source_row_id == null ? index : claim.source_row_id,
      yahoo_symbol: yahooSymbolFor(claim.ticker),
      ...alignment,
      event_date: alignment.executable_date,
    };
  });

  const symbols = [...new Set(aligned.map((c) => c.yahoo_symbol).filter(Boolean))];
  const dates = aligned.map((c) => c.executable_date).filter(Boolean).sort();
  const fromDate = dates[0] ? shiftIsoDate(dates[0], -420) : shiftIsoDate(asOfDate, -420);
  const toDate = dates.length ? shiftIsoDate(dates[dates.length - 1], monthDays + 5) : asOfDate;

  /** @type {Map<string, object>} */
  const seriesBySymbol = new Map();
  for (const symbol of symbols) {
    const series = await provider.getOhlcvSeries(symbol, fromDate, toDate);
    seriesBySymbol.set(symbol, series);
  }

  const rows = [];
  for (const claim of aligned) {
    const series = seriesBySymbol.get(claim.yahoo_symbol) || { bars: [], status: 'missing' };
    const bars = Array.isArray(series.bars) ? series.bars : [];
    const hist = barsThrough(bars, claim.executable_date || claim.claim_date);
    // Use bars strictly before executable day for indicator snapshot to avoid leakage
    // of the entry day's close into pre-trade features when possible.
    const featureBars = claim.executable_date
      ? barsThrough(bars, shiftIsoDate(claim.executable_date, -1))
      : hist;
    const snap = computeIndicatorSnapshot(featureBars.length ? featureBars : hist);
    const trend = classifyTrendRegime(snap);
    const vol = classifyVolRegime(snap);
    const mtf = multiTimeframeScore(snap, claim.bias);
    const gapTalk = looksLikeGapTalk(claim.evidence_text || claim.rationale || '');
    const gap = evaluateGapAroundDate(bars, claim.executable_date, { gapTalk });
    const arch = classifySetupArchetype(claim, { gap, snap });
    const sim = simulateRTrade({
      bars,
      entryDate: claim.executable_date,
      bias: claim.bias,
      atr: snap.atr14,
    });

    // Horizon prices from executable date.
    let entryPx = null;
    let weekPx = null;
    let monthPx = null;
    let priceStatus = series.status || 'ok';
    if (claim.executable_date) {
      const entryBar = bars.find((b) => b.date >= claim.executable_date);
      entryPx = entryBar ? Number(entryBar.open ?? entryBar.close) : null;
      const weekDate = shiftIsoDate(claim.executable_date, weekDays);
      const monthDate = shiftIsoDate(claim.executable_date, monthDays);
      if (weekDate && weekDate <= asOfDate) {
        const wb = [...bars].reverse().find((b) => b.date <= weekDate) || null;
        weekPx = wb ? Number(wb.close) : null;
      }
      if (monthDate && monthDate <= asOfDate) {
        const mb = [...bars].reverse().find((b) => b.date <= monthDate) || null;
        monthPx = mb ? Number(mb.close) : null;
      }
      if (!Number.isFinite(entryPx)) priceStatus = 'missing_entry';
    } else {
      priceStatus = 'missing_event_date';
    }

    const ret1w = simpleReturn(entryPx, weekPx);
    const ret1m = simpleReturn(entryPx, monthPx);
    const hit1w = directionHit(claim.bias, ret1w);
    const hit1m = directionHit(claim.bias, ret1m);

    rows.push({
      source: claim.source,
      source_row_id: claim.source_row_id,
      video_id: claim.video_id || '',
      upload_date: claim.upload_date || '',
      ticker: claim.ticker || '',
      yahoo_symbol: claim.yahoo_symbol || '',
      bias: claim.bias || '',
      claim_kind: claim.claim_kind || 'forward',
      is_prediction: claim.is_prediction ? 1 : 0,
      evidence_text: claim.evidence_text || '',
      claim_date: claim.claim_date || '',
      claim_clock: claim.claim_clock || null,
      executable_date: claim.executable_date || '',
      event_date: claim.executable_date || '',
      alignment_confidence: claim.alignment_confidence || '',
      alignment_rule: claim.alignment_rule || '',
      asof_date: snap.asof_date || '',
      close: snap.close,
      rsi14: snap.rsi14,
      macd: snap.macd,
      macd_signal: snap.macd_signal,
      macd_hist: snap.macd_hist,
      sma20: snap.sma20,
      sma50: snap.sma50,
      sma200: snap.sma200,
      ema21: snap.ema21,
      atr14: snap.atr14,
      atr_pct: snap.atr_pct,
      bb_mid: snap.bb_mid,
      bb_upper: snap.bb_upper,
      bb_lower: snap.bb_lower,
      bb_bandwidth: snap.bb_bandwidth,
      volume_z20: snap.volume_z20,
      adx14: snap.adx14,
      bar_count: snap.bar_count,
      trend_regime: trend.label,
      trend_flags: trend,
      vol_regime: vol.label,
      vol_flags: vol,
      mtf_score: mtf.score,
      mtf_max: mtf.max_score,
      mtf_ratio: mtf.ratio,
      mtf_label: mtf.label,
      mtf_components: mtf.components,
      archetype: arch.archetype,
      archetype_score: arch.score,
      gap_talk: gap.gap_talk,
      has_gap: gap.has_gap,
      gap_pct: gap.gap_pct,
      gap_direction: gap.gap_direction,
      gap_kind: gap.gap_kind,
      gap_filled_5d: gap.filled_5d,
      gap_date: gap.gap_date,
      r_multiple: sim.r_multiple,
      mfe_r: sim.mfe_r,
      mae_r: sim.mae_r,
      exit_reason: sim.exit_reason,
      sim,
      entry_price: Number.isFinite(entryPx) ? entryPx : null,
      price_1w: Number.isFinite(weekPx) ? weekPx : null,
      price_1m: Number.isFinite(monthPx) ? monthPx : null,
      return_1w: ret1w,
      return_1m: ret1m,
      aligned_return_1w: alignedReturn(claim.bias, ret1w),
      aligned_return_1m: alignedReturn(claim.bias, ret1m),
      hit_1w: hit1w,
      hit_1m: hit1m,
      price_status: priceStatus,
      feature_version: FEATURE_VERSION,
    });
  }

  const summary = summarizeTaRows(rows);
  summary.walk_forward = evaluateWalkForward(rows, { trainMonths: opts.trainMonths || 3 });
  summary.feature_version = FEATURE_VERSION;
  summary.generated_at = new Date().toISOString();
  summary.horizons = { '1w_days': weekDays, '1m_days': monthDays };
  summary.as_of = asOfDate;

  return { summary, rows };
}

/**
 * @param {Array<object>} rows
 * @returns {object}
 */
function summarizeTaRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const scored1w = list.filter((r) => r.hit_1w === true || r.hit_1w === false);
  const hits1w = scored1w.filter((r) => r.hit_1w === true).length;
  const scored1m = list.filter((r) => r.hit_1m === true || r.hit_1m === false);
  const hits1m = scored1m.filter((r) => r.hit_1m === true).length;
  const rRows = list.filter((r) => Number.isFinite(Number(r.r_multiple)));
  const avg = (key) => {
    const xs = list.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
    if (!xs.length) return null;
    return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));
  };

  function group(key) {
    const map = new Map();
    for (const row of list) {
      const k = String(row[key] || 'unknown');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return [...map.entries()].map(([name, groupRows]) => {
      const s1w = groupRows.filter((r) => r.hit_1w === true || r.hit_1w === false);
      const h1w = s1w.filter((r) => r.hit_1w === true).length;
      const rr = groupRows.filter((r) => Number.isFinite(Number(r.r_multiple)));
      return {
        key: name,
        n: groupRows.length,
        scored_1w: s1w.length,
        hit_rate_1w: s1w.length ? Number((h1w / s1w.length).toFixed(3)) : null,
        avg_r: rr.length
          ? Number((rr.reduce((a, b) => a + Number(b.r_multiple), 0) / rr.length).toFixed(4))
          : null,
        avg_aligned_return_1w: (() => {
          const xs = groupRows.map((r) => Number(r.aligned_return_1w)).filter((n) => Number.isFinite(n));
          return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : null;
        })(),
      };
    }).sort((a, b) => b.n - a.n);
  }

  // MTF monotonicity: average hit rate by mtf_label order
  const mtfOrder = ['contrary', 'weak', 'moderate', 'strong'];
  const mtfByLabel = group('mtf_label');
  const mtfHitSeries = mtfOrder
    .map((label) => mtfByLabel.find((r) => r.key === label))
    .filter(Boolean)
    .map((r) => r.hit_rate_1w)
    .filter((v) => v != null);
  let mtfMonotonic = null;
  if (mtfHitSeries.length >= 3) {
    let nonDecreasing = true;
    for (let i = 1; i < mtfHitSeries.length; i += 1) {
      if (mtfHitSeries[i] + 1e-9 < mtfHitSeries[i - 1]) nonDecreasing = false;
    }
    mtfMonotonic = nonDecreasing;
  }

  const gapTalkRows = list.filter((r) => r.gap_talk);
  const gapConfirmed = gapTalkRows.filter((r) => r.has_gap === true);

  return {
    claim_count: list.length,
    scored_1w: scored1w.length,
    hit_rate_1w: scored1w.length ? Number((hits1w / scored1w.length).toFixed(3)) : null,
    scored_1m: scored1m.length,
    hit_rate_1m: scored1m.length ? Number((hits1m / scored1m.length).toFixed(3)) : null,
    avg_return_1w: avg('return_1w'),
    avg_return_1m: avg('return_1m'),
    avg_aligned_return_1w: avg('aligned_return_1w'),
    avg_r: rRows.length
      ? Number((rRows.reduce((a, b) => a + Number(b.r_multiple), 0) / rRows.length).toFixed(4))
      : null,
    avg_mfe_r: avg('mfe_r'),
    avg_mae_r: avg('mae_r'),
    by_trend_regime: group('trend_regime'),
    by_vol_regime: group('vol_regime'),
    by_archetype: group('archetype'),
    by_mtf_label: mtfByLabel,
    mtf_monotonic_hit_rate: mtfMonotonic,
    gap_talk_n: gapTalkRows.length,
    gap_confirmed_n: gapConfirmed.length,
    gap_fill_rate_5d: (() => {
      const xs = gapConfirmed.filter((r) => r.gap_filled_5d === true || r.gap_filled_5d === false);
      if (!xs.length) return null;
      return Number((xs.filter((r) => r.gap_filled_5d === true).length / xs.length).toFixed(3));
    })(),
    alignment: group('alignment_confidence'),
  };
}

module.exports = {
  FEATURE_VERSION,
  evaluateClaimsWithTa,
  summarizeTaRows,
};
