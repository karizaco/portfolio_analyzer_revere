'use strict';

// The QMG download pipeline, in stages, unattended.
//
// STAGE 1 (already running when this starts):
//   the 1080p pass over the whole catalog, with the fixed checkpoint logic.
//
// STAGE 2 (this script):
//   the 39 known-720p-only videos, at format 136 (720p), into the 720p
//   library.
//
// WHY STAGE 2 IS SEPARATE
//
// Those 39 videos have no 1080p upload on YouTube. The 1080p pass skips them
// on purpose (src/video/known720pOnly.js) -- retrying them every run would
// spend 39 requests proving what is already known. They still need media
// though, so a separate pass fetches them at 720p.
//
// SEPARATE CHECKPOINT, SEPARATE DIRECTORY
//
// The two passes must not share a checkpoint or a directory. A shared
// checkpoint would let a 720p success be read as a 1080p success; a shared
// directory would put a 720p file in the 1080p library, where
// findHiresOnDisk() would report it as a finished 1080p download.
//
// WHY IT WAITS
//
// Two yt-dlp processes at once compete for the same YouTube rate-limit
// budget, and the symptom of losing that race is a "Video unavailable" error
// on videos that exist. So stage 2 waits for stage 1's process to exit.
//
// Usage:
//   node tools/qmgDownloadStages.js --wait-for-pid 179748
//   node tools/qmgDownloadStages.js --skip-wait      # run stage 2 now

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { getDownloadDir } = require('../src/video/mediaRoots');
const { KNOWN_720P_ONLY_IDS } = require('../src/video/known720pOnly');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const waitForPid = Number(flag('--wait-for-pid', 0)) || 0;
const skipWait = argv.includes('--skip-wait');

/**
 * Is this pid still alive?
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function log(msg) {
  console.log(`[stages] ${new Date().toISOString()} ${msg}`);
}

if (waitForPid && !skipWait) {
  log(`waiting for pid ${waitForPid} to exit before stage 2`);
  while (alive(waitForPid)) {
    // Poll every 30s. A blocking sleep of minutes would keep this process
    // alive without doing anything, and the point is to react when stage 1
    // ends.
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  }
  log(`pid ${waitForPid} has exited -- starting stage 2`);
} else {
  log('skipping the wait -- starting stage 2 now');
}

const hiresDir = getDownloadDir('hires');
fs.mkdirSync(hiresDir, { recursive: true });
const checkpoint = path.join(hiresDir, '_qmg_720p_checkpoint.json');

log(`stage 2: ${KNOWN_720P_ONLY_IDS.length} known-720p-only videos at 720p`);
log(`  out dir:    ${hiresDir}`);
log(`  checkpoint: ${checkpoint}`);

const started = Date.now();
const r = spawnSync(process.execPath, [
  path.join(ROOT, 'tools', 'downloadQmg1080p.js'),
  '--height', '720',
  '--limit', String(KNOWN_720P_ONLY_IDS.length + 5),
  '--retry-errored',
  '--out-dir', hiresDir,
  '--checkpoint-file', checkpoint,
  '--only-ids', KNOWN_720P_ONLY_IDS.join(','),
], { encoding: 'utf8', stdio: 'inherit' });

const elapsed = ((Date.now() - started) / 1000).toFixed(0);
log(`stage 2 finished with exit code ${r.status} in ${elapsed}s`);
fs.writeFileSync(path.join(ROOT, 'data', 'qmg_download_stages.json'), JSON.stringify({
  stage2_exit_code: r.status,
  stage2_elapsed_s: Number(elapsed),
  finished_at: new Date().toISOString(),
  out_dir: hiresDir,
  checkpoint,
}, null, 2));
process.exit(r.status === 0 ? 0 : 1);
