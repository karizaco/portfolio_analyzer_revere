'use strict';

// Path-aware R-multiple simulation on daily bars.
// Conservative defaults: enter next open, stop = k*ATR, targets in R units.

/**
 * @param {object} opts
 * @param {Array<object>} opts.bars ascending OHLCV including pre-entry history
 * @param {string} opts.entryDate executable date
 * @param {string} opts.bias bullish|bearish
 * @param {number} [opts.atr]
 * @param {number} [opts.atrMult] stop distance in ATR units (default 1.5)
 * @param {number} [opts.targetR] target in R (default 2)
 * @param {number} [opts.maxBars] max holding bars (default 20)
 * @returns {object}
 */
function simulateRTrade(opts) {
  const bars = Array.isArray(opts.bars) ? opts.bars : [];
  const bias = opts.bias === 'bearish' ? 'bearish' : opts.bias === 'bullish' ? 'bullish' : '';
  const entryDate = opts.entryDate || '';
  const atrMult = Number.isFinite(Number(opts.atrMult)) ? Number(opts.atrMult) : 1.5;
  const targetR = Number.isFinite(Number(opts.targetR)) ? Number(opts.targetR) : 2;
  const maxBars = Number.isFinite(Number(opts.maxBars)) ? Number(opts.maxBars) : 20;

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
    mfe_r: null,
    mae_r: null,
    hit_target: null,
    hit_stop: null,
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
  if (!Number.isFinite(atr) || atr <= 0) {
    // fallback: 1.5% of price
    atr = entry * 0.015;
  }
  const stopDist = atr * atrMult;
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

  const lastIdx = Math.min(bars.length - 1, entryIdx + maxBars);
  for (let i = entryIdx; i <= lastIdx; i += 1) {
    const bar = bars[i];
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    barsHeld = i - entryIdx + 1;

    if (bias === 'bullish') {
      mfe = Math.max(mfe, high - entry);
      mae = Math.max(mae, entry - low);
      // conservative same-bar path: stop before target if both touched
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

    if (i === lastIdx) {
      exitPrice = close;
      exitDate = bar.date;
      exitReason = 'time';
    }
  }

  if (!Number.isFinite(exitPrice)) {
    return {
      ...empty,
      status: 'no_exit',
      side: bias,
      entry_date: entryBar.date,
      entry_price: round(entry),
      stop_price: round(stop),
      target_price: round(target),
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
    mfe_r: round(mfe / stopDist, 4),
    mae_r: round(mae / stopDist, 4),
    hit_target: hitTarget,
    hit_stop: hitStop,
    stop_dist: round(stopDist, 6),
    atr_used: round(atr, 6),
    target_r: targetR,
    atr_mult: atrMult,
  };
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

module.exports = {
  simulateRTrade,
};
