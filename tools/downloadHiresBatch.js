'use strict';

// Resumable high-resolution downloader for Revere YouTube videos.
//
// The default `npm run video:download` is capped at 360p by YouTube's
// `android,web_safari,web` client combo. This script switches to the
// `mediaconnect` client which exposes the full DASH format ladder:
//   137 = 1080p, 136 = 720p (default), 135 = 480p, 134 = 360p.
//
// It writes mp4s into a separate folder (`downloads_hires/`) and updates the
// SQLite row's `download_path` to point at the new file so the existing OCR
// pipeline picks them up automatically.
//
// Resumability:
//   1. SQLite `status='done'` rows are skipped.
//   2. Already-on-disk hires mp4s are skipped (also flipped to `status='done'`).
//   3. A checkpoint file (`_download_checkpoint.json`) remembers which ids
//      have succeeded and which have errored. Re-running the script mid-batch
//      picks up exactly where it left off, even after a hard kill.
//
// Usage:
//   node tools/downloadHiresBatch.js                  # 30 most-recent at 720p
//   node tools/downloadHiresBatch.js --limit 10
//   node tools/downloadHiresBatch.js --height 1080    # 1080p instead of 720p
//   node tools/downloadHiresBatch.js --limit 30 --height 1080

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const limit = Number(readFlag(argv, '--limit')) || 30;
const height = Number(readFlag(argv, '--height')) || 720;
const retryErrored = argv.includes('--retry-errored');
// Optional explicit allow-list of video_ids (used by the parallel download
// wrapper to fan out N workers across disjoint slices of the catalog).
// When set, the candidate query filters to this list (case-insensitive).
const onlyIds = new Set(
  argv.filter((a, i) => argv[i - 1] === '--only-id' || a.startsWith('--only-id='))
    .flatMap((a) => {
      if (a.startsWith('--only-id=')) return [a.slice('--only-id='.length)];
      return [];
    })
    .concat(
      // Also support `--only-ids id1,id2,id3` (comma-separated) for one-shot use.
      (readFlag(argv, '--only-ids') || '').split(',').filter(Boolean)
    )
    .map((s) => s.trim().toLowerCase())
);

if (![360, 480, 720, 1080].includes(height)) {
  console.error(`Unsupported --height ${height}; expected one of 360, 480, 720, 1080.`);
  process.exit(1);
}
const formatCode = String({ 360: 134, 480: 135, 720: 136, 1080: 137 }[height]);

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
const dlDir = path.resolve('data/video_pipeline/downloads_hires');
const checkpointPath = path.join(dlDir, '_download_checkpoint.json');

if (!fs.existsSync(dbPath)) {
  console.error(`No SQLite at ${dbPath}. Run 'npm run video:init' first.`);
  process.exit(1);
}
fs.mkdirSync(dlDir, { recursive: true });

const checkpoint = (() => {
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); }
  catch { return { height, done: [], errored: {} }; }
})();
if (Number(checkpoint.height) !== height) checkpoint.height = height;
checkpoint.done = Array.isArray(checkpoint.done) ? checkpoint.done : [];
checkpoint.errored = (typeof checkpoint.errored === 'object' && checkpoint.errored) || {};

console.log(`[hires] height=${height}p format=${formatCode} limit=${limit} retry-errored=${retryErrored}`);
console.log(`[hires] checkpoint: ${checkpoint.done.length} done, ${Object.keys(checkpoint.errored).length} errored`);

const py = process.platform === 'win32' ? 'py' : 'python3';
const pathCondition = onlyIds.size
    ? "(download_path IS NOT NULL OR download_path = '')"
    : "download_path IS NOT NULL";
const script = `
import json, sqlite3, sys
c = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute(
    "SELECT video_id, upload_date, title, download_path FROM videos "
    "WHERE status IN ('pending','scanning','error') AND ${pathCondition} "
    "AND upload_date IS NOT NULL AND upload_date != 'NA' "
    "ORDER BY upload_date DESC, video_id ASC"
).fetchall()
out = [dict(r) for r in rows]
json.dump(out, sys.stdout)
`;
const qRes = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (qRes.status !== 0) { console.error(qRes.stderr); process.exit(1); }
const allRows = JSON.parse(qRes.stdout);
console.log(`[hires] ${allRows.length} candidate rows in SQLite${onlyIds.size ? ` (after --only-ids filter: ${onlyIds.size} requested)` : ''}`);

if (onlyIds.size) {
  const filtered = allRows.filter((r) => onlyIds.has(String(r.video_id || '').toLowerCase()));
  const missing = [...onlyIds].filter((id) => !allRows.some((r) => String(r.video_id || '').toLowerCase() === id));
  if (missing.length) console.warn(`[hires] WARN: ${missing.length} requested id(s) not in catalog: ${missing.slice(0, 5).join(',')}${missing.length > 5 ? ', ...' : ''}`);
  allRows.length = 0;
  allRows.push(...filtered);
  console.log(`[hires] after explicit allow-list: ${allRows.length} rows`);
}

const todo = [];
let skippedDone = 0;
let skippedDisk = 0;
let skippedCheckpoint = 0;
let skippedErrored = 0;
for (const row of allRows) {
  const { video_id: videoId, upload_date: uploadDate } = row;
  if (checkpoint.done.includes(videoId)) { skippedCheckpoint += 1; continue; }
  if (!retryErrored && checkpoint.errored[videoId]) { skippedErrored += 1; continue; }
  const expected = path.join(dlDir, `${uploadDate}_${videoId}.mp4`);
  if (fs.existsSync(expected) && fs.statSync(expected).size > 1024 * 1024) {
    skippedDisk += 1;
    finalizeRow(videoId, expected);
    checkpoint.done.push(videoId);
    continue;
  }
  todo.push(row);
  if (limit > 0 && todo.length >= limit) break;
}
console.log(`[hires] skipped: done=${skippedDone} disk=${skippedDisk} checkpoint=${skippedCheckpoint} errored=${skippedErrored}`);
console.log(`[hires] to download: ${todo.length}`);

if (!todo.length) {
  console.log('[hires] nothing to do; exiting cleanly.');
  saveCheckpoint();
  process.exit(0);
}

let downloaded = 0;
let errored = 0;
const startedAt = Date.now();

for (const row of todo) {
  const { video_id: videoId, upload_date: uploadDate, title } = row;
  const outTemplate = path.join(dlDir, `${uploadDate}_${videoId}.%(ext)s`);
  const started = Date.now();
  console.log(`[hires ${++downloaded}/${todo.length}] ${uploadDate} ${videoId} "${(title||'').slice(0, 50)}"`);
  const r = spawnSync(py, [
    '-3', '-m', 'yt_dlp',
    '--no-playlist',
    '-f', formatCode,
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=mediaconnect',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`
  ], { encoding: 'utf8', stdio: 'inherit' });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const expected = path.join(dlDir, `${uploadDate}_${videoId}.mp4`);
  if (r.status !== 0 || !fs.existsSync(expected) || fs.statSync(expected).size < 1024 * 1024) {
    errored += 1;
    checkpoint.errored[videoId] = {
      upload_date: uploadDate,
      last_error_at: new Date().toISOString(),
      exit_code: r.status
    };
    saveCheckpoint();
    console.log(`[hires] ERROR ${videoId} exit=${r.status} elapsed=${elapsed}s`);
    continue;
  }

  const sizeMb = (fs.statSync(expected).size / 1024 / 1024).toFixed(1);
  console.log(`[hires] OK ${videoId} ${sizeMb} MB in ${elapsed}s`);
  checkpoint.done.push(videoId);
  delete checkpoint.errored[videoId];
  finalizeRow(videoId, expected);
  saveCheckpoint();
}

const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const summary = {
  height,
  format_code: formatCode,
  downloaded,
  errored,
  skipped_done: skippedDone,
  skipped_disk: skippedDisk,
  skipped_checkpoint: skippedCheckpoint,
  skipped_errored: skippedErrored,
  total_elapsed_s: Number(totalElapsed),
  ended_at: new Date().toISOString()
};
fs.writeFileSync(path.join(dlDir, '_last_run.json'), JSON.stringify(summary, null, 2));
console.log('');
console.log(`[hires] DONE downloaded=${downloaded} errored=${errored} elapsed=${totalElapsed}s`);
console.log(`[hires] to resume: re-run with the same args (the same checkpoint will be picked up)`);
console.log(`[hires] to retry the errored list: --retry-errored`);

function finalizeRow(videoId, hiresPath) {
  const update = `
import sqlite3
c = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
c.execute("UPDATE videos SET download_path=?, status='scanning', error='' WHERE video_id=?", (${JSON.stringify(hiresPath)}, ${JSON.stringify(videoId)}))
c.commit()
`;
  const u = spawnSync(py, ['-3', '-c', update], { encoding: 'utf8' });
  if (u.status !== 0) console.error(`[hires] WARN: SQLite update failed for ${videoId}: ${u.stderr}`);
}

function saveCheckpoint() {
  try {
    fs.writeFileSync(checkpointPath, JSON.stringify({
      height: checkpoint.height,
      done: [...new Set(checkpoint.done)],
      errored: checkpoint.errored
    }, null, 2));
  } catch (e) {
    console.error(`[hires] WARN: failed to save checkpoint: ${e.message}`);
  }
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
