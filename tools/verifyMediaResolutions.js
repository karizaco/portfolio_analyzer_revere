'use strict';

/**
 * Verify the real resolution of every file in the out-of-tree media dirs.
 *
 * Filesize tells you nothing about resolution (see CLAUDE.md), so this asks
 * ffprobe for the actual frame dimensions. It is the check that caught revere's
 * 1080p uploads measuring 1670x1080 / 1728x1080 / 1920x1078 rather than a
 * uniform 1920x1080.
 *
 * YouTube's "1080p" streams are not a single frame size, so the test is
 * HEIGHT WITHIN A TOLERANCE, not exact dimensions.
 *
 * Usage:
 *   node tools/verifyMediaResolutions.js
 *   node tools/verifyMediaResolutions.js --media-root <dir> --quiet
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mediaRoot } = require('./mediaRoot.js');

const argv = process.argv.slice(2);
const readFlag = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const MEDIA_ROOT = mediaRoot(readFlag('--media-root'));
const quiet = argv.includes('--quiet');
const TOLERANCE = 4;

const TARGETS = [
  { dir: path.join(MEDIA_ROOT, 'downloads_1080p'), height: 1080 },
  { dir: path.join(MEDIA_ROOT, 'downloads_720p'), height: 720 },
];

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  const [w, h] = out.split(',').map(Number);
  return { width: w || 0, height: h || 0, raw: out };
}

let totalOk = 0;
let totalBad = 0;
const shapes = new Map();

for (const { dir, height } of TARGETS) {
  if (!fs.existsSync(dir)) {
    console.log('[verify] missing directory: ' + dir);
    continue;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
  let ok = 0;
  const bad = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const { width, height: h, raw } = probe(full);
    const key = raw || '(probe failed)';
    shapes.set(key, (shapes.get(key) || 0) + 1);
    if (Math.abs(h - height) <= TOLERANCE) ok += 1;
    else bad.push('  ' + f + ' -> ' + (raw || 'PROBE FAILED'));
  }
  totalOk += ok;
  totalBad += bad.length;
  console.log('[verify] ' + path.basename(dir) + ': ' + ok + '/' + files.length +
    ' within ' + height + 'p (tolerance ' + TOLERANCE + ')');
  if (bad.length) {
    console.log('  NOT ' + height + 'p:');
    bad.forEach((b) => console.log(b));
  }
}

if (!quiet) {
  console.log('\n[verify] distinct frame sizes seen:');
  for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(14) + String(v).padStart(5));
  }
}
console.log('\n[verify] total: ' + totalOk + ' ok, ' + totalBad + ' not matching');
process.exit(totalBad ? 1 : 0);
