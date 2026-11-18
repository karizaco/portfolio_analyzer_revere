'use strict';

/**
 * The Komar CONVERSION: what he said he was watching, what he traded,
 * and whether either worked.
 *
 * WHAT THIS STAGE DOES
 *
 * Three questions, all of which only Komar can answer, because it is
 * the only source with all the ends:
 *
 * 1. **DID THE CALL BECOME A TRADE?** A setup names a ticker on a
 *    date; the trade log records what he actually traded. Joining them
 *    on the ticker and the date gives the conversion rate, which is
 *    the number no other source in the project can produce.
 * 2. **DID HIS TRADES BEAT THE INDEX?** The trade log carries the
 *    average opening and closing prices of every trade, so each trade
 *    has a return, and the same window on SPY says what the index did
 *    over it.
 * 3. **DOES HIS OWN CHECKLIST PREDICT HIS OWN OUTCOMES?** The deck
 *    notes carry his nine-item Quick checklist for each trade -- the
 *    setup definition in his own words. Scoring the trades by the
 *    items he ticked calibrates the definition against his own
 *    results.
 *
 * THE JOIN
 *
 * The setup and the trade join on the TICKER and the date: a setup in
 * a session and a trade of the same ticker within a month of it. The
 * window is a month because a session's watchlist is not traded the
 * same day.
 *
 * The deck note and the trade join on the STOP LOSS, which is exact:
 * the note prints "Initial entry: 15.21 Stop loss: 14.43 (5%)" and
 * the trade log carries the same 14.43. The ENTRY price does not
 * match -- the note prints the FIRST entry and the log carries the
 * AVERAGE of the entries -- so the stop is the key.
 *
 * Usage:
 *   node tools/analyzeKomarConversion.js --dry-run
 *   node tools/analyzeKomarConversion.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const { yahooSymbolFor } = require('../src/sevcik/outcomeAnalysis');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const OUTPUT_DIR = path.join(ROOT, 'data');

/** How long after a session a trade of the same ticker counts as its
 *  outcome. A session's watchlist is not traded the same day. */
const TRADE_WINDOW_DAYS = 30;

/** The same window on the index. */
const BENCHMARK_WINDOW_DAYS = 30;

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
};

/**
 * A date as YYYY-MM-DD.
 *
 * @param {string} value
 * @returns {string}
 */
function toIsoDate(value) {
  const text = String(value || '');
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

/**
 * A date, shifted by days.
 *
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
function shiftIsoDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The days between two ISO dates.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function daysBetween(left, right) {
  return Math.round(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000
  );
}

/**
 * The setups from the SESSIONS, with their video's date.
 *
 * The lessons and the webinars are out of scope: evergreen teaching
 * content is not a call with a window.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listSetups(db) {
  return db.prepare(`
    SELECT s.*, v.session_date AS video_session_date, v.kind AS video_kind
    FROM komar_setups s
    LEFT JOIN komar_videos v ON v.video_id = s.video_id
    WHERE v.kind NOT IN ('lesson', 'webinar')
    ORDER BY v.session_date, s.video_id, s.segment_start_index
  `).all();
}

/**
 * The trade log.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listTrades(db) {
  return db.prepare('SELECT * FROM komar_trade_log ORDER BY date_opened, row_index').all();
}

/**
 * The deck notes, with their checklists parsed.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listNotes(db) {
  const rows = db.prepare('SELECT * FROM komar_deck_notes ORDER BY page').all();
  return rows.map((row) => {
    let checklist = [];
    try {
      checklist = JSON.parse(row.quick_checklist_json || '[]');
    } catch { checklist = []; }
    // The stop loss the note prints: "Stop loss: 14.43 (5%)".
    const stop = /stop\s*loss:?\s*([0-9]+[.,][0-9]+)/i.exec(String(row.body_text || ''));
    return {
      checklist,
      page: row.page,
      stars: row.stars,
      state: row.trade_state,
      stop_loss: stop ? Number(stop[1].replace(',', '.')) : null,
      text: String(row.body_text || ''),
    };
  });
}

/**
 * The setups that became trades.
 *
 * @param {object[]} setups
 * @param {object[]} trades
 * @returns {object[]}
 */
function joinSetupsToTrades(setups, trades) {
  const byTicker = new Map();
  for (const trade of trades) {
    if (!byTicker.has(trade.ticker)) byTicker.set(trade.ticker, []);
    byTicker.get(trade.ticker).push(trade);
  }
  const joined = [];
  for (const setup of setups) {
    const date = toIsoDate(setup.video_session_date);
    if (!date) continue;
    const candidates = (byTicker.get(setup.ticker) || []).filter((trade) => {
      const opened = toIsoDate(trade.date_opened);
      if (!opened) return false;
      return Math.abs(daysBetween(date, opened)) <= TRADE_WINDOW_DAYS;
    });
    if (!candidates.length) continue;
    joined.push({
      days_to_trade: daysBetween(date, toIsoDate(candidates[0].date_opened)),
      setup_bias: setup.bias,
      setup_ticker: setup.ticker,
      trade: candidates[0],
      trade_row_index: candidates[0].row_index,
    });
  }
  return joined;
}

/**
 * The deck note for a trade, by the stop loss.
 *
 * @param {object[]} notes
 * @param {object} trade
 * @returns {object|null}
 */
function noteForTrade(notes, trade) {
  if (!trade || !Number.isFinite(trade.stop_loss_price)) return null;
  return notes.find((note) => (
    Number.isFinite(note.stop_loss)
    && Math.abs(note.stop_loss - trade.stop_loss_price) < 0.0001
  )) || null;
}

/**
 * The trade's own return, and the index's over the same window.
 *
 * @param {object[]} trades
 * @param {object} provider
 * @param {string} asOfDate
 * @returns {Promise<object[]>}
 */
async function scoreTrades(trades, provider, asOfDate) {
  const scored = [];
  for (const trade of trades) {
    const opened = toIsoDate(trade.date_opened);
    const closed = toIsoDate(trade.date_closed);
    if (!opened || !closed) continue;
    const symbol = yahooSymbolFor(trade.ticker);
    const entry = await provider.getPricePoint(symbol, opened);
    const exit = await provider.getPricePoint(symbol, closed);
    const spyOpen = await provider.getPricePoint('SPY', opened);
    const spyClose = await provider.getPricePoint('SPY', closed);
    const own = Number.isFinite(trade.avg_open_price) && Number.isFinite(trade.avg_close_price)
      ? ((trade.avg_close_price - trade.avg_open_price) / trade.avg_open_price) * 100
      : null;
    const index = Number.isFinite(spyOpen.price) && Number.isFinite(spyClose.price)
      ? ((spyClose.price - spyOpen.price) / spyOpen.price) * 100
      : null;
    const prices = Number.isFinite(entry.price) && Number.isFinite(exit.price)
      ? ((exit.price - entry.price) / entry.price) * 100
      : null;
    scored.push({
      avg_return_pct: own === null ? null : Number(own.toFixed(4)),
      closed: closed,
      days_held: daysBetween(opened, closed),
      index_return_pct: index === null ? null : Number(index.toFixed(4)),
      opened,
      price_return_pct: prices === null ? null : Number(prices.toFixed(4)),
      // The stop loss is the JOIN key to the deck note, so it has to
      // travel with the scored row.
      stop_loss_price: trade.stop_loss_price,
      ticker: trade.ticker,
      trade_row_index: trade.row_index,
      wl_pct: trade.wl_pct,
    });
  }
  return scored;
}

/**
 * The DECK's own census of the setups: how each one ended.
 *
 * This is the conversion measure that works. The corpus's archive has a
 * hole -- its trade log covers 2 July to 1 August 2025 and its SESSIONS
 * with setups start on 17 August 2025 (the reports in between are not
 * in the corpus), so a setup cannot be joined to a trade through the
 * sessions. But the DECK carries every setup he described, with its
 * state: `Closed`, `Open`, or `Did not trigger` -- a setup that never
 * fired. That is the funnel's middle rung, read straight off the page.
 *
 * @param {object[]} notes
 * @returns {object}
 */
function deckCensus(notes) {
  const states = new Map();
  for (const note of notes) {
    const state = String(note.state || '').trim() || 'unknown';
    states.set(state, (states.get(state) || 0) + 1);
  }
  const total = notes.length || 1;
  const closed = states.get('Closed') || 0;
  const never = states.get('Did not trigger') || 0;
  return {
    closed,
    closed_share: Number((closed / total).toFixed(3)),
    never_triggered: never,
    never_triggered_share: Number((never / total).toFixed(3)),
    setups_described: notes.length,
    states: Object.fromEntries([...states.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * Does his STAR RATING predict his own outcome?
 *
 * The deck rates each setup out of five stars, and the trade log
 * carries what the trade returned. So the rating can be scored against
 * the result -- which is the only calibration set the corpus has for
 * his own judgement.
 *
 * @param {object[]} scored - the scored trades
 * @param {object[]} notes
 * @returns {object[]}
 */
function calibrateStars(scored, notes) {
  const buckets = new Map();
  for (const trade of scored) {
    const note = noteForTrade(notes, trade);
    if (!note || !Number.isFinite(note.stars)) continue;
    const key = String(note.stars);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...trade, stars: note.stars });
  }
  return [...buckets.entries()].map(([stars, trades]) => {
    const returns = trades.map((trade) => trade.avg_return_pct).filter((value) => Number.isFinite(value));
    return {
      avg_return_pct: returns.length
        ? Number((returns.reduce((sum, value) => sum + value, 0) / returns.length).toFixed(3))
        : null,
      stars: Number(stars),
      trades: trades.length,
      win_rate: returns.length
        ? Number((returns.filter((value) => value > 0).length / returns.length).toFixed(3))
        : null,
    };
  }).sort((a, b) => b.stars - a.stars);
}

/**
 * The checklist calibration: each item, the trades that ticked it and
 * the trades that did not, and how each group did.
 *
 * @param {object[]} trades - the scored trades
 * @param {object[]} notes
 * @returns {object[]}
 */
function calibrateChecklist(trades, notes) {
  const items = new Map();
  for (const trade of trades) {
    const note = noteForTrade(notes, trade);
    if (!note) continue;
    for (const entry of note.checklist) {
      const item = String(entry.item || '').trim();
      if (!item) continue;
      if (!items.has(item)) items.set(item, { checked: [], item, unchecked: [] });
      items.get(item)[entry.checked ? 'checked' : 'unchecked'].push(trade);
    }
  }
  const mean = (rows, field) => {
    const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
  };
  return [...items.values()].map((entry) => ({
    checked: entry.checked.length,
    checked_avg_return_pct: mean(entry.checked, 'avg_return_pct'),
    checked_win_rate: entry.checked.length
      ? Number((entry.checked.filter((row) => (row.avg_return_pct || 0) > 0).length / entry.checked.length).toFixed(3))
      : null,
    item: entry.item,
    unchecked: entry.unchecked.length,
    unchecked_avg_return_pct: mean(entry.unchecked, 'avg_return_pct'),
    unchecked_win_rate: entry.unchecked.length
      ? Number((entry.unchecked.filter((row) => (row.avg_return_pct || 0) > 0).length / entry.unchecked.length).toFixed(3))
      : null,
  })).sort((a, b) => b.checked + b.unchecked - (a.checked + a.unchecked));
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  const setups = listSetups(db);
  const trades = listTrades(db);
  const notes = listNotes(db);

  const joined = joinSetupsToTrades(setups, trades);
  const calledTickers = new Set(joined.map((row) => row.setup_ticker));
  const tradedTickers = new Set(trades.map((trade) => trade.ticker));

  console.log(`[komar-conversion] ${setups.length} setups from sessions, ${trades.length} trades, ${notes.length} deck notes`);
  console.log(`[komar-conversion] ${joined.length} setups became a trade (${calledTickers.size} tickers called and traded)`);
  if (options.dryRun) {
    console.log('dry run: no prices fetched');
    db.close();
    return;
  }

  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: '2025-06-01',
    defaultToDate: new Date().toISOString().slice(0, 10),
    prefetchConcurrency: 4,
  });
  const symbols = [...new Set([...trades.map((trade) => yahooSymbolFor(trade.ticker)), 'SPY'])].filter(Boolean);
  await provider.prefetchTickers(symbols);

  const asOfDate = new Date().toISOString().slice(0, 10);
  const scored = await scoreTrades(trades, provider, asOfDate);
  const checklist = calibrateChecklist(scored, notes);
  const census = deckCensus(notes);
  const stars = calibrateStars(scored, notes);

  const ownReturns = scored.map((row) => row.avg_return_pct).filter((value) => Number.isFinite(value));
  const indexReturns = scored.map((row) => row.index_return_pct).filter((value) => Number.isFinite(value));
  const mean = (values) => (values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
    : null);

  const payload = {
    called_and_traded: {
      calls: joined.length,
      calls_by_ticker: [...calledTickers].sort(),
      // WHY THE JOIN IS EMPTY, which is a fact about the corpus and not
      // a defect in the join: the trade log covers 2 July to 1 August
      // 2025 and the corpus's sessions with setups start on 17 August
      // 2025 (the reports in between are not in the corpus), so no
      // setup in the corpus has a session in the month the log covers.
      note: joined.length
        ? ''
        : 'the corpus has no session inside the trade log\'s month (2 July - 1 August 2025): the archive is missing the reports in between',
      trades: trades.length,
      trades_by_ticker: [...tradedTickers].sort(),
      window_days: TRADE_WINDOW_DAYS,
    },
    checklist,
    deck: census,
    generated_at: new Date().toISOString(),
    joined: joined.map((row) => ({
      days_to_trade: row.days_to_trade,
      setup_bias: row.setup_bias,
      setup_ticker: row.setup_ticker,
      trade_ticker: row.trade.ticker,
      trade_wl_pct: row.trade.wl_pct,
    })),
    setups_total: setups.length,
    stars,
    trades: {
      avg_return_pct: mean(ownReturns),
      beaten_the_index: scored.filter((row) => (
        Number.isFinite(row.avg_return_pct) && Number.isFinite(row.index_return_pct)
        && row.avg_return_pct > row.index_return_pct
      )).length,
      index_avg_return_pct: mean(indexReturns),
      scored: scored.length,
      win_rate: ownReturns.length
        ? Number((ownReturns.filter((value) => value > 0).length / ownReturns.length).toFixed(3))
        : null,
    },
    trades_rows: scored,
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, 'komar_conversion.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  db.close();
  console.log(`[komar-conversion] ${joined.length} calls became a trade; `
    + `the ${scored.length} trades returned ${payload.trades.avg_return_pct}% on average `
    + `against ${payload.trades.index_avg_return_pct}% for SPY`);
  console.log('[komar-conversion] wrote data/komar_conversion.json');
  if (options.json) console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
