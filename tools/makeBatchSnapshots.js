'use strict';

// Make a batch of N snapshots within M seconds of a chosen timestamp.
// These are useful for multi-frame merge: all snapshots will show the
// same Quullamaggie position list (which changes slowly through the stream).
//
// Usage:
//   node tools/makeBatchSnapshots.js \
//     --video data/video_pipeline/downloads_1080p/qmg_20220323_Xsk8dD6eoEA.mp4 \
//     --timestamp 1020 \
//     --window-seconds 5 \
//     --count 5 \
//     --out-dir data/video_scan_test/_batch_snapshots
//
//   --video PATH          Path to the source video
//   --timestamp SECONDS   Center timestamp (seconds from start)
//   --window-seconds N    Snapshots will span [timestamp - N/2, timestamp + N/2]
//   --count N             How many snapshots to take across the window
//   --out-dir DIR         Output directory
//   --name PREFIX         Filename prefix (default: derived from video basename)

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}

const videoPath = arg('--video');
const timestamp = parseFloat(arg('--timestamp'));
const windowSeconds = parseFloat(arg('--window-seconds', '4'));
const count = parseInt(arg('--count', '5'), 10);
const outDir = arg('--out-dir', 'data/video_scan_test/_batch_snapshots');
const namePrefix = arg('--name', null);

if (!videoPath || isNaN(timestamp)) {
  console.error('Usage: node tools/makeBatchSnapshots.js --video PATH --timestamp SECONDS [--window-seconds N] [--count N] [--out-dir DIR] [--name PREFIX]');
  process.exit(1);
}

// Resolve ffmpeg
function resolveFfmpegBin() {
  const direct = 'C:/Users/admin/Projects/portfolio_analyzer_revere/tools/ffmpeg.exe';
  try { require('node:fs').accessSync(direct); return direct; } catch { /* ignore */ }
  return 'ffmpeg';
}

fs.mkdirSync(outDir, { recursive: true });
const ffmpegBin = resolveFfmpegBin();

const baseName = namePrefix || path.basename(videoPath, path.extname(videoPath)).slice(0, 40);
const halfWindow = windowSeconds / 2;

// Spread count snapshots evenly across [timestamp - halfWindow, timestamp + halfWindow]
const snapshots = [];
for (let i = 0; i < count; i++) {
  const t = timestamp - halfWindow + (i * windowSeconds) / Math.max(1, count - 1);
  snapshots.push({ idx: i, ts: t });
}

console.log('Batch snapshots for ' + path.basename(videoPath));
console.log('  Timestamp: ' + timestamp + 's');
console.log('  Window: ' + windowSeconds + 's (±' + halfWindow + 's)');
console.log('  Count: ' + count);
console.log('  Output: ' + outDir);

for (const s of snapshots) {
  const fname = baseName + '_batch_t' + s.ts.toFixed(2) + '_i' + s.idx + '.png';
  const outPath = path.join(outDir, fname);
  const cmd = [
    ffmpegBin, '-hide_banner', '-loglevel', 'error',
    '-ss', s.ts.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    outPath
  ];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('  Failed at t=' + s.ts + ': ' + (r.stderr || '').slice(-200));
  } else {
    console.log('  ' + fname + ' (t=' + s.ts.toFixed(2) + 's)');
  }
}

console.log('Done.');
