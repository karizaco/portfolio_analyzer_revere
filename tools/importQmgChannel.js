'use strict';

/**
 * imports the full Qullamaggie YouTube channel:
 *
 *   Pass 1 — fast:  yt-dlp --flat-playlist  → all video IDs + titles (no upload_date)
 *   Pass 2 — slow:  yt-dlp individual metadata → upload dates (rate-limited, batches of 25)
 *
 * Each batch waits 5 s between requests to avoid triggering YouTube's per-IP throttle.
 * The tool is idempotent: existing rows in SQLite are left untouched; only new IDs
 * are inserted with whatever metadata is available at import time.
 *
 * Usage:
 *   node tools/importQmgChannel.js                 # full channel
 *   node tools/importQmgChannel.js --dry-run       # show what would be inserted
 *   node tools/importQmgChannel.js --limit 100    # first 100 for testing
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CHANNEL      = 'qullamaggie';
const CHANNEL_URL  = 'https://www.youtube.com/@Qullamaggie/videos';
const BATCH_SIZE   = 25;
const BATCH_DELAY_MS = 5000; // 5 s between batches to avoid rate-limiting

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry-run');
const limitArg = (() => {
  const i = argv.indexOf('--limit');
  return i !== -1 ? Number(argv[i + 1]) : 0;
})();
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
// WHICH channel, and WHICH listing of it. The tool was written for the
// Qullamaggie videos tab; both are now arguments.
const channel    = flag('--channel', CHANNEL);
const channelUrl = flag('--source-url', CHANNEL_URL);
// WHERE the catalog is. A scratch copy is how the tool is tested without
// touching the real one.
const dbPath     = path.resolve(flag('--db', 'data/video_pipeline/state.sqlite'));

// ── helpers ────────────────────────────────────────────────────────────────────

const py = process.platform === 'win32' ? 'py' : 'python3';

// The yt-dlp to run. A path to a SCRIPT works as well as the module, and
// that is how the tool is exercised without touching YouTube -- the same
// shape the Python worker is tested with.
const YTDLP = (() => {
  const custom = flag('--ytdlp', '');
  if (!custom) return { cmd: py, args: ['-3', '-m', 'yt_dlp'] };
  if (custom.endsWith('.py')) return { cmd: py, args: ['-3', custom] };
  return { cmd: custom, args: [] };
})();

function ytdlp(args, timeout = 60) {
  const r = spawnSync(YTDLP.cmd, [...YTDLP.args, ...args], {
    encoding: 'utf8',
    timeout: timeout * 1000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error(`yt-dlp exit ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}

function sqliteQuery(sql, params = []) {
  const script = `
import json, sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
rows = conn.execute(${JSON.stringify(sql)}, ${JSON.stringify(params)}).fetchall()
print(json.dumps([dict(r) for r in rows], default=str))
`.trim();
  const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite error');
  return JSON.parse(r.stdout.trim() || '[]');
}

/**
 * Run one statement over MANY rows, in ONE process.
 *
 * The insert used to spawn a Python process PER ROW -- 539 of them for a
 * full channel -- which is 539 interpreter starts to write 539 rows.
 */
function sqliteRunBatch(sql, rows) {
  if (!rows.length) return 0;
  const script = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.executemany(${JSON.stringify(sql)}, ${JSON.stringify(rows)})
conn.commit()
print(conn.total_changes)
`.trim();
  const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite error');
  return Number(String(r.stdout || '0').trim()) || 0;
}

/**
 * Write ONE row into catalog_runs, and return its id.
 *
 * Every source writes a catalog_runs row, and a reader of that table
 * expects to see every source's runs. This tool wrote NONE -- it was the
 * documented open defect: "a second writer of `videos` with no audit row
 * at all".
 */
function recordCatalogRun(row) {
  const script = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
cur = conn.execute(
  "INSERT INTO catalog_runs (source_url, channel, command_json, raw_output_path, row_count,"
  " inserted_count, updated_count, missing_upload_dates, malformed_rows, created_at, kind,"
  " not_listed_count, listing_complete, row_count_kind)"
  " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'live', 0, ?, 'listing_rows')",
  (${JSON.stringify(row.source_url)}, ${JSON.stringify(row.channel)}, ${JSON.stringify(row.command_json)},
   ${JSON.stringify(row.raw_output_path)}, ${row.row_count}, ${row.inserted_count}, ${row.updated_count},
   ${row.missing_upload_dates}, ${row.malformed_rows}, ${row.listing_complete})
)
conn.commit()
print(cur.lastrowid)
`.trim();
  const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite error');
  return Number(String(r.stdout || '0').trim()) || 0;
}

/**
 * Update a catalog_runs row's counters.
 *
 * The row is written when the run STARTS and its counters are filled in
 * as it goes, so an interrupted run still leaves a row that says what it
 * DID rather than what it was asked to do. (The `fill-dates` lesson: a run
 * whose audit row was written at the END lost 1,582 rows' worth of
 * provenance.)
 */
function updateCatalogRun(runId, patch) {
  const script = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.execute(
  "UPDATE catalog_runs SET inserted_count = ?, updated_count = ?, missing_upload_dates = ?,"
  " malformed_rows = ? WHERE run_id = ?",
  (${patch.inserted_count}, ${patch.updated_count}, ${patch.missing_upload_dates},
   ${patch.malformed_rows}, ${runId})
)
conn.commit()
print('ok')
`.trim();
  const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'sqlite error');
  return true;
}

// ── Pass 1: get all IDs + titles via flat-playlist (fast) ────────────────────

console.log('[import] Pass 1: fetching all video IDs via --flat-playlist ...');
const raw = ytdlp([
  '--skip-download', '--ignore-errors', '--flat-playlist',
  '--print', '%(id)s\t%(upload_date)s\t%(title)s',
  channelUrl
], 60);

const allRows = [];
let malformed = 0;
for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [id, date, ...titleParts] = trimmed.split('\t');
  if (!id) { malformed += 1; continue; }
  const title = titleParts.join('\t').trim();
  allRows.push({ video_id: id.trim(), upload_date: date.trim() || '', title });
}
if (limitArg) allRows.length = Math.min(allRows.length, limitArg);
console.log(`[import] Total IDs retrieved: ${allRows.length}`);

// ── Check existing IDs ─────────────────────────────────────────────────────────

const existing = new Map(sqliteQuery(
  `SELECT video_id, upload_date, title, video_url FROM videos WHERE channel = ?`,
  [channel]
).map(r => [r.video_id, r]));

// A video id is the table's PRIMARY KEY, so a row that is already in the
// catalog under ANOTHER channel is not new either -- and the insert would
// fail on it. Those are counted apart instead.
const allIds = new Set(sqliteQuery('SELECT video_id FROM videos').map(r => r.video_id));

const newRows    = allRows.filter(r => !allIds.has(r.video_id));
const knownRows  = allRows.filter(r =>  existing.has(r.video_id));
const elsewhere  = allRows.filter(r => !existing.has(r.video_id) && allIds.has(r.video_id));

console.log(`[import] Already in DB: ${existing.size} | New: ${newRows.length} | Known-here: ${knownRows.length}`
  + `${elsewhere.length ? ` | Known under another channel: ${elsewhere.length}` : ''}`);

if (dryRun) {
  console.log('[import] Dry-run — would insert:');
  for (const r of newRows.slice(0, 20)) {
    console.log(`  ${r.video_id}  "${r.title}"  date=${r.upload_date || '(none)'}`);
  }
  if (newRows.length > 20) console.log(`  ... and ${newRows.length - 20} more`);
  console.log('[import] Dry-run writes nothing — no rows and no audit row.');
  process.exit(0);
}

// THE AUDIT ROW GOES IN NOW, BEFORE THE NETWORK WORK AND BEFORE THE ROWS.
//
// This tool wrote no catalog_runs row at all, so a reader of that table
// could not see a run of it -- and an interrupted run left nothing
// behind either. The row is written at the START and its counters are
// filled in as the run goes, so it reports what the run DID, not what it
// was asked to do.
const runId = recordCatalogRun({
  source_url: channelUrl,
  channel,
  command_json: JSON.stringify(process.argv.slice(1)),
  raw_output_path: '',
  row_count: allRows.length,
  inserted_count: 0,
  updated_count: 0,
  missing_upload_dates: 0,
  malformed_rows: malformed,
  // A --limit listing did not cover the channel, so "not listed" proves
  // nothing about the rows it is missing.
  listing_complete: limitArg ? 0 : 1,
});
console.log(`[import] catalog_runs row ${runId} (written at the start, so an interrupted run still leaves a row)`);

if (!newRows.length) {
  updateCatalogRun(runId, { inserted_count: 0, updated_count: 0, missing_upload_dates: 0, malformed_rows: malformed });
  console.log('[import] Nothing new to insert. Exiting.');
  process.exit(0);
}

// ── Pass 2: fetch upload_dates for new IDs in batches ─────────────────────────

async function fetchDatesInBatches(rows) {
  let dateResolved = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    // Resolve upload_date for EACH row in the batch — a single yt-dlp call with
    // one URL only returns metadata for that URL, so the previous
    // `watch?v=${batch[0].video_id}` call silently dropped dates for batch[1..N].
    for (const row of batch) {
      let metaText = '';
      try {
        metaText = ytdlp([
          '--skip-download', '--no-warnings',
          // `mweb` is the catalog's measured fast metadata path (4.2 s a
          // video, against 8.5 s for the full client list, and it WORKS).
          // The tool used to ask for `web_safari`, which this project's
          // own rules call out as bot-blocked: it returns nothing, so
          // every date fetch failed.
          '--extractor-args', 'youtube:player_client=mweb',
          '--print', '%(id)s\t%(upload_date)s',
          `https://www.youtube.com/watch?v=${row.video_id}`,
        ], 30);
      } catch (e) {
        console.warn(`[import] ${row.video_id}: failed: ${e.message.slice(0, 100)}`);
        continue;
      }
      for (const line of metaText.split('\n')) {
        const parts = line.trim().split('\t');
        if (!parts[0]) continue;
        if (parts[0] === row.video_id && parts[1] && parts[1] !== 'NA') {
          row.upload_date = parts[1].trim();
          dateResolved += 1;
          break;
        }
      }
    }
    const done = Math.min(i + BATCH_SIZE, rows.length);
    console.log(`[import] batch ${i+1}–${done}/${rows.length}: ${dateResolved} dates resolved`);
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS);
  }
  return dateResolved;
}

// ── Insert new rows ───────────────────────────────────────────────────────────

async function main() {
  await fetchDatesInBatches(newRows);

  // Also try to get dates from the flat-playlist output for available videos
  // by re-running with the extractor args
  console.log('[import] Attempting to resolve dates from channel page ...');
  let channelPageText = '';
  try {
    channelPageText = ytdlp([
      '--skip-download', '--ignore-errors',
      // `mweb`, not `web_safari` -- the same reason as the per-video pass.
      '--extractor-args', 'youtube:player_client=mweb',
      '--flat-playlist',
      '--print', '%(upload_date)s\t%(id)s',
      channelUrl
    ], 30);
    let resolved = 0;
    for (const line of channelPageText.split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length < 2) continue;
      const [date, ...idParts] = parts;
      const vid = idParts.join('\t').trim();
      const row = newRows.find(r => r.video_id === vid);
      if (row && date && date !== 'NA' && !row.upload_date) {
        row.upload_date = date;
        resolved++;
      }
    }
    console.log(`[import] Channel-page dates resolved: ${resolved}`);
  } catch (e) {
    console.warn('[import] Channel-page date fetch failed:', e.message.slice(0, 200));
  }

  console.log('[import] Inserting new rows ...');
  // Use only columns that exist in the schema:
  // video_id, source_url, video_url, title, upload_date, channel
  //
  // The status is 'pending' -- the catalog's own vocabulary: the row
  // exists and the media has not been fetched (src/video/videoStatus.js).
  // The tool used to write 'cataloged', which the schema's CHECK
  // constraint REJECTS, so the insert failed for every row and the tool
  // inserted nothing.
  //
  // The rows go in as ONE batch, in ONE process. The insert used to
  // spawn a Python process PER ROW -- 539 interpreter starts to write 539
  // rows -- and a row that already existed aborted its own process with
  // a UNIQUE-constraint error, which was then counted as "skipped".
  const stmt = `
INSERT INTO videos
  (video_id, channel, title, upload_date, video_url, source_url, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
`;
  const before = sqliteQuery(`SELECT COUNT(*) AS n FROM videos WHERE channel = ?`, [channel])[0].n;
  const params = newRows.map((r) => [
    r.video_id, channel, r.title || '', r.upload_date || '',
    `https://www.youtube.com/watch?v=${r.video_id}`, channelUrl,
  ]);
  sqliteRunBatch(stmt, params);
  const after = sqliteQuery(`SELECT COUNT(*) AS n FROM videos WHERE channel = ?`, [channel])[0].n;
  const inserted = after - before;
  // A row that is already in the catalog under ANOTHER channel is not
  // new, and the primary key says so. It is counted apart rather than
  // lost in an error.
  const skipped = newRows.length - inserted + elsewhere.length;

  // How many of the rows still have no date. The tool's own job is the
  // date, so the number of rows it could not date is what the audit row
  // has to say.
  const stillUndated = sqliteQuery(
    `SELECT COUNT(*) AS n FROM videos WHERE channel = ? AND (upload_date IS NULL OR upload_date = '')`,
    [channel],
  )[0].n;

  updateCatalogRun(runId, {
    inserted_count: inserted,
    updated_count: 0,
    missing_upload_dates: stillUndated,
    malformed_rows: malformed,
  });

  console.log(`[import] Done. Inserted: ${inserted} | Skipped (already exists): ${skipped} | Total in DB for ${channel}: ${after}`);
  console.log(`[import] catalog_runs row ${runId}: ${inserted} inserted, ${stillUndated} row(s) still without a date`);
}

main().catch(e => { console.error(e); process.exit(1); });
