'use strict';

/**
 * Phase 1 analytics over clement_posts / clement_ideas.
 *
 * - noise filter (empty/link/other without ideas)
 * - watchlist timeline (first/last/days/mentions)
 * - theme rollup from idea.theme and focus_themes on daily plans
 *
 *   node tools/buildClementAnalytics.js
 *   node tools/buildClementAnalytics.js --json
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { DDL } = require('../src/discord/clement/schema');

const ANALYTICS_PARSER = 'clement-analytics-1';

const EXTRA_DDL = `
CREATE TABLE IF NOT EXISTS clement_watchlist_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    ticker TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 0,
    long_ideas INTEGER NOT NULL DEFAULT 0,
    short_ideas INTEGER NOT NULL DEFAULT 0,
    focus_or_watch INTEGER NOT NULL DEFAULT 0,
    first_date TEXT NOT NULL DEFAULT '',
    last_date TEXT NOT NULL DEFAULT '',
    span_days INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clement_watchlist_ticker
    ON clement_watchlist_stats(ticker);

CREATE TABLE IF NOT EXISTS clement_theme_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parser_version TEXT NOT NULL,
    theme TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 0,
    tickers TEXT NOT NULL DEFAULT '',
    first_date TEXT NOT NULL DEFAULT '',
    last_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function dayDiff(a, b) {
  if (!a || !b) return 0;
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 86400000));
}

function main() {
  const jsonMode = process.argv.includes('--json');
  ensureDerivedSchema();
  const db = new DatabaseSync(DERIVED_DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(DDL);
  db.exec(EXTRA_DDL);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM clement_watchlist_stats WHERE parser_version = ?').run(ANALYTICS_PARSER);
    db.prepare('DELETE FROM clement_theme_stats WHERE parser_version = ?').run(ANALYTICS_PARSER);

    // Ensure post noise: empty/other with no ideas and no images could stay other
    // Watchlist stats from ideas with dates
    const ideaRows = db.prepare(`
      SELECT ticker, role, as_of_date, theme
      FROM clement_ideas
      WHERE ticker != '' AND as_of_date != ''
    `).all();

    /** @type {Map<string, any>} */
    const byTicker = new Map();
    /** @type {Map<string, any>} */
    const byTheme = new Map();

    for (const row of ideaRows) {
      const t = String(row.ticker).toUpperCase();
      let st = byTicker.get(t);
      if (!st) {
        st = {
          ticker: t, mentions: 0, long_ideas: 0, short_ideas: 0, focus_or_watch: 0,
          first_date: row.as_of_date, last_date: row.as_of_date,
        };
        byTicker.set(t, st);
      }
      st.mentions += 1;
      if (row.role === 'long_idea') st.long_ideas += 1;
      if (row.role === 'short_idea') st.short_ideas += 1;
      if (row.role === 'focus' || row.role === 'watch' || row.role === 'theme_member') st.focus_or_watch += 1;
      if (row.as_of_date < st.first_date) st.first_date = row.as_of_date;
      if (row.as_of_date > st.last_date) st.last_date = row.as_of_date;

      const theme = String(row.theme || '').trim();
      if (theme && theme.length > 2) {
        let th = byTheme.get(theme);
        if (!th) {
          th = {
            theme, mentions: 0, tickers: new Set(),
            first_date: row.as_of_date, last_date: row.as_of_date,
          };
          byTheme.set(theme, th);
        }
        th.mentions += 1;
        th.tickers.add(t);
        if (row.as_of_date < th.first_date) th.first_date = row.as_of_date;
        if (row.as_of_date > th.last_date) th.last_date = row.as_of_date;
      }
    }

    // Also fold daily plan focus_themes text as theme labels without tickers
    const plans = db.prepare(`
      SELECT as_of_date, focus_themes FROM clement_daily_plans
      WHERE focus_themes IS NOT NULL AND focus_themes != ''
    `).all();
    for (const p of plans) {
      const theme = String(p.focus_themes).trim();
      if (!theme) continue;
      let th = byTheme.get(theme);
      if (!th) {
        th = {
          theme, mentions: 0, tickers: new Set(),
          first_date: p.as_of_date || '', last_date: p.as_of_date || '',
        };
        byTheme.set(theme, th);
      }
      th.mentions += 1;
      if (p.as_of_date && (!th.first_date || p.as_of_date < th.first_date)) th.first_date = p.as_of_date;
      if (p.as_of_date && p.as_of_date > th.last_date) th.last_date = p.as_of_date;
    }

    const insW = db.prepare(`
      INSERT INTO clement_watchlist_stats (
        parser_version, ticker, mentions, long_ideas, short_ideas, focus_or_watch,
        first_date, last_date, span_days
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const st of byTicker.values()) {
      insW.run(
        ANALYTICS_PARSER, st.ticker, st.mentions, st.long_ideas, st.short_ideas, st.focus_or_watch,
        st.first_date, st.last_date, dayDiff(st.first_date, st.last_date),
      );
    }

    const insT = db.prepare(`
      INSERT INTO clement_theme_stats (
        parser_version, theme, mentions, tickers, first_date, last_date
      ) VALUES (?,?,?,?,?,?)
    `);
    for (const th of byTheme.values()) {
      insT.run(
        ANALYTICS_PARSER, th.theme, th.mentions,
        [...th.tickers].sort().join(','), th.first_date, th.last_date,
      );
    }

    db.exec('COMMIT');

    const top = db.prepare(`
      SELECT ticker, mentions, long_ideas, first_date, last_date, span_days
      FROM clement_watchlist_stats
      WHERE parser_version = ?
      ORDER BY mentions DESC, ticker ASC LIMIT 15
    `).all(ANALYTICS_PARSER);
    const themes = db.prepare(`
      SELECT theme, mentions, tickers FROM clement_theme_stats
      WHERE parser_version = ?
      ORDER BY mentions DESC LIMIT 12
    `).all(ANALYTICS_PARSER);
    const postKinds = db.prepare('SELECT post_kind, COUNT(*) c FROM clement_posts GROUP BY 1').all();
    const useful = postKinds.filter((k) => k.post_kind !== 'other');
    const summary = {
      parser_version: ANALYTICS_PARSER,
      watchlist_tickers: top.length,
      top_watchlist: top,
      themes,
      post_kinds: postKinds,
      useful_posts: useful.reduce((s, r) => s + r.c, 0),
      plans: db.prepare('SELECT COUNT(*) c FROM clement_daily_plans').get().c,
    };
    if (jsonMode) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log('[clement-analytics]', ANALYTICS_PARSER);
      console.log('[clement-analytics] useful posts', summary.useful_posts, 'plans', summary.plans);
      console.log('[clement-analytics] top', top.slice(0, 8).map((t) => `${t.ticker}:${t.mentions}`).join(', '));
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.close();
  }
}

main();
