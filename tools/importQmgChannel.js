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

const dbPath       = path.resolve('data/video_pipeline/state.sqlite');
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

// ── helpers ────────────────────────────────────────────────────────────────────

const py = process.platform === 'win32' ? 'py' : 'python3';

function ytdlp(args, timeout = 60) {
  const r = spawnSync(py, ['-3', '-m', 'yt_dlp', ...args], {
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

function sqliteRun(sql, params = []) {
  const script = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.execute(${JSON.stringify(sql)}, ${JSON.stringify(params)})
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
  CHANNEL_URL
], 60);

const allRows = [];
for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [id, date, ...titleParts] = trimmed.split('\t');
  if (!id) continue;
  const title = titleParts.join('\t').trim();
  allRows.push({ video_id: id.trim(), upload_date: date.trim() || '', title });
}
if (limitArg) allRows.length = Math.min(allRows.length, limitArg);
console.log(`[import] Total IDs retrieved: ${allRows.length}`);

// ── Check existing IDs ─────────────────────────────────────────────────────────

const existing = new Map(sqliteQuery(
  `SELECT video_id, upload_date, title, video_url FROM videos WHERE channel = ?`,
  [CHANNEL]
).map(r => [r.video_id, r]));

const newRows  = allRows.filter(r => !existing.has(r.video_id));
const knownRows = allRows.filter(r =>  existing.has(r.video_id));

console.log(`[import] Already in DB: ${existing.size} | New: ${newRows.length} | Known-here: ${knownRows.length}`);

if (dryRun) {
  console.log('[import] Dry-run — would insert:');
  for (const r of newRows.slice(0, 20)) {
    console.log(`  ${r.video_id}  "${r.title}"  date=${r.upload_date || '(none)'}`);
  }
  if (newRows.length > 20) console.log(`  ... and ${newRows.length - 20} more`);
  process.exit(0);
}

if (!newRows.length) {
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
          '--extractor-args', 'youtube:player_client=web_safari',
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
      '--extractor-args', 'youtube:player_client=web_safari',
      '--flat-playlist',
      '--print', '%(upload_date)s\t%(id)s',
      CHANNEL_URL
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
  const stmt = `
INSERT INTO videos
  (video_id, channel, title, upload_date, video_url, source_url, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 'cataloged', datetime('now'), datetime('now'))
`;
  let inserted = 0;
  let skipped = 0;
  for (const r of newRows) {
    const videoUrl = `https://www.youtube.com/watch?v=${r.video_id}`;
    const srcUrl  = CHANNEL_URL;
    try {
      sqliteRun(stmt, [r.video_id, CHANNEL, r.title || '', r.upload_date || '', videoUrl, srcUrl]);
      inserted++;
    } catch (e) {
      if (e.message.includes('UNIQUE constraint') || e.message.includes('are not unique')) {
        skipped++;
      } else {
        console.error(`[import] insert failed for ${r.video_id}: ${e.message}`);
      }
    }
  }
  console.log(`[import] Done. Inserted: ${inserted} | Skipped (already exists): ${skipped} | Total in DB for ${CHANNEL}: ${existing.size + inserted - skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
