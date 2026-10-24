'use strict';

/**
 * Delete 720p copies that are redundant duplicates of a verified 1080p file.
 *
 * A 720p copy is only redundant when the SAME video_id also exists in
 * downloads_1080p AND that 1080p file is genuinely usable. So every
 * candidate must pass all of these before its 720p twin is touched:
 *
 *   1. the 1080p file exists,
 *   2. ffprobe reports a height within HEIGHT_TOLERANCE of 1080
 *      (YouTube's "1080p" is not a single frame size — revere measures
 *       1670x1080, 1728x1080, 1920x1078 and 1920x1080),
 *   3. the 1080p file's duration matches the 720p file's, so the two are
 *      the same complete video and not a truncated one,
 *   4. the video_id is NOT one of the hardcoded 720p-only IDs — those have
 *      no 1080p upload, so their 720p file is the only copy that exists.
 *
 * Filesize is never used to decide anything (see CLAUDE.md).
 *
 * Dry run by default. Pass --execute to actually delete.
 *
 * Usage:
 *   node tools/pruneDuplicate720p.js
 *   node tools/pruneDuplicate720p.js --execute
 *   node tools/pruneDuplicate720p.js --media-root <dir>
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const readFlag = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const MEDIA_ROOT = readFlag('--media-root')
  || 'C:/Users/Admin/Projects/portfolio_analyzer_revere_media';
const DIR_1080 = path.join(MEDIA_ROOT, 'downloads_1080p');
const DIR_720 = path.join(MEDIA_ROOT, 'downloads_720p');
const execute = argv.includes('--execute');

const HEIGHT_TOLERANCE = 4;
const DURATION_TOLERANCE = 2;   // seconds

// The 39 IDs that genuinely have no 1080p upload on YouTube. Their 720p file
// is the ONLY copy that exists — never delete one of these.
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

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try {
    const j = JSON.parse(r.stdout || '{}');
    const s = (j.streams || [])[0] || {};
    return { width: s.width || 0, height: s.height || 0, duration: Number(j.format?.duration || 0) };
  } catch (_) {
    return { width: 0, height: 0, duration: 0 };
  }
}

/** The video_id inside `<date>_<id>.mp4` or `<id>.mp4`. */
function idOf(file) {
  return file.replace(/^\d+_/, '').replace(/\.mp4$/, '');
}

if (!fs.existsSync(DIR_1080) || !fs.existsSync(DIR_720)) {
  console.error('[prune720] missing media directory under ' + MEDIA_ROOT);
  process.exit(1);
}

const files1080 = fs.readdirSync(DIR_1080).filter((f) => f.endsWith('.mp4'));
const files720 = fs.readdirSync(DIR_720).filter((f) => f.endsWith('.mp4'));
const byId1080 = new Map(files1080.map((f) => [idOf(f), f]));

const candidates = files720.filter((f) => byId1080.has(idOf(f)));
console.log('[prune720] ' + files1080.length + ' files @1080p, ' + files720.length +
  ' files @720p, ' + candidates.length + ' video_id(s) present in BOTH');

if (!candidates.length) {
  console.log('[prune720] nothing to prune.');
  process.exit(0);
}

let deleted = 0;
let kept = 0;
let freed = 0;

for (const f720 of candidates) {
  const id = idOf(f720);
  const f1080 = byId1080.get(id);
  const p1080 = path.join(DIR_1080, f1080);
  const p720 = path.join(DIR_720, f720);

  if (KNOWN_720P_ONLY.has(id)) {
    console.log('  KEEP  ' + id + ' — on the known-720p-only list (no 1080p upload exists)');
    kept += 1;
    continue;
  }

  const a = probe(p1080);
  const b = probe(p720);

  if (!a.width || !a.height) {
    console.log('  KEEP  ' + id + ' — ffprobe could not read the 1080p copy');
    kept += 1;
    continue;
  }
  if (Math.abs(a.height - 1080) > HEIGHT_TOLERANCE) {
    console.log('  KEEP  ' + id + ' — 1080p copy is ' + a.width + 'x' + a.height +
      ', not within ' + HEIGHT_TOLERANCE + ' of 1080');
    kept += 1;
    continue;
  }
  if (!b.duration || !a.duration || Math.abs(a.duration - b.duration) > DURATION_TOLERANCE) {
    console.log('  KEEP  ' + id + ' — durations differ (1080p ' + a.duration.toFixed(1) +
      's vs 720p ' + b.duration.toFixed(1) + 's); not the same complete video');
    kept += 1;
    continue;
  }

  const size = fs.statSync(p720).size;
  freed += size;
  deleted += 1;
  if (execute) {
    fs.unlinkSync(p720);
    console.log('  DEL   ' + f720 + '  (' + (size / 1024 ** 2).toFixed(1) + ' MiB) — ' +
      '1080p copy verified at ' + a.width + 'x' + a.height);
  } else {
    console.log('  WOULD DEL  ' + f720 + '  (' + (size / 1024 ** 2).toFixed(1) + ' MiB) — ' +
      '1080p copy verified at ' + a.width + 'x' + a.height);
  }
}

console.log('\n[prune720] ' + (execute ? 'deleted ' : 'would delete ') + deleted +
  ', kept ' + kept + ', ' + (freed / 1024 ** 3).toFixed(2) + ' GiB' +
  (execute ? ' freed' : ' reclaimable'));
if (!execute) console.log('[prune720] dry run — pass --execute to delete.');
