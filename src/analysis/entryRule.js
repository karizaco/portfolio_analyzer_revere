'use strict';

/**
 * The ENTRY RULE: the price a reader actually pays when a claim is acted on.
 *
 * WHY THIS IS A SHARED MODULE
 *
 * Every forward claim in this project is entered at ONE price: the close
 * on the day the claim was made. That rule has never been measured against
 * an alternative, and it is applied identically to every source -- which
 * means a systematic bias in it would be invisible in every source at
 * once.
 *
 * The bias is real, and three sources document it from their own side:
 *
 *   - Martin Klass's forward readings are published AFTER the news that
 *     moved the name, so the close on the day of the claim is already
 *     past the move the call is about.
 *   - Monoszon's retrospective calls are excluded precisely because "the
 *     price has already moved".
 *   - HariSeldon is an intraday trader: 285 of his 460 closed episodes
 *     are same-day, and a close-to-close model cannot see them at all.
 *
 * So the entry rule is the one lever that has never been pulled, and it
 * is the one that decides whether "these sources do not beat the index"
 * is a fact about the sources or a fact about the rule.
 *
 * THE RULES, AND WHAT EACH ONE ASSUMES
 *
 *   close_d0   the close on the day of the claim. THE SHIPPED RULE.
 *   open_d1    the open of the next session. What a reader who acts on
 *              the claim TOMORROW pays, and it is executable.
 *   close_d1   the close of the next session. Executable, and it is the
 *              most conservative of the three in the sense that it gives
 *              the claim the least time to work.
 *   limit_d0   a limit order 1 % BETTER than the signal close, filled
 *              during the next session if the market trades through it.
 *              This is the rule that asks the sharpest question: is the
 *              call good, and merely late? A limit that does not fill is
 *              NOT a trade, and the row is counted as unfilled rather
 *              than silently scored.
 *
 * THE HORIZON DOES NOT MOVE
 *
 * The exit is always the close on the CLAIM date plus the horizon, in
 * every rule. Only the entry changes. So the comparison isolates the
 * entry, and a rule that enters later is judged on a SHORTER holding
 * period -- which is what entering later means.
 *
 * THE PRICES ARE ALL ON ONE BASIS
 *
 * The cache stores an adjusted close (`price`, which carries the split
 * and dividend adjustment) alongside the raw `open`, `high` and `low`.
 * Mixing an adjusted close with a raw open would compare two different
 * instruments on two different days. So every bar is put on the ADJUSTED
 * basis by scaling the raw prices by the bar's own adjustment factor.
 */

const { toIsoDate, shiftIsoDate } = require('../sevcik/outcomeAnalysis');

/** The rules that need no fill. */
const ENTRY_RULES = [
  {
    name: 'close_d0',
    label: 'the close on the day of the claim',
    needsFill: false,
  },
  {
    name: 'open_d1',
    label: "the next session's open",
    needsFill: false,
  },
  {
    name: 'close_d1',
    label: "the next session's close",
    needsFill: false,
  },
];

/**
 * A limit rule: a limit order `limitPct` better than the signal close.
 *
 * @param {number} limitPct  0.01 is one percent
 * @returns {object} the rule
 */
function makeLimitRule(limitPct) {
  const pct = Number(limitPct);
  return {
    name: `limit_d0_${(pct * 100).toFixed(1).replace('.', '_')}`,
    label: `a limit ${(pct * 100).toFixed(1)} % better than the signal close, filled on the next session`,
    needsFill: true,
    limitPct: pct,
  };
}

/** The limit rule the instrument measures first. */
const LIMIT_RULE_1PCT = makeLimitRule(0.01);

/** Every rule the instrument measures, in order. */
function allRules() {
  return [
    ...ENTRY_RULES,
    LIMIT_RULE_1PCT,
    makeLimitRule(0.005),
    makeLimitRule(0.02),
  ];
}

/**
 * Put a bar on the ADJUSTED basis.
 *
 * The cache stores `price` (the adjusted close) next to the raw
 * `open`, `high` and `low`. The raw prices are scaled by the bar's own
 * adjustment factor so that every price in the instrument is the same
 * instrument.
 *
 * @param {object} bar  a cache bar
 * @returns {object|null} the adjusted bar
 */
function adjustedBar(bar) {
  if (!bar || !bar.date) return null;
  const close = Number.isFinite(bar.close) ? bar.close : null;
  const price = Number.isFinite(bar.price) ? bar.price : close;
  if (!Number.isFinite(price)) return null;
  const factor = Number.isFinite(close) && close !== 0 ? price / close : 1;
  const scale = (value) => (Number.isFinite(value) ? value * factor : null);
  return {
    date: bar.date,
    open: scale(bar.open),
    high: scale(bar.high),
    low: scale(bar.low),
    close: price,
    volume: bar.volume,
  };
}

/**
 * The bars for a claim: the one it was made on, and the next session.
 *
 * The claim's own date is often a weekend or a holiday, so `d0` is the
 * LAST bar at or before it -- the same "previous trading day" rule the
 * price provider uses everywhere else.
 *
 * @param {object[]} bars  the adjusted bars, ascending by date
 * @param {string} claimDate  YYYY-MM-DD
 * @returns {{d0: object|null, d1: object|null}} the two bars
 */
function resolveBars(bars, claimDate) {
  const list = Array.isArray(bars) ? bars : [];
  const date = toIsoDate(claimDate);
  if (!list.length || !date) return { d0: null, d1: null };
  let index = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].date <= date) index = i;
    else break;
  }
  if (index < 0) return { d0: null, d1: null };
  return { d0: list[index], d1: list[index + 1] || null };
}

/**
 * The entry a rule produces, and whether it produced one at all.
 *
 * @param {object} rule  the rule
 * @param {{d0: object|null, d1: object|null}} bars  the claim's bars
 * @param {string} bias  bullish | bearish
 * @returns {{entry: number|null, status: string}} the entry and why
 */
function entryForRule(rule, bars, bias) {
  const d0 = bars && bars.d0;
  const d1 = bars && bars.d1;
  if (!d0) return { entry: null, status: 'no_signal_day_price' };

  if (rule.name === 'close_d0') {
    return Number.isFinite(d0.close)
      ? { entry: d0.close, status: 'ok' }
      : { entry: null, status: 'no_close' };
  }

  if (!d1) return { entry: null, status: 'no_next_session' };

  if (rule.name === 'open_d1') {
    return Number.isFinite(d1.open)
      ? { entry: d1.open, status: 'ok' }
      : { entry: null, status: 'no_open' };
  }

  if (rule.name === 'close_d1') {
    return Number.isFinite(d1.close)
      ? { entry: d1.close, status: 'ok' }
      : { entry: null, status: 'no_close' };
  }

  if (rule.needsFill) {
    const pct = Number(rule.limitPct);
    if (!Number.isFinite(pct) || pct <= 0) return { entry: null, status: 'no_limit_pct' };
    if (!Number.isFinite(d0.close)) return { entry: null, status: 'no_close' };
    // A buy limit sits BELOW the close and a sell limit ABOVE it, so
    // both are the price a reader is asking for rather than the price
    // the market offers.
    const limit = bias === 'bearish' ? d0.close * (1 + pct) : d0.close * (1 - pct);
    const filled = bias === 'bearish'
      ? (Number.isFinite(d1.high) ? d1.high >= limit : false)
      : (Number.isFinite(d1.low) ? d1.low <= limit : false);
    // A limit order fills AT the limit or better, so the limit is the
    // WORST case for the trade. Reporting the worst case is the
    // conservative choice and it is what the rule means.
    return filled
      ? { entry: limit, status: 'filled' }
      : { entry: null, status: 'not_filled' };
  }

  return { entry: null, status: 'unknown_rule' };
}

/**
 * The exit price for a horizon: the last close at or before it.
 *
 * @param {object[]} bars  the adjusted bars, ascending by date
 * @param {string} claimDate  the claim's own date
 * @param {number} days  the horizon in calendar days
 * @returns {number|null}
 */
function exitPrice(bars, claimDate, days) {
  const target = shiftIsoDate(toIsoDate(claimDate), days);
  if (!target) return null;
  let best = null;
  for (const bar of bars || []) {
    if (bar.date <= target) best = bar;
    else break;
  }
  return best && Number.isFinite(best.close) ? best.close : null;
}

/**
 * Has the horizon ELAPSED?
 *
 * A horizon that has not elapsed yet has no exit, and taking "the last
 * close so far" as one would measure a PARTIAL window and report it as
 * a full one. Every source's own analysis refuses to score a horizon
 * that has not elapsed, and this instrument has to refuse it too -- or
 * its own validation against the published numbers fails.
 *
 * @param {string} claimDate  the claim's own date
 * @param {number} days  the horizon in calendar days
 * @param {string} asOfDate  the measurement date, YYYY-MM-DD
 * @returns {boolean}
 */
function horizonElapsed(claimDate, days, asOfDate) {
  const target = shiftIsoDate(toIsoDate(claimDate), days);
  const today = toIsoDate(asOfDate);
  if (!target || !today) return false;
  return target <= today;
}

module.exports = {
  ENTRY_RULES,
  LIMIT_RULE_1PCT,
  adjustedBar,
  allRules,
  entryForRule,
  exitPrice,
  horizonElapsed,
  makeLimitRule,
  resolveBars,
};
