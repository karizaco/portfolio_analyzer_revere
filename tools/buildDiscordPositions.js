'use strict';

/**
 * Read the three Discord channels and write the parsed layers.
 *
 *   discord_positions     Drendel's "Portfolio" snapshots
 *   discord_trade_actions every trade action either trader posted
 *   discord_episodes      the position lifecycles behind them
 *
 * This is a REBUILD, not an increment: the tables are derived from
 * `discord_messages`, so dropping them and running this again is the way to
 * change the parser. The messages are read-only here.
 *
 *   node tools/buildDiscordPositions.js            # everything
 *   node tools/buildDiscordPositions.js --json     # a summary, no log lines
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');

const {
  ACCOUNT_TRADING, ACCOUNT_VIBE, PARSER_VERSION, SOURCES, SUB_ACCOUNT_SMALL,
} = require('../src/discord/sources');
const {
  episodesFromActions, episodesFromSnapshots, priceEpisode, snapshotCurve,
} = require('../src/discord/episodes');
const { parsePortfolioPost, resolveSnapshotDates, sessionDateOf } = require('../src/discord/drendelPortfolio');
const { readActionStream } = require('../src/discord/tradeActions');
const { loadLexicon } = require('../src/discord/symbols');
const { loadCachedCloses } = require('../src/discord/priceCache');
const { ensureDiscordSchema } = require('../src/discord/schema');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const json = process.argv.includes('--json');

function log(...args) {
  if (!json) console.error(...args);
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureDiscordSchema(db);
  const known = loadLexicon();

  // The sources THIS tool owns. A source with its own parser -- plechac --
  // writes its own rows, so the delete is scoped to these names and the
  // other source's rows survive.
  const owned = Object.keys(SOURCES);

  db.exec('BEGIN');
  try {
    for (const table of ['discord_positions', 'discord_trade_actions', 'discord_episodes']) {
      const placeholders = owned.map(() => '?').join(', ');
      db.prepare(`DELETE FROM ${table} WHERE source_name IN (${placeholders})`).run(...owned);
    }

    const select = db.prepare('SELECT id, content, posted_at FROM discord_messages WHERE source_id = ? ORDER BY posted_at');
    const sources = db.prepare('SELECT id, name FROM discord_sources WHERE name IN (?, ?, ?)').all(
      'drendel', 'ariel-long', 'ariel-short',
    );
    const byName = new Map(sources.map((row) => [row.name, row.id]));
    if (byName.size !== 3) {
      throw new Error(`expected the three trader sources in discord_sources, found ${byName.size}`);
    }

    const insertPosition = db.prepare(`
      INSERT INTO discord_positions
        (parser_version, source_name, message_id, as_of_date, as_of_source, account, sub_account,
         side, ticker, weight_pct, stated_price, annotation, note, is_new, snapshot_notes, header,
         long_exposure_pct, short_exposure_pct, cash_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAction = db.prepare(`
      INSERT INTO discord_trade_actions
        (parser_version, source_name, message_id, posted_at, kind, action, ticker, ticker_inferred,
         price, stop_price, stop_text, size_pct, size_note, fraction, fraction_basis,
         stated_result_pct, atr_multiple, verb, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisode = db.prepare(`
      INSERT INTO discord_episodes
        (parser_version, source_name, basis, account, sub_account, ticker, side, direction,
         entry_date, entry_weight, entry_price, entry_price_at, exit_date, exit_weight, exit_price,
         exit_price_at, exit_action, return_pct, priced, still_open, left_censored, implied_open,
         ambiguous_inverse)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const summary = { actions: {}, episodes: {}, positions: 0, sources: {}, unpriced: 0 };
    const allEpisodes = [];
    let lastMessageId = 0;

    for (const [name, id] of byName) {
      const config = SOURCES[name];
      const messages = select.all(id);
      if (name === 'drendel') {
        // The trading account comes from his own snapshots, not from his
        // messages: a snapshot says what he holds, a message says what he did.
        const snapshots = resolveSnapshotDates(messages
          .map((row) => ({ ...parsePortfolioPost(row.content, row.posted_at), posted_at: row.posted_at, message_id: row.id }))
          .filter((row) => row.as_of_date));
        for (const snapshot of snapshots) {
          for (const position of snapshot.positions) {
            insertPosition.run(
              PARSER_VERSION, name, snapshot.message_id, snapshot.as_of_date, snapshot.as_of_source,
              position.account, position.sub_account, position.side, position.ticker,
              position.weight_pct, position.stated_price, position.annotation, position.note,
              position.is_new ? 1 : 0, JSON.stringify(snapshot.notes), snapshot.header,
              snapshot.long_exposure_pct, snapshot.short_exposure_pct, snapshot.cash_pct,
            );
            summary.positions += 1;
          }
        }
        const trading = episodesFromSnapshots(snapshots, { includeVibe: false });
        const vibe = episodesFromSnapshots(snapshots, { includeVibe: true })
          .filter((episode) => episode.account === ACCOUNT_VIBE);
        // Drendel's trading account is his own snapshot; his ACTIONS are a
        // second, independent reading of the same account (a trade he made
        // intraday and then folded into the day's snapshot). They are kept
        // apart by `basis`, never merged: merging a state with an event
        // would double-count every position.
        allEpisodes.push(...trading.map((episode) => ({ ...episode, basis: 'snapshots', source_name: name })),
          ...vibe.map((episode) => ({ ...episode, basis: 'snapshots', source_name: name })));
      }

      const actions = readActionStream(messages, { book: config.book, known })
        .map((row) => ({ ...row, source_name: name, session_date: sessionDateOf(row.posted_at) }));
      const tickerSet = new Set(actions.map((row) => row.ticker).filter(Boolean));
      summary.actions[name] = actions.reduce((counts, row) => {
        const key = row.kind === 'action' ? row.action : row.kind;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
      for (const action of actions) {
        insertAction.run(
          PARSER_VERSION, name, action.message_id, action.posted_at, action.kind, action.action,
          action.ticker, action.ticker_inferred ? 1 : 0, action.price, action.stop_price,
          action.stop_text, action.size_pct, action.size_note || '', action.fraction,
          action.fraction_basis || '', action.stated_result_pct, action.atr_multiple, action.verb || '',
          action.content,
        );
        if (action.kind !== 'action') continue;
        const side = config.direction;
        const ambiguous = side === 'short' && !tickerSet.has(action.ticker);
        allEpisodes.push({
          ...action,
          basis: 'actions',
          account: config.book === 'trading' ? ACCOUNT_TRADING : config.book,
          ambiguous_inverse: ambiguous,
          side,
          sub_account: '',
          ticker: action.ticker,
        });
      }
      summary.sources[name] = { messages: messages.length, actions: actions.filter((row) => row.kind === 'action').length, snapshots: name === 'drendel' ? undefined : 0 };
      lastMessageId = Math.max(lastMessageId, ...messages.map((row) => row.id));
    }

    // The chain has to be per (source, ticker): two channels naming one
    // ticker are two traders, not one position.
    const chained = [];
    const bySource = new Map();
    for (const episode of allEpisodes) {
      if (episode.basis !== 'actions') {
        chained.push(episode);
        continue;
      }
      const key = episode.source_name;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(episode);
    }
    for (const [sourceName, rows] of bySource) {
      const config = SOURCES[sourceName];
      if (!config) throw new Error(`no source configuration for ${sourceName}`);
      const perTicker = new Map();
      for (const row of rows) {
        if (!row.ticker) continue;
        if (!perTicker.has(row.ticker)) perTicker.set(row.ticker, []);
        perTicker.get(row.ticker).push(row);
      }
      for (const [ticker, actions] of perTicker) {
        const episodes = episodesFromActions(actions, {
          account: config.book === 'trading' ? ACCOUNT_TRADING : config.book,
          side: config.direction,
          sub_account: config.book === 'trading' ? SUB_ACCOUNT_SMALL : '',
        });
        for (const episode of episodes) {
          chained.push({
            ...episode,
            ambiguous_inverse: config.direction === 'short' && !actions.some((row) => row.kind === 'open' && row.ticker === ticker),
            basis: 'actions',
            source_name: sourceName,
            ticker,
          });
        }
      }
    }

    const symbols = [...new Set(allEpisodes.map((row) => row.ticker).filter(Boolean))];
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

    for (const episode of chained) {
      const priced = priceEpisode(episode, priceAt, markDate);
      if (!priced.priced) summary.unpriced += 1;
      insertEpisode.run(
        PARSER_VERSION, priced.source_name || '', priced.basis, priced.account || '', priced.sub_account || '',
        priced.ticker, priced.side, priced.direction, priced.entry_date, priced.entry_weight ?? null,
        priced.entry_price ?? null, priced.entry_price_at, priced.exit_date, priced.exit_weight ?? null,
        priced.exit_price ?? null, priced.exit_price_at, priced.exit_action || '', priced.return_pct,
        priced.priced ? 1 : 0, priced.still_open ? 1 : 0, priced.left_censored ? 1 : 0,
        priced.implied_open ? 1 : 0, priced.ambiguous_inverse ? 1 : 0,
      );
      summary.episodes[priced.source_name] = (summary.episodes[priced.source_name] || 0) + 1;
    }

    db.exec('COMMIT');
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      log(`positions ${summary.positions}`);
      for (const [name, counts] of Object.entries(summary.actions)) {
        log(`${name}: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
      }
      for (const [name, count] of Object.entries(summary.episodes)) log(`episodes ${name}: ${count}`);
      log(`episodes unpriced: ${summary.unpriced}`);
      log(`last message id: ${lastMessageId}`);
    }
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

main();
