'use strict';

/**
 * Read plechac's two Discord channels and write the parsed layers.
 *
 *   discord_trade_actions  every trade action he posted, with the BOOK it
 *                          belongs to
 *   discord_episodes       the position lifecycles behind them, one per
 *                          (book, ticker)
 *
 * This is plechac's OWN builder, and it shares the tables with the other
 * Discord sources but not their rows: every row it writes carries
 * `source_name = 'plechac'`, and the delete at the top is scoped to that
 * name, so the other sources' rows survive a rebuild of either one.
 *
 * The PARSER is his own too (`src/discord/plechac/`), because he writes
 * Czech: the verbs are Czech, the books are his, and the line is the unit
 * of a statement rather than the message. What is shared is the machinery
 * around it: the episode chaining (`src/discord/episodes.js`), the price
 * cache, and the schema.
 *
 *   node tools/buildDiscordPlechacPositions.js            # everything
 *   node tools/buildDiscordPlechacPositions.js --json     # a summary, no log lines
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');

const { episodesFromActions, priceEpisode } = require('../src/discord/episodes');
const { loadLexicon } = require('../src/discord/symbols');
const { loadCachedCloses } = require('../src/discord/priceCache');
const { ensureDiscordSchema } = require('../src/discord/schema');
const {
  ACCOUNT_MAIN, ACCOUNT_RISKY, CHANNELS, PARSER_VERSION, SOURCE_NAME, SOURCE_NAMES,
} = require('../src/discord/plechac/sources');
const { readActionStream } = require('../src/discord/plechac/parser');

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

  db.exec('BEGIN');
  try {
    // Only plechac's own rows. The other sources' rows are not this
    // tool's to delete. The parameter is BOUND -- `db.exec` does not bind
    // parameters, so an unbound "?" is NULL and the delete matches
    // nothing, and every rebuild would DOUBLE the rows.
    db.prepare('DELETE FROM discord_trade_actions WHERE source_name = ?').run(SOURCE_NAME);
    db.prepare('DELETE FROM discord_episodes WHERE source_name = ?').run(SOURCE_NAME);

    const select = db.prepare(
      'SELECT id, content, posted_at FROM discord_messages WHERE source_id = ? ORDER BY posted_at',
    );
    const sources = db.prepare(
      `SELECT id, name FROM discord_sources WHERE name IN (${SOURCE_NAMES.map(() => '?').join(', ')})`,
    ).all(...SOURCE_NAMES);
    const byName = new Map(sources.map((row) => [row.name, row.id]));

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

    const summary = {
      sources: {},
      actions: 0,
      episodes: 0,
      unpriced: 0,
      books: {},
    };
    const allActions = [];
    let lastMessageId = 0;

    for (const name of SOURCE_NAMES) {
      const id = byName.get(name);
      if (id === undefined) {
        summary.sources[name] = { registered: false };
        continue;
      }
      const messages = select.all(id);
      const config = CHANNELS[name];
      const actions = readActionStream(messages, { known, kind: config.kind });
      for (const action of actions) {
        allActions.push({ ...action, source_name: SOURCE_NAME });
        summary.actions += 1;
        summary.books[action.account] = (summary.books[action.account] || 0) + 1;
      }
      summary.sources[name] = {
        registered: true,
        channel_id: config.channel_id,
        messages: messages.length,
        actions: actions.length,
      };
      if (messages.length) {
        lastMessageId = Math.max(lastMessageId, ...messages.map((row) => row.id));
      }
    }

    for (const action of allActions) {
      insertAction.run(
        PARSER_VERSION, SOURCE_NAME, action.message_id, action.posted_at, action.kind,
        action.action, action.ticker, action.ticker_inferred ? 1 : 0, action.price,
        action.stop_price, action.stop_text, action.size_pct, action.size_note || '',
        action.fraction, action.fraction_basis || '', action.stated_result_pct,
        action.atr_multiple, action.verb || '', action.account || '', action.content,
      );
    }

    // The chain is per (BOOK, ticker): a position in the risky book and
    // the same name in the main book are two positions, and the two
    // never cancel each other out.
    const episodes = [];
    for (const book of [ACCOUNT_MAIN, ACCOUNT_RISKY]) {
      const rows = allActions.filter((row) => row.account === book);
      if (!rows.length) continue;
      const byTicker = new Map();
      for (const row of rows) {
        if (!row.ticker) continue;
        if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
        byTicker.get(row.ticker).push(row);
      }
      for (const [ticker, actions] of byTicker) {
        const built = episodesFromActions(actions, {
          account: book,
          side: 'long',
          sub_account: '',
        });
        for (const episode of built) {
          episodes.push({ ...episode, source_name: SOURCE_NAME, ticker });
        }
      }
    }

    const symbols = [...new Set(episodes.map((row) => row.ticker).filter(Boolean))];
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
    const markDate = String(
      db.prepare('SELECT MAX(posted_at) AS at FROM discord_messages').get().at || '',
    ).slice(0, 10);

    for (const episode of episodes) {
      const priced = priceEpisode(episode, priceAt, markDate);
      if (!priced.priced) summary.unpriced += 1;
      insertEpisode.run(
        PARSER_VERSION, priced.source_name || '', priced.basis || '', priced.account || '',
        priced.sub_account || '', priced.ticker, priced.side, priced.direction,
        priced.entry_date, priced.entry_weight ?? null, priced.entry_price ?? null,
        priced.entry_price_at, priced.exit_date, priced.exit_weight ?? null,
        priced.exit_price ?? null, priced.exit_price_at, priced.exit_action || '',
        priced.return_pct, priced.priced ? 1 : 0, priced.still_open ? 1 : 0,
        priced.left_censored ? 1 : 0, priced.implied_open ? 1 : 0,
        priced.ambiguous_inverse ? 1 : 0,
      );
      summary.episodes += 1;
    }

    db.exec('COMMIT');
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      log(`sources: ${JSON.stringify(summary.sources)}`);
      log(`actions ${summary.actions}  episodes ${summary.episodes}  unpriced ${summary.unpriced}`);
      log(`books: ${JSON.stringify(summary.books)}`);
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
