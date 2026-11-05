'use strict';

// Path-aware R-multiple simulation on daily bars.
// Conservative defaults: enter next open, stop = k*ATR (floored/capped), targets in R.

const DEFAULT_ATR_MULT = 1.5;
const DEFAULT_TARGET_R = 2;
const DEFAULT_MAX_BARS = 20;
/** Floor stop distance as fraction of entry (blocks absurd R on tiny ATR). */
const MIN_STOP_PCT = 0.01;
/** Cap stop distance as fraction of entry. */
const MAX_STOP_PCT = 0.08;
/** Clip |R| in aggregate stats only; raw r_multiple stays unclipped on the row. */
const AGG_R_CLIP = 5;

/**
 * OHLC must be finite and strictly positive. Yahoo occasionally emits close=0 stubs.
 * @param {object|null|undefined} bar
 * @returns {boolean}
 */
function isValidBar(bar) {
  if (!bar) return false;
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return false;
  // Soft sanity: high should be the top, low the bottom (allow minor feed noise).
  if (high < low) return false;
  if (high < Math.min(open, close) * 0.5) return false;
  return true;
}

/**
 * Drop invalid OHLC rows; keep order.
 * @param {Array<object>} bars
 * @returns {Array<object>}
 */
function sanitizeBars(bars) {
  return (Array.isArray(bars) ? bars : []).filter(isValidBar);
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.bars ascending OHLCV including pre-entry history
 * @param {string} opts.entryDate executable date
 * @param {string} opts.bias bullish|bearish
 * @param {number} [opts.atr]
 * @param {number} [opts.atrMult]
 * @param {number} [opts.targetR]
 * @param {number} [opts.maxBars]
 * @param {boolean} [opts.useStructureStop] prior bar low/high as structural stop candidate
 * @returns {object}
 */
function simulateRTrade(opts) {
  const bars = sanitizeBars(opts.bars);
  const bias = opts.bias === 'bearish' ? 'bearish' : opts.bias === 'bullish' ? 'bullish' : '';
  const entryDate = opts.entryDate || '';
  const atrMult = Number.isFinite(Number(opts.atrMult)) ? Number(opts.atrMult) : DEFAULT_ATR_MULT;
  const targetR = Number.isFinite(Number(opts.targetR)) ? Number(opts.targetR) : DEFAULT_TARGET_R;
  const maxBars = Number.isFinite(Number(opts.maxBars)) ? Number(opts.maxBars) : DEFAULT_MAX_BARS;
  const minStopPct = Number.isFinite(Number(opts.minStopPct)) ? Number(opts.minStopPct) : MIN_STOP_PCT;
  const maxStopPct = Number.isFinite(Number(opts.maxStopPct)) ? Number(opts.maxStopPct) : MAX_STOP_PCT;
  const useStructureStop = opts.useStructureStop !== false;

  const empty = {
    status: 'unscored',
    side: bias || '',
    entry_date: '',
    entry_price: null,
    stop_price: null,
    target_price: null,
    exit_date: '',
    exit_price: null,
    exit_reason: '',
    bars_held: null,
    r_multiple: null,
    r_multiple_clipped: null,
    mfe_r: null,
    mae_r: null,
    hit_target: null,
    hit_stop: null,
    stop_mode: '',
  };

  if (!bias || !entryDate || !bars.length) {
    return { ...empty, status: 'missing_inputs' };
  }

  let entryIdx = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].date >= entryDate) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) return { ...empty, status: 'entry_bar_missing' };

  const entryBar = bars[entryIdx];
  const entry = Number(entryBar.open);
  if (!Number.isFinite(entry) || entry <= 0) return { ...empty, status: 'bad_entry_price' };

  let atr = Number(opts.atr);
  if (!Number.isFinite(atr) || atr <= 0) atr = entry * 0.015;

  let stopDist = atr * atrMult;
  let stopMode = 'atr';
  if (useStructureStop && entryIdx > 0) {
    const prev = bars[entryIdx - 1];
    if (isValidBar(prev)) {
      const structural = bias === 'bullish'
        ? entry - Number(prev.low)
        : Number(prev.high) - entry;
      if (Number.isFinite(structural) && structural > 0) {
        if (structural > stopDist) {
          stopDist = structural;
          stopMode = 'structure';
        } else {
          stopMode = 'atr_ge_structure';
        }
      }
    }
  }

  const minDist = entry * minStopPct;
  const maxDist = entry * maxStopPct;
  if (stopDist < minDist) {
    stopDist = minDist;
    stopMode = `${stopMode}|floor`;
  } else if (stopDist > maxDist) {
    stopDist = maxDist;
    stopMode = `${stopMode}|cap`;
  }
  if (!Number.isFinite(stopDist) || stopDist <= 0) return { ...empty, status: 'bad_stop' };

  const stop = bias === 'bullish' ? entry - stopDist : entry + stopDist;
  const target = bias === 'bullish'
    ? entry + (stopDist * targetR)
    : entry - (stopDist * targetR);

  let mfe = 0;
  let mae = 0;
  let exitPrice = null;
  let exitDate = '';
  let exitReason = 'time';
  let barsHeld = 0;
  let hitTarget = false;
  let hitStop = false;
  let lastValidClose = null;
  let lastValidDate = '';
  let validBarsSeen = 0;

  const lastIdx = Math.min(bars.length - 1, entryIdx + maxBars);
  for (let i = entryIdx; i <= lastIdx; i += 1) {
    const bar = bars[i];
    if (!isValidBar(bar)) continue;
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    validBarsSeen += 1;
    barsHeld = i - entryIdx + 1;
    lastValidClose = close;
    lastValidDate = bar.date || '';

    if (bias === 'bullish') {
      mfe = Math.max(mfe, high - entry);
      mae = Math.max(mae, entry - low);
      const stopHit = low <= stop;
      const targetHit = high >= target;
      if (stopHit && targetHit) {
        exitPrice = stop;
        exitDate = bar.date;
        exitReason = 'stop_before_target_same_bar';
        hitStop = true;
        break;
      }
      if (stopHit) {
        exitPrice = stop;
        exitDate = bar.date;
        exitReason = 'stop';
        hitStop = true;
        break;
      }
      if (targetHit) {
        exitPrice = target;
        exitDate = bar.date;
        exitReason = 'target';
        hitTarget = true;
        break;
      }
    } else {
      mfe = Math.max(mfe, entry - low);
      mae = Math.max(mae, high - entry);
      const stopHit = high >= stop;
      const targetHit = low <= target;
      if (stopHit && targetHit) {
        exitPrice = stop;
        exitDate = bar.date;
        exitReason = 'stop_before_target_same_bar';
        hitStop = true;
        break;
      }
      if (stopHit) {
        exitPrice = stop;
        exitDate = bar.date;
        exitReason = 'stop';
        hitStop = true;
        break;
      }
      if (targetHit) {
        exitPrice = target;
        exitDate = bar.date;
        exitReason = 'target';
        hitTarget = true;
        break;
      }
    }
  }

  if (!hitStop && !hitTarget) {
    if (Number.isFinite(lastValidClose) && lastValidClose > 0) {
      exitPrice = lastValidClose;
      exitDate = lastValidDate;
      exitReason = 'time';
    }
  }

  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    return {
      ...empty,
      status: validBarsSeen ? 'no_exit' : 'no_valid_bars',
      side: bias,
      entry_date: entryBar.date,
      entry_price: round(entry),
      stop_price: round(stop),
      target_price: round(target),
      stop_mode: stopMode,
    };
  }

  const signed = bias === 'bullish' ? (exitPrice - entry) : (entry - exitPrice);
  const rMultiple = signed / stopDist;
  return {
    status: 'ok',
    side: bias,
    entry_date: entryBar.date,
    entry_price: round(entry),
    stop_price: round(stop),
    target_price: round(target),
    exit_date: exitDate,
    exit_price: round(exitPrice),
    exit_reason: exitReason,
    bars_held: barsHeld,
    r_multiple: round(rMultiple, 4),
    r_multiple_clipped: round(clipR(rMultiple, AGG_R_CLIP), 4),
    mfe_r: round(mfe / stopDist, 4),
    mae_r: round(mae / stopDist, 4),
    hit_target: hitTarget,
    hit_stop: hitStop,
    stop_dist: round(stopDist, 6),
    atr_used: round(atr, 6),
    target_r: targetR,
    atr_mult: atrMult,
    stop_mode: stopMode,
    min_stop_pct: minStopPct,
    max_stop_pct: maxStopPct,
    valid_bars_seen: validBarsSeen,
  };
}

function clipR(value, limit = AGG_R_CLIP) {
  if (!Number.isFinite(value)) return null;
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

/**
 * Aggregate R hygiene for a list of sim rows / feature rows.
 * @param {Array<object>} rows
 * @returns {object}
 */
function summarizeRStats(rows) {
  const usable = (rows || []).filter((r) => {
    const status = r.sim_status || r.status;
    if (status && status !== 'ok') return false;
    const exit = Number(r.exit_price);
    if (Number.isFinite(exit) && exit <= 0) return false;
    return Number.isFinite(Number(r.r_multiple));
  });
  const raw = usable.map((r) => Number(r.r_multiple));
  const clipped = raw.map((n) => clipR(n));
  const exits = { stop: 0, target: 0, time: 0, other: 0, missing: 0 };
  for (const row of rows || []) {
    const reason = String(row.exit_reason || '');
    if (!reason) exits.missing += 1;
    else if (reason === 'stop' || reason.startsWith('stop_')) exits.stop += 1;
    else if (reason === 'target') exits.target += 1;
    else if (reason === 'time') exits.time += 1;
    else exits.other += 1;
  }
  return {
    n: raw.length,
    avg_r: mean(raw),
    avg_r_clipped: mean(clipped),
    median_r: median(raw),
    avg_mfe_r: mean(usable.map((r) => Number(r.mfe_r)).filter((n) => Number.isFinite(n))),
    avg_mae_r: mean(usable.map((r) => Number(r.mae_r)).filter((n) => Number.isFinite(n))),
    exit_mix: exits,
    r_clip: AGG_R_CLIP,
  };
}

function mean(xs) {
  if (!xs.length) return null;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Number(v.toFixed(4));
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

module.exports = {
  AGG_R_CLIP,
  MAX_STOP_PCT,
  MIN_STOP_PCT,
  clipR,
  isValidBar,
  sanitizeBars,
  simulateRTrade,
  summarizeRStats,
};
