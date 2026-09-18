'use strict';

// Node CLI wrapper for the Discord channel-ingestion POC. Mirrors
// `tools/runWhiteboardWorker.js`: every subcommand shells out to a Python
// helper (or to sqlite3 via a Python heredoc for the cheap register/status paths).
//
// Subcommands:
//   init              → ensure discord_sources / discord_messages /
//                       discord_pipeline_runs exist in state.sqlite.
//   add-source        → register a new source. Idempotent on duplicate name.
//   ingest            → spawn py -m tools.discord_pipeline.ingest_channel.
//   extract-tickers   → spawn extract_tickers.py to write discord_signals.csv.
//   status            → SELECT rows + last run per source.
//   list              → pretty-print every source with message counts.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'video_pipeline', 'state.sqlite');

function pythonLauncher() {
  if (process.platform === 'win32') return { command: 'py', prefix: ['-3'] };
  return { command: 'python3', prefix: [] };
}

function runPythonScript(body) {
  const p = pythonLauncher();
  return spawnSync(p.command, [...p.prefix, '-c', body], { encoding: 'utf8' });
}

function runPythonModule(module, args = []) {
  const p = pythonLauncher();
  return spawnSync(p.command, [...p.prefix, '-m', module, ...args],
    { encoding: 'utf8', stdio: 'inherit' });
}

function ensureDbExists() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run \`npm run video:init\` first.`);
    process.exit(1);
  }
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}

function commandInit() {
  const script = `
from data.discord_pipeline import bootstrap_schema
import sqlite3
conn = sqlite3.connect(r"${DB_PATH.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
bootstrap_schema(conn)
conn.close()
print('[discord] schema initialized (idempotent)')
`;
  const r = runPythonScript(script);
  if (r.status !== 0) {
    console.error(r.stderr || `python exited with code ${r.status}`);
    process.exit(r.status || 1);
  }
  process.stdout.write(r.stdout || '');
  process.stdout.write(r.stderr || '');
}

function commandAddSource(argv) {
  ensureDbExists();
  const positional = argv.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  const channelId = positional[1];
  const guildId = readFlag(argv, '--guild-id')
    || process.env.DISCORD_DEFAULT_GUILD_ID || '';
  const kind = readFlag(argv, '--kind') || 'text';
  if (!name || !channelId || !guildId) {
    console.error(
      'Usage: node tools/runDiscordIngest.js add-source <name> <channel_id> ' +
      '--guild-id <guild_id> [--kind text|thread|forum]');
    process.exit(1);
  }
  const script = `
from data.discord_pipeline import register_source
import json, sqlite3
conn = sqlite3.connect(r"${DB_PATH.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
row_id = register_source(conn, ${JSON.stringify(name)},
                         ${JSON.stringify(channelId)},
                         ${JSON.stringify(guildId)},
                         ${JSON.stringify(kind)})
conn.close()
print(json.dumps({
    'source_id': row_id,
    'name': ${JSON.stringify(name)},
    'channel_id': ${JSON.stringify(channelId)},
    'guild_id': ${JSON.stringify(guildId)},
    'channel_kind': ${JSON.stringify(kind)},
}, indent=2))
`;
  const r = runPythonScript(script);
  if (r.status !== 0) {
    console.error(r.stderr || `python exited with code ${r.status}`);
    process.exit(r.status || 1);
  }
  process.stdout.write(r.stdout || '');
}

function commandIngest(argv) {
  const source = readFlag(argv, '--source') || '';
  const limit = readFlag(argv, '--limit') || '';
  if (!source) {
    console.error('Usage: node tools/runDiscordIngest.js ingest --source <name> [--limit N]');
    process.exit(1);
  }
  const args = ['--source', source];
  if (limit) args.push('--limit', limit);
  const r = runPythonModule('tools.discord_pipeline.ingest_channel', args);
  process.exit(r.status || 0);
}

function commandExtractTickers() {
  const r = runPythonModule('tools.discord_pipeline.extract_tickers');
  process.exit(r.status || 0);
}

function commandStatus() {
  ensureDbExists();
  const script = `
import json, sqlite3
from data.discord_pipeline import bootstrap_schema
conn = sqlite3.connect(r"${DB_PATH.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
bootstrap_schema(conn)
sources = [dict(r) for r in conn.execute(
    'SELECT id, name, channel_id, guild_id, channel_kind, added_at, '
    'last_run_at, last_message_id, enabled FROM discord_sources ORDER BY id'
).fetchall()]
last_runs = {}
for src in sources:
    row = conn.execute(
        'SELECT run_tag, started_at, finished_at, fetched_count, new_count, error '
        'FROM discord_pipeline_runs WHERE source_id = ? '
        'ORDER BY id DESC LIMIT 1', (src['id'],)
    ).fetchone()
    last_runs[src['id']] = dict(row) if row else None
print(json.dumps({'sources': sources, 'last_runs': last_runs},
                 indent=2, default=str))
`;
  const r = runPythonScript(script);
  if (r.status !== 0) {
    console.error(r.stderr || `python exited with code ${r.status}`);
    process.exit(r.status || 1);
  }
  process.stdout.write(r.stdout || '');
}

function commandList() {
  ensureDbExists();
  const script = `
import sqlite3
from data.discord_pipeline import bootstrap_schema
conn = sqlite3.connect(r"${DB_PATH.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
bootstrap_schema(conn)
rows = [dict(r) for r in conn.execute(
    'SELECT s.id, s.name, s.channel_id, s.guild_id, s.channel_kind, '
    's.added_at, s.last_run_at, s.last_message_id, s.enabled, '
    '(SELECT COUNT(*) FROM discord_messages m WHERE m.source_id = s.id) AS message_count, '
    '(SELECT COUNT(*) FROM discord_messages m WHERE m.source_id = s.id AND m.has_tickers = 1) AS ticker_count '
    'FROM discord_sources s ORDER BY s.id'
).fetchall()]
conn.close()
if not rows:
    print('(no discord sources registered yet)')
else:
    headers = ('id', 'name', 'channel_id', 'message_count', 'ticker_count',
               'last_message_id', 'last_run_at', 'enabled')
    print('| ' + ' | '.join(headers) + ' |')
    print('|' + '|'.join('---' for _ in headers) + '|')
    for r in rows:
        print('| ' + ' | '.join(str(r[h] if r[h] is not None else '').replace('|', '\\\\|') for h in headers) + ' |')
`;
  const r = runPythonScript(script);
  if (r.status !== 0) {
    console.error(r.stderr || `python exited with code ${r.status}`);
    process.exit(r.status || 1);
  }
  process.stdout.write(r.stdout || '');
}

function printUsage() {
  console.error(
    'Usage:\n' +
    '  node tools/runDiscordIngest.js init\n' +
    '  node tools/runDiscordIngest.js add-source <name> <channel_id> --guild-id <id> [--kind text]\n' +
    '  node tools/runDiscordIngest.js ingest --source <name> [--limit N]\n' +
    '  node tools/runDiscordIngest.js extract-tickers\n' +
    '  node tools/runDiscordIngest.js status\n' +
    '  node tools/runDiscordIngest.js list');
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'init': return commandInit();
    case 'add-source': return commandAddSource(rest);
    case 'ingest': return commandIngest(rest);
    case 'extract-tickers': return commandExtractTickers();
    case 'status': return commandStatus();
    case 'list': return commandList();
    default:
      printUsage();
      process.exit(1);
  }
}

main();
