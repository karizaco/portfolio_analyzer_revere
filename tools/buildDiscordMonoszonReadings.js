'use strict';

/**
 * Rebuild David's calls out of `discord_messages`.
 *
 * WHAT IT WRITES
 *
 * One row per call in `monoszon_readings`: the subject he named, the
 * direction, whether it is about the future, and the sentence it was
 * read from.
 *
 * The messages are NEVER rewritten -- this is a derived table, and a
 * change to the parser is visible because the row carries a
 * `parser_version`.
 *
 *   node tools/buildDiscordMonoszonReadings.js
 *   node tools/buildDiscordMonoszonReadings.js --json
 *   node tools/buildDiscordMonoszonReadings.js --dry-run
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDerivedSchema, DERIVED_DB_PATH } = require('../src/db/derivedStore');
const { DDL } = require('../src/discord/monoszon/schema');
const { parseMessage } = require('../src/discord/monoszon/parser');
const { PARSER_VERSION, SOURCE_NAME } = require('../src/discord/monoszon/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

function sqlPath(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function main() {
  const jsonMode = process.argv.includes('--json');
  const dryRun = process.argv.includes('--dry-run');
  ensureDerivedSchema();

  const derived = new DatabaseSync(DERIVED_DB_PATH);
  derived.exec('PRAGMA busy_timeout = 60000');
  derived.exec(DDL);
  derived.exec(`ATTACH DATABASE '${sqlPath(DB_PATH)}' AS catalog`);

  const source = derived.prepare(
    'SELECT id, name FROM catalog.discord_sources WHERE name = ?',
  ).get(SOURCE_NAME);
  if (!source) {
    derived.close();
    throw new Error(`source ${SOURCE_NAME} is not registered in discord_sources`);
  }

  const rows = derived.prepare(`
    SELECT id, discord_message_id, content, posted_at
    FROM catalog.discord_messages
    WHERE source_id = ?
    ORDER BY posted_at ASC, id ASC
  `).all(source.id);

  const readings = [];
  const byKind = Object.create(null);
  const byStance = Object.create(null);
  const bySubject = Object.create(null);
  for (const row of rows) {
    const parsed = parseMessage(row.content || '', {
      message_id: row.id,
      discord_message_id: row.discord_message_id || '',
      posted_at: row.posted_at || '',
      parser_version: PARSER_VERSION,
      source_name: SOURCE_NAME,
    });
    for (const reading of parsed) {
      readings.push(reading);
      byKind[reading.claim_kind] = (byKind[reading.claim_kind] || 0) + 1;
      byStance[reading.stance] = (byStance[reading.stance] || 0) + 1;
      bySubject[reading.subject] = (bySubject[reading.subject] || 0) + 1;
    }
  }

  if (!dryRun) {
    const insert = derived.prepare(`
      INSERT INTO monoszon_readings
        (parser_version, source_name, message_id, discord_message_id, posted_at,
         as_of_date, scope, subject, proxy_ticker, stance, claim_kind, horizon,
         horizon_text, level, confidence, evidence_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, subject, stance, claim_kind, parser_version) DO UPDATE SET
        posted_at = excluded.posted_at,
        as_of_date = excluded.as_of_date,
        scope = excluded.scope,
        proxy_ticker = excluded.proxy_ticker,
        horizon = excluded.horizon,
        horizon_text = excluded.horizon_text,
        level = excluded.level,
        confidence = excluded.confidence,
        evidence_text = excluded.evidence_text
    `);
    derived.exec('BEGIN');
    try {
      // The rows of THIS parser version are replaced; the rows of an
      // older parser are left, so a reader can tell the two apart.
      derived.prepare('DELETE FROM monoszon_readings WHERE parser_version = ?').run(PARSER_VERSION);
      for (const reading of readings) {
        insert.run(
          reading.parser_version, reading.source_name, reading.message_id,
          reading.discord_message_id, reading.posted_at, reading.as_of_date,
          reading.scope, reading.subject, reading.proxy_ticker, reading.stance,
          reading.claim_kind, reading.horizon, reading.horizon_text, reading.level,
          reading.confidence, reading.evidence_text,
        );
      }
      derived.exec('COMMIT');
    } catch (error) {
      try { derived.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  const summary = {
    parser_version: PARSER_VERSION,
    source: SOURCE_NAME,
    messages: rows.length,
    readings: readings.length,
    by_kind: byKind,
    by_stance: byStance,
    by_subject: bySubject,
    dry_run: dryRun,
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(`[monoszon] parser ${PARSER_VERSION}`);
    console.log(`[monoszon] messages ${rows.length} -> readings ${readings.length}`);
    console.log('[monoszon] by kind', byKind);
    console.log('[monoszon] by stance', byStance);
    console.log('[monoszon] top subjects', Object.entries(bySubject)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([ticker, n]) => `${ticker}:${n}`).join(', '));
  }

  try { derived.exec('DETACH DATABASE catalog'); } catch { /* ignore */ }
  derived.close();
}

main();
