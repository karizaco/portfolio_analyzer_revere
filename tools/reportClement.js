'use strict';

/** Clement status: captions, daily plans, watchlist analytics. */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived, DERIVED_DB_PATH, ensureDerivedSchema } = require('../src/db/derivedStore');

ensureDerivedSchema();
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'video_pipeline', 'state.sqlite'));
attachDerived(db);

function safeAll(sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function safeGet(sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return { c: 0 }; }
}

const kinds = safeAll('SELECT post_kind, COUNT(*) c FROM clement_posts GROUP BY 1 ORDER BY c DESC');
const ideas = safeGet('SELECT COUNT(*) c FROM clement_ideas');
const plans = safeGet('SELECT COUNT(*) c FROM clement_daily_plans');
const top = safeAll(`
  SELECT ticker, COUNT(*) n FROM clement_ideas
  GROUP BY ticker ORDER BY n DESC, ticker ASC LIMIT 12`);
const recentPlans = safeAll(`
  SELECT as_of_date, daily_buy_signal, weekly_buy_signal, above_rising_5dma,
         traction_last_5, net_52w_hl_positive, technical_theme, focus_themes
  FROM clement_daily_plans ORDER BY as_of_date DESC LIMIT 8`);
const watch = safeAll(`
  SELECT ticker, mentions, long_ideas, short_ideas, first_date, last_date, span_days
  FROM clement_watchlist_stats
  WHERE parser_version = 'clement-analytics-1'
  ORDER BY mentions DESC LIMIT 12`);
const themes = safeAll(`
  SELECT theme, mentions, tickers FROM clement_theme_stats
  WHERE parser_version = 'clement-analytics-1'
  ORDER BY mentions DESC LIMIT 10`);
const planSignals = safeAll(`
  SELECT
    SUM(CASE WHEN daily_buy_signal = 1 THEN 1 ELSE 0 END) AS daily_yes,
    SUM(CASE WHEN daily_buy_signal = 0 THEN 1 ELSE 0 END) AS daily_no,
    COUNT(*) AS n
  FROM clement_daily_plans`);

console.log(JSON.stringify({
  derived: DERIVED_DB_PATH,
  post_kinds: kinds,
  ideas: ideas.c,
  daily_plans: plans.c,
  plan_signal_summary: planSignals[0] || null,
  top_tickers: top,
  watchlist_stats: watch,
  themes,
  recent_plans: recentPlans,
}, null, 2));
