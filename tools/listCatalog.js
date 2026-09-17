'use strict';

// View the YouTube-channel catalog state from data/video_pipeline/state.sqlite.
// Prints a clean per-video table grouped by status so a reviewer can see at a
// glance which videos are downloaded, which are still pending, and which
// failed. Also prints aggregate counts and a per-month breakdown.
//
// Usage:
//   node tools/listCatalog.js                      # all rows, table format
//   node tools/listCatalog.js --status pending    # only pending rows
//   node tools/listCatalog.js --from 20260501 --to 20260731
//   node tools/listCatalog.js --json              # machine-readable

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const statusFilter = readFlag(argv, '--status') || null;
const fromDate = readFlag(argv, '--from') || null;
const toDate = readFlag(argv, '--to') || null;
const limit = Number(readFlag(argv, '--limit')) || 0;
const channelFilter = readFlag(argv, '--channel') || null;

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`No SQLite state at ${dbPath}. Run 'npm run video:init' first.`);
  process.exit(1);
}

const py = process.platform === 'win32' ? 'py' : 'python3';
const script = `
import json, sqlite3, sys
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row

filters = []
params = []
${statusFilter ? `filters.append('status = ?'); params.append(${JSON.stringify(statusFilter)})` : ''}
${fromDate ? `filters.append('upload_date >= ?'); params.append(${JSON.stringify(fromDate)})` : ''}
${toDate ? `filters.append('upload_date <= ?'); params.append(${JSON.stringify(toDate)})` : ''}
${channelFilter ? `filters.append('channel = ?'); params.append(${JSON.stringify(channelFilter)})` : ''}

where = ('WHERE ' + ' AND '.join(filters)) if filters else ''
limit_clause = 'LIMIT ' + str(${limit}) if ${limit} else ''

rows = conn.execute(
    f'SELECT video_id, upload_date, status, channel, title, download_path, error, '
    f'video_url, source_url, output_path, transcript_path '
    f'FROM videos {where} ORDER BY upload_date DESC, video_id DESC {limit_clause}',
    params
).fetchall()

by_status = dict(conn.execute(
    'SELECT status, COUNT(*) FROM videos GROUP BY status'
).fetchall())

by_channel = dict(conn.execute(
    "SELECT COALESCE(NULLIF(channel,''),'revere') AS channel, COUNT(*) FROM videos GROUP BY channel"
).fetchall())

by_month = list(conn.execute(
    "SELECT substr(upload_date,1,6) AS ym, COUNT(*) FROM videos "
    "WHERE upload_date != '' GROUP BY ym ORDER BY ym"
).fetchall())

total = conn.execute('SELECT COUNT(*) FROM videos').fetchone()[0]
na = conn.execute("SELECT COUNT(*) FROM videos WHERE upload_date = 'NA' OR upload_date = ''").fetchone()[0]

json.dump({
    'total': total,
    'na_date_rows': na,
    'by_status': by_status,
    'by_channel': by_channel,
    'by_month': [{'month': ym, 'count': n} for ym, n in by_month],
    'rows': [dict(r) for r in rows]
}, sys.stdout, indent=2, default=str)
`;

const result = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}

const data = JSON.parse(result.stdout);

if (wantJson) {
  process.stdout.write(result.stdout);
  process.stdout.write('\n');
  process.exit(0);
}

const tableCell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

console.log('# Video catalog (Revere + Qullamaggie)');
console.log('');
console.log(`- SQLite: \`${dbPath}\``);
console.log(`- Total rows: ${data.total}`);
console.log(`- NA-date rows: ${data.na_date_rows}`);
console.log('- By status:');
for (const [s, n] of Object.entries(data.by_status).sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${s}: ${n}`);
}
console.log('- By channel:');
for (const [c, n] of Object.entries(data.by_channel).sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${c}: ${n}`);
}
console.log('- By month:');
for (const m of data.by_month) {
  console.log(`  - ${m.month}: ${m.count}`);
}
console.log('');

const rows = data.rows;
if (!rows.length) {
  console.log('(no rows match the current filter)');
  process.exit(0);
}

console.log(`| channel | upload_date | video_id | status | downloaded | title | error |`);
console.log('|---|---|---|---|:---:|---|---|');
for (const r of rows) {
  const downloaded = r.download_path && fs.existsSync(r.download_path) ? '✓' : '·';
  const title = (r.title || '').slice(0, 64) + ((r.title || '').length > 64 ? '…' : '');
  const err = r.error ? tableCell(r.error).slice(0, 40) : '';
  const channel = r.channel || 'revere';
  console.log(`| ${channel} | ${r.upload_date || '—'} | ${r.video_id} | ${r.status} | ${downloaded} | ${title} | ${err} |`);
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
