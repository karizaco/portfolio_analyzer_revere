'use strict';

/**
 * Score the three Discord traders.
 *
 * WHAT IS SCORED
 *
 *   the episodes        one position lifecycle each, priced from the SYMBOL's
 *                       closes: entry = the close on the entry date, exit = the
 *                       close on the exit date, signed by the direction
 *   the curve           Drendel's trading and Vibe accounts, day by day,
 *                       from his own snapshots
 *   the rules           his and Ariel's stated rules, measured: the ATR trim,
 *                       the stop, the size
 *   the overlap         what the two traders hold at the same time, and who
 *                       moved first
 *
 * WHAT IS NOT CLAIMED
 *
 *   The returns are MODELLED from closes. Neither trader publishes fills, so
 *   a modelled return is not his P&L: it ignores the intraday path, and his
 *   entries are made on intraday levels, so a close-to-close model is
 *   conservative about his entries and says nothing about his exits.
 *
 *   The Vibe account carries NO weights, so it is treated as equal-weighted
 *   and fully invested, and that is stated in the output.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const { ACCOUNT_TRADING, ACCOUNT_VIBE, INVERSE_INSTRUMENTS } = require('../src/discord/sources');
const { directionOf, snapshotCurve } = require('../src/discord/episodes');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const OUT_DIR = path.join(ROOT, 'data');
const json = process.argv.includes('--json');
const skipFetch = process.argv.includes('--no-fetch');

function log(...args) {
  if (!json) console.error(...args);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function wilson(hits, n, z = 1.96) {
  if (!n) return null;
  const p = hits / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    high: (centre + margin) / denominator,
    low: (centre - margin) / denominator,
  };
}

/** The daily bars of a symbol, sorted by date. */
function barsOf(series) {
  return (series.bars || [])
    .filter((bar) => bar.date && Number.isFinite(bar.price))
    .map((bar) => ({ close: bar.price, date: bar.date, high: bar.high, low: bar.low, open: bar.open }));
}

/** The last close at or before a date. */
function closeAt(bars, date) {
  let best = null;
  for (const bar of bars) {
    if (bar.date <= date) best = bar;
    else break;
  }
  return best ? best.close : null;
}

/** The first bar on or after a date. */
function firstOnOrAfter(bars, date) {
  for (const bar of bars) {
    if (bar.date >= date) return bar;
  }
  return null;
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const episodes = db.prepare('SELECT * FROM discord_episodes').all();
  const actions = db.prepare('SELECT * FROM discord_trade_actions').all();
  const positions = db.prepare('SELECT * FROM discord_positions').all();
  if (!episodes.length) {
    throw new Error('discord_episodes is empty -- run: node tools/buildDiscordPositions.js');
  }

  const symbols = [...new Set(episodes.map((row) => row.ticker).filter(Boolean))].sort();
  const dates = episodes.flatMap((row) => [row.entry_date, row.exit_date]).filter(Boolean).sort();
  const from = dates[0] || '2024-01-01';
  const to = dates[dates.length - 1] || new Date().toISOString().slice(0, 10);
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: from,
    defaultToDate: to,
    prefetchConcurrency: 4,
  });

  const books = new Map();
  let fetched = 0;
  for (const symbol of [...symbols, 'SPY']) {
    let series = null;
    if (skipFetch) {
      const file = path.join(CACHE_DIR, `${symbol}.json`);
      if (fs.existsSync(file)) {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        series = { bars: (entry.prices || []).map((point) => ({ close: point.price, date: point.date, high: point.high, low: point.low, open: point.open })) };
      }
    } else {
      series = await provider.getOhlcvSeries(symbol, from, to);
      if (series && series.bars && series.bars.length) fetched += 1;
    }
    books.set(symbol, barsOf(series || {}));
  }
  log(`priced symbols ${books.size} (${fetched} fetched), ${from} .. ${to}`);

  const spy = books.get('SPY') || [];
  const priceAt = (symbol, date) => closeAt(books.get(symbol) || [], date);

  // --- price the episodes -------------------------------------------------
  const update = db.prepare(`
    UPDATE discord_episodes
    SET entry_price_at = ?, exit_price_at = ?, return_pct = ?, priced = ?
    WHERE id = ?
  `);
  db.exec('BEGIN');
  const scored = [];
  for (const episode of episodes) {
    const bars = books.get(episode.ticker) || [];
    const entryDate = episode.entry_date;
    const exitDate = episode.exit_date || to;
    const entry = closeAt(bars, entryDate);
    const exit = closeAt(bars, exitDate);
    const priced = entry !== null && exit !== null && entry > 0;
    const direction = directionOf(episode.side, episode.ticker);
    const returnPct = priced ? ((exit / entry) - 1) * 100 * direction : null;
    update.run(entry, exit, returnPct, priced ? 1 : 0, episode.id);
    const spyEntry = closeAt(spy, entryDate);
    const spyExit = closeAt(spy, exitDate);
    const spyReturn = spyEntry && spyExit ? ((spyExit / spyEntry) - 1) * 100 * direction : null;
    scored.push({
      ...episode,
      direction,
      exit_date_effective: exitDate,
      return_pct: returnPct,
      spy_return_pct: spyReturn,
      excess_pct: returnPct !== null && spyReturn !== null ? returnPct - spyReturn : null,
      // The flag was decided when the episode was built: a still-open
      // position was marked to the last close, and its date says so.
      still_open: episode.still_open ? 1 : 0,
      holding_days: episode.exit_date ? Math.round((new Date(`${episode.exit_date}T00:00:00Z`) - new Date(`${entryDate}T00:00:00Z`)) / 86400000) : null,
    });
  }
  db.exec('COMMIT');

  // --- summaries ----------------------------------------------------------
  // The hit rate is over CLOSED episodes. A position that is still open is
  // marked to the last close, and its "return" is a year of drift rather
  // than a trade: counting it would put the open book into the win rate.
  const summarise = (rows) => {
    const closed = rows.filter((row) => !row.still_open && row.return_pct !== null);
    const open = rows.filter((row) => row.still_open && row.return_pct !== null);
    // A trade opened and closed on the SAME DAY is invisible to a
    // close-to-close model: it reads as a flat 0%. Those are counted apart
    // rather than folded into the win rate, because a 0% return is not a
    // trade that did nothing.
    const sameDay = closed.filter((row) => row.holding_days === 0);
    const held = closed.filter((row) => row.holding_days !== 0);
    const wins = held.filter((row) => row.return_pct > 0).length;
    const interval = wilson(wins, held.length);
    const excess = held.filter((row) => row.excess_pct !== null);
    const excessOpen = open.filter((row) => row.excess_pct !== null);
    // The mean is outlier-driven: one long SOXL hold is +947% and it moves
    // an average. The winsorised mean (the extreme 2% of trades moved to the
    // edge) is reported beside it, because both are true and only one of
    // them describes a typical trade.
    const clipped = held.map((row) => Math.max(-100, Math.min(100, row.return_pct)));
    return {
      episodes: rows.length,
      closed: closed.length,
      still_open: open.length,
      priced: rows.filter((row) => row.return_pct !== null).length,
      unpriced: rows.filter((row) => row.return_pct === null).length,
      same_day_trades: sameDay.length,
      hit_rate_pct: held.length ? Number(((wins / held.length) * 100).toFixed(1)) : null,
      hit_rate_ci: interval ? { low: Number((interval.low * 100).toFixed(1)), high: Number((interval.high * 100).toFixed(1)) } : null,
      avg_return_pct: held.length ? Number(mean(held.map((row) => row.return_pct)).toFixed(2)) : null,
      winsorised_avg_return_pct: clipped.length ? Number(mean(clipped).toFixed(2)) : null,
      median_return_pct: held.length ? Number(median(held.map((row) => row.return_pct)).toFixed(2)) : null,
      avg_excess_pct: excess.length ? Number(mean(excess.map((row) => row.excess_pct)).toFixed(2)) : null,
      avg_holding_days: held.length ? Number(mean(held.map((row) => row.holding_days).filter((value) => value !== null)).toFixed(1)) : null,
      median_holding_days: held.length ? median(held.map((row) => row.holding_days).filter((value) => value !== null)) : null,
      open_marked_avg_pct: open.length ? Number(mean(open.map((row) => row.return_pct)).toFixed(2)) : null,
      open_marked_avg_excess_pct: excessOpen.length ? Number(mean(excessOpen.map((row) => row.excess_pct)).toFixed(2)) : null,
    };
  };

  const bySource = {};
  for (const source of ['drendel', 'ariel-long', 'ariel-short']) {
    const rows = scored.filter((row) => row.source_name === source);
    const byBasis = {};
    for (const basis of ['snapshots', 'actions']) {
      const subset = rows.filter((row) => row.basis === basis);
      if (subset.length) byBasis[basis] = summarise(subset);
    }
    const trading = rows.filter((row) => row.account === ACCOUNT_TRADING && row.basis === 'snapshots');
    const vibe = rows.filter((row) => row.account === ACCOUNT_VIBE);
    bySource[source] = {
      all: summarise(rows),
      by_basis: byBasis,
      trading_account: trading.length ? summarise(trading) : null,
      vibe_account: vibe.length ? summarise(vibe) : null,
    };
  }

  // --- Drendel's accounts, side by side -----------------------------------
  const drendelRows = scored.filter((row) => row.source_name === 'drendel' && row.basis === 'snapshots');
  const accountCompare = {};
  for (const account of [ACCOUNT_TRADING, ACCOUNT_VIBE]) {
    const rows = drendelRows.filter((row) => row.account === account && row.return_pct !== null);
    if (!rows.length) continue;
    const inBoth = new Map();
    for (const row of rows) {
      const key = row.ticker;
      if (!inBoth.has(key)) inBoth.set(key, []);
      inBoth.get(key).push(row);
    }
    accountCompare[account] = {
      ...summarise(rows),
      tickers: inBoth.size,
      // The Vibe list is the same names as the trading book on most days, so
      // the pair is compared name by name, not as two independent portfolios.
      shared_tickers: [...inBoth.keys()].filter((ticker) => drendelRows.some((row) => row.account !== account && row.ticker === ticker)).length,
    };
  }

  // --- the snapshot curve -------------------------------------------------
  const snapshots = [];
  const seenSnapshot = new Set();
  for (const row of positions) {
    const key = `${row.as_of_date}|${row.account}`;
    if (seenSnapshot.has(key)) continue;
    seenSnapshot.add(key);
    snapshots.push({
      as_of_date: row.as_of_date,
      account: row.account,
      cash_pct: row.cash_pct,
      long_exposure_pct: row.long_exposure_pct,
      positions: [],
      short_exposure_pct: row.short_exposure_pct,
    });
  }
  const snapshotIndex = new Map(snapshots.map((row) => [`${row.as_of_date}|${row.account}`, row]));
  for (const row of positions) {
    const holder = snapshotIndex.get(`${row.as_of_date}|${row.account}`);
    if (holder) {
      holder.positions.push(row);
    }
  }
  const tradingSnapshots = snapshots.filter((row) => row.account === ACCOUNT_TRADING).sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const vibeSnapshots = snapshots.filter((row) => row.account === ACCOUNT_VIBE).sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));

  // The portfolio's return between two snapshots.
  //
  // A position that is STILL held contributes its move to the period end. A
  // position that was CLOSED during the period contributes its move to the
  // day it was closed -- NOT to the period end, and NOT nothing. Dropping it
  // (as a snapshot-to-snapshot diff does) is a survivorship bias: the
  // positions that lost money are exactly the ones that disappear.
  //
  // The Vibe account carries no weights, so it is read as an EQUAL-WEIGHTED,
  // fully invested basket of the names it lists, and that is said out loud.
  const episodeIndex = new Map();
  for (const row of scored) {
    if (row.source_name !== 'drendel' || row.basis !== 'snapshots') continue;
    const key = `${row.account}|${row.side}|${row.ticker}`;
    if (!episodeIndex.has(key)) episodeIndex.set(key, []);
    episodeIndex.get(key).push(row);
  }
  for (const rows of episodeIndex.values()) rows.sort((a, b) => a.entry_date.localeCompare(b.entry_date));

  const episodeAt = (account, side, ticker, date) => {
    const rows = episodeIndex.get(`${account}|${side}|${ticker}`) || [];
    for (const row of rows) {
      const open = !row.exit_date || row.exit_date >= date;
      if (row.entry_date <= date && open) return row;
    }
    return null;
  };

  const portfolioCurve = (rows, account) => {
    const out = [];
    for (let index = 1; index < rows.length; index += 1) {
      const before = rows[index - 1];
      const after = rows[index];
      const held = before.positions.filter((row) => row.account === account);
      if (!held.length) continue;
      const weighted = held.filter((row) => row.weight_pct !== null);
      const useEqualWeight = weighted.length === 0;
      const weightOf = (row) => (useEqualWeight ? 100 / held.length : row.weight_pct);
      let sum = 0;
      let measured = 0;
      let closedInside = 0;
      for (const row of held) {
        const start = priceAt(row.ticker, before.as_of_date);
        if (start === null || !(start > 0)) continue;
        const episode = episodeAt(account, row.side, row.ticker, before.as_of_date);
        const endDate = episode && episode.exit_date && episode.exit_date <= after.as_of_date
          ? episode.exit_date : after.as_of_date;
        const end = priceAt(row.ticker, endDate);
        if (end === null) continue;
        sum += (weightOf(row) / 100) * directionOf(row.side, row.ticker) * ((end / start) - 1);
        measured += weightOf(row) / 100;
        if (episode && episode.exit_date && episode.exit_date <= after.as_of_date) closedInside += 1;
      }
      if (!measured) continue;
      const spyStart = closeAt(spy, before.as_of_date);
      const spyEnd = closeAt(spy, after.as_of_date);
      const spyReturn = spyStart && spyEnd ? ((spyEnd / spyStart) - 1) * 100 : null;
      out.push({
        account,
        as_of_date: after.as_of_date,
        from_date: before.as_of_date,
        measured_weight: Number((measured * 100).toFixed(2)),
        positions: held.length,
        closed_during_period: closedInside,
        return_pct: Number((sum * 100).toFixed(3)),
        spy_return_pct: spyReturn === null ? null : Number(spyReturn.toFixed(3)),
        excess_pct: spyReturn === null ? null : Number((sum * 100 - spyReturn).toFixed(3)),
        equal_weighted: useEqualWeight ? 1 : 0,
      });
    }
    return out;
  };

  const tradingCurve = portfolioCurve(tradingSnapshots, ACCOUNT_TRADING);
  const vibeCurve = portfolioCurve(vibeSnapshots, ACCOUNT_VIBE);

  const curveSummary = (rows) => {
    const priced = rows.filter((row) => row.return_pct !== null);
    const cumulative = priced.reduce((total, row) => total + row.return_pct / 100, 1);
    const wins = priced.filter((row) => row.return_pct > 0).length;
    const excess = priced.filter((row) => row.excess_pct !== null);
    const excessCumulative = excess.reduce((total, row) => total + row.excess_pct / 100, 1);
    return {
      periods: rows.length,
      priced: priced.length,
      cumulative_pct: Number(((cumulative - 1) * 100).toFixed(2)),
      cumulative_excess_pct: Number(((excessCumulative - 1) * 100).toFixed(2)),
      hit_rate_pct: priced.length ? Number(((wins / priced.length) * 100).toFixed(1)) : null,
      avg_period_pct: priced.length ? Number(mean(priced.map((row) => row.return_pct)).toFixed(3)) : null,
      equal_weighted: rows.length ? rows[rows.length - 1].equal_weighted : 0,
    };
  };

  // --- the rules ----------------------------------------------------------
  // Ariel's trims cite an ATR multiple. A trim at an extension is a claim
  // that the move is spent; the claim is worth measuring.
  //
  // The measurement is SIGNED by the book: a trim in the long book is a
  // sale, so it is a good trim when the price FALLS after it, and a trim in
  // the short book is a cover, so it is good when the price RISES. The raw
  // forward return is reported beside it, because a reader has to see which
  // way the name went before the sign is applied.
  const trimActions = actions.filter((row) => row.action === 'trim' && row.ticker);
  const atrTrims = trimActions.filter((row) => row.atr_multiple !== null);
  const bookSign = (sourceName) => (sourceName === 'ariel-short' ? 1 : -1);
  const rule = (rows, horizonDays) => {
    const raw = [];
    const signed = [];
    for (const row of rows) {
      const bars = books.get(row.ticker) || [];
      const anchor = firstOnOrAfter(bars, row.posted_at.slice(0, 10));
      if (!anchor) continue;
      const target = bars.find((bar) => bar.date >= addDays(anchor.date, horizonDays));
      if (!target) continue;
      const forward = ((target.close / anchor.close) - 1) * 100;
      raw.push(forward);
      signed.push(forward * bookSign(row.source_name));
    }
    const wins = signed.filter((value) => value > 0).length;
    return {
      n: signed.length,
      avg_forward_pct: signed.length ? Number(mean(raw).toFixed(2)) : null,
      avg_trim_quality_pct: signed.length ? Number(mean(signed).toFixed(2)) : null,
      hit_rate_pct: signed.length ? Number(((wins / signed.length) * 100).toFixed(1)) : null,
    };
  };
  const atrRule = {
    atr_cited: atrTrims.length,
    trims_total: trimActions.length,
    by_book: Object.fromEntries(['ariel-long', 'ariel-short'].map((sourceName) => {
      const inBook = (rows) => rows.filter((row) => row.source_name === sourceName);
      return [sourceName, {
        atr_trim_5d: rule(inBook(atrTrims), 5),
        atr_trim_20d: rule(inBook(atrTrims), 20),
        other_trim_5d: rule(inBook(trimActions.filter((row) => row.atr_multiple === null)), 5),
        other_trim_20d: rule(inBook(trimActions.filter((row) => row.atr_multiple === null)), 20),
      }];
    })),
  };

  // Did the stop hold? For every episode with a stated stop, was the day's
  // low through it before the position was closed?
  const stopRows = [];
  for (const action of actions) {
    if (!action.ticker || action.stop_price === null) continue;
    const episode = scored.find((row) => row.source_name === action.source_name
      && row.ticker === action.ticker
      && row.entry_date <= action.posted_at.slice(0, 10)
      && (!row.exit_date || row.exit_date >= action.posted_at.slice(0, 10)));
    if (!episode) continue;
    const bars = (books.get(action.ticker) || []).filter((bar) => bar.date >= action.posted_at.slice(0, 10)
      && bar.date <= (episode.exit_date || to));
    const breached = bars.some((bar) => Number.isFinite(bar.low) && bar.low <= action.stop_price);
    stopRows.push({
      breached: breached ? 1 : 0,
      exit_action: episode.exit_action,
      exit_date: episode.exit_date,
      return_pct: episode.return_pct,
      source_name: action.source_name,
      stop_price: action.stop_price,
      ticker: action.ticker,
    });
  }
  const stopRule = {
    with_a_stop: stopRows.length,
    breached_before_exit: stopRows.filter((row) => row.breached).length,
    breach_rate_pct: stopRows.length ? Number(((stopRows.filter((row) => row.breached).length / stopRows.length) * 100).toFixed(1)) : null,
    exited_by_stop: stopRows.filter((row) => row.exit_action === 'stop_out').length,
    avg_return_when_breached: stopRows.filter((row) => row.breached && row.return_pct !== null).length
      ? Number(mean(stopRows.filter((row) => row.breached && row.return_pct !== null).map((row) => row.return_pct)).toFixed(2)) : null,
    avg_return_when_held: stopRows.filter((row) => !row.breached && row.return_pct !== null).length
      ? Number(mean(stopRows.filter((row) => !row.breached && row.return_pct !== null).map((row) => row.return_pct)).toFixed(2)) : null,
  };

  // --- size and outcome ---------------------------------------------------
  const sizeBuckets = {};
  for (const row of scored) {
    if (row.entry_weight === null || row.return_pct === null) continue;
    const weight = row.entry_weight;
    const bucket = weight >= 8 ? '8%+' : weight >= 4 ? '4-8%' : weight >= 1 ? '1-4%' : '<1%';
    if (!sizeBuckets[bucket]) sizeBuckets[bucket] = [];
    sizeBuckets[bucket].push(row.return_pct);
  }
  const sizeRule = Object.fromEntries(Object.entries(sizeBuckets).map(([bucket, values]) => [bucket, {
    n: values.length,
    avg_pct: Number(mean(values).toFixed(2)),
    hit_rate_pct: Number(((values.filter((value) => value > 0).length / values.length) * 100).toFixed(1)),
  }]));

  // --- the two traders ----------------------------------------------------
  const arielRows = scored.filter((row) => row.source_name.startsWith('ariel') && row.return_pct !== null);
  const arielByTicker = new Map();
  for (const row of arielRows) {
    const key = row.ticker;
    if (!arielByTicker.has(key)) arielByTicker.set(key, []);
    arielByTicker.get(key).push(row);
  }
  const drendelTickers = new Set(scored.filter((row) => row.source_name === 'drendel').map((row) => row.ticker));
  const overlap = {
    ariel_tickers: arielByTicker.size,
    drendel_tickers: drendelTickers.size,
    shared: [...arielByTicker.keys()].filter((ticker) => drendelTickers.has(ticker)).sort(),
  };
  // Who moved first: for a shared ticker, the earlier ENTRY wins.
  // The dates are ISO strings, so they compare as strings -- `Math.min` on
  // them returns NaN and every pair then looks like the same day.
  const earliest = (rows) => rows.map((row) => row.entry_date).filter(Boolean).sort()[0] || '';
  const firstMover = { ariel: 0, drendel: 0, same_day: 0 };
  for (const ticker of overlap.shared) {
    const arielEntry = earliest(arielByTicker.get(ticker));
    const drendelEntry = earliest(scored.filter((row) => row.source_name === 'drendel' && row.ticker === ticker));
    if (!arielEntry || !drendelEntry) continue;
    if (arielEntry < drendelEntry) firstMover.ariel += 1;
    else if (drendelEntry < arielEntry) firstMover.drendel += 1;
    else firstMover.same_day += 1;
  }

  // --- the other sources --------------------------------------------------
  const signalRows = db.prepare(`
    SELECT video_id, ticker, action, bias, confidence_score, event_time_sec, evidence_text, parser_version
    FROM trade_signals WHERE ticker IS NOT NULL AND ticker <> ''
  `).all();
  const signalByTicker = new Map();
  for (const row of signalRows) {
    if (!signalByTicker.has(row.ticker)) signalByTicker.set(row.ticker, []);
    signalByTicker.get(row.ticker).push(row);
  }
  const videoDates = db.prepare('SELECT video_id, upload_date, channel FROM videos').all();
  const videoDate = new Map(videoDates.map((row) => [row.video_id, String(row.upload_date || '').replace(/-/g, '')]));
  const crossSource = { matched_trades: 0, matched_traders: 0, by_channel: {}, total_signals: signalRows.length };
  for (const row of scored) {
    if (row.return_pct === null) continue;
    const signals = signalByTicker.get(row.ticker) || [];
    for (const signal of signals) {
      const date = videoDate.get(signal.video_id) || '';
      if (!date) continue;
      const days = Math.round((new Date(`${row.entry_date}T00:00:00Z`) - new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`)) / 86400000);
      if (Math.abs(days) > 5) continue;
      crossSource.matched_trades += 1;
      crossSource.matched_traders += 1;
      const channel = videoDate.get(signal.video_id);
      crossSource.by_channel[channel] = (crossSource.by_channel[channel] || 0) + 1;
      break;
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    price_range: { from, to },
    sources: bySource,
    drendel_accounts: accountCompare,
    curves: {
      trading_account: curveSummary(tradingCurve),
      vibe_account: curveSummary(vibeCurve),
      trading_periods: tradingCurve.filter((row) => row.return_pct !== null).slice(-30),
    },
    rules: {
      atr_trim: atrRule,
      stop: stopRule,
      size: sizeRule,
    },
    overlap: { ...overlap, first_mover: firstMover },
    cross_source: crossSource,
    coverage: {
      actions: actions.length,
      actions_without_ticker: actions.filter((row) => !row.ticker).length,
      inferred_tickers: actions.filter((row) => row.ticker_inferred).length,
      episodes_unpriced: scored.filter((row) => row.return_pct === null).length,
      snapshots: new Set(positions.map((row) => row.as_of_date)).size,
    },
  };

  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    log('sources');
    for (const [name, value] of Object.entries(bySource)) {
      log(` ${name}: ${JSON.stringify(value.all)}`);
    }
    log('curves');
    log(` trading: ${JSON.stringify(payload.curves.trading_account)}`);
    log(` vibe:    ${JSON.stringify(payload.curves.vibe_account)}`);
    log('rules');
    log(` atr trim: ${JSON.stringify(atrRule)}`);
    log(` stop:     ${JSON.stringify(stopRule)}`);
    log(` size:     ${JSON.stringify(sizeRule)}`);
    log(` overlap:  ${JSON.stringify(overlap.shared.length)} shared tickers, first mover ${JSON.stringify(firstMover)}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'discord_traders.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'discord_episodes.csv'), [
    'source,account,ticker,side,entry_date,exit_date,holding_days,entry_weight,entry_price_at,exit_price_at,return_pct,spy_return_pct,excess_pct,exit_action,still_open,left_censored,implied_open,ambiguous_inverse,basis',
    ...scored.map((row) => [
      row.source_name, row.account, row.ticker, row.side, row.entry_date, row.exit_date, row.holding_days,
      row.entry_weight, row.entry_price_at, row.exit_price_at, row.return_pct, row.spy_return_pct,
      row.excess_pct, row.exit_action, row.still_open, row.left_censored, row.implied_open,
      row.ambiguous_inverse, row.basis,
    ].map((value) => (value === null || value === undefined ? '' : String(value))).join(',')),
  ].join('\n'));
  db.close();
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

main();
