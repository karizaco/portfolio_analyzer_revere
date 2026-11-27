'use strict';

/**
 * Rebuild Martin Klass's readings out of `discord_messages`.
 *
 *   node tools/buildDiscordMartinKlassReadings.js
 *   node tools/buildDiscordMartinKlassReadings.js --json
 *   node tools/buildDiscordMartinKlassReadings.js --dry-run
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { DDL } = require('../src/discord/martinklass/schema');
const { parsePost } = require('../src/discord/martinklass/parser');
const { loadLexicon } = require('../src/discord/symbols');
const {
  PARSER_VERSION, SOURCE_NAME, SOURCES,
} = require('../src/discord/martinklass/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const json = process.argv.includes('--json');
const dryRun = process.argv.includes('--dry-run');

function sqlPath(value) {
  return String(value).replace(/\\/g, '/').replace(/'/g, "''");
}

function main() {
  // The DERIVED file is the record and the CATALOG is read through an
  // ATTACH, so an unqualified INSERT cannot land in the catalog. (The
  // first version of this builder connected to the catalog and wrote the
  // readings there -- and the table was created in the catalog too.)
  ensureDerivedSchema();
  const derived = new DatabaseSync(DERIVED_DB_PATH);
  derived.exec('PRAGMA busy_timeout = 60000');
  derived.exec(DDL);
  derived.exec(`ATTACH DATABASE '${sqlPath(DB_PATH)}' AS catalog`);
  const known = loadLexicon();

  const readings = [];
  const perSource = {};

  for (const [name, config] of Object.entries(SOURCES)) {
    const source = derived.prepare('SELECT id FROM catalog.discord_sources WHERE name = ?').get(name);
    if (!source) throw new Error(`source ${name} is not registered in discord_sources`);
    const messages = derived.prepare(
      'SELECT id, discord_message_id, content, posted_at FROM catalog.discord_messages WHERE source_id = ? ORDER BY posted_at',
    ).all(source.id);
    let count = 0;
    for (const message of messages) {
      const parsed = parsePost(message.content || '', {
        channel: name,
        lexicon: known,
        message_id: message.id,
        discord_message_id: message.discord_message_id || '',
        posted_at: message.posted_at || '',
        parser_version: PARSER_VERSION,
        source_name: SOURCE_NAME,
      });
      for (const reading of parsed) {
        readings.push(reading);
        count += 1;
      }
    }
    perSource[name] = { messages: messages.length, readings: count };
  }

  const summary = {
    parser_version: PARSER_VERSION,
    source: SOURCE_NAME,
    sources: perSource,
    readings: readings.length,
    by_kind: {},
    by_stance: {},
    by_scope: {},
    by_channel: {},
  };
  for (const reading of readings) {
    summary.by_kind[reading.claim_kind] = (summary.by_kind[reading.claim_kind] || 0) + 1;
    summary.by_stance[reading.stance] = (summary.by_stance[reading.stance] || 0) + 1;
    summary.by_scope[reading.scope] = (summary.by_scope[reading.scope] || 0) + 1;
    summary.by_channel[reading.channel] = (summary.by_channel[reading.channel] || 0) + 1;
  }

  if (!dryRun) {
    const insert = derived.prepare(`
      INSERT INTO martinklass_readings
        (parser_version, source_name, message_id, discord_message_id, posted_at,
         as_of_date, channel, scope, subject, proxy_ticker, stance, claim_kind,
         horizon, horizon_text, confidence, evidence_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, subject, stance, claim_kind, parser_version) DO UPDATE SET
        posted_at = excluded.posted_at,
        as_of_date = excluded.as_of_date,
        scope = excluded.scope,
        proxy_ticker = excluded.proxy_ticker,
        horizon = excluded.horizon,
        horizon_text = excluded.horizon_text,
        confidence = excluded.confidence,
        evidence_text = excluded.evidence_text
    `);
    derived.exec('BEGIN');
    try {
      derived.prepare('DELETE FROM martinklass_readings WHERE parser_version = ?').run(PARSER_VERSION);
      for (const reading of readings) {
        insert.run(
          reading.parser_version, reading.source_name, reading.message_id,
          reading.discord_message_id, reading.posted_at, reading.as_of_date,
          reading.channel, reading.scope, reading.subject, reading.proxy_ticker,
          reading.stance, reading.claim_kind, reading.horizon, reading.horizon_text,
          reading.confidence, reading.evidence_text,
        );
      }
      derived.exec('COMMIT');
    } catch (error) {
      derived.exec('ROLLBACK');
      throw error;
    }
  }

  try { derived.exec('DETACH DATABASE catalog'); } catch { /* ignore */ }
  derived.close();
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[martinklass] readings ${summary.readings}`);
    console.log(`[martinklass] by kind ${JSON.stringify(summary.by_kind)}`);
    console.log(`[martinklass] by stance ${JSON.stringify(summary.by_stance)}`);
    console.log(`[martinklass] by scope ${JSON.stringify(summary.by_scope)}`);
    console.log(`[martinklass] by channel ${JSON.stringify(summary.by_channel)}`);
  }
}

main();
