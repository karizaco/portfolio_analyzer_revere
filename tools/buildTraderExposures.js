'use strict';

/**
 * Project existing Discord/Clement tables into trader_exposures (improvement #1).
 * Read-only on source tables; rebuilds only trader_exposures.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { EXPOSURE_DDL } = require('../src/discord/shared/additiveSchema');
const { EXPOSURE_KINDS } = require('../src/discord/shared/exposureKinds');

const PARSER = 'trader-exposures-1';
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

function sqlPath(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function sessionDate(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function main() {
  const jsonMode = process.argv.includes('--json');
  ensureDerivedSchema();
  const db = new DatabaseSync(DERIVED_DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(EXPOSURE_DDL);
  db.exec(`ATTACH DATABASE '${sqlPath(CATALOG)}' AS catalog`);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM trader_exposures WHERE parser_version = ?').run(PARSER);
    const ins = db.prepare(`
      INSERT INTO trader_exposures (
        parser_version, trader, source_name, as_of_date, ticker, kind, side,
        size, role_or_action, account, ref_table, ref_id, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    let n = 0;

    // Drendel holdings
    try {
      const rows = db.prepare(`
        SELECT id, source_name, as_of_date, ticker, side, weight_pct, account, note
        FROM discord_positions WHERE source_name = 'drendel'
      `).all();
      for (const r of rows) {
        ins.run(PARSER, 'drendel', r.source_name, r.as_of_date || '', r.ticker || '',
          EXPOSURE_KINDS.HOLDING, r.side || '', r.weight_pct, 'holding', r.account || '',
          'discord_positions', r.id, r.note || '');
        n += 1;
      }
    } catch (e) {
      if (!jsonMode) console.error('[exposures] positions skip', e.message);
    }

    // Ariel + Drendel actions
    try {
      const rows = db.prepare(`
        SELECT id, source_name, posted_at, ticker, action, kind, content
        FROM discord_trade_actions
        WHERE source_name IN ('drendel','ariel-long','ariel-short')
      `).all();
      for (const r of rows) {
        const trader = r.source_name === 'drendel' ? 'drendel' : 'ariel';
        const side = r.source_name === 'ariel-short' ? 'short'
          : r.source_name === 'ariel-long' ? 'long' : '';
        ins.run(PARSER, trader, r.source_name, sessionDate(r.posted_at), r.ticker || '',
          EXPOSURE_KINDS.ACTION, side, null, r.action || r.kind || '', '',
          'discord_trade_actions', r.id, (r.content || '').slice(0, 200));
        n += 1;
      }
    } catch (e) {
      if (!jsonMode) console.error('[exposures] actions skip', e.message);
    }

    // Clement ideas
    try {
      const rows = db.prepare(`
        SELECT id, source_name, as_of_date, ticker, role, note, source
        FROM clement_ideas WHERE ticker != ''
      `).all();
      for (const r of rows) {
        const side = r.role === 'short_idea' ? 'short'
          : (r.role === 'long_idea' || r.role === 'focus' || r.role === 'watch' ? 'long' : '');
        ins.run(PARSER, 'clement', r.source_name || 'clement', r.as_of_date || '', r.ticker,
          EXPOSURE_KINDS.IDEA, side, null, r.role || '', '',
          'clement_ideas', r.id, `${r.source || ''}|${(r.note || '').slice(0, 160)}`);
        n += 1;
      }
    } catch (e) {
      if (!jsonMode) console.error('[exposures] ideas skip', e.message);
    }

    // Clement regime days
    try {
      const rows = db.prepare(`
        SELECT id, as_of_date, daily_buy_signal, weekly_buy_signal, technical_theme
        FROM clement_daily_plans
      `).all();
      for (const r of rows) {
        const note = [
          r.daily_buy_signal == null ? '' : `daily=${r.daily_buy_signal}`,
          r.weekly_buy_signal == null ? '' : `weekly=${r.weekly_buy_signal}`,
          r.technical_theme || '',
        ].filter(Boolean).join('; ');
        ins.run(PARSER, 'clement', 'clement', r.as_of_date || '', '',
          EXPOSURE_KINDS.REGIME, '', null, 'daily_plan', '',
          'clement_daily_plans', r.id, note.slice(0, 300));
        n += 1;
      }
    } catch (e) {
      if (!jsonMode) console.error('[exposures] plans skip', e.message);
    }

    // Focus episodes if present
    try {
      const rows = db.prepare(`
        SELECT id, ticker, side, entry_date, exit_date, still_open, days
        FROM clement_focus_episodes
      `).all();
      for (const r of rows) {
        ins.run(PARSER, 'clement', 'clement', r.entry_date || '', r.ticker || '',
          EXPOSURE_KINDS.FOCUS_EPISODE, r.side || 'long', null,
          r.still_open ? 'open' : 'closed', '',
          'clement_focus_episodes', r.id,
          `exit=${r.exit_date || ''};days=${r.days || 0}`);
        n += 1;
      }
    } catch {
      // table may not exist yet on first run order
    }

    db.exec('COMMIT');
    const by = db.prepare(`
      SELECT trader, kind, COUNT(*) c FROM trader_exposures
      WHERE parser_version = ? GROUP BY 1, 2 ORDER BY 1, 2
    `).all(PARSER);
    const out = { parser_version: PARSER, rows: n, by };
    if (jsonMode) console.log(JSON.stringify(out, null, 2));
    else console.error('[exposures]', out);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    try { db.exec('DETACH DATABASE catalog'); } catch { /* ignore */ }
    db.close();
  }
}

main();
