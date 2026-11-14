'use strict';

/**
 * Aggregate the O'Connell corpus and render its report.
 *
 * This reads what the extractors wrote and turns it into the artifacts
 * the rest of the project consumes: the CSVs, the JSON payload and the
 * self-contained HTML dashboard.
 *
 * The stage order matters, and it is the order the other sources use:
 * outcomes FIRST, then the aggregate, because the aggregate embeds the
 * outcome summary and the report is rebuilt from the payload. Run in the
 * other order the panel says "Not scored yet" while the database holds
 * the scored rows -- which is exactly what happened to the Sevcik report
 * on 2026-11-05.
 *
 * Usage:
 *   node tools/aggregateOconnellSignals.js
 *   node tools/aggregateOconnellSignals.js --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  DAILY_COLUMNS,
  POSITION_COLUMNS,
  SETUP_COLUMNS,
  TICKER_COLUMNS,
  buildOconnellPayload,
} = require('../src/oconnell/aggregate');
const { ensureOconnellSchema } = require('../src/oconnell/schema');
const { renderOconnellReport } = require('../src/report/oconnellReport');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const DATA_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const options = { json: argv.includes('--json') };

function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  // Opened WRITABLE, because the schema migration has to run before the
  // columns this tool reads exist. It only reads afterwards.
  const db = new DatabaseSync(DB_PATH);
  ensureOconnellSchema(db);
  return db;
}

/**
 * The outcome rows, if they have been scored.
 *
 * @param {object} db
 * @returns {object|null}
 */
function loadOutcomes(db) {
  const file = path.join(DATA_DIR, 'oconnell_outcomes.json');
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { rows: payload.rows || [], summary: payload.summary || null };
  } catch {
    return null;
  }
}

async function main() {
  const db = openDatabase();
  const outcomes = loadOutcomes(db);
  const payload = buildOconnellPayload(db, { outcomes });

  await writeCsv(path.join(DATA_DIR, 'oconnell_setups.csv'), SETUP_COLUMNS, payload.setups);
  await writeCsv(path.join(DATA_DIR, 'oconnell_positions.csv'), POSITION_COLUMNS, payload.positions);
  await writeCsv(path.join(DATA_DIR, 'oconnell_daily_summary.csv'), DAILY_COLUMNS, payload.daily);
  await writeCsv(path.join(DATA_DIR, 'oconnell_ticker_summary.csv'), TICKER_COLUMNS, payload.tickers);

  fs.writeFileSync(
    path.join(DATA_DIR, 'oconnell_signals.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  );

  const html = renderOconnellReport(payload);
  fs.writeFileSync(path.join(DATA_DIR, 'oconnell_report.html'), html, 'utf8');

  if (options.json) {
    console.log(JSON.stringify(payload.counts, null, 2));
  } else {
    console.log(`documents ${payload.counts.documents} | setups ${payload.counts.setups} `
      + `| positions ${payload.counts.positions} | tickers ${payload.tickers.length}`);
    console.log('wrote: oconnell_setups.csv, oconnell_positions.csv, '
      + 'oconnell_daily_summary.csv, oconnell_ticker_summary.csv, '
      + 'oconnell_signals.json, oconnell_report.html');
  }

  db.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = { buildOconnellPayload };
