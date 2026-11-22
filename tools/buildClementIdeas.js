'use strict';

/**
 * Rebuild Clement caption-derived posts and ideas from discord_messages.
 *
 *   node tools/buildClementIdeas.js
 *   node tools/buildClementIdeas.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived, ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { ensureClementSchema, DDL } = require('../src/discord/clement/schema');
const { parseCaption, PARSER_VERSION, SOURCE_NAME } = require('../src/discord/clement/parseCaption');
const { loadLexicon } = require('../src/discord/symbols');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

function imageMeta(rawJson) {
  let imageCount = 0;
  let primary = '';
  let primaryArea = 0;
  try {
    const raw = typeof rawJson === 'string' ? JSON.parse(rawJson || '{}') : (rawJson || {});
    const atts = Array.isArray(raw.attachments) ? raw.attachments : [];
    for (const a of atts) {
      const ct = String(a.content_type || '');
      const name = String(a.filename || '').toLowerCase();
      const isImg = ct.startsWith('image/')
        || /\.(png|jpe?g|webp|gif)$/i.test(name);
      if (!isImg) continue;
      imageCount += 1;
      const area = (Number(a.width) || 0) * (Number(a.height) || 0);
      if (area >= primaryArea) {
        primaryArea = area;
        primary = String(a.id || '');
      }
    }
  } catch {
    // ignore
  }
  return { imageCount, primary };
}

function main() {
  const jsonMode = process.argv.includes('--json');
  ensureDerivedSchema();
  // Apply Clement DDL onto the derived file directly (canonical).
  {
    const derived = new DatabaseSync(DERIVED_DB_PATH);
    derived.exec(DDL);
    derived.close();
  }

  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureClementSchema(db);
  const known = loadLexicon();

  const source = db.prepare('SELECT id, name FROM discord_sources WHERE name = ?').get(SOURCE_NAME);
  if (!source) {
    throw new Error(`source ${SOURCE_NAME} is not registered in discord_sources`);
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM clement_ideas').run();
    db.prepare('DELETE FROM clement_posts').run();

    const insertPost = db.prepare(`
      INSERT INTO clement_posts
        (parser_version, source_name, message_id, discord_message_id, posted_at, as_of_date,
         as_of_source, post_kind, title, body, image_count, primary_attachment_id, idea_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertIdea = db.prepare(`
      INSERT INTO clement_ideas
        (parser_version, source_name, message_id, discord_message_id, as_of_date,
         ticker, role, theme, note, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rows = db.prepare(`
      SELECT id, discord_message_id, content, posted_at, raw_json
      FROM discord_messages
      WHERE source_id = ?
      ORDER BY posted_at ASC, id ASC
    `).all(source.id);

    let posts = 0;
    let ideas = 0;
    const byKind = Object.create(null);

    for (const row of rows) {
      const { imageCount, primary } = imageMeta(row.raw_json);
      const parsed = parseCaption(row.content || '', {
        message_id: row.id,
        discord_message_id: row.discord_message_id || '',
        posted_at: row.posted_at || '',
        image_count: imageCount,
        primary_attachment_id: primary,
        known,
      });
      const p = parsed.post;
      insertPost.run(
        p.parser_version, p.source_name, p.message_id, p.discord_message_id, p.posted_at,
        p.as_of_date, p.as_of_source, p.post_kind, p.title, p.body,
        p.image_count, p.primary_attachment_id, parsed.ideas.length,
      );
      posts += 1;
      byKind[p.post_kind] = (byKind[p.post_kind] || 0) + 1;
      for (const idea of parsed.ideas) {
        insertIdea.run(
          idea.parser_version, idea.source_name, idea.message_id, idea.discord_message_id,
          idea.as_of_date, idea.ticker, idea.role, idea.theme, idea.note,
          idea.confidence, idea.source,
        );
        ideas += 1;
      }
    }

    db.exec('COMMIT');

    const top = db.prepare(`
      SELECT ticker, COUNT(*) AS n
      FROM clement_ideas
      WHERE parser_version = ?
      GROUP BY ticker
      ORDER BY n DESC, ticker ASC
      LIMIT 15
    `).all(PARSER_VERSION);

    const summary = {
      parser_version: PARSER_VERSION,
      source: SOURCE_NAME,
      messages: rows.length,
      posts,
      ideas,
      by_kind: byKind,
      top_tickers: top,
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      console.log(`[clement] parser ${PARSER_VERSION}`);
      console.log(`[clement] messages ${summary.messages} → posts ${posts}, ideas ${ideas}`);
      console.log(`[clement] by kind`, byKind);
      console.log(`[clement] top tickers`, top.map((r) => `${r.ticker}:${r.n}`).join(', '));
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.close();
  }
}

main();
