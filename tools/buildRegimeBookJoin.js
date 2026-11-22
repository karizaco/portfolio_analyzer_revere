'use strict';

/**
 * Improvement #5: join Clement regime days to book/idea counts.
 * Uses existing clement_daily_plans + discord_positions + discord_episodes + clement_ideas.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { EXPOSURE_DDL } = require('../src/discord/shared/additiveSchema');

const PARSER = 'regime-book-1';

function main() {
  const jsonMode = process.argv.includes('--json');
  ensureDerivedSchema();
  const db = new DatabaseSync(DERIVED_DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(EXPOSURE_DDL);

  const plans = db.prepare(`
    SELECT as_of_date, daily_buy_signal, weekly_buy_signal, technical_theme
    FROM clement_daily_plans
    WHERE as_of_date IS NOT NULL AND as_of_date != ''
    ORDER BY as_of_date
  `).all();

  const posStmt = db.prepare(`
    SELECT COUNT(*) c FROM discord_positions
    WHERE source_name = 'drendel' AND as_of_date = ?
  `);
  const epStmt = db.prepare(`
    SELECT COUNT(*) c FROM discord_episodes
    WHERE source_name IN ('ariel-long','ariel-short')
      AND entry_date <= ?
      AND (still_open = 1 OR (exit_date != '' AND exit_date >= ?))
  `);
  const focusStmt = db.prepare(`
    SELECT COUNT(DISTINCT ticker) c FROM clement_ideas
    WHERE source = 'dashboard_left_ocr'
      AND role IN ('long_idea','short_idea','focus')
      AND as_of_date = ?
  `);
  const ideaStmt = db.prepare(`
    SELECT COUNT(*) c FROM clement_ideas
    WHERE source = 'caption' AND as_of_date = ?
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM regime_book_days WHERE parser_version = ?').run(PARSER);
    const ins = db.prepare(`
      INSERT INTO regime_book_days (
        parser_version, as_of_date, daily_buy_signal, weekly_buy_signal, technical_theme,
        drendel_holdings, ariel_open_episodes, clement_focus_tickers, clement_idea_mentions
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `);

    for (const p of plans) {
      const d = p.as_of_date;
      let drendel = 0;
      let ariel = 0;
      let focus = 0;
      let ideas = 0;
      try { drendel = posStmt.get(d).c; } catch { /* empty */ }
      try { ariel = epStmt.get(d, d).c; } catch { /* empty */ }
      try { focus = focusStmt.get(d).c; } catch { /* empty */ }
      try { ideas = ideaStmt.get(d).c; } catch { /* empty */ }
      ins.run(
        PARSER, d, p.daily_buy_signal, p.weekly_buy_signal, p.technical_theme || '',
        drendel, ariel, focus, ideas,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  const rows = db.prepare(`
    SELECT * FROM regime_book_days WHERE parser_version = ? ORDER BY as_of_date DESC LIMIT 8
  `).all(PARSER);
  const corr = db.prepare(`
    SELECT
      daily_buy_signal,
      ROUND(AVG(drendel_holdings), 1) AS avg_drendel,
      ROUND(AVG(ariel_open_episodes), 1) AS avg_ariel,
      ROUND(AVG(clement_focus_tickers), 1) AS avg_focus,
      COUNT(*) AS n
    FROM regime_book_days
    WHERE parser_version = ? AND daily_buy_signal IS NOT NULL
    GROUP BY daily_buy_signal
  `).all(PARSER);

  const out = { parser_version: PARSER, days: plans.length, by_signal: corr, recent: rows };
  if (jsonMode) console.log(JSON.stringify(out, null, 2));
  else console.error('[regime-book]', out);
  db.close();
}

main();
