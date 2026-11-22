'use strict';

/**
 * Clement focus-list membership episodes (improvement #2).
 * Built only from existing clement_ideas (dashboard_left_ocr long/short) +
 * dated plans — does not re-OCR or rewrite clement_daily_plans.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { EXPOSURE_DDL } = require('../src/discord/shared/additiveSchema');
const { repairOcrTicker } = require('../src/discord/shared/ocrConfusables');

const PARSER = 'clement-focus-episodes-1';

function dayDiff(a, b) {
  if (!a || !b) return 0;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : 0;
}

function main() {
  const jsonMode = process.argv.includes('--json');
  ensureDerivedSchema();
  const db = new DatabaseSync(DERIVED_DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(EXPOSURE_DDL);

  // Dates that have a daily plan (regime calendar)
  const planDates = db.prepare(`
    SELECT DISTINCT as_of_date FROM clement_daily_plans
    WHERE as_of_date IS NOT NULL AND as_of_date != ''
    ORDER BY as_of_date
  `).all().map((r) => r.as_of_date);

  // Focus membership by date from OCR long/short ideas
  const ideaRows = db.prepare(`
    SELECT as_of_date, ticker, role FROM clement_ideas
    WHERE source = 'dashboard_left_ocr'
      AND role IN ('long_idea', 'short_idea', 'focus')
      AND as_of_date != '' AND ticker != ''
  `).all();

  /** @type {Map<string, {long: Set<string>, short: Set<string>}>} */
  const byDate = new Map();
  for (const d of planDates) byDate.set(d, { long: new Set(), short: new Set() });

  for (const r of ideaRows) {
    const t = repairOcrTicker(r.ticker);
    if (!t || t.length > 5) continue;
    if (!byDate.has(r.as_of_date)) byDate.set(r.as_of_date, { long: new Set(), short: new Set() });
    const bucket = byDate.get(r.as_of_date);
    if (r.role === 'short_idea') bucket.short.add(t);
    else bucket.long.add(t);
  }

  const dates = [...byDate.keys()].sort();

  function buildEpisodes(side) {
    /** @type {Map<string, {entry: string, last: string}>} */
    const open = new Map();
    const closed = [];
    for (const d of dates) {
      const set = side === 'long' ? byDate.get(d).long : byDate.get(d).short;
      // close missing
      for (const [t, ep] of [...open.entries()]) {
        if (!set.has(t)) {
          closed.push({
            ticker: t, side, entry_date: ep.entry, exit_date: d, still_open: 0,
            days: dayDiff(ep.entry, d),
          });
          open.delete(t);
        } else {
          ep.last = d;
        }
      }
      // open new
      for (const t of set) {
        if (!open.has(t)) open.set(t, { entry: d, last: d });
        else open.get(t).last = d;
      }
    }
    const lastDate = dates[dates.length - 1] || '';
    for (const [t, ep] of open.entries()) {
      closed.push({
        ticker: t, side, entry_date: ep.entry, exit_date: '', still_open: 1,
        days: dayDiff(ep.entry, lastDate),
      });
    }
    return closed;
  }

  const episodes = [...buildEpisodes('long'), ...buildEpisodes('short')];

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM clement_focus_episodes WHERE parser_version = ?').run(PARSER);
    const ins = db.prepare(`
      INSERT INTO clement_focus_episodes (
        parser_version, ticker, side, entry_date, exit_date, still_open, days, source
      ) VALUES (?,?,?,?,?,?,?,?)
    `);
    for (const e of episodes) {
      ins.run(PARSER, e.ticker, e.side, e.entry_date, e.exit_date, e.still_open, e.days, 'dashboard_left_ocr');
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  const summary = {
    parser_version: PARSER,
    plan_dates: dates.length,
    episodes: episodes.length,
    open: episodes.filter((e) => e.still_open).length,
    sample: episodes.slice(0, 8),
  };
  if (jsonMode) console.log(JSON.stringify(summary, null, 2));
  else console.error('[focus-episodes]', summary);
  db.close();
}

main();
