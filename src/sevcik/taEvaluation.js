'use strict';

// TA evaluation orchestration over scored Sevcik claims.
// Pure-ish: price series are injected via provider; summarization is local.

const { alignClaimEvent } = require('./eventAlignment');
const { barsThrough, computeIndicatorSnapshot } = require('./taIndicators');
const { classifyTrendRegime, classifyVolRegime, multiTimeframeScore } = require('./taRegimes');
const { evaluateGapAroundDate, looksLikeGapTalk } = require('./gapEvaluator');
const { classifySetupArchetype } = require('./setupArchetypes');
const { simulateRTrade, summarizeRStats } = require('./rMultipleSim');
const { evaluateWalkForward, buildWalkForwardFolds } = require('./walkForward');
const { buildEdgeMatrix, applyEdgePolicyWalkForward } = require('./edgeMatrix');
const {
  alignedReturn,
  directionHit,
  shiftIsoDate,
  simpleReturn,
  yahooSymbolFor,
} = require('./outcomeAnalysis');

const FEATURE_VERSION = 'sevcik-ta-2';

/**
 * Confidence band for edge matrix / scorecards.
 * @param {object} claim
 * @returns {string}
 */
function confidenceBand(claim) {
  if (claim.confidence_band) return String(claim.confidence_band);
  if (claim.certainty_band) return String(claim.certainty_band);
  const c = Number(claim.confidence);
  if (Number.isFinite(c)) {
    if (c >= 0.75) return 'high';
    if (c >= 0.45) return 'medium';
    return 'low';
  }
  const cert = Number(claim.certainty);
  if (Number.isFinite(cert)) {
    if (cert >= 0.75) return 'high';
    if (cert >= 0.45) return 'medium';
    return 'low';
  }
  return 'unknown';
}

/**
 * Prefer signals over setups; then higher confidence / certainty.
 * @param {object} a
 * @param {object} b
 * @returns {number} negative if a wins
 */
function claimRank(a, b) {
  const srcScore = (row) => (String(row.source) === 'signal' ? 2 : String(row.source) === 'setup' ? 1 : 0);
  const dSrc = srcScore(b) - srcScore(a);
  if (dSrc) return dSrc;
  const conf = (row) => {
    const n = Number(row.confidence);
    if (Number.isFinite(n)) return n;
    const c = Number(row.certainty);
    return Number.isFinite(c) ? c : 0;
  };
  const dConf = conf(b) - conf(a);
  if (dConf) return dConf;
  // Stable tie-break: lower source_row_id wins.
  return Number(a.source_row_id || 0) - Number(b.source_row_id || 0);
}

/**
 * De-dupe claims on (video_id, ticker, executable_date).
 * @param {Array<object>} rows
 * @returns {{primary:object[], dropped:object[], map:Map<string,object>}}
 */
function dedupePrimaryClaims(rows) {
  /** @type {Map<string, object>} */
  const best = new Map();
  const dropped = [];
  for (const row of rows || []) {
    const key = [
      String(row.video_id || ''),
      String(row.ticker || '').toUpperCase(),
      String(row.executable_date || row.event_date || ''),
    ].join('|');
    if (!best.has(key)) {
      best.set(key, { ...row, dedupe_key: key, dedupe_primary: true });
      continue;
    }
    const current = best.get(key);
    if (claimRank(row, current) < 0) {
      dropped.push({ ...current, dedupe_primary: false, dedupe_key: key });
      best.set(key, { ...row, dedupe_key: key, dedupe_primary: true });
    } else {
      dropped.push({ ...row, dedupe_primary: false, dedupe_key: key });
    }
  }
  return {
    primary: [...best.values()],
    dropped,
    map: best,
  };
}

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
  const edgeMinN = Number(opts.edgeMinN) || 8;

  const aligned = list.map((claim, index) => {
    const yahoo = claim.yahoo_symbol || yahooSymbolFor(claim.ticker);
    const alignment = alignClaimEvent({ ...claim, yahoo_symbol: yahoo });
    return {
      ...claim,
      source: claim.source || 'signal',
      source_row_id: claim.source_row_id == null ? index : claim.source_row_id,
      yahoo_symbol: alignment.yahoo_symbol || yahoo,
      confidence_band: confidenceBand(claim),
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
    // Features use bars strictly before executable day to avoid leakage.
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
      confidence: claim.confidence == null ? null : Number(claim.confidence),
      certainty: claim.certainty == null ? null : Number(claim.certainty),
      confidence_band: claim.confidence_band || confidenceBand(claim),
      evidence_text: claim.evidence_text || '',
      claim_date: claim.claim_date || '',
      claim_clock: claim.claim_clock || null,
      event_time_sec: claim.event_time_sec == null ? null : claim.event_time_sec,
      executable_date: claim.executable_date || '',
      event_date: claim.executable_date || '',
      venue: claim.venue || '',
      venue_known: !!claim.venue_known,
      alignment_confidence: claim.alignment_confidence || '',
      alignment_rule: claim.alignment_rule || '',
      asof_date: claim.claim_date || '',
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
      bar_count: snap.bar_count || 0,
      trend_regime: trend.regime || trend.label || trend || '',
      vol_regime: vol.regime || vol.label || vol || '',
      mtf_score: mtf.score == null ? null : mtf.score,
      mtf_label: mtf.label || '',
      archetype: arch.archetype || '',
      archetype_score: arch.score,
      gap_qualified: !!arch.gap_qualified,
      gap_talk: !!gap.gap_talk,
      linguistic_gap_setup: !!gap.linguistic_gap_setup,
      market_gap_observed: gap.market_gap_observed,
      real_gap: gap.real_gap,
      has_gap: gap.has_gap,
      gap_pct: gap.gap_pct,
      gap_direction: gap.gap_direction,
      gap_kind: gap.gap_kind,
      gap_filled_5d: gap.filled_5d,
      gap_date: gap.gap_date,
      r_multiple: sim.r_multiple,
      r_multiple_clipped: sim.r_multiple_clipped,
      mfe_r: sim.mfe_r,
      mae_r: sim.mae_r,
      exit_reason: sim.exit_reason,
      stop_mode: sim.stop_mode || '',
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

  const summary = summarizeTaRows(rows, { edgeMinN });
  const wf = evaluateWalkForward(rows, { trainMonths: opts.trainMonths || 3 });
  // Frozen edge policy checked on walk-forward OOS folds (no refit inside test month).
  const folds = buildWalkForwardFolds(rows, { trainMonths: opts.trainMonths || 3 });
  const edgeWf = folds.map((fold) => ({
    fold: fold.fold,
    test_month: fold.test_month,
    ...applyEdgePolicyWalkForward(fold.train, fold.test, { minN: edgeMinN }),
  }));
  const edgeSelectedHits = edgeWf
    .map((f) => f.selected_hit_rate_1w)
    .filter((v) => v != null);
  wf.edge_policy = {
    folds: edgeWf,
    avg_selected_hit_rate_1w: edgeSelectedHits.length
      ? Number((edgeSelectedHits.reduce((a, b) => a + b, 0) / edgeSelectedHits.length).toFixed(4))
      : null,
    note: 'Allow-buckets learned on train months only; test month is untouched.',
  };
  summary.walk_forward = wf;
  summary.feature_version = FEATURE_VERSION;
  summary.generated_at = new Date().toISOString();
  summary.horizons = { '1w_days': weekDays, '1m_days': monthDays };
  summary.as_of = asOfDate;

  return { summary, rows };
}

/**
 * Scorecard for a subset of rows.
 * @param {Array<object>} rows
 * @returns {object}
 */
function scorecardFor(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const scored1w = list.filter((r) => r.hit_1w === true || r.hit_1w === false);
  const hits1w = scored1w.filter((r) => r.hit_1w === true).length;
  const scored1m = list.filter((r) => r.hit_1m === true || r.hit_1m === false);
  const hits1m = scored1m.filter((r) => r.hit_1m === true).length;
  const rStats = summarizeRStats(list);
  const avg = (key) => {
    const xs = list.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
    if (!xs.length) return null;
    return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));
  };
  return {
    claim_count: list.length,
    scored_1w: scored1w.length,
    hit_rate_1w: scored1w.length ? Number((hits1w / scored1w.length).toFixed(3)) : null,
    scored_1m: scored1m.length,
    hit_rate_1m: scored1m.length ? Number((hits1m / scored1m.length).toFixed(3)) : null,
    avg_return_1w: avg('return_1w'),
    avg_return_1m: avg('return_1m'),
    avg_aligned_return_1w: avg('aligned_return_1w'),
    avg_r: rStats.avg_r,
    avg_r_clipped: rStats.avg_r_clipped,
    median_r: rStats.median_r,
    avg_mfe_r: rStats.avg_mfe_r,
    avg_mae_r: rStats.avg_mae_r,
    exit_mix: rStats.exit_mix,
  };
}

/**
 * @param {Array<object>} rows
 * @param {object} [opts]
 * @returns {object}
 */
function summarizeTaRows(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const edgeMinN = Number(opts.edgeMinN) || 8;
  const base = scorecardFor(list);

  function group(key) {
    const map = new Map();
    for (const row of list) {
      const k = String(row[key] || 'unknown');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return [...map.entries()].map(([name, groupRows]) => {
      const card = scorecardFor(groupRows);
      return {
        key: name,
        n: groupRows.length,
        scored_1w: card.scored_1w,
        hit_rate_1w: card.hit_rate_1w,
        avg_r: card.avg_r,
        avg_r_clipped: card.avg_r_clipped,
        median_r: card.median_r,
        avg_aligned_return_1w: card.avg_aligned_return_1w,
      };
    }).sort((a, b) => b.n - a.n);
  }

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
  const gapReal = list.filter((r) => r.real_gap === true || r.has_gap === true);
  const gapLinguistic = list.filter((r) => r.linguistic_gap_setup === true || r.gap_qualified === true);

  const signals = list.filter((r) => r.source === 'signal');
  const setups = list.filter((r) => r.source === 'setup');
  const deduped = dedupePrimaryClaims(list);

  const edgeMatrix = buildEdgeMatrix(list, { minN: edgeMinN });
  const edgeMatrixDeduped = buildEdgeMatrix(deduped.primary, { minN: edgeMinN });

  return {
    ...base,
    by_trend_regime: group('trend_regime'),
    by_vol_regime: group('vol_regime'),
    by_archetype: group('archetype'),
    by_mtf_label: mtfByLabel,
    by_source: group('source'),
    by_alignment: group('alignment_confidence'),
    mtf_monotonic_hit_rate: mtfMonotonic,
    gap_talk_n: gapTalkRows.length,
    gap_observed_n: list.filter((r) => r.market_gap_observed === true).length,
    gap_real_n: gapReal.length,
    gap_confirmed_n: gapLinguistic.length,
    gap_linguistic_n: gapLinguistic.length,
    gap_fill_rate_5d: (() => {
      const xs = gapLinguistic.filter((r) => r.gap_filled_5d === true || r.gap_filled_5d === false);
      if (!xs.length) {
        // Fall back to real gaps only if no linguistic-qualified rows.
        const ys = gapReal.filter((r) => r.gap_filled_5d === true || r.gap_filled_5d === false);
        if (!ys.length) return null;
        return Number((ys.filter((r) => r.gap_filled_5d === true).length / ys.length).toFixed(3));
      }
      return Number((xs.filter((r) => r.gap_filled_5d === true).length / xs.length).toFixed(3));
    })(),
    alignment: group('alignment_confidence'),
    scorecards: {
      all: base,
      signals_only: scorecardFor(signals),
      setups_only: scorecardFor(setups),
      deduped_primary: scorecardFor(deduped.primary),
    },
    dedupe: {
      input_n: list.length,
      primary_n: deduped.primary.length,
      dropped_n: deduped.dropped.length,
      rule: 'key=(video_id,ticker,executable_date); prefer signal over setup, then higher confidence/certainty',
    },
    edge_matrix: edgeMatrix,
    edge_matrix_deduped: edgeMatrixDeduped,
  };
}

module.exports = {
  FEATURE_VERSION,
  claimRank,
  confidenceBand,
  dedupePrimaryClaims,
  evaluateClaimsWithTa,
  scorecardFor,
  summarizeTaRows,
};
