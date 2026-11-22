'use strict';

/**
 * Improvement #4: flag Ariel/Drendel messages that are image-heavy / text-thin
 * so they can be reviewed or later OCR'd. Does not invent trades.
 *
 * Writes only discord_attachment_hints from catalog.discord_messages.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { EXPOSURE_DDL } = require('../src/discord/shared/additiveSchema');

const PARSER = 'discord-attachment-hints-1';
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SOURCES = ['drendel', 'ariel-long', 'ariel-short'];

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

  const sources = db.prepare(`
    SELECT id, name FROM catalog.discord_sources WHERE name IN (${SOURCES.map(() => '?').join(',')})
  `).all(...SOURCES);
  const byId = new Map(sources.map((s) => [s.id, s.name]));

  const rows = db.prepare(`
    SELECT id, source_id, discord_message_id, content, posted_at, raw_json
    FROM catalog.discord_messages
    WHERE source_id IN (${sources.map(() => '?').join(',')})
  `).all(...sources.map((s) => s.id));

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM discord_attachment_hints WHERE parser_version = ?').run(PARSER);
    const ins = db.prepare(`
      INSERT OR IGNORE INTO discord_attachment_hints (
        parser_version, source_name, message_id, discord_message_id, posted_at, as_of_date,
        attachment_id, filename, content_type, hint
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    let n = 0;
    for (const row of rows) {
      const content = String(row.content || '').trim();
      let raw;
      try { raw = JSON.parse(row.raw_json || '{}'); } catch { continue; }
      const atts = Array.isArray(raw.attachments) ? raw.attachments : [];
      const images = atts.filter((a) => {
        const ct = String(a.content_type || '');
        const fn = String(a.filename || '').toLowerCase();
        return ct.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(fn);
      });
      if (!images.length) continue;

      const thin = content.length < 40;
      const empty = content.length === 0;
      if (!thin && !empty) continue; // only image-heavy / text-thin

      const sourceName = byId.get(row.source_id) || '';
      for (const a of images) {
        const hint = empty ? 'image_only_no_text' : 'image_with_thin_text';
        ins.run(
          PARSER, sourceName, row.id, row.discord_message_id || '', row.posted_at || '',
          sessionDate(row.posted_at), String(a.id || ''), String(a.filename || ''),
          String(a.content_type || ''), hint,
        );
        n += 1;
      }
    }
    db.exec('COMMIT');
    const by = db.prepare(`
      SELECT source_name, hint, COUNT(*) c FROM discord_attachment_hints
      WHERE parser_version = ? GROUP BY 1, 2
    `).all(PARSER);
    const out = { parser_version: PARSER, rows: n, by };
    if (jsonMode) console.log(JSON.stringify(out, null, 2));
    else console.error('[attachment-hints]', out);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    try { db.exec('DETACH DATABASE catalog'); } catch { /* ignore */ }
    db.close();
  }
}

main();
