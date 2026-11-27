'use strict';

/**
 * The direction an OPTION action states on the underlying.
 *
 * WHY THE OPTION ACTIONS ARE NOT SCORED AS EPISODES
 *
 * HariSeldon's equity actions are chained into position episodes, and an
 * episode is priced from the UNDERLYING's closes. An option action
 * cannot be chained the same way, because the price he states is the
 * SPREAD's premium and not the underlying's price: "Short $SPY PDS
 * $730/$720 for $3.08" -- $3.08 is what the spread cost, and SPY's
 * price is a different number entirely. Chaining them would publish a
 * return made from two different numbers.
 *
 * So they were recorded and never scored, and that left 544 option
 * opens -- a THIRD of his trading -- outside the measurement.
 *
 * WHAT AN OPTION ACTION ACTUALLY STATES
 *
 * An option structure is a DIRECTIONAL claim on the underlying, and his
 * vocabulary says which direction:
 *
 *   "Short $ADBE using $407.5 Puts"   a bearish position on ADBE
 *   "Long $OXY $50 Strike Calls"      a bullish position on OXY
 *   "Long $MSTR CDS $370/$380"        a bullish position on MSTR
 *   "Short $ANF PDS $123/$122"        a bearish position on ANF
 *   "Long Strangle on $SPY ..."        NO direction -- both sides
 *
 * A strangle is the exception: it is a volatility position and it says
 * nothing about direction. Those are recorded and NOT scored.
 *
 * AND THE CAVEAT, WHICH IS STATED RATHER THAN HIDDEN
 *
 * A spread is a BOUNDED bet. "Short $SPY PDS $730/$720" pays only if
 * SPY falls below 720, so it is a bearish claim with a limited payoff
 * and a limited risk, and scoring it as an ordinary bearish call reads
 * it as stronger than it is. The measurement therefore asks a slightly
 * different question than the equity episodes ask: does the direction
 * of his option trades carry information about the underlying -- and the
 * answer is allowed to be "yes, and the SPY did the same thing".
 *
 * WHAT IS SCORED
 *
 * The OPENS. An open is a claim about the future; an exit is the
 * resolution of one, and a resolution has already had its move.
 *
 * The two things that are NOT scored are counted APART, because they
 * are different things: an open that states no direction (a strangle)
 * and an exit (the resolution of a claim).
 */

const { findOption } = require('./parser');

/**
 * The direction an option action states on the underlying.
 *
 * @param {object} action  an action from `discord_trade_actions`
 * @returns {{direction: string|null, instrument: string, reason: string}|null}
 */
function directionOfAction(action) {
  if (!action || !action.content) return null;
  const option = findOption(action.content);
  if (!option) return null;

  if (action.action !== 'open') {
    return {
      direction: null,
      instrument: option.kind,
      reason: 'not an open -- an exit is the resolution of a claim, not a claim',
    };
  }
  if (!option.side) {
    return {
      direction: null,
      instrument: option.kind,
      reason: `${option.kind} states no direction`,
    };
  }
  return {
    direction: option.side === 'short' ? 'bearish' : 'bullish',
    instrument: option.kind,
    reason: `a ${option.kind} is a ${option.side} position on the underlying`,
  };
}

/**
 * The readings an option action stream carries.
 *
 * @param {object[]} actions  the option actions
 * @returns {{readings: object[], coverage: object}}
 */
function readingsFromActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const readings = [];
  const coverage = {
    option_actions: list.length,
    opens: 0,
    opens_with_a_direction: 0,
    opens_without_a_direction: 0,
    exits: 0,
    by_instrument: {},
  };
  for (const action of list) {
    if (action.action === 'open') coverage.opens += 1;
    else coverage.exits += 1;
    const found = directionOfAction(action);
    if (!found) continue;
    coverage.by_instrument[found.instrument] = (coverage.by_instrument[found.instrument] || 0) + 1;
    if (!found.direction) {
      // An exit is not a claim, and a strangle states no direction.
      // They are counted apart, because they are different things.
      if (action.action === 'open') coverage.opens_without_a_direction += 1;
      continue;
    }
    coverage.opens_with_a_direction += 1;
    readings.push({
      id: action.id,
      date: String(action.posted_at || '').slice(0, 10),
      subject: action.ticker,
      proxy_ticker: action.ticker,
      scope: 'option',
      stance: found.direction,
      claim_kind: 'forward',
      horizon: '',
      confidence: 'medium',
      evidence_text: action.content,
      instrument: found.instrument,
      option_price: action.price,
      size_note: action.size_note || '',
      verb: action.verb || '',
      reason: found.reason,
    });
  }
  return { readings, coverage };
}

module.exports = {
  directionOfAction,
  readingsFromActions,
};
