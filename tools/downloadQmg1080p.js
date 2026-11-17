'use strict';

// QMG 1080p downloader for qullamaggie YouTube videos.
//
// The default `npm run video:download` is capped at 360p by YouTube's
// `android,web_safari,web` client combo. This script switches to the
// `mediaconnect` client which exposes the full DASH format ladder:
//   137 = 1080p, 136 = 1080p, 135 = 480p, 134 = 360p.
//
// It writes mp4s into a separate folder (`downloads_1080p/`) and updates the
// SQLite row's `download_path` to point at the new file so the existing OCR
// pipeline picks them up automatically.
//
// Resumability:
//   1. SQLite `status='done'` rows are skipped — a `done` row has been OCR'd,
//      so there is nothing here for a downloader to do.
//   2. Already-on-disk 1080p mp4s are skipped. The row's status is set to
//      `scanning`, NOT to `done`: `scanning` is the state that means "the
//      media is on disk, the OCR queue has not run on it yet", and it is what
//      tools/runAllOcr.js selects.
//   3. A checkpoint file (`_download_checkpoint.json`) remembers which ids
//      have succeeded and which have errored. Re-running the script mid-batch
//      picks up exactly where it left off, even after a hard kill.
//
// THE TRAP IN RULE 1
// `done` records that a pass finished. It says nothing about whether the file
// is still on disk. A row that was OCR'd and whose mp4 was later deleted is
// therefore skipped here forever: neither re-fetched nor reported as
// missing. `tools/reconcileCatalogStatus.js` is the repair; see
// src/video/videoStatus.js for what each status means.
//
// Usage:
//   node tools/downloadQmg1080p.js                 # qullamaggie 1080p
//   node tools/downloadHiresBatch.js --limit 10
//   node tools/downloadQmg1080p.js --limit 10
//   node tools/downloadHiresBatch.js --limit 30 --height 1080

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getDownloadDir, ensureDownloadDirs } = require('../src/video/mediaRoots');

const {
  CANDIDATE_SQL,
  selectDownloadCandidates,
  toPortablePath,
} = require('../src/video/downloadCandidates');
const { KNOWN_720P_ONLY_IDS } = require('../src/video/known720pOnly');
// The candidate query's status list lives in src/video/videoStatus.js, which
// is where each status's meaning is written down.

const argv = process.argv.slice(2);
const limit = Number(readFlag(argv, '--limit')) || 30;
const height = Number(readFlag(argv, '--height')) || 1080;
const retryErrored = argv.includes('--retry-errored');
// Print what WOULD be downloaded and exit. No download, no SQLite write.
const dryRun = argv.includes('--dry-run');
const defaultCookies = path.resolve('data/video_pipeline/downloads_1080p/youtubeCookies.txt');
const cookiesFile = readFlag(argv, '--cookies')
  || (fs.existsSync(defaultCookies) ? defaultCookies : null);
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

if (![720, 1080].includes(height)) {
  console.error(`Unsupported --height ${height}; qullamaggie supports 720 or 1080.`);
  process.exit(1);
}
const formatCode = String(height === 720 ? '136' : '137');

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
// Where new files land. The default is the 1080p library; a 720p pass wants
// the 720p library instead, and putting a 720p file in the 1080p library would
// make findHiresOnDisk() report it as a finished 1080p download.
const outDirArg = readFlag(argv, '--out-dir');
const dlDir = outDirArg ? path.resolve(outDirArg) : getDownloadDir('1080p');
ensureDownloadDirs();
// The checkpoint name is per-height, not fixed. A 720p pass and a 1080p pass
// share this file otherwise, and one pass's successes would silently become
// the other pass's successes -- which is how a 720p file ends up recorded as
// a completed 1080p download.
const checkpointFileArg = readFlag(argv, '--checkpoint-file');
const checkpointPath = checkpointFileArg
  ? path.resolve(checkpointFileArg)
  : path.join(dlDir, `_qmg_${height}p_checkpoint.json`);
// The repository root, derived from the database's own location
// (`<root>/data/video_pipeline/state.sqlite`). Stored paths are relative to
// it, so it is what they have to be resolved against.
const repoRoot = path.resolve(path.dirname(dbPath), '..', '..');

if (!fs.existsSync(dbPath)) {
  console.error(`No SQLite at ${dbPath}. Run 'npm run video:init' first.`);
  process.exit(1);
}
fs.mkdirSync(dlDir, { recursive: true });

// Identify the machine that produced each download. Captured once per run
// and stamped into every checkpoint entry (done[]/errored/blocked) and the
// summary JSON. When the checkpoint is copied between machines (e.g. via
// git, rsync, or shared drive), downstream code can tell which machine
// performed the download by inspecting `downloaded_by`.
const os = require('os');
const RUN_MACHINE = {
  hostname: os.hostname(),
    user: (process.env.USERNAME || process.env.USER || 'unknown'),
    platform: `${process.platform}-${process.arch}`,
    node_version: process.version,
    captured_at: new Date().toISOString(),
  };
function stampMachine(entry) {
  // Stamp with the run's machine info. Tolerate either legacy (string) or
  // new (object) checkpoint.done[] entries — legacy entries are migrated
  // to { id, downloaded_by } in place when seen.
  if (typeof entry === 'string') {
    return { id: entry, downloaded_by: RUN_MACHINE };
  }
  if (entry && typeof entry === 'object') {
    if (!entry.downloaded_by) entry.downloaded_by = RUN_MACHINE;
    return entry;
  }
  return entry;
}

const checkpoint = (() => {
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); }
  catch { return { height, done: [], errored: {}, blocked: [] }; }
})();
if (Number(checkpoint.height) !== height) checkpoint.height = height;
checkpoint.done = Array.isArray(checkpoint.done) ? checkpoint.done : [];
checkpoint.errored = (typeof checkpoint.errored === 'object' && checkpoint.errored) || {};
checkpoint.blocked = Array.isArray(checkpoint.blocked) ? checkpoint.blocked : [];

// Migrate any legacy string entries to { id, downloaded_by } form so the
// file shape stays consistent across older/newer runs of this script.
checkpoint.done = checkpoint.done.map(stampMachine);
checkpoint.blocked = checkpoint.blocked.map(stampMachine);

console.log(`[qmg1080] height=${height}p format=${formatCode} limit=${limit} retry-errored=${retryErrored}`);
console.log(`[qmg1080] media dir: ${dlDir}`);
console.log(`[qmg1080] checkpoint: ${checkpoint.done.length} done, ${Object.keys(checkpoint.errored).length} errored`);

const py = process.platform === 'win32' ? 'py' : 'python3';
const script = `
import json, sqlite3, sys
c = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute(${JSON.stringify(CANDIDATE_SQL)}).fetchall()
done_rows = c.execute("SELECT COUNT(*) FROM videos WHERE channel='qullamaggie' AND status='done'").fetchone()[0]
json.dump({"rows": [dict(r) for r in rows], "status_done": done_rows}, sys.stdout)
`;
const qRes = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (qRes.status !== 0) { console.error(qRes.stderr); process.exit(1); }
const qData = JSON.parse(qRes.stdout);
const allRows = Array.isArray(qData) ? qData : qData.rows;
const statusDoneRows = Array.isArray(qData) ? 0 : (qData.status_done || 0);
console.log(`[qmg1080] ${allRows.length} candidate rows in SQLite${onlyIds.size ? ` (after --only-ids filter: ${onlyIds.size} requested)` : ''}`);
console.log(`[qmg1080] ${statusDoneRows} row(s) excluded because the catalog says the OCR pass already ran`);

if (onlyIds.size) {
  const filtered = allRows.filter((r) => onlyIds.has(String(r.video_id || '').toLowerCase()));
  const missing = [...onlyIds].filter((id) => !allRows.some((r) => String(r.video_id || '').toLowerCase() === id));
  if (missing.length) console.warn(`[qmg1080] WARN: ${missing.length} requested id(s) not in catalog: ${missing.slice(0, 5).join(',')}${missing.length > 5 ? ', ...' : ''}`);
  allRows.length = 0;
  allRows.push(...filtered);
  console.log(`[qmg1080] after explicit allow-list: ${allRows.length} rows`);
}

// The catalog's `download_path` is a POINTER, and it goes stale: it records
// where a file was when some machine downloaded it, and nothing updates it
// when the file is later deleted. Of the 541 QMG rows that point into
// downloads_1080p, only 27 still resolve on disk — the other 514 are
// pointers to files that are gone.
//
// So "is this video already downloaded?" has to be answered by the
// FILESYSTEM, not by the string in the column. The old query answered it
// with `download_path NOT LIKE '%downloads_1080p%'`, which excluded every
// row whose pointer mentioned the target directory — including the 514
// whose file is gone. That selected 47 of 588 QMG rows and made the
// missing videos impossible to re-fetch with the tool meant to fetch them.
//
// The selection logic lives in src/video/downloadCandidates.js so it can be
// tested without running a download.
// THE ORDER IS THE FIX.
//
// The checkpoint used to be consulted BEFORE the filesystem, so any id the
// checkpoint had recorded as done was skipped without ever asking whether
// the file was still there. Measured on 2026-11-17: 181 of the checkpoint's
// 457 done ids had no file anywhere on disk, and all 181 were skipped
// forever -- never re-fetched, never reported missing.
//
// Now the FILESYSTEM answers "is it already downloaded?" and the checkpoint
// only answers "did we already try?". selectDownloadCandidates() holds that
// order, and it lives in src/video/downloadCandidates.js so it can be tested
// without running a download.
//
// The known 720p-only videos are excluded from the 1080p pass: they have no
// 1080p upload, so every run would spend a request proving that again and
// bury the real failures in noise. They are fetched by a separate 720p pass.
const excludeIds = height === 1080 ? KNOWN_720P_ONLY_IDS : [];
const selection = selectDownloadCandidates(allRows, checkpoint, {
  dir: dlDir,
  retryErrored,
  excludeIds,
});
const todo = selection.todo.slice(0, limit > 0 ? limit : undefined);

if (dryRun) {
  console.log(`[qmg1080] DRY RUN -- ${todo.length} video(s) would be downloaded:`);
  for (const row of todo.slice(0, 60)) {
    console.log(`  ${row.upload_date || '???????'} ${row.video_id} ${String(row.title || '').slice(0, 60)}`);
  }
  if (todo.length > 60) console.log(`  ... and ${todo.length - 60} more`);
  process.exit(0);
}

// A file on disk satisfies the work whatever the checkpoint says. Record the
// ids the checkpoint had not seen, so the checkpoint converges on the truth.
for (const s of selection.satisfied) {
  if (!s.alreadyInCheckpoint) checkpoint.done.push(stampMachine(s.row.video_id));
  finalizeRow(s.row.video_id, s.path);
}

console.log(`[qmg1080] skipped: disk=${selection.satisfied.length} errored=${selection.skippedErrored} blocked=${selection.skippedBlocked} excluded=${selection.skippedExcluded}`);
if (selection.stranded.length) {
  console.log(`[qmg1080] RE-DOWNLOADING ${selection.stranded.length} id(s) the checkpoint called done but whose file is gone`);
  console.log(`[qmg1080]   (the checkpoint records that a run finished, not that the file survived)`);
}
console.log(`[qmg1080] to download: ${todo.length}`);

if (!todo.length) {
  console.log('[qmg1080] nothing to do; exiting cleanly.');
  saveCheckpoint();
  process.exit(0);
}

let downloaded = 0;
let errored = 0;
const startedAt = Date.now();

for (const row of todo) {
  const { video_id: videoId, upload_date: uploadDate, title } = row;
  const outTemplate = path.join(dlDir, `${uploadDate ? uploadDate + '_' : ''}${videoId}.%(ext)s`);
  const started = Date.now();
  console.log(`[hires ${++downloaded}/${todo.length}] ${uploadDate} ${videoId} "${(title||'').slice(0, 50)}"`);
  const r = spawnSync(py, [
    '-3', '-m', 'yt_dlp',
    '--no-playlist',
    '-f', formatCode,
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visios',
    ...(cookiesFile ? ['--cookies', cookiesFile] : []),
    '--sleep-requests', '2',
    '--sleep-interval', '1',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`
  ], { encoding: 'utf8', stdio: 'inherit' });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const expected = path.join(dlDir, `${uploadDate ? uploadDate + '_' : ''}${videoId}.mp4`);
  if (r.status !== 0 || !fs.existsSync(expected) || fs.statSync(expected).size < 1024 * 1024) {
    errored += 1;
    checkpoint.errored[videoId] = {
      upload_date: uploadDate,
      last_error_at: new Date().toISOString(),
      exit_code: r.status,
      failed_on: RUN_MACHINE,
    };
    saveCheckpoint();
    console.log(`[qmg1080] ERROR ${videoId} exit=${r.status} elapsed=${elapsed}s on ${RUN_MACHINE.hostname}/${RUN_MACHINE.user}`);
    continue;
  }

  const sizeMb = (fs.statSync(expected).size / 1024 / 1024).toFixed(1);
  console.log(`[qmg1080] OK ${videoId} ${sizeMb} MB in ${elapsed}s on ${RUN_MACHINE.hostname}/${RUN_MACHINE.user}`);
  checkpoint.done.push(stampMachine(videoId));
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
  skipped_done: statusDoneRows,
  skipped_disk: selection.satisfied.length,
  skipped_errored: selection.skippedErrored,
  skipped_blocked: selection.skippedBlocked,
  skipped_excluded: selection.skippedExcluded,
  stranded_redownloaded: selection.stranded.length,
  total_elapsed_s: Number(totalElapsed),
  ended_at: new Date().toISOString()
};
fs.writeFileSync(path.join(dlDir, '_last_run.json'), JSON.stringify(summary, null, 2));
console.log('');
console.log(`[qmg1080] DONE downloaded=${downloaded} errored=${errored} elapsed=${totalElapsed}s`);
console.log(`[qmg1080] to resume: re-run with the same args (the same checkpoint will be picked up)`);
console.log(`[qmg1080] to retry the errored list: --retry-errored`);

function finalizeRow(videoId, hiresPath) {
  // The catalog is committed to git, so the pointer it holds has to mean
  // something on another machine: a path inside the repository is stored
  // relative to its root.
  const stored = toPortablePath(hiresPath, repoRoot);
  const update = `
import sqlite3
c = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
c.execute("UPDATE videos SET download_path=?, status='scanning', error='' WHERE video_id=?", (${JSON.stringify(stored)}, ${JSON.stringify(videoId)}))
c.commit()
`;
  const u = spawnSync(py, ['-3', '-c', update], { encoding: 'utf8' });
  if (u.status !== 0) console.error(`[qmg1080] WARN: SQLite update failed for ${videoId}: ${u.stderr}`);
}

function saveCheckpoint() {
  try {
    // Dedupe BY ID. The entries are objects ({ id, downloaded_by }), so
    // `new Set(done)` compares them by reference and lets duplicate ids
    // through -- the file grew a little on every run.
    const seenIds = new Set();
    const doneEntries = [];
    for (const entry of checkpoint.done) {
      const id = typeof entry === 'string' ? entry : (entry && entry.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      doneEntries.push(stampMachine(entry));
    }
    fs.writeFileSync(checkpointPath, JSON.stringify({
      height: checkpoint.height,
      done: doneEntries,
      errored: checkpoint.errored,
      blocked: checkpoint.blocked || []
    }, null, 2));
  } catch (e) {
    console.error(`[qmg1080] WARN: failed to save checkpoint: ${e.message}`);
  }
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
