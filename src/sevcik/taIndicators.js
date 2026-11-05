'use strict';

// Pure technical-indicator helpers over daily OHLCV bars.
// No network, no I/O -- feed sorted bars [{date,open,high,low,close,volume}].

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const v = finite(values[i]);
    if (v === null) return null;
    sum += v;
  }
  return sum / period;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = finite(values[i]);
    if (v === null) continue;
    if (prev === null) {
      seed += v;
      if (i + 1 >= period) {
        // seed uses the first `period` finite values ending at i when possible
        let count = 0;
        let sum = 0;
        for (let j = i; j >= 0 && count < period; j -= 1) {
          const vv = finite(values[j]);
          if (vv === null) continue;
          sum += vv;
          count += 1;
        }
        if (count === period) {
          prev = sum / period;
          out[i] = prev;
        }
      }
      continue;
    }
    prev = (v * k) + (prev * (1 - k));
    out[i] = prev;
  }
  return out;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = finite(closes[i - 1]);
    const cur = finite(closes[i]);
    if (prev === null || cur === null) return null;
    const diff = cur - prev;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function stdev(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period).map(finite);
  if (slice.some((v) => v === null)) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const varSum = slice.reduce((a, b) => a + ((b - mean) ** 2), 0) / period;
  return Math.sqrt(varSum);
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  if (mid === null || sd === null) {
    return { mid: null, upper: null, lower: null, bandwidth: null };
  }
  const upper = mid + (mult * sd);
  const lower = mid - (mult * sd);
  const bandwidth = mid !== 0 ? (upper - lower) / mid : null;
  return { mid, upper, lower, bandwidth };
}

function trueRange(bar, prevClose) {
  const high = finite(bar.high);
  const low = finite(bar.low);
  const close = finite(bar.close);
  if (high === null || low === null) return null;
  const ranges = [high - low];
  if (finite(prevClose) !== null) {
    ranges.push(Math.abs(high - prevClose));
    ranges.push(Math.abs(low - prevClose));
  }
  return Math.max(...ranges);
}

function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = finite(bars[i - 1].close);
    const tr = trueRange(bars[i], prevClose);
    if (tr === null) return null;
    trs.push(tr);
  }
  if (trs.length < period) return null;
  return sma(trs, period);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signal) {
    return { macd: null, signal: null, hist: null };
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });
  // Build signal EMA only on defined macd points by carrying forward nulls.
  const compact = [];
  const compactIndex = [];
  for (let i = 0; i < macdLine.length; i += 1) {
    if (macdLine[i] !== null) {
      compact.push(macdLine[i]);
      compactIndex.push(i);
    }
  }
  const signalCompact = emaSeries(compact, signal);
  const signalLine = new Array(macdLine.length).fill(null);
  for (let j = 0; j < compactIndex.length; j += 1) {
    signalLine[compactIndex[j]] = signalCompact[j];
  }
  const last = macdLine.length - 1;
  const m = macdLine[last];
  const s = signalLine[last];
  return {
    macd: m,
    signal: s,
    hist: (m !== null && s !== null) ? (m - s) : null,
  };
}

function volumeZScore(volumes, period = 20) {
  if (!Array.isArray(volumes) || volumes.length < period) return null;
  const slice = volumes.slice(volumes.length - period).map(finite);
  if (slice.some((v) => v === null)) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + ((b - mean) ** 2), 0) / period);
  if (!sd) return 0;
  const last = slice[slice.length - 1];
  return (last - mean) / sd;
}

/**
 * ADX approximation (Wilder-lite) using simple averages for stability.
 * @param {Array<object>} bars
 * @param {number} [period]
 * @returns {number|null}
 */
function adx(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period + 1) return null;
  const plusDM = [];
  const minusDM = [];
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const up = finite(bars[i].high) - finite(bars[i - 1].high);
    const down = finite(bars[i - 1].low) - finite(bars[i].low);
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const tr = trueRange(bars[i], finite(bars[i - 1].close));
    if (tr === null) return null;
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const trN = sma(trs, period);
  const plusN = sma(plusDM, period);
  const minusN = sma(minusDM, period);
  if (!trN) return null;
  const plusDI = 100 * (plusN / trN);
  const minusDI = 100 * (minusN / trN);
  const denom = plusDI + minusDI;
  if (!denom) return 0;
  const dx = 100 * Math.abs(plusDI - minusDI) / denom;
  return dx;
}

/**
 * Snapshot indicators at the last bar of the provided window.
 * Bars must be sorted ascending by date and end at/before the as-of bar.
 *
 * @param {Array<object>} bars
 * @returns {object}
 */
function computeIndicatorSnapshot(bars) {
  const list = Array.isArray(bars) ? bars.filter((b) => b && b.date) : [];
  if (!list.length) {
    return {
      asof_date: '',
      close: null,
      rsi14: null,
      macd: null,
      macd_signal: null,
      macd_hist: null,
      sma20: null,
      sma50: null,
      sma200: null,
      ema21: null,
      atr14: null,
      atr_pct: null,
      bb_mid: null,
      bb_upper: null,
      bb_lower: null,
      bb_bandwidth: null,
      volume_z20: null,
      adx14: null,
      bar_count: 0,
    };
  }
  const closes = list.map((b) => finite(b.close));
  const volumes = list.map((b) => finite(b.volume));
  const last = list[list.length - 1];
  const close = finite(last.close);
  const macdParts = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(list, 14);
  return {
    asof_date: last.date,
    close,
    rsi14: rsi(closes, 14),
    macd: macdParts.macd,
    macd_signal: macdParts.signal,
    macd_hist: macdParts.hist,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema21: ema(closes, 21),
    atr14,
    atr_pct: (atr14 !== null && close) ? (atr14 / close) : null,
    bb_mid: bb.mid,
    bb_upper: bb.upper,
    bb_lower: bb.lower,
    bb_bandwidth: bb.bandwidth,
    volume_z20: volumeZScore(volumes, 20),
    adx14: adx(list, 14),
    bar_count: list.length,
  };
}

/**
 * Slice bars to those with date <= asOfDate.
 * @param {Array<object>} bars
 * @param {string} asOfDate
 * @returns {Array<object>}
 */
function barsThrough(bars, asOfDate) {
  if (!asOfDate) return [];
  return (bars || []).filter((b) => b && b.date && b.date <= asOfDate);
}

module.exports = {
  adx,
  atr,
  barsThrough,
  bollinger,
  computeIndicatorSnapshot,
  ema,
  macd,
  rsi,
  sma,
  stdev,
  volumeZScore,
};
