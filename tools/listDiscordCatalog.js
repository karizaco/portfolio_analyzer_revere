'use strict';

// Mirrors `tools/listCatalog.js` for the Discord pipeline. Prints a per-source
// table with name, channel_id, message_count, last_message_id, last_run_at,
// ticker_count.
//
// Usage:
//   node tools/listDiscordCatalog.js                   # table view
//   node tools/listDiscordCatalog.js --json            # raw JSON
//   node tools/listDiscordCatalog.js --source <name>   # single source detail

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'video_pipeline', 'state.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error(
    `No SQLite state at ${DB_PATH}. Run 'npm run video:init' then 'npm run discord:init' first.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const sourceName = readFlag(argv, '--source') || null;

const py = process.platform === 'win32' ? 'py' : 'python3';
const script = `
import json, sqlite3
from data.discord_pipeline import bootstrap_schema
conn = sqlite3.connect(r"${DB_PATH.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
bootstrap_schema(conn)
filters = []
params = []
${sourceName ? `filters.append('s.name = ?'); params.append(${JSON.stringify(sourceName)})` : ''}
where = ('WHERE ' + ' AND '.join(filters)) if filters else ''
rows = [dict(r) for r in conn.execute(
    'SELECT s.id, s.name, s.channel_id, s.guild_id, s.channel_kind, '
    's.enabled, s.added_at, s.last_run_at, s.last_message_id, '
    '(SELECT COUNT(*) FROM discord_messages m WHERE m.source_id = s.id) AS message_count, '
    '(SELECT COUNT(*) FROM discord_messages m WHERE m.source_id = s.id AND m.has_tickers = 1) AS ticker_count '
    'FROM discord_sources s ' + where + ' ORDER BY s.id', params
).fetchall()]
last_runs = {}
for r in rows:
    run = conn.execute(
        'SELECT run_tag, started_at, finished_at, fetched_count, new_count, error '
        'FROM discord_pipeline_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1',
        (r['id'],)
    ).fetchone()
    last_runs[r['id']] = dict(run) if run else None
json.dump({
    'total_sources': len(rows),
    'total_messages': sum(r['message_count'] for r in rows),
    'total_tickers': sum(r['ticker_count'] for r in rows),
    'rows': rows, 'last_runs': last_runs,
}, __import__('sys').stdout, indent=2, default=str)
`;

const result = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(result.status || 1);
}

const data = JSON.parse(result.stdout);

if (wantJson) {
  process.stdout.write(result.stdout);
  process.stdout.write('\n');
  process.exit(0);
}

console.log('# Discord channel catalog');
console.log('');
console.log(`- SQLite: \`${DB_PATH}\``);
console.log(`- Total sources: ${data.total_sources}`);
console.log(`- Total messages ingested: ${data.total_messages}`);
console.log(`- Messages with at least one ticker: ${data.total_tickers}`);
console.log('');

if (!data.rows.length) {
  console.log('(no discord sources registered yet — run `npm run discord:add-source -- <name> <channel_id> --guild-id <id>` first)');
  process.exit(0);
}

const headers = [
  'id', 'name', 'channel_id', 'channel_kind', 'enabled',
  'message_count', 'ticker_count', 'last_message_id', 'last_run_at'
];
console.log(`| ${headers.join(' | ')} |`);
console.log(`|${headers.map(() => '---').join('|')}|`);
for (const r of data.rows) {
  const cells = [
    r.id, r.name, r.channel_id, r.channel_kind, r.enabled ? 'yes' : 'no',
    r.message_count, r.ticker_count,
    r.last_message_id || '—', r.last_run_at || '—',
  ];
  console.log('| ' + cells.map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|')).join(' | ') + ' |');
}

if (data.rows.length === 1) {
  const lastRun = data.last_runs[data.rows[0].id];
  if (lastRun) {
    console.log('');
    console.log('Last run:');
    console.log(`  - run_tag:        ${lastRun.run_tag}`);
    console.log(`  - started_at:     ${lastRun.started_at}`);
    console.log(`  - finished_at:    ${lastRun.finished_at || '—'}`);
    console.log(`  - fetched_count:  ${lastRun.fetched_count}`);
    console.log(`  - new_count:      ${lastRun.new_count}`);
    if (lastRun.error) console.log(`  - error:          ${lastRun.error}`);
  }
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
