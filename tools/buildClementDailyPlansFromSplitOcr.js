'use strict';

/**
 * Ingest left-half dashboard OCR into clement_daily_plans (+ focus list ideas).
 *
 * Used after tools/clementDashboardSplitOcr.py (or any producer of *_LEFT.txt
 * plus split_summary.json).
 *
 *   node tools/buildClementDailyPlansFromSplitOcr.js \
 *     --dir data/discord_pipeline/media/clement/ocr_split_probe
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { DDL } = require('../src/discord/clement/schema');
const { parseDashboardLeft } = require('../src/discord/clement/parseDashboardLeft');
const { loadLexicon } = require('../src/discord/symbols');

const PLAN_PARSER = 'clement-dashboard-left-1';
const ROOT = path.resolve(__dirname, '..');

function sqlPath(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function ynInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function main() {
  const dirFlag = process.argv.indexOf('--dir');
  const defaultDir = fs.existsSync(path.join(ROOT, 'data/discord_pipeline/media/clement/ocr_split_batch', 'split_summary.json'))
    || fs.existsSync(path.join(ROOT, 'data/discord_pipeline/media/clement/ocr_split_batch'))
    ? path.join(ROOT, 'data/discord_pipeline/media/clement/ocr_split_batch')
    : path.join(ROOT, 'data/discord_pipeline/media/clement/ocr_split_probe');
  const dir = path.resolve(dirFlag >= 0 ? process.argv[dirFlag + 1] : defaultDir);
  if (!fs.existsSync(dir)) {
    throw new Error(`split OCR dir not found: ${dir}`);
  }

  ensureDerivedSchema();
  const derived = new DatabaseSync(DERIVED_DB_PATH);
  derived.exec('PRAGMA busy_timeout = 60000');
  derived.exec(DDL);
  derived.exec(`ATTACH DATABASE '${sqlPath(path.join(ROOT, 'data/video_pipeline/state.sqlite'))}' AS catalog`);

  const known = loadLexicon();
  let summaryJson = null;
  const summaryPath = path.join(dir, 'split_summary.json');
  if (fs.existsSync(summaryPath)) {
    summaryJson = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  }

  const leftFiles = fs.readdirSync(dir).filter((n) => n.endsWith('_LEFT.txt'));
  derived.exec('BEGIN');
  try {
    // Replace only this parser version rows
    derived.prepare('DELETE FROM clement_daily_plans WHERE parser_version = ?').run(PLAN_PARSER);
    derived.prepare(
      "DELETE FROM clement_ideas WHERE parser_version = ? AND source = 'dashboard_left_ocr'",
    ).run(PLAN_PARSER);

    const insertPlan = derived.prepare(`
      INSERT INTO clement_daily_plans (
        parser_version, source_name, message_id, discord_message_id, attachment_id,
        as_of_date, split_x, split_frac, split_method,
        daily_buy_signal, weekly_buy_signal, above_rising_5dma, traction_last_5, net_52w_hl_positive,
        technical_theme, focus_themes, situational_awareness, emotional_analysis,
        left_ocr_path, right_ocr_path, image_path
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertIdea = derived.prepare(`
      INSERT INTO clement_ideas (
        parser_version, source_name, message_id, discord_message_id, as_of_date,
        ticker, role, theme, note, confidence, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    let plans = 0;
    let ideas = 0;

    for (const name of leftFiles) {
      const leftPath = path.join(dir, name);
      const text = fs.readFileSync(leftPath, 'utf8');
      const parsed = parseDashboardLeft(text, { known });
      const stem = name.replace(/_LEFT\.txt$/i, '');
      const meta = (summaryJson || []).find((r) => String(r.file || '').includes(stem)) || {};
      const split = meta.split || {};

      // Resolve message via attachment filename pattern YYYYMMDD_msgId_attId
      const m = stem.match(/_(\d{17,20})_(\d{17,20})$/);
      let discordMessageId = m ? m[1] : '';
      let attachmentId = m ? m[2] : '';
      let messageId = null;
      if (discordMessageId) {
        const row = derived.prepare(
          'SELECT id FROM catalog.discord_messages WHERE discord_message_id = ?',
        ).get(discordMessageId);
        if (row) messageId = row.id;
      }

      insertPlan.run(
        PLAN_PARSER, 'clement', messageId, discordMessageId, attachmentId,
        parsed.as_of_date, split.split_x ?? null, split.split_frac ?? null, split.method || '',
        ynInt(parsed.signals.daily_buy_signal),
        ynInt(parsed.signals.weekly_buy_signal),
        ynInt(parsed.signals.above_rising_5dma),
        ynInt(parsed.signals.traction_last_5),
        ynInt(parsed.signals.net_52w_hl_positive),
        parsed.technical_theme || '',
        parsed.focus_themes || '',
        parsed.situational_awareness || '',
        parsed.emotional_analysis || '',
        path.relative(ROOT, leftPath).replace(/\\/g, '/'),
        path.relative(ROOT, path.join(dir, `${stem}_RIGHT.txt`)).replace(/\\/g, '/'),
        meta.file || '',
      );
      plans += 1;

      for (const idea of parsed.ideas) {
        insertIdea.run(
          PLAN_PARSER, 'clement', messageId || 0, discordMessageId,
          parsed.as_of_date, idea.ticker, idea.role,
          parsed.focus_themes || '', idea.note || '', idea.confidence || 'medium',
          'dashboard_left_ocr',
        );
        ideas += 1;
      }
    }

    derived.exec('COMMIT');
    const out = { parser_version: PLAN_PARSER, dir, plans, ideas, left_files: leftFiles.length };
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    try { derived.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    try { derived.exec('DETACH DATABASE catalog'); } catch { /* ignore */ }
    derived.close();
  }
}

main();
