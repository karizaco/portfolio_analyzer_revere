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
//   ingest-jsonl      → spawn py -m tools.discord_pipeline.import_jsonl.
//   ingest-agentic    → print the agentic prompt path + JSONL schema +
//                       the exact npm command to run after the agent finishes.
//                       Does NOT spawn an agent itself.
//   ingest-browser    → spawn py -m tools.discord_pipeline.browser_ingest
//                       (headful Chromium; user logs in manually once),
//                       then chain into ingest-jsonl by default.
//                       Or, when --driver is passed, calls browser_driver
//                       directly from Node (Playwright/DOM → raw JSON on
//                       stdout → JS parses + writes JSONL).
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

/** Escape a string for embedding inside a Python triple-quoted string. */
function shellEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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

const AGENTIC_PROMPT_PATH = path.join(__dirname, 'discord_pipeline', 'agentic_prompt.md');
const JSONL_SCHEMA_SUMMARY = [
  '{',
  '  "discord_message_id": "1234567890123456789",   // required, snowflake',
  '  "author_id":          "987654321098765432",    // required',
  '  "author_name":        "trader_jane",          // required',
  '  "content":            "$TQQQ breaking out",   // required',
  '  "posted_at":          "2026-09-17T14:32:08+00:00", // required, ISO-8601',
  '  "edited_at":          null,                    // optional',
  '  "is_pinned":          false,                   // optional',
  '  "has_attachments":    false                    // optional',
  '}',
].join('\n');

function commandIngestJsonl(argv) {
  const source = readFlag(argv, '--source') || '';
  const file = readFlag(argv, '--file') || './discord_dump.jsonl';
  const limit = readFlag(argv, '--limit') || '';
  const skipExtract = argv.includes('--skip-extract');
  if (!source) {
    console.error(
      'Usage: node tools/runDiscordIngest.js ingest-jsonl --source <name> ' +
      '[--file <path>|-] [--limit N] [--skip-extract]');
    process.exit(1);
  }
  const args = ['--source', source, '--file', file];
  if (limit) args.push('--limit', limit);
  if (skipExtract) args.push('--skip-extract');
  const r = runPythonModule('tools.discord_pipeline.import_jsonl', args);
  process.exit(r.status || 0);
}

function commandIngestAgentic(argv) {
  const source = readFlag(argv, '--source') || '';
  const messages = readFlag(argv, '--messages') || '100';
  if (!source) {
    console.error(
      'Usage: node tools/runDiscordIngest.js ingest-agentic --source <name> ' +
      '[--messages N]');
    process.exit(1);
  }
  console.log('Agentic JSONL ingest — Discord channel scrape via browser agent');
  console.log('------------------------------------------------------------');
  console.log(`Source:                ${source}`);
  console.log(`Requested message cap: ${messages}`);
  console.log('');
  console.log('Agent prompt file:');
  console.log(`  ${AGENTIC_PROMPT_PATH}`);
  console.log('');
  console.log('Required JSONL schema (one JSON object per line):');
  console.log(JSONL_SCHEMA_SUMMARY);
  console.log('');
  console.log('Workflow:');
  console.log('  1. Hand the agent prompt to a computer-use agent');
  console.log('     (Claude with computer use, Grok bot, OpenClaw, ...).');
  console.log('  2. The agent browses Discord in a real browser and writes a');
  console.log('     JSONL file at a path it chooses.');
  console.log('  3. The agent prints the absolute path of that JSONL file.');
  console.log('  4. You then run the command below to ingest it.');
  console.log('');
  console.log('Ingest command (run AFTER the agent finishes):');
  console.log(`  npm run discord:ingest:jsonl -- --source ${source} --file <absolute_path_to_jsonl>`);
  console.log('');
  console.log('Optional flags you can append to the ingest command:');
  console.log('  --limit N          import at most N new rows');
  console.log('  --skip-extract     do not auto-run extract_tickers afterwards');
  console.log('');
  console.log('Note: this subcommand does NOT spawn an agent itself.');
  console.log('      It only prints what the agent needs + how to import the JSONL.');
}

/**
 * Call browser_driver directly from Node:
 *   1. Spawn python -m tools.discord_pipeline.browser_driver (captures raw JSON on stdout)
 *   2. Parse each raw DOM dict through message_parser.parse_message_element()
 *   3. Write one JSON object per line to `outPath`
 *   4. Persist the browser session to `sessionPath`
 *
 * Returns the number of messages written on success; throws on error.
 */
function scrapeWithBrowser({ url, sessionPath, messages, loginTimeout, outPath }) {
  const p = pythonLauncher();
  const pyArgs = [
    ...p.prefix,
    '-m', 'tools.discord_pipeline.browser_driver',
    '--url', url,
    '--messages', String(messages),
    '--login-timeout-seconds', String(loginTimeout),
  ];
  if (sessionPath) {
    pyArgs.push('--session', sessionPath);
  }

  console.log(`[discord-browser] launching: ${p.command} ${pyArgs.join(' ')}`);
  const result = spawnSync(p.command, pyArgs, {
    encoding: 'utf8',
    timeout: 0,           // no Node-side timeout; Python login_timeout controls it
  });

  if (result.status !== 0) {
    throw new Error(
      `browser_driver exited with code ${result.status}\n${result.stderr || ''}`
    );
  }

  // Parse raw DOM message dicts from stdout
  let rawMessages;
  try {
    rawMessages = JSON.parse(result.stdout || '[]');
  } catch (_) {
    throw new Error(`browser_driver returned invalid JSON:\n${result.stdout}`);
  }

  if (!Array.isArray(rawMessages)) {
    throw new Error(`browser_driver returned ${typeof rawMessages}, expected array`);
  }

  // Pipe each raw dict through message_parser.parse_message_element() via a
  // Python heredoc, then write the normalised records to outPath as JSONL.
  const escapedRaw = shellEscape(JSON.stringify(rawMessages));
  const escapedOut = shellEscape(outPath);
  const script = `
import json, sys
from tools.discord_pipeline.message_parser import parse_message_element

raw_messages = json.loads(${JSON.stringify(rawMessages.length > 10000
    ? rawMessages.slice(0, 10000).map(m => m).join('')   // truncate for shell
    : JSON.stringify(rawMessages))})
out_path = ${JSON.stringify(outPath)}
parsed = []
for raw in raw_messages:
    try:
        # parse_message_element expects an HTML fragment; we stored it as _html
        parsed_msg = parse_message_element(raw.get("_html", ""))
        if parsed_msg and parsed_msg.get("discord_message_id"):
            parsed.append(parsed_msg)
    except Exception as exc:
        print(f"[browser-ingest] parse failed: {exc}", file=sys.stderr)
        continue

${JSON.stringify(outPath)}.parent.mkdir(parents=True, exist_ok=True)
with ${JSON.stringify(outPath)}.open("w", encoding="utf-8", newline="\\n") as fh:
    for m in parsed:
        fh.write(json.dumps(m, ensure_ascii=False) + "\\n")
print(f"[discord-browser] wrote {len(parsed)} records to ${outPath}")
`;

  // Use the compact inline approach: write the parsed messages directly from Node
  // rather than spawning a second Python process for the JSONL step.
  const parsed = [];
  for (const raw of rawMessages) {
    try {
      // parse_message_element needs the HTML; we stored it as raw._html
      const html = raw._html || '';
      const parsedMsg = _parseMessageElement(html);
      if (parsedMsg && parsedMsg.discord_message_id) {
        parsed.push(parsedMsg);
      }
    } catch (_) {
      // skip unparseable elements
    }
  }

  // Write JSONL
  const lines = parsed.map(m => JSON.stringify(m, ensure_ascii=False)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines, 'utf8');
  console.log(`[discord-browser] wrote ${parsed.length} records to ${outPath}`);

  return parsed.length;
}

/** Minimal HTML → message dict paser mirroring message_parser.parse_message_element.
 *  We keep a tiny inline implementation so Node does not need a Python round-trip
 *  for every message; the real normalisation lives in Python's message_parser.
 */
function _parseMessageElement(html) {
  if (!html) return null;
  const idM = html.match(/id="(?:message-id-|message-)([0-9]{17,20})"/);
  if (!idM) return null;
  const snowflake = idM[1];
  const authorIdM = html.match(/data-author-id="([0-9]{17,20})"/);
  const authorId = authorIdM ? authorIdM[1] : '0';
  const authorNameM = html.match(/<span[^>]*class="[^"]*username[^"]*"[^>]*>([^<]+)<\/span>/);
  const authorName = authorNameM ? authorNameM[1].trim() : 'Unknown';
  const tsM = html.match(/<time[^>]*datetime="([^"]+)"/);
  const postedAt = tsM ? tsM[1] : '';
  const editedM = html.match(/<time[^>]*datetime="([^"]+)"[^>]*>.*?class="[^"]*\bedited\b/);
  const editedAt = editedM ? editedM[1] : '';
  const contentM = html.match(/<div[^>]*id="message-content-[^"]*"[^>]*>(.*?)<\/div>\s*</);
  let content = contentM ? contentM[1].replace(/<[^>]+>/g, ' ').trim() : '';
  content = content.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                   .replace(/\s+/g, ' ').trim();
  const isPinned = html.includes('pinnedMessage');
  const hasAttachments = html.includes('attachment') || html.includes('embed') ||
                         html.includes('imageContent');
  const replyM = html.match(/<div[^>]*class="[^"]*repliedMessageContent[^"]*"[^>]*>(.*?)<\/div>/);
  let replyText = '';
  let replyTo = '';
  if (replyM) {
    replyText = replyM[1].replace(/<[^>]+>/g, ' ').trim();
    const replyIdM = replyM[1].match(/([0-9]{17,20})/);
    replyTo = replyIdM ? replyIdM[1] : '';
    content = `@replying to ${authorName}: ${replyText} -- ${content}`;
  }
  // ISO-8601 normalisation (inline cheap version)
  function toISO(s) {
    if (!s) return '';
    s = s.endsWith('Z') ? s.slice(0, -1) + '+00:00' : s;
    try { return new Date(s).toISOString().replace('.000', ''); } catch (_) { return s; }
  }
  return {
    discord_message_id: snowflake,
    author_id: authorId,
    author_name: authorName,
    content: content || '[embed-only]',
    posted_at: toISO(postedAt),
    edited_at: editedAt ? toISO(editedAt) : null,
    is_pinned: isPinned,
    has_attachments: hasAttachments,
    snowflake,
    author_name_enriched: authorName,
    content_text: content || '[embed-only]',
    timestamp_iso: toISO(postedAt),
    edited: toISO(editedAt),
    reply_to_snowflake: replyTo,
  };
}

function commandIngestBrowser(argv) {
  const source = readFlag(argv, '--source') || '';
  const url = readFlag(argv, '--url') || '';
  const messages = parseInt(readFlag(argv, '--messages') || '200', 10);
  const out = readFlag(argv, '--out') || '';
  const session = readFlag(argv, '--session') || '';
  const loginTimeout = parseInt(readFlag(argv, '--login-timeout-seconds') || '120', 10);
  const skipImport = argv.includes('--skip-import');
  const useDriver = argv.includes('--driver');

  if (!source || !url) {
    console.error(
      'Usage: node tools/runDiscordIngest.js ingest-browser --source <name> ' +
      '--url <discord_channel_url> [--messages N] [--out <path>] ' +
      '[--session <path>] [--login-timeout-seconds N] [--skip-import] [--driver]\n' +
      '  --driver   use browser_driver (Node-side orchestration) instead of\n' +
      '             the browser_ingest Python shim');
    process.exit(1);
  }

  const outPath = path.resolve(out || 'discord_dump.jsonl');

  if (useDriver) {
    // Node-side orchestration: call browser_driver, parse, write JSONL
    const sessionPath = session || path.join(
      REPO_ROOT, 'data', 'discord_pipeline', '.cache',
      `browser_session_${source.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`
    );
    console.log('Browser ingest (driver mode) — opening headful Chromium; '
                + 'log in manually if prompted.');
    let written;
    try {
      written = scrapeWithBrowser({
        url, sessionPath, messages, loginTimeout, outPath,
      });
    } catch (exc) {
      console.error(`[discord-browser] ${exc.message}`);
      process.exit(1);
    }
    if (skipImport) {
      console.log('[discord-browser] --skip-import set; leaving JSONL on disk.');
      process.exit(0);
    }
    console.log('[discord-browser] chaining into import_jsonl …');
    const importer = runPythonModule('tools.discord_pipeline.import_jsonl',
      ['--source', source, '--file', outPath]);
    process.exit(importer.status || 0);
  }

  // Legacy path: delegate entirely to the Python browser_ingest shim
  const args = ['--source', source, '--url', url];
  if (messages) args.push('--messages', String(messages));
  if (out) args.push('--out', out);
  if (session) args.push('--session', session);
  if (loginTimeout) args.push('--login-timeout-seconds', String(loginTimeout));
  console.log('Browser ingest — opening headful Chromium; log in manually if prompted.');
  const scrape = runPythonModule('tools.discord_pipeline.browser_ingest', args);
  if (scrape.status !== 0) {
    process.exit(scrape.status || 1);
  }
  if (skipImport) {
    console.log('[discord-browser] --skip-import set; leaving JSONL on disk.');
    process.exit(0);
  }
  // Chain into import_jsonl with the JSONL the scraper just wrote.
  const jsonlPath = out || './discord_dump.jsonl';
  console.log('[discord-browser] chaining into import_jsonl …');
  const importer = runPythonModule('tools.discord_pipeline.import_jsonl',
    ['--source', source, '--file', jsonlPath]);
  process.exit(importer.status || 0);
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
    '  node tools/runDiscordIngest.js ingest-jsonl --source <name> [--file <path>|-] [--limit N] [--skip-extract]\n' +
    '  node tools/runDiscordIngest.js ingest-agentic --source <name> [--messages N]\n' +
    '  node tools/runDiscordIngest.js ingest-browser --source <name> --url <url> [--messages N] [--skip-import]\n' +
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
    case 'ingest-jsonl': return commandIngestJsonl(rest);
    case 'ingest-agentic': return commandIngestAgentic(rest);
    case 'ingest-browser': return commandIngestBrowser(rest);
    case 'extract-tickers': return commandExtractTickers();
    case 'status': return commandStatus();
    case 'list': return commandList();
    default:
      printUsage();
      process.exit(1);
  }
}

main();
