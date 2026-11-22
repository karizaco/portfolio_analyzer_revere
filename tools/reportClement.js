'use strict';

/** Quick Clement caption + daily-plan status. */
const { DatabaseSync } = require('node:sqlite');
const { attachDerived, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'video_pipeline', 'state.sqlite'));
attachDerived(db);

const kinds = db.prepare('SELECT post_kind, COUNT(*) c FROM clement_posts GROUP BY 1 ORDER BY c DESC').all();
const ideas = db.prepare('SELECT COUNT(*) c FROM clement_ideas').get();
const plans = db.prepare('SELECT COUNT(*) c FROM clement_daily_plans').get();
const top = db.prepare(`
  SELECT ticker, COUNT(*) n FROM clement_ideas
  WHERE role IN ('long_idea','short_idea','focus','watch','theme_member','mention')
  GROUP BY ticker ORDER BY n DESC LIMIT 12
`).all();
const recentPlans = db.prepare(`
  SELECT as_of_date, daily_buy_signal, weekly_buy_signal, technical_theme, focus_themes
  FROM clement_daily_plans ORDER BY as_of_date DESC LIMIT 5
`).all();

console.log(JSON.stringify({
  derived: DERIVED_DB_PATH,
  post_kinds: kinds,
  ideas: ideas.c,
  daily_plans: plans.c,
  top_tickers: top,
  recent_plans: recentPlans,
}, null, 2));
