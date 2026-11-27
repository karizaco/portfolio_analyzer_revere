'use strict';

/**
 * Rebuild HariSeldon's parsed layers from his Discord posts.
 *
 * WHAT IT WRITES
 *
 *   discord_trade_actions  every trade action he posted
 *   discord_episodes       the EQUITY position lifecycles behind them
 *
 * The OPTION actions are recorded but NOT chained into episodes, and the
 * reason is the price: a spread's price is the SPREAD's price and not the
 * underlying's, and an episode is priced from the underlying's closes.
 * Chaining them would publish a return made from two different numbers.
 *
 * THE MIRRORS ARE DEDUPED, and the mirrors are the reason this source
 * needs its own reader. The Reddit, Twitter and alias accounts are
 * WEBHOOKS posting under one Discord user id, so the same trade arrives
 * two or three times: his own post is "Exit $NKE `36.52` with .98 profit
 * per share" and the Twitter mirror is "Exit NKE with .98 profit per
 * share". Measured: 97 of his 126 messages in the sample have a mirror
 * within 15 minutes. The rule is to keep the RICHER post -- the one with
 * the price -- because that is the one the episode is priced from.
 *
 *   node tools/buildDiscordHariSeldonPositions.js
 *   node tools/buildDiscordHariSeldonPositions.js --json
 *   node tools/buildDiscordHariSeldonPositions.js --dry-run
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { episodesFromActions, priceEpisode } = require('../src/discord/episodes');
const { loadCachedCloses } = require('../src/discord/priceCache');
const { ensureDiscordSchema } = require('../src/discord/schema');
const { parsePost } = require('../src/discord/hariseldon/parser');
const {
  DEDUPE_MINUTES, PARSER_VERSION, SOURCE_NAME,
} = require('../src/discord/hariseldon/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const json = process.argv.includes('--json');
const dryRun = process.argv.includes('--dry-run');

const ACCOUNT = 'main';

/**
 * Drop the mirrors.
 *
 * Two posts are the same trade when they carry the same ticker and the
 * same action within twenty minutes of each other. The one that is kept
 * is the one with more of the record in it.
 *
 * @param {object[]} messages
 * @returns {{kept: object[], dropped: number}}
 */
function dedupe(messages) {
  const kept = [];
  let dropped = 0;
  for (const message of messages) {
    const parsed = parsePost(message.content, { inheritedTicker: '' });
    const primary = parsed.find((row) => row.action);
    if (!primary) {
      // A post with no trade in it (an announcement, a link) is kept: it
      // is not a mirror of anything.
      kept.push(message);
      continue;
    }
    const at = Date.parse(message.posted_at);
    const twin = kept.find((other) => {
      if (!other.parsed || !other.parsedPrimary) return false;
      if (other.parsedPrimary.ticker !== primary.ticker) return false;
      if (other.parsedPrimary.action !== primary.action) return false;
      return Math.abs(Date.parse(other.posted_at) - at) <= DEDUPE_MINUTES * 60 * 1000;
    });
    if (!twin) {
      kept.push({ ...message, parsed, parsedPrimary: primary });
      continue;
    }
    dropped += 1;
    // The richer post wins: the one with the price in it.
    const richer = (message.content || '').length > (twin.content || '').length ? message : twin;
    if (richer === twin) continue;
    twin.content = richer.content;
    twin.parsed = richer.parsed;
    twin.parsedPrimary = richer.parsedPrimary;
    // The EARLIER post is the one that starts the trade, and the
    // comparison has to be a STRING comparison: `Math.min` on an ISO
    // date is NaN, and NaN written to a NOT NULL column is a crash.
    twin.posted_at = twin.posted_at <= message.posted_at ? twin.posted_at : message.posted_at;
  }
  return { kept, dropped };
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureDiscordSchema(db);

  const source = db.prepare('SELECT id, name FROM discord_sources WHERE name = ?').get(SOURCE_NAME);
  if (!source) {
    throw new Error(`source ${SOURCE_NAME} is not registered in discord_sources`);
  }
  const messages = db.prepare(
    'SELECT id, content, posted_at, author_name FROM discord_messages WHERE source_id = ? ORDER BY posted_at, id',
  ).all(source.id);

  const { kept, dropped } = dedupe(messages);

  // The ticker is INHERITED: "Bought back the sold Calls" and "I added
  // to another 250 Shares" name no ticker, and they belong to the
  // position he was last talking about.
  const actions = [];
  let inherited = '';
  for (const message of kept) {
    const parsed = message.parsed && message.parsed.length
      ? message.parsed
      : parsePost(message.content, { inheritedTicker: inherited });
    for (const row of parsed) {
      if (!row.ticker) continue;
      inherited = row.ticker;
      actions.push({
        ...row,
        source_name: SOURCE_NAME,
        message_id: message.id,
        posted_at: message.posted_at,
      });
    }
  }

  // THE SIDE OF A POSITION, and an exit takes the side of the position
  // it closes. He writes "Long $TSLA" and "Short $SPY" and never says
  // which book an exit belongs to, so the side is carried along the
  // ticker: an OPEN sets it and an EXIT, an ADD and a TRIM take it.
  //
  // This matters, and it is measurable: with the exit's side guessed as
  // 'long', every exit of a SHORT position is a different position from
  // the open, and the short position is never closed.
  const sideOf = new Map();
  for (const row of actions) {
    if (row.kind === 'option') continue;
    if (row.verb === 'Long') sideOf.set(row.ticker, 'long');
    else if (row.verb === 'Short') sideOf.set(row.ticker, 'short');
    else if (!sideOf.has(row.ticker)) sideOf.set(row.ticker, 'long');
    row.side = sideOf.get(row.ticker);
  }

  const equity = actions.filter((row) => row.kind === 'equity' || row.kind === 'future');
  const option = actions.filter((row) => row.kind === 'option');

  // The chain is per (ticker, side): a long and a short of one name are
  // two positions.
  const chains = [];
  const groups = new Map();
  for (const row of equity) {
    const side = row.side || 'long';
    const key = `${row.ticker}|${side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, side });
  }
  for (const [key, rows] of groups) {
    const side = key.split('|')[1];
    for (const episode of episodesFromActions(rows, { account: ACCOUNT, side })) {
      chains.push({
        ...episode,
        basis: 'actions',
        source_name: SOURCE_NAME,
        account: ACCOUNT,
        ticker: key.split('|')[0],
        side,
      });
    }
  }

  const symbols = [...new Set(chains.map((row) => row.ticker).filter(Boolean))];
  const closes = loadCachedCloses([...symbols, 'SPY'], CACHE_DIR);
  const priceAt = (ticker, date) => {
    const series = closes.get(ticker);
    if (!series) return null;
    let best = null;
    for (const [key, price] of series) {
      if (key <= date) best = price;
      else break;
    }
    return best === null ? null : best;
  };
  const markDate = String(db.prepare('SELECT MAX(posted_at) AS at FROM discord_messages').get().at || '').slice(0, 10);

  const summary = {
    source: SOURCE_NAME,
    messages: messages.length,
    mirrors_dropped: dropped,
    actions: actions.length,
    equity_actions: equity.length,
    option_actions: option.length,
    episodes: chains.length,
    unpriced: 0,
    by_action: {},
    by_ticker: {},
  };
  for (const row of actions) {
    summary.by_action[row.action] = (summary.by_action[row.action] || 0) + 1;
    summary.by_ticker[row.ticker] = (summary.by_ticker[row.ticker] || 0) + 1;
  }

  if (!dryRun) {
    const insertAction = db.prepare(`
      INSERT INTO discord_trade_actions
        (parser_version, source_name, message_id, posted_at, kind, action, ticker, ticker_inferred,
         price, stop_price, stop_text, size_pct, size_note, fraction, fraction_basis,
         stated_result_pct, atr_multiple, verb, account, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisode = db.prepare(`
      INSERT INTO discord_episodes
        (parser_version, source_name, basis, account, sub_account, ticker, side, direction,
         entry_date, entry_weight, entry_price, entry_price_at, exit_date, exit_weight, exit_price,
         exit_price_at, exit_action, return_pct, priced, still_open, left_censored, implied_open,
         ambiguous_inverse)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM discord_trade_actions WHERE source_name = ? AND parser_version = ?')
        .run(SOURCE_NAME, PARSER_VERSION);
      db.prepare('DELETE FROM discord_episodes WHERE source_name = ? AND parser_version = ?')
        .run(SOURCE_NAME, PARSER_VERSION);

      for (const row of actions) {
        insertAction.run(
          PARSER_VERSION, SOURCE_NAME, row.message_id, row.posted_at, row.kind, row.action,
          row.ticker, 0, row.price, row.stop_price, '', row.size_pct, row.size_note || '',
          null, '', row.stated_result_pct, null, row.verb || '', ACCOUNT, row.content,
        );
      }
      for (const episode of chains) {
        const priced = priceEpisode(episode, priceAt, markDate);
        if (!priced.priced) summary.unpriced += 1;
        insertEpisode.run(
          PARSER_VERSION, SOURCE_NAME, priced.basis, priced.account || '', '',
          priced.ticker, priced.side, priced.direction, priced.entry_date, priced.entry_weight ?? null,
          priced.entry_price ?? null, priced.entry_price_at, priced.exit_date, priced.exit_weight ?? null,
          priced.exit_price ?? null, priced.exit_price_at, priced.exit_action || '', priced.return_pct,
          priced.priced ? 1 : 0, priced.still_open ? 1 : 0, priced.left_censored ? 1 : 0,
          priced.implied_open ? 1 : 0, priced.ambiguous_inverse ? 1 : 0,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.close();
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[hariseldon] messages ${summary.messages}, mirrors dropped ${summary.mirrors_dropped}`);
    console.log(`[hariseldon] actions ${summary.actions} (equity ${summary.equity_actions}, option ${summary.option_actions}) ${JSON.stringify(summary.by_action)}`);
    console.log(`[hariseldon] episodes ${summary.episodes}, unpriced ${summary.unpriced}`);
    console.log(`[hariseldon] tickers ${Object.keys(summary.by_ticker).length}`);
  }
}

main();
