'use strict';

/**
 * Position episodes: a lifecycle (open -> adds/trims -> exit), and what it
 * returned.
 *
 * TWO KINDS, AND THEY CANNOT BE READ THE SAME WAY
 *
 * `episodesFromSnapshots`  Drendel's "Portfolio" post. It is a STATE: he says
 *                          what he holds and how large, once a day. A position
 *                          runs from the first snapshot that lists it to the
 *                          first one that does not. No trade message is
 *                          needed, and the weight is his own.
 *
 * `episodesFromActions`    Ariel's two channels, and Drendel's messages. They
 *                          are ACTIONS: a lifecycle has to be CHAINED -- an
 *                          open, then adds, then a trim, then an exit. The
 *                          size comes from the message when he states it.
 *
 * WHAT A RETURN IS
 *
 * A return is computed from the SYMBOL's closes: entry = the close on the
 * entry date, exit = the close on the exit date, signed by the direction.
 * That is a MODEL, not his fill. It deliberately ignores the intraday path
 * (he buys on intraday levels, so the close entry understates a fill made on
 * a dip), and it is conservative in that direction.
 *
 * AN INVERSE PRODUCT IS HELD LONG. Drendel's trading-account "Shorts" are
 * SARK, SOXS, AVS and the rest -- instruments he BUYS to be bearish. Their
 * P&L is the symbol's own return. Only a short of a real stock is signed
 * negative.
 *
 * A position whose entry or exit price cannot be had is NOT scored. It is
 * reported as unpriced rather than filled in with a guess.
 */

const { INVERSE_INSTRUMENTS, ACCOUNT_TRADING, ACCOUNT_VIBE } = require('./sources');

const MIN_WEIGHT_PCT = 0.25;

function directionOf(side, ticker) {
  if (side === 'short' && !INVERSE_INSTRUMENTS.has(ticker)) return -1;
  return 1;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

/**
 * The episodes a snapshot series describes.
 *
 * A position is OPEN while a snapshot lists it. It is closed when the
 * snapshot no longer lists it, or when its weight falls to nothing. A
 * position that reappears afterwards is a NEW episode -- he bought it again,
 * and the two trades are separate trades.
 *
 * The account's own rule matters: the Vibe list carries NO weights, so a
 * position there is closed by DISAPPEARING from the list and never by its
 * weight. Reading a missing weight as "closed" would make every Vibe
 * position a one-day trade.
 *
 * @param {object[]} snapshots  from parsePortfolioPost, date-resolved
 * @param {object} [options]
 * @param {boolean} [options.includeVibe]
 * @returns {object[]}
 */
function episodesFromSnapshots(snapshots, options = {}) {
  const ordered = [...snapshots].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const dates = ordered.map((snapshot) => snapshot.as_of_date);
  const presence = new Map();
  for (const snapshot of ordered) {
    for (const position of snapshot.positions) {
      if (position.account === ACCOUNT_VIBE && !options.includeVibe) continue;
      const key = `${position.account}|${position.sub_account}|${position.side}|${position.ticker}`;
      if (!presence.has(key)) presence.set(key, new Map());
      presence.get(key).set(snapshot.as_of_date, position);
    }
  }

  const out = [];
  for (const [key, seen] of presence) {
    const [account, sub, side, ticker] = key.split('|');
    let episode = null;
    let previous = null;
    for (const date of dates) {
      const position = seen.get(date) || null;
      if (!episode) {
        if (!position) { previous = position; continue; }
        episode = {
          account, entry_date: date, entry_weight: position.weight_pct, exit_date: '',
          exit_weight: null, is_new: position.is_new, left_censored: true, side, sub_account: sub, ticker,
        };
        previous = position;
        continue;
      }
      if (!position) {
        episode.exit_date = date;
        episode.exit_weight = null;
        episode.left_censored = false;
        out.push(episode);
        episode = null;
        previous = position;
        continue;
      }
      if (previous && previous.weight_pct !== null && position.weight_pct !== null
        && Math.abs(previous.weight_pct - position.weight_pct) > 0.25) {
        episode.turnover_pct = round(previous.weight_pct - position.weight_pct, 2);
      }
      if (position.weight_pct !== null && position.weight_pct <= MIN_WEIGHT_PCT) {
        episode.exit_date = date;
        episode.exit_weight = position.weight_pct;
        episode.left_censored = false;
        out.push(episode);
        episode = null;
        previous = position;
        continue;
      }
      if (position.is_new && episode.entry_date !== date) {
        episode.exit_date = date;
        episode.exit_weight = position.weight_pct;
        episode.left_censored = false;
        out.push(episode);
        episode = {
          account, entry_date: date, entry_weight: position.weight_pct, exit_date: '',
          exit_weight: null, is_new: true, left_censored: true, side, sub_account: sub, ticker,
        };
      }
      previous = position;
    }
    if (episode) {
      episode.exit_date = '';
      episode.exit_weight = null;
      out.push(episode);
    }
  }

  return out.sort((a, b) => a.entry_date.localeCompare(b.entry_date));
}

/**
 * The episodes an action stream describes.
 *
 * An open starts an episode; an add widens it; a trim narrows it; an exit or
 * a stop-out closes it. An action with no live episode still becomes an
 * episode (flagged `implied_open`), because a trader's first message about a
 * name is often "added to X" after he stopped posting about the entry.
 *
 * @param {object[]} actions  rows of readActionStream, one per ticker
 * @param {object} [options]
 * @param {string} [options.side]  'long' | 'short'
 * @returns {object[]}
 */
function episodesFromActions(actions, options = {}) {
  const byTicker = new Map();
  for (const action of actions) {
    if (!action.ticker) continue;
    if (!byTicker.has(action.ticker)) byTicker.set(action.ticker, []);
    byTicker.get(action.ticker).push(action);
  }

  const out = [];
  for (const [ticker, rows] of byTicker) {
    const side = options.side || rows[0].side || 'long';
    let episode = null;
    let size = null;
    for (const row of rows) {
      const date = row.session_date || String(row.posted_at).slice(0, 10);
      const open = (row.action === 'open' || row.action === 'add') && !episode;
      if (row.action === 'open' || row.action === 'add') {
        if (!episode) {
          episode = {
            account: options.account || '', entry_date: date, entry_price: row.price, entry_weight: row.size_pct,
            exit_date: '', exit_price: null, implied_open: row.action === 'add', is_new: row.action === 'open',
            left_censored: false, side, sub_account: options.sub_account || '', ticker, actions: [],
          };
          size = row.size_pct;
        } else if (row.action === 'add' && row.size_pct) {
          size = size === null ? row.size_pct : Math.min(100, size + row.size_pct);
          episode.entry_weight = episode.entry_weight === null ? row.size_pct : episode.entry_weight;
        }
        episode.actions.push(row);
        continue;
      }
      if (!episode) continue;
      episode.actions.push(row);
      if (row.action === 'trim' && row.fraction !== null && row.fraction_basis !== 'portfolio') {
        const taken = (size === null ? 100 : size) * row.fraction;
        if (size !== null) size = Math.max(0, size - taken);
        if (size !== null && size < MIN_WEIGHT_PCT) {
          episode.exit_date = date;
          episode.exit_price = row.price;
          episode.exit_action = 'trimmed_out';
          episode.exit_weight = 0;
          out.push(episode);
          episode = null;
          size = null;
        }
        continue;
      }
      if (row.action === 'exit' || row.action === 'stop_out') {
        episode.exit_action = row.action;
        episode.exit_date = date;
        episode.exit_price = row.price;
        episode.exit_weight = 0;
        out.push(episode);
        episode = null;
        size = null;
      }
    }
    if (episode) {
      episode.exit_date = '';
      episode.exit_price = null;
      out.push(episode);
    }
  }
  return out.sort((a, b) => a.entry_date.localeCompare(b.entry_date));
}

/**
 * Attach the prices an episode's return is made of, and the return itself.
 *
 * @param {object} episode
 * @param {function} priceAt  (ticker, date) => number|null
 * @param {string} markDate  the last date to price a still-open episode at
 * @returns {object} the episode, plus `entry_price_at`, `exit_price_at`,
 *   `return_pct` (null when unpriced) and `priced`
 */
function priceEpisode(episode, priceAt, markDate) {
  const direction = directionOf(episode.side, episode.ticker);
  const entryDate = episode.entry_date;
  const exitDate = episode.exit_date || markDate;
  const entryPrice = priceAt(episode.ticker, entryDate);
  const exitPrice = exitDate ? priceAt(episode.ticker, exitDate) : null;
  const priced = entryPrice !== null && exitPrice !== null && entryPrice > 0;
  return {
    ...episode,
    direction,
    entry_price_at: entryPrice,
    exit_date: exitDate || '',
    exit_price_at: exitPrice,
    priced,
    return_pct: priced ? round(((exitPrice / entryPrice) - 1) * 100 * direction) : null,
    still_open: !episode.exit_date,
  };
}

/**
 * Drendel's trading account, marked to a date: exposure, and how each
 * account's book moved between two snapshots.
 *
 * The exposure is a STATE, not a return: the weights he posts are what he
 * holds, so the implied daily return of the account is the sum of each
 * position's move between the two snapshots (cash earns nothing).
 *
 * @param {object[]} snapshots
 * @param {function} priceAt  (ticker, date) => number|null
 * @returns {{exposure: object[], curve: object[]}}
 */
function snapshotCurve(snapshots, priceAt) {
  const ordered = [...snapshots].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const exposure = [];
  const curve = [];
  let previous = null;
  for (const snapshot of ordered) {
    for (const account of [ACCOUNT_TRADING, ACCOUNT_VIBE]) {
      const rows = snapshot.positions.filter((row) => row.account === account);
      if (!rows.length) continue;
      const long = rows.filter((row) => row.side === 'long' && row.weight_pct !== null).reduce((total, row) => total + row.weight_pct, 0);
      const short = rows.filter((row) => row.side === 'short' && row.weight_pct !== null).reduce((total, row) => total + row.weight_pct, 0);
      exposure.push({
        account, as_of_date: snapshot.as_of_date, long_pct: round(long, 2),
        net_pct: round(long - short, 2), positions: rows.length, short_pct: round(short, 2),
        weighted: rows.filter((row) => row.weight_pct !== null).length,
      });
    }
    if (previous) {
      for (const account of [ACCOUNT_TRADING, ACCOUNT_VIBE]) {
        const at = (snap, acct) => snap.positions.filter((row) => row.account === acct && row.weight_pct !== null);
        const before = at(previous, account);
        const after = at(snapshot, account);
        if (!before.length || !after.length) continue;
        let sum = 0;
        let measured = 0;
        for (const row of before) {
          const now = after.find((other) => other.ticker === row.ticker && other.side === row.side);
          const from = priceAt(row.ticker, previous.as_of_date);
          const to = priceAt(row.ticker, snapshot.as_of_date);
          if (!now || from === null || to === null || !(from > 0)) continue;
          sum += (row.weight_pct / 100) * directionOf(row.side, row.ticker) * ((to / from) - 1);
          measured += row.weight_pct / 100;
        }
        curve.push({
          account, as_of_date: snapshot.as_of_date, from_date: previous.as_of_date,
          measured_weight: round(measured * 100, 2), return_pct: round(sum * 100, 3),
          unmeasured_weight: round(100 - measured * 100, 2),
        });
      }
    }
    previous = snapshot;
  }
  return { curve, exposure };
}

module.exports = {
  directionOf,
  episodesFromActions,
  episodesFromSnapshots,
  priceEpisode,
  snapshotCurve,
};
