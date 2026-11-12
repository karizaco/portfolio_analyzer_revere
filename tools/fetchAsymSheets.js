'use strict';

// Fetch the Market Monitor Google Sheets linked from free AsymTrading posts.
//
// The sheets are PUBLIC. Google's CSV export returns them without a login,
// so this is one GET per post and a parse. What is stored is the measurement
// behind the written breadth / momentum reading.
//
// Usage:
//   node tools/fetchAsymSheets.js
//   node tools/fetchAsymSheets.js --limit 3
//   node tools/fetchAsymSheets.js --video-id asym_222466781
//   node tools/fetchAsymSheets.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  parseMarketMonitorCsv,
  spreadsheetCsvUrl,
  spreadsheetIdFromUrl,
} = require('../src/asym/marketMonitor');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const SHEETS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'sheets_asym');

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  json: argv.includes('--json'),
  force: argv.includes('--force'),
};

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || '';
}

function openCatalog() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('No SQLite at ' + DB_PATH);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function selectPosts(db) {
  const params = [];
  let sql = `SELECT video_id, upload_date, spreadsheet_url
               FROM asym_posts
              WHERE spreadsheet_url IS NOT NULL AND length(spreadsheet_url) > 10`;
  if (options.videoId) {
    sql += ' AND video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY upload_date DESC';
  let rows = db.prepare(sql).all(...params);
  if (options.limit) rows = rows.slice(0, options.limit);
  return rows;
}

async function main() {
  fs.mkdirSync(SHEETS_DIR, { recursive: true });
  const db = openCatalog();
  const posts = selectPosts(db);
  console.log('[asym-sheets] posts=' + posts.length);

  const summary = {
    command: ['fetchAsymSheets.js', ...argv],
    posts: posts.length,
    fetched: 0,
    skipped: 0,
    failed: 0,
    days: 0,
  };

  const insertSheet = db.prepare(`
    INSERT INTO asym_monitor_sheets (
      video_id, spreadsheet_id, spreadsheet_url, file_path, file_bytes,
      row_count, first_date, last_date, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      spreadsheet_id = excluded.spreadsheet_id,
      spreadsheet_url = excluded.spreadsheet_url,
      file_path = excluded.file_path,
      file_bytes = excluded.file_bytes,
      row_count = excluded.row_count,
      first_date = excluded.first_date,
      last_date = excluded.last_date,
      fetched_at = datetime('now')
  `);
  const deleteDays = db.prepare('DELETE FROM asym_monitor_days WHERE video_id = ?');
  const insertDay = db.prepare(`
    INSERT INTO asym_monitor_days (
      video_id, day, breadth_nh, breadth_nl, breadth_net,
      momentum_up, momentum_down, momentum_net,
      groups_json, indices_json, source_row
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, day) DO UPDATE SET
      breadth_nh = excluded.breadth_nh,
      breadth_nl = excluded.breadth_nl,
      breadth_net = excluded.breadth_net,
      momentum_up = excluded.momentum_up,
      momentum_down = excluded.momentum_down,
      momentum_net = excluded.momentum_net,
      groups_json = excluded.groups_json,
      indices_json = excluded.indices_json,
      source_row = excluded.source_row
  `);

  for (const post of posts) {
    const spreadsheetId = spreadsheetIdFromUrl(post.spreadsheet_url);
    if (!spreadsheetId) {
      summary.failed += 1;
      console.error('[asym-sheets] ' + post.video_id + ' no spreadsheet id in ' + post.spreadsheet_url);
      continue;
    }
    const dest = path.join(SHEETS_DIR, post.video_id + '.csv');
    try {
      const url = spreadsheetCsvUrl(spreadsheetId);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const csv = await res.text();
      if (!csv || csv.length < 50 || /<!DOCTYPE html>/i.test(csv.slice(0, 40))) {
        throw new Error('not a CSV export (' + csv.length + ' bytes)');
      }
      fs.writeFileSync(dest, csv, 'utf8');
      const parsed = parseMarketMonitorCsv(csv, { yearHint: post.upload_date });
      if (!parsed.rows.length) throw new Error('no data rows');
      // A sheet can list the same calendar day twice (weekend edits, re-exports).
      // Keep the first occurrence -- the sheet is newest-first, so that is the
      // latest reading for that day.
      const byDay = new Map();
      for (const row of parsed.rows) {
        if (!byDay.has(row.date)) byDay.set(row.date, row);
      }
      parsed.rows = [...byDay.values()];

      const rel = path.relative(ROOT, dest).replace(/\\/g, '/');
      db.exec('BEGIN');
      insertSheet.run(
        post.video_id,
        spreadsheetId,
        post.spreadsheet_url,
        rel,
        csv.length,
        parsed.rows.length,
        parsed.rows[parsed.rows.length - 1].date,
        parsed.rows[0].date,
      );
      deleteDays.run(post.video_id);
      for (const row of parsed.rows) {
        insertDay.run(
          post.video_id,
          row.date,
          row.breadth_nh,
          row.breadth_nl,
          row.breadth_net,
          row.momentum_up,
          row.momentum_down,
          row.momentum_net,
          JSON.stringify(row.groups),
          JSON.stringify(row.indices),
          row.source_row,
        );
      }
      db.exec('COMMIT');
      summary.fetched += 1;
      summary.days += parsed.rows.length;
      console.log('[asym-sheets] ' + post.upload_date + ' ' + post.video_id
        + ' -> ' + parsed.rows.length + ' day(s), latest ' + parsed.rows[0].date
        + ' breadth_net=' + parsed.rows[0].breadth_net);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      summary.failed += 1;
      console.error('[asym-sheets] ' + post.video_id + ' failed: ' + (error && error.message ? error.message : error));
    }
  }

  db.close();
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log('[asym-sheets] fetched=' + summary.fetched + ' failed=' + summary.failed + ' days=' + summary.days);
}

main().catch((error) => {
  console.error('[asym-sheets] failed: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});