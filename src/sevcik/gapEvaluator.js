'use strict';

// Gap evaluation helpers for Sevcik claims that talk about gaps ("gapy").

/**
 * Does the evidence look like gap commentary?
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeGapTalk(text) {
  const t = String(text || '').toLowerCase();
  // Czech ASR often writes gap as "gap", "gapy", sometimes "gab"/"gaby".
  return /\bgap(?:y|u|em|ů|ech)?\b/.test(t)
    || /\bgab(?:y|u|em)?\b/.test(t)
    || /mezera/.test(t);
}

/**
 * Detect gap between previous close and current open.
 * @param {object|null} prevBar
 * @param {object|null} bar
 * @returns {object}
 */
function detectGap(prevBar, bar) {
  const prevClose = Number(prevBar && prevBar.close);
  const open = Number(bar && bar.open);
  if (!Number.isFinite(prevClose) || !Number.isFinite(open) || prevClose === 0) {
    return {
      has_gap: null,
      gap_pct: null,
      direction: null,
      kind: 'unknown',
    };
  }
  const gapPct = (open - prevClose) / prevClose;
  const abs = Math.abs(gapPct);
  // Ignore tiny microstructure noise.
  if (abs < 0.002) {
    return { has_gap: false, gap_pct: Number(gapPct.toFixed(6)), direction: 'flat', kind: 'none' };
  }
  return {
    has_gap: true,
    gap_pct: Number(gapPct.toFixed(6)),
    direction: gapPct > 0 ? 'up' : 'down',
    kind: abs >= 0.02 ? 'large' : 'normal',
  };
}

/**
 * Did the gap fill within N bars (low/high touches prior close)?
 * @param {object} gap detectGap result
 * @param {number} priorClose
 * @param {Array<object>} forwardBars bars AFTER the gap bar, ascending
 * @param {number} [maxBars]
 * @returns {object}
 */
function gapFillOutcome(gap, priorClose, forwardBars, maxBars = 5) {
  if (!gap || !gap.has_gap || !Number.isFinite(priorClose)) {
    return { filled: null, fill_bar: null, fill_date: null };
  }
  const list = Array.isArray(forwardBars) ? forwardBars.slice(0, maxBars) : [];
  for (let i = 0; i < list.length; i += 1) {
    const bar = list[i];
    const high = Number(bar.high);
    const low = Number(bar.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    const filled = gap.direction === 'up'
      ? low <= priorClose
      : high >= priorClose;
    if (filled) {
      return { filled: true, fill_bar: i + 1, fill_date: bar.date || null };
    }
  }
  return { filled: list.length ? false : null, fill_bar: null, fill_date: null };
}

/**
 * Evaluate gap context around an executable date.
 * @param {Array<object>} bars full series ascending
 * @param {string} executableDate
 * @param {object} [opts]
 * @returns {object}
 */
function evaluateGapAroundDate(bars, executableDate, opts = {}) {
  const maxBars = opts.maxBars || 5;
  const list = Array.isArray(bars) ? bars.filter((b) => b && b.date) : [];
  if (!executableDate || !list.length) {
    return {
      gap_talk: !!opts.gapTalk,
      has_gap: null,
      gap_pct: null,
      gap_direction: null,
      gap_kind: 'unknown',
      filled_5d: null,
      fill_bar: null,
      fill_date: null,
      prior_close: null,
      gap_date: '',
    };
  }
  let idx = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].date >= executableDate) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) {
    return {
      gap_talk: !!opts.gapTalk,
      has_gap: null,
      gap_pct: null,
      gap_direction: null,
      gap_kind: 'unknown',
      filled_5d: null,
      fill_bar: null,
      fill_date: null,
      prior_close: null,
      gap_date: '',
    };
  }
  const bar = list[idx];
  const prev = list[idx - 1];
  const gap = detectGap(prev, bar);
  const fill = gapFillOutcome(gap, Number(prev.close), list.slice(idx + 1), maxBars);
  return {
    gap_talk: !!opts.gapTalk,
    has_gap: gap.has_gap,
    gap_pct: gap.gap_pct,
    gap_direction: gap.direction,
    gap_kind: gap.kind,
    filled_5d: fill.filled,
    fill_bar: fill.fill_bar,
    fill_date: fill.fill_date,
    prior_close: Number(prev.close),
    gap_date: bar.date,
  };
}

module.exports = {
  detectGap,
  evaluateGapAroundDate,
  gapFillOutcome,
  looksLikeGapTalk,
};
