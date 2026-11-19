'use strict';

// Download the videos that have NO 1080p upload, at 720p.
//
// WHY THIS IS NOT downloadHiresBatch.js
//
// The 1080p pass (`tools/downloadQmg1080p.js`) takes every candidate and asks
// for format 137. On the ids in `src/video/known720pOnly.js` that format does
// not exist -- the channel never published it -- so the 1080p pass skips them
// and nothing else fetches them. This is that something else.
//
// It reads the SAME shared list, so there is one answer to "which videos are
// 720p-only" and not two.
//
// THE RULES
//
//   * one yt-dlp at a time, the project's visios client, the project's
//     cookies. A throttled session stops the run.
//   * format 136 only. 480p and 360p are never taken, and this tool does
//     not fall back: a refusal is an error, not a licence to go lower.
//   * a file is kept only when ffprobe says 1280x720. The resolution is
//     never inferred from the file size.
//   * a file already on disk is skipped, so the tool is idempotent.
//
// Usage:
//   node tools/downloadKnown720pOnly.js
//   node tools/downloadKnown720pOnly.js --only-ids id1,id2
//   node tools/downloadKnown720pOnly.js --dry-run

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { KNOWN_720P_ONLY_IDS } = require('../src/video/known720pOnly');
const { getDownloadDir } = require('../src/video/mediaRoots');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const DIR = getDownloadDir('hires');
const COOKIES = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'youtubeCookies.txt');
const PY = process.platform === 'win32' ? 'py' : 'python3';

/**
 * A refusal that means STOP, not a video to try at a lower resolution.
 *
 * "Requested format is not available" on a known-720p-only id is odd -- the
 * format was verified for every id on the list -- and on a throttled session
 * YouTube lies with it. Either way the answer is to stop, not to drop to
 * 480p, which the project never does.
 */
const STOP = /confirm you'?re not a bot|rate-limited|Sign in to confirm your age|Requested format is not available/i;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const onlyFlag = readFlag(argv, '--only-ids');

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

function ffprobe(file) {
  const probe = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', file,
  ], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  try {
    const streams = JSON.parse(probe.stdout).streams || [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    return video ? { width: video.width, height: video.height } : null;
  } catch {
    return null;
  }
}

const wanted = onlyFlag
  ? onlyFlag.split(',').map((id) => id.trim()).filter(Boolean)
  : KNOWN_720P_ONLY_IDS.slice();

fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 60000');
const lookup = db.prepare('SELECT upload_date FROM videos WHERE video_id = ?');
const mark = db.prepare(
  "UPDATE videos SET download_path = ?, status = 'scanning', error = '' WHERE video_id = ?",
);

let done = 0;
let skipped = 0;
let errored = 0;
let stopped = false;

for (const id of wanted) {
  const row = lookup.get(id);
  const date = row && row.upload_date;
  if (!date) {
    console.log(`[720p] SKIP ${id} not in the catalog`);
    skipped += 1;
    continue;
  }
  const out = path.join(DIR, `${date}_${id}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1024 * 1024) {
    console.log(`[720p] HAVE ${id}`);
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(`[720p] WOULD FETCH ${id} ${date}`);
    continue;
  }

  console.log(`[720p] START ${id} ${date}`);
  const result = spawnSync(PY, [
    '-3', '-m', 'yt_dlp',
    '--no-playlist',
    '-f', '136',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visios',
    '--cookies', COOKIES,
    '--sleep-requests', '2',
    '-o', out,
    `https://www.youtube.com/watch?v=${id}`,
  ], { encoding: 'utf8', cwd: ROOT });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;

  if (result.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1024 * 1024) {
    console.log(`[720p] ERROR ${id} exit=${result.status}`);
    console.log(text.slice(-800));
    if (fs.existsSync(out)) fs.unlinkSync(out);
    errored += 1;
    if (STOP.test(text)) {
      console.log('[720p] STOP throttling or format refusal. Not taking a lower resolution.');
      stopped = true;
      break;
    }
    continue;
  }

  const size = ffprobe(out);
  if (!size || size.width !== 1280 || size.height !== 720) {
    console.log(`[720p] REJECT ${id} ffprobe=${JSON.stringify(size)}`);
    fs.unlinkSync(out);
    errored += 1;
    continue;
  }

  const stored = path.relative(ROOT, out).replace(/\\/g, '/');
  mark.run(stored, id);
  done += 1;
  console.log(`[720p] OK ${id} ${size.width}x${size.height}`
    + ` ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB`);
}

console.log(JSON.stringify({
  done,
  dry_run: dryRun,
  errored,
  requested: wanted.length,
  skipped,
  stopped,
}, null, 2));
db.close();
process.exit(stopped ? 2 : 0);
