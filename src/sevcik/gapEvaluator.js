'use strict';

// Gap evaluation helpers for Sevcik claims that talk about gaps ("gapy").

/** Minimum |open-prevClose|/prevClose to call a market gap "real". */
const REAL_GAP_PCT = 0.015;

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
 * @param {object} [opts]
 * @param {number} [opts.minGapPct]
 * @returns {object}
 */
function detectGap(prevBar, bar, opts = {}) {
  const minGapPct = Number.isFinite(Number(opts.minGapPct)) ? Number(opts.minGapPct) : REAL_GAP_PCT;
  const prevClose = Number(prevBar && prevBar.close);
  const open = Number(bar && bar.open);
  if (!Number.isFinite(prevClose) || !Number.isFinite(open) || prevClose === 0) {
    return {
      has_gap: null,
      market_gap_observed: null,
      gap_pct: null,
      direction: null,
      kind: 'unknown',
      real_gap: null,
    };
  }
  const gapPct = (open - prevClose) / prevClose;
  const abs = Math.abs(gapPct);
  // Microstructure noise only.
  if (abs < 0.002) {
    return {
      has_gap: false,
      market_gap_observed: false,
      gap_pct: Number(gapPct.toFixed(6)),
      direction: 'flat',
      kind: 'none',
      real_gap: false,
    };
  }
  const direction = gapPct > 0 ? 'up' : 'down';
  const kind = abs >= 0.02 ? 'large' : (abs >= minGapPct ? 'normal' : 'tiny');
  const realGap = abs >= minGapPct;
  return {
    // Backward-compatible: has_gap means a REAL gap for scoring.
    has_gap: realGap,
    market_gap_observed: true,
    gap_pct: Number(gapPct.toFixed(6)),
    direction,
    kind,
    real_gap: realGap,
    min_gap_pct: minGapPct,
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
  const usable = gap && (gap.has_gap === true || gap.real_gap === true || gap.market_gap_observed === true);
  if (!usable || !Number.isFinite(priorClose) || !gap.direction || gap.direction === 'flat') {
    return { filled: null, fill_bar: null, fill_date: null };
  }
  // Prefer filling only real gaps in scorecards; still compute when observed.
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
  const minGapPct = Number.isFinite(Number(opts.minGapPct)) ? Number(opts.minGapPct) : REAL_GAP_PCT;
  const list = Array.isArray(bars) ? bars.filter((b) => b && b.date) : [];
  const base = {
    gap_talk: !!opts.gapTalk,
    linguistic_gap_setup: false,
    has_gap: null,
    market_gap_observed: null,
    real_gap: null,
    gap_pct: null,
    gap_direction: null,
    gap_kind: 'unknown',
    filled_5d: null,
    fill_bar: null,
    fill_date: null,
    prior_close: null,
    gap_date: '',
    min_gap_pct: minGapPct,
  };
  if (!executableDate || !list.length) return base;

  let idx = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].date >= executableDate) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return base;

  const bar = list[idx];
  const prev = list[idx - 1];
  const gap = detectGap(prev, bar, { minGapPct });
  const fill = gapFillOutcome(gap, Number(prev.close), list.slice(idx + 1), maxBars);
  const linguistic = !!opts.gapTalk && gap.real_gap === true;
  return {
    gap_talk: !!opts.gapTalk,
    linguistic_gap_setup: linguistic,
    has_gap: gap.has_gap,
    market_gap_observed: gap.market_gap_observed,
    real_gap: gap.real_gap,
    gap_pct: gap.gap_pct,
    gap_direction: gap.direction,
    gap_kind: gap.kind,
    filled_5d: gap.real_gap ? fill.filled : null,
    fill_bar: gap.real_gap ? fill.fill_bar : null,
    fill_date: gap.real_gap ? fill.fill_date : null,
    prior_close: Number(prev.close),
    gap_date: bar.date,
    min_gap_pct: minGapPct,
  };
}

module.exports = {
  REAL_GAP_PCT,
  detectGap,
  evaluateGapAroundDate,
  gapFillOutcome,
  looksLikeGapTalk,
};
