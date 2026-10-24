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
// The record of the 718 videos destroyed on 2026-10-21, generated from the
// pre-loss state.sqlite in git HEAD. This — not the live DB — defines the
// lost set, because resetting a row clears its download_path.
const LEDGER = path.join(PROJECT, 'data', '_lost_videos_ledger.json');
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

/** Every row in the catalog, with its download_path. */
function catalog() {
  const script = `
import sqlite3, json, sys
c = sqlite3.connect(r"${DB.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute(
    "SELECT video_id, channel, upload_date, title, download_path FROM videos "
    "ORDER BY channel, upload_date DESC, video_id ASC"
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
 * Split the catalog into what is already recovered and what is still lost.
 *
 * The authority for "what was lost" is `data/_lost_videos_ledger.json`, not
 * the current SQLite paths: resetting a row clears its `download_path`, so
 * inferring the lost set from the live DB loses rows mid-run (and on resume).
 * The ledger was generated from the pre-loss `state.sqlite` as it stood in
 * git HEAD, and holds exactly the 718 rows that pointed at the destroyed
 * in-tree media directories.
 *
 * "Recovered" = the row's path now points inside the out-of-tree media root.
 *
 * The ledger's `scope` records which DIRECTORY the original file sat in, not
 * which resolutions YouTube offers. It is used here only to split the work
 * into two pools; both are fetched at 1080p first, because probing on
 * 2026-10-23 showed format 137 is available for the revere uploads too.
 */
function partition(rows) {
  const byId = new Map(rows.map((r) => [r.video_id, r]));
  const done = new Set();
  const scopes = { qmg1080: [], other720: [] };

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch (e) {
    console.error('[redownload] cannot read the lost-videos ledger at ' + LEDGER + ': ' + e.message);
    console.error('[redownload] it is the record of the 718 videos destroyed on 2026-10-21 — ' +
      'regenerate it before running.');
    process.exit(1);
  }

  for (const entry of ledger) {
    const row = byId.get(entry.video_id);
    if (!row) continue;                       // not in the live catalog
    const p = norm(row.download_path);
    if (p.startsWith(mediaRootNorm)) { done.add(entry.video_id); continue; }
    if (!p) { /* reset but not yet downloaded — still lost */ }

    const want720 = entry.scope === '720p' || KNOWN_720P_ONLY.has(entry.video_id);
    (want720 ? scopes.other720 : scopes.qmg1080).push(row);
  }
  return { done, scopes };
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
function download(ids, dlDir, height, channel) {
  const args = [
    path.join(PROJECT, 'tools', 'downloadQmg1080p.js'),
    '--limit', String(ids.length),
    '--height', String(height),
    '--channel', channel,
    '--only-ids', ids.join(','),
    '--dl-dir', dlDir,
    // A video that was throttled is recorded in the checkpoint's errored map.
    // Retry those rather than treating the earlier failure as final.
    '--retry-errored',
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

/**
 * Verify a batch of files against an expected HEIGHT.
 *
 * Height, not exact dimensions: YouTube's "1080p" uploads are not uniform.
 * The revere frames measure 1670x1080, 1728x1080, 1920x1078 and 1920x1080
 * across a four-video sample. Comparing against a hardcoded 1920x1080 would
 * fail every one of them; so would an exact-height check, because 1078 is a
 * crop of 1080. A small tolerance on the height is the right test.
 */
const HEIGHT_TOLERANCE = 4;

function verify(dir, ids, wantHeight) {
  const results = [];
  for (const id of ids) {
    // The downloader names files <upload_date>_<id>.mp4 when a date is known.
    const found = fs.readdirSync(dir).filter((f) => f.endsWith(`_${id}.mp4`) || f === `${id}.mp4`);
    if (!found.length) { results.push({ id, ok: false, why: 'no file' }); continue; }
    const file = path.join(dir, found[0]);
    const dims = probe(file);
    const height = Number((dims.split(',')[1] || 0));
    const ok = Math.abs(height - wantHeight) <= HEIGHT_TOLERANCE;
    results.push({ id, ok, dims, file: path.basename(file) });
  }
  return results;
}

/** Which of `ids` the downloader recorded as successful in `dlDir`'s checkpoint. */
function checkpointDone(dlDir) {
  try {
    const cp = JSON.parse(fs.readFileSync(path.join(dlDir, '_qmg_1080p_checkpoint.json'), 'utf8'));
    return new Set((cp.done || []).map((e) => (typeof e === 'string' ? e : e.id)));
  } catch (_) {
    return new Set();
  }
}

/**
 * Does this video actually offer a 1080p stream?
 *
 * "Requested format is not available" is ambiguous: on the hardcoded
 * 720p-only IDs it means the upload genuinely has no 1080p stream, but on
 * ANY other video YouTube is usually throttling and lying. Confirmed on
 * 2026-10-24: `i-FvQ9bD9S8` failed its 1080p attempt yet `--list-formats`
 * shows format 137 present.
 *
 * So before downgrading anything to 720p, ask YouTube what the ladder
 * actually contains. Only a video with no 137 gets the 720p copy; the rest
 * stay errored for a later retry with fresh cookies.
 */
function has1080pStream(videoId) {
  const r = spawnSync(PY, ['-3', '-m', 'yt_dlp', '--no-playlist', '-j',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visionos',
    ...(fs.existsSync(path.join(PROJECT, cookiesFile))
      ? ['--cookies', path.join(PROJECT, cookiesFile)] : []),
    `https://www.youtube.com/watch?v=${videoId}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;              // could not tell
  let info;
  try { info = JSON.parse(r.stdout); } catch (_) { return null; }
  return (info.formats || []).some((f) => f.format_id === '137');
}

// ---------------------------------------------------------------------------

fs.mkdirSync(DL_1080, { recursive: true });
fs.mkdirSync(DL_720, { recursive: true });

const rows = catalog();
const { done, scopes } = partition(rows);

console.log('[redownload] media root   : ' + MEDIA_ROOT);
console.log('[redownload] already have : ' + done.size);
console.log('[redownload] free on C:   : ' + freeGb(PROJECT).toFixed(1) + ' GB');
console.log('[redownload] still lost   : ' +
  (scopes.qmg1080.length + scopes.other720.length) +
  '  (' + scopes.qmg1080.length + ' @1080p, ' + scopes.other720.length + ' @720p)');

if (dryRun) {
  console.log('\n[redownload] DRY RUN — next 1080p ids (pool 1):');
  console.log(scopes.qmg1080.slice(0, batchSize).map((r) => r.video_id).join(','));
  console.log('\n[redownload] DRY RUN — next ids (pool 2, 1080p first, 720p fallback):');
  console.log(scopes.other720.slice(0, batchSize).map((r) => r.video_id).join(','));
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

  // 1080p-eligible qullamaggie videos first, then the "other" scope (the 26
  // qullamaggie + 151 revere videos that originally sat in downloads_hires).
  //
  // The ledger's scope records which DIRECTORY the original file was in, not
  // what YouTube offers. Probing revere on 2026-10-23 showed format 137
  // (1080p) IS available for revere uploads — one comes down as 1670x1080,
  // not 1920x1080. So the whole "other" scope is attempted at 1080p first and
  // only the videos that genuinely have no 1080p stream fall back to 720p.
  const useOther = scopes.qmg1080.length === 0;
  const pool = useOther ? scopes.other720 : scopes.qmg1080;
  if (!pool.length) {
    console.log('[redownload] nothing left to download.');
    break;
  }
  const batch = pool.slice(0, batchSize);
  const ids = batch.map((r) => r.video_id);
  const channel = useOther ? 'any' : 'qullamaggie';

  console.log('\n[redownload] === batch ' + (batches + 1) + ' === ' +
    ids.length + ' videos @1080p (' + channel + ') -> ' + DL_1080);
  console.log('[redownload] free before: ' + freeGb(PROJECT).toFixed(1) + ' GB');

  resetRows(ids);
  download(ids, DL_1080, 1080, channel);

  const landed1080 = checkpointDone(DL_1080);
  const failedAt1080 = ids.filter((id) => !landed1080.has(id));

  // Anything that failed at 1080p gets checked against YouTube's real format
  // ladder before being downgraded. A video that DOES offer 137 was throttled,
  // not downgraded-worthy — it stays errored for a later retry with fresh
  // cookies, because a 720p copy is strictly worse than what was lost.
  let badIds = failedAt1080;
  const retryIds = [];
  if (failedAt1080.length) {
    console.log('[redownload] ' + failedAt1080.length +
      ' video(s) failed at 1080p; checking which genuinely lack a 1080p stream.');
    const genuine720 = [];
    const throttled = [];
    for (const id of failedAt1080) {
      const has1080 = has1080pStream(id);
      if (has1080 === false) genuine720.push(id);
      else if (has1080 === true) throttled.push(id);
      else throttled.push(id);                   // could not tell — assume throttled
    }
    if (throttled.length) {
      retryIds.push(...throttled);
      console.log('[redownload] ' + throttled.length +
        ' video(s) DO offer 1080p but the attempt failed (throttled); left errored ' +
        'for a later retry, NOT downgraded: ' + throttled.join(','));
    }
    if (genuine720.length) {
      console.log('[redownload] ' + genuine720.length +
        ' video(s) genuinely have no 1080p stream; fetching them at 720p.');
      resetRows(genuine720);
      download(genuine720, DL_720, 720, 'any');
      const landed720 = checkpointDone(DL_720);
      const ok720 = genuine720.filter((id) => landed720.has(id));
      const check720 = verify(DL_720, ok720, 720);
      verified720 += check720.filter((c) => c.ok).length;
      badIds = throttled.concat(genuine720.filter((id) => !landed720.has(id)));
      console.log('[redownload] 720p fallback: ' + check720.filter((c) => c.ok).length +
        ' verified @720p, ' + badIds.length + ' still missing');
    } else {
      badIds = throttled;
    }
  }

  const check = verify(DL_1080, ids.filter((id) => landed1080.has(id)), 1080);
  const okIds = check.filter((c) => c.ok).map((c) => c.id);
  verified1080 += okIds.length;
  failed += badIds.length;
  console.log('[redownload] batch ' + (batches + 1) + ': ' + okIds.length +
    ' verified @1080p, ' + badIds.length + ' not verified' +
    (badIds.length ? ' (' + badIds.join(',') + ')' : ''));

  // Remove the batch from the pool, but put back anything that was merely
  // throttled — it still has a 1080p stream waiting to be fetched, so it must
  // not be silently abandoned. Genuinely unavailable videos are dropped, so a
  // video that cannot be fetched does not wedge the loop forever.
  pool.splice(0, ids.length);
  for (const id of retryIds) {
    const row = rows.find((r) => r.video_id === id);
    if (row) pool.unshift(row);
  }
  if (retryIds.length) {
    console.log('[redownload] requeued ' + retryIds.length +
      ' throttled video(s) for a later attempt: ' + retryIds.join(','));
  }

  batches += 1;
  console.log('[redownload] cumulative verified: ' + verified1080 + ' @1080p, ' +
    verified720 + ' @720p, ' + failed + ' failed');
  console.log('[redownload] free after: ' + freeGb(PROJECT).toFixed(1) + ' GB');
}

console.log('\n[redownload] DONE batches=' + batches +
  ' verified1080=' + verified1080 + ' verified720=' + verified720 + ' failed=' + failed);
console.log('[redownload] re-run the same command to resume — the checkpoint file ' +
  'in each media dir remembers what already succeeded.');
