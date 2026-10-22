'use strict';

/**
 * Unattended re-download driver for the qullamaggie videos destroyed by the
 * 2026-10-21 sparse-checkout prune.
 *
 * It loops over batches of lost videos and, for each batch:
 *   1. resets the stale SQLite rows (`tools/resetLostVideoRows.py`),
 *   2. downloads them with `tools/downloadQmg1080p.js` into the OUT-OF-TREE
 *      media directory,
 *   3. verifies each landed file's real resolution with ffprobe.
 *
 * Everything it writes lands outside the git working tree. Nothing here can
 * delete anything: the only destructive verb is the downloader's own
 * `-o` template, which yt-dlp overwrites in place.
 *
 * Usage:
 *   node tools/redownloadLostQmg.js --batch 30
 *   node tools/redownloadLostQmg.js --batch 30 --max-batches 5
 *   node tools/redownloadLostQmg.js --dry-run          # show the plan only
 *
 * Flags:
 *   --batch N        videos per batch (default 30)
 *   --max-batches N  stop after N batches (default 0 = run until done)
 *   --min-free-gb N  stop before a batch if C: has less than N GB free (default 40)
 *   --cookies PATH   Netscape cookie file (default data/youtube_cookies.txt)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const batchSize = Number(readFlag(argv, '--batch')) || 30;
const maxBatches = Number(readFlag(argv, '--max-batches')) || 0;
const minFreeGb = Number(readFlag(argv, '--min-free-gb')) || 40;
const dryRun = argv.includes('--dry-run');
const cookiesFile = readFlag(argv, '--cookies') || 'data/youtube_cookies.txt';

const PROJECT = path.resolve(__dirname, '..');
const MEDIA_ROOT = readFlag(argv, '--media-root')
  || 'C:/Users/Admin/Projects/portfolio_analyzer_revere_media';
const DL_1080 = path.join(MEDIA_ROOT, 'downloads_1080p');
const DL_720 = path.join(MEDIA_ROOT, 'downloads_720p');
const DB = path.join(PROJECT, 'data', 'video_pipeline', 'state.sqlite');
const PY = process.platform === 'win32' ? 'py' : 'python3';

// The hardcoded 39 IDs that genuinely have no 1080p upload. These are fetched
// at 720p (format 136) into their own directory instead.
const KNOWN_720P_ONLY = new Set(
  ('0Ew3DImAZlw,1QtMVbPrKUw,1X0J9XbF7I4,3328puCDrks,3w5BmkbsJpo,' +
   '4UWLcS4-lbI,6XgAT5LW9Ks,8uyENUhiW1c,AAs9-ZO33eA,A_0Sj3Hi9Jw,' +
   'Ab6bXsSfweo,Ax5a_ouJMKU,B1TCCDizExQ,BqGwSzbGS10,D4pnSkaFVb8,' +
   'FN20YOH_XRM,FcXJZ3Y98YU,MFew0xR3iv0,MSVE_HaH0qo,NDCSRLjr1-g,' +
   'Nlc2r-uz6Gg,O333thFuU40,PvL5_kwE0fI,R7nACKgTydc,SZ0QELUoCJ4,' +
   'SrIGW4fvzFE,UG1vfP9hCH0,UmAdr1cM3RY,V5ETDZgbnOs,gqzntxo4DdI,' +
   'jtyYLDlgdbE,l2olCkDuHGo,n8SWEpUNylE,o3IoaGLCxz4,oRX7YeTLdRg,' +
   'pomzmadhQV0,sUU3mXKLgok,ttKgeB-cZbY,u84s3-ehrw4').split(',')
);

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}

/** Free space on the volume holding `dir`, in GB. */
function freeGb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch (_) {
    return Infinity;
  }
}

/** Every qullamaggie row, with its download_path. */
function catalog() {
  const script = `
import sqlite3, json, sys
c = sqlite3.connect(r"${DB.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute(
    "SELECT video_id, upload_date, title, download_path FROM videos "
    "WHERE channel='qullamaggie' ORDER BY upload_date DESC, video_id ASC"
).fetchall()
json.dump([dict(r) for r in rows], sys.stdout)
`;
  const r = spawnSync(PY, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const mediaRootNorm = norm(MEDIA_ROOT);

/**
 * A row is "lost" if it still points at a destroyed in-tree media path, or at
 * nothing at all, and it is not already downloaded out-of-tree.
 */
function partition(rows) {
  const done = new Set();
  for (const r of rows) {
    if (norm(r.download_path).startsWith(mediaRootNorm)) done.add(r.video_id);
  }
  const lost = rows.filter(
    (r) => !done.has(r.video_id) &&
      norm(r.download_path).includes('downloads_1080p')
  );
  return { done, lost };
}

/** Reset the stale rows so the downloader will consider them. */
function resetRows(ids) {
  const r = spawnSync(PY, ['-3', path.join(PROJECT, 'tools', 'resetLostVideoRows.py'),
    '--ids', ids.join(',')], { cwd: PROJECT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[redownload] reset failed: ' + (r.stderr || r.stdout));
    process.exit(1);
  }
}

/** Download a batch. Returns the ids that landed on disk. */
function download(ids, dlDir, height) {
  const args = [
    path.join(PROJECT, 'tools', 'downloadQmg1080p.js'),
    '--limit', String(ids.length),
    '--height', String(height),
    '--only-ids', ids.join(','),
    '--dl-dir', dlDir,
  ];
  if (fs.existsSync(path.join(PROJECT, cookiesFile))) {
    args.push('--cookies', cookiesFile);
  }
  const r = spawnSync('node', args, { cwd: PROJECT, encoding: 'utf8', stdio: 'inherit' });
  return r.status === 0;
}

/** The real resolution of a file, via ffprobe. Never infer from filesize. */
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function verify(dir, ids, wantW, wantH) {
  const results = [];
  for (const id of ids) {
    const prefix = dir.split('/').pop();
    // The downloader names files <upload_date>_<id>.mp4 when a date is known.
    const found = fs.readdirSync(dir).filter((f) => f.endsWith(`_${id}.mp4`) || f === `${id}.mp4`);
    if (!found.length) { results.push({ id, ok: false, why: 'no file' }); continue; }
    const file = path.join(dir, found[0]);
    const dims = probe(file);
    const ok = dims === `${wantW},${wantH}`;
    results.push({ id, ok, dims, file: path.basename(file) });
  }
  return results;
}

// ---------------------------------------------------------------------------

fs.mkdirSync(DL_1080, { recursive: true });
fs.mkdirSync(DL_720, { recursive: true });

const rows = catalog();
const { done, lost } = partition(rows);

console.log('[redownload] media root   : ' + MEDIA_ROOT);
console.log('[redownload] already have : ' + done.size);
console.log('[redownload] still lost   : ' + lost.length);
console.log('[redownload] free on C:   : ' + freeGb(PROJECT).toFixed(1) + ' GB');

const to720 = lost.filter((r) => KNOWN_720P_ONLY.has(r.video_id));
const to1080 = lost.filter((r) => !KNOWN_720P_ONLY.has(r.video_id));
console.log('[redownload] of those, ' + to720.length + ' are known 720p-only, ' +
  to1080.length + ' should have a 1080p upload');

if (dryRun) {
  console.log('\n[redownload] DRY RUN — next 1080p ids:');
  console.log(to1080.slice(0, batchSize).map((r) => r.video_id).join(','));
  console.log('\n[redownload] DRY RUN — next 720p ids:');
  console.log(to720.slice(0, batchSize).map((r) => r.video_id).join(','));
  process.exit(0);
}

let batches = 0;
let verified1080 = 0;
let verified720 = 0;
let failed = 0;

while (true) {
  if (maxBatches && batches >= maxBatches) {
    console.log('[redownload] reached --max-batches ' + maxBatches + '; stopping.');
    break;
  }
  const free = freeGb(PROJECT);
  if (free < minFreeGb) {
    console.log('[redownload] STOP: only ' + free.toFixed(1) + ' GB free on C: ' +
      '(need ' + minFreeGb + ' GB). Reclaim space and re-run to resume.');
    break;
  }

  // Take a batch of 1080p-eligible videos. The 720p-only ones are handled
  // first, in a single batch, because they need a different height.
  const use720 = to720.length > 0;
  const pool = use720 ? to720 : to1080;
  if (!pool.length) {
    console.log('[redownload] nothing left to download.');
    break;
  }
  const batch = pool.slice(0, batchSize);
  const ids = batch.map((r) => r.video_id);
  const dlDir = use720 ? DL_720 : DL_1080;
  const height = use720 ? 720 : 1080;

  console.log('\n[redownload] === batch ' + (batches + 1) + ' === ' +
    ids.length + ' videos @' + height + 'p -> ' + dlDir);
  console.log('[redownload] free before: ' + freeGb(PROJECT).toFixed(1) + ' GB');

  resetRows(ids);
  download(ids, dlDir, height);

  const check = verify(dlDir, ids, height === 720 ? 1280 : 1920, 1080);
  const okIds = check.filter((c) => c.ok).map((c) => c.id);
  const badIds = check.filter((c) => !c.ok).map((c) => c.id);
  if (use720) verified720 += okIds.length; else verified1080 += okIds.length;
  failed += badIds.length;
  console.log('[redownload] batch ' + (batches + 1) + ': ' + okIds.length +
    ' verified @' + (height === 720 ? '1280x720' : '1920x1080') + ', ' +
    badIds.length + ' not verified' + (badIds.length ? ' (' + badIds.join(',') + ')' : ''));

  // Remove the batch from the pool either way, so a video that cannot be
  // fetched at this height does not wedge the loop forever.
  const doneSet = new Set(ids);
  if (use720) {
    to720.splice(0, ids.length);
  } else {
    to1080.splice(0, ids.length);
  }
  void doneSet;

  batches += 1;
  console.log('[redownload] cumulative verified: ' + verified1080 + ' @1080p, ' +
    verified720 + ' @720p, ' + failed + ' failed');
  console.log('[redownload] free after: ' + freeGb(PROJECT).toFixed(1) + ' GB');
}

console.log('\n[redownload] DONE batches=' + batches +
  ' verified1080=' + verified1080 + ' verified720=' + verified720 + ' failed=' + failed);
console.log('[redownload] re-run the same command to resume — the checkpoint file ' +
  'in each media dir remembers what already succeeded.');
