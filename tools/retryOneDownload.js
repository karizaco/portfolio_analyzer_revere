'use strict';

/**
 * Retry one or more video downloads with backoff.
 *
 * The machine's ephemeral port pool (49152-65535 = 16384 ports) can be
 * exhausted by other applications' TIME_WAIT sockets — on 2026-11-27 there
 * were 23k of them, mostly from the user's own Grok Bot / TradingView /
 * Firefox / IBKR TWS, not from our downloads. yt-dlp then fails at connect
 * time with:
 *
 *   Failed to establish a new connection: [WinError 10048]
 *   Only one usage of each socket address (protocol/network address/port)
 *   is normally permitted.
 *
 * That is transient: the same video downloads cleanly on a later attempt.
 * This wrapper retries with a growing sleep between attempts and stops as
 * soon as the file lands.
 *
 * "Sign in to confirm your age" is NOT transient — it means the video is
 * genuinely age-restricted and the cookie file carries no logged-in session.
 * That aborts the run rather than spinning on it.
 *
 * Usage:
 *   node tools/retryOneDownload.js --id <videoId> [--attempts N]
 *   node tools/retryOneDownload.js --ids id1,id2,id3 [--attempts N]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mediaRoot } = require('./mediaRoot.js');

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const ids = (flag('--ids') || flag('--id') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!ids.length) {
  console.error('usage: node tools/retryOneDownload.js --id <videoId> | --ids id1,id2 [--attempts N]');
  process.exit(2);
}
const attempts = Number(flag('--attempts', 5));
const height = Number(flag('--height', 1080));
const cookies = flag('--cookies', 'data/youtube_cookies.txt');
const dlDir = path.resolve(flag('--dl-dir', path.join(mediaRoot(), 'downloads_1080p')));
const py = process.platform === 'win32' ? 'py' : 'python3';

// The upload date is only known from SQLite; the downloader writes
// "<date>_<id>.mp4" when the catalog has one, "<id>.mp4" otherwise.
function uploadDateOf(id) {
  try {
    const script = `import sqlite3, json
c = sqlite3.connect(r"${path.resolve('data/video_pipeline/state.sqlite').replace(/\\/g, '/')}")
r = c.execute("SELECT upload_date FROM videos WHERE video_id = ?", (${JSON.stringify(id)},)).fetchone()
print(r[0] if r and r[0] else "")`;
    const r = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function playerClient() {
  const probe = spawnSync(py, ['-3', '-c',
    'import yt_dlp.extractor.youtube._video as v; ' +
    'ks=list(getattr(v,"INNERTUBE_CLIENTS",{}).keys()); ' +
    'print("visionos" if "visionos" in ks else ("visios" if "visios" in ks else "visionos"))'
  ], { encoding: 'utf8' });
  const found = (probe.stdout || '').trim().split(/\s+/).pop();
  return found === 'visios' ? 'visios' : 'visionos';
}
const client = playerClient();

console.log(`[retry] client=${client} height=${height} attempts=${attempts} ids=${ids.length}`);

const failed = [];
for (const id of ids) {
  const dateOf = uploadDateOf(id);
  const outPath = path.join(dlDir, `${dateOf ? dateOf + '_' : ''}${id}.mp4`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 * 1024) {
    console.log(`[retry] ${id} already on disk (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB) — skipping`);
    continue;
  }
  console.log(`[retry] ${id}  -> ${outPath}`);

  let landed = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    console.log(`[retry] ${id} attempt ${attempt}/${attempts} ...`);
    const r = spawnSync(py, [
      '-3', '-m', 'yt_dlp',
      '--no-playlist',
      '-f', height === 720 ? '136' : '137',
      '--js-runtimes', 'node',
      '--extractor-args', `youtube:player_client=${client}`,
      ...(cookies ? ['--cookies', cookies] : []),
      '-o', outPath.replace(/\.mp4$/, '.%(ext)s'),
      `https://www.youtube.com/watch?v=${id}`
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 * 1024) {
      console.log(`[retry] OK ${id} ${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB in ${elapsed}s`);
      landed = true;
      break;
    }
    const err = ((r.stderr || '') + (r.stdout || '')).split('\n')
      .filter((l) => /ERROR|error|Sign in|age-restricted/.test(l)).slice(-2).join(' | ');
    console.log(`[retry] ${id} attempt ${attempt} failed (exit=${r.status}, ${elapsed}s): ${err.slice(0, 200)}`);

    // A "Sign in to confirm your age" error is not transient — retrying with
    // the same anonymous cookies will fail identically. Stop on this video.
    if (/Sign in to confirm your age/i.test(err)) {
      console.log(`[retry] ${id} is age-restricted — needs a logged-in cookie session, not a retry.`);
      break;
    }
    if (attempt < attempts) {
      // The WinError 10048 socket exhaustion clears when the OS reclaims an
      // ephemeral port, so wait longer each time.
      const wait = Math.min(180, 30 * attempt);
      console.log(`[retry] waiting ${wait}s before the next attempt`);
      spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${wait * 1000})`], { stdio: 'inherit' });
    }
  }
  if (!landed) failed.push(id);
}

if (failed.length) {
  console.log(`[retry] still missing: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('[retry] all requested videos are on disk');
process.exit(0);
