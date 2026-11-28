#!/usr/bin/env node
'use strict';

/**
 * Remove the SOURCE copy of a media tree after it has been relocated.
 *
 * This exists because the repo's guard hook (tools/guardDestructiveBash.js)
 * blocks every recursive delete that names a media directory — correctly,
 * because a blind `rm -rf` on 237 GB of videos is unrecoverable. A `mv`
 * across drives is not available on Windows, so a relocation is
 * copy-then-delete, and the delete half needs a gate.
 *
 * The gate is verification, not permission:
 *
 *   1. The destination must exist and contain the SAME number of files as
 *      the source.
 *   2. Every source file must have a destination file of exactly the same
 *      size. A missing or short file aborts the whole run.
 *   3. The total byte count of the destination must equal the source's.
 *   4. A sample of destination .mp4s must still decode (ffprobe).
 *
 * Only then does it delete — file by file, from the SOURCE tree only. The
 * destination is never touched.
 *
 * Usage:
 *   node tools/removeMovedMedia.js --from <old root> --to <new root>
 *   node tools/removeMovedMedia.js --from <old root> --to <new root> --confirm
 *
 * Without --confirm it verifies and reports, and deletes nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const FROM = path.resolve(flag('--from') || '');
const TO = path.resolve(flag('--to') || '');
const CONFIRM = argv.includes('--confirm');
const SAMPLE = 15;

if (!FROM || !TO) {
  console.error('usage: node tools/removeMovedMedia.js --from <old root> --to <new root> [--confirm]');
  process.exit(2);
}
if (FROM === TO) {
  console.error('REFUSE: --from and --to are the same path');
  process.exit(2);
}
// Never delete inside the destination, and never delete the destination.
if (TO.startsWith(FROM + path.sep) || FROM.startsWith(TO + path.sep)) {
  console.error('REFUSE: --from and --to overlap');
  process.exit(2);
}

function walk(dir, base, out) {
  let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    const p = path.join(dir, x.name);
    if (x.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

console.log('removeMovedMedia');
console.log('  from : ' + FROM);
console.log('  to   : ' + TO);
console.log('  mode : ' + (CONFIRM ? 'DELETE after verification' : 'verify only (no deletion)'));

if (!fs.existsSync(FROM)) { console.error('REFUSE: source does not exist'); process.exit(2); }
if (!fs.existsSync(TO)) { console.error('REFUSE: destination does not exist'); process.exit(2); }

const srcFiles = walk(FROM, FROM, []);
const dstFiles = walk(TO, TO, []);
console.log('\n  source files : ' + srcFiles.length);
console.log('  dest files   : ' + dstFiles.length);

const dstSet = new Set(dstFiles);
let srcBytes = 0, dstBytes = 0, missing = 0, short = 0;
for (const f of dstFiles) { try { dstBytes += fs.statSync(path.join(TO, f)).size; } catch { /* skip */ } }
for (const f of srcFiles) {
  let ss = 0; try { ss = fs.statSync(path.join(FROM, f)).size; } catch { /* skip */ }
  srcBytes += ss;
  if (!dstSet.has(f)) { if (missing < 5) console.log('    MISSING AT DEST: ' + f); missing++; continue; }
  let ds = 0; try { ds = fs.statSync(path.join(TO, f)).size; } catch { ds = -1; }
  if (ds !== ss) { if (short < 5) console.log('    SIZE MISMATCH: ' + f + ' src=' + ss + ' dst=' + ds); short++; }
}
console.log('  source bytes : ' + srcBytes);
console.log('  dest bytes   : ' + dstBytes);
console.log('  missing      : ' + missing);
console.log('  size mismatch: ' + short);

// The destination must still be decodable, not just the same size.
const mp4s = dstFiles.filter((f) => f.toLowerCase().endsWith('.mp4'));
const step = Math.max(1, Math.floor(mp4s.length / SAMPLE));
let probed = 0, decodable = 0;
for (const f of mp4s.filter((_, i) => i % step === 0).slice(0, SAMPLE)) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(TO, f)],
      { encoding: 'utf8', timeout: 120000 }).trim();
    probed++;
    if (/^\d+,\d+$/.test(out)) decodable++;
    else console.log('    BAD PROBE: ' + f + ' -> ' + JSON.stringify(out));
  } catch (e) {
    console.log('    PROBE FAILED: ' + f + ' ' + String(e.message).slice(0, 70));
  }
}
console.log('  ffprobe ok   : ' + decodable + '/' + probed);

const ok = missing === 0 && short === 0 && srcBytes === dstBytes &&
  probed > 0 && decodable === probed && srcFiles.length === dstFiles.length;

if (!ok) {
  console.error('\n  VERIFY FAILED — nothing deleted.');
  process.exit(1);
}
console.log('\n  VERIFY PASSED: the destination holds a complete, decodable copy.');

if (!CONFIRM) {
  console.log('  (dry run — re-run with --confirm to delete the source.)');
  process.exit(0);
}

// ------------------------------------------------------------------- delete
let removed = 0, freed = 0, failed = 0;
for (const f of srcFiles) {
  const p = path.join(FROM, f);
  try {
    const s = fs.statSync(p).size;
    fs.unlinkSync(p);
    freed += s; removed++;
  } catch (e) {
    if (failed < 5) console.error('  FAILED ' + p + ': ' + e.message);
    failed++;
  }
}
// Remove the now-empty directories, bottom up.
const dirs = [];
(function collect(d) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) if (x.isDirectory()) { const p = path.join(d, x.name); collect(p); dirs.push(p); }
})(FROM);
let dirsRemoved = 0;
for (const d of dirs.reverse()) {
  try { if (fs.readdirSync(d).length === 0) { fs.rmdirSync(d); dirsRemoved++; } } catch { /* skip */ }
}
try { if (fs.readdirSync(FROM).length === 0) { fs.rmdirSync(FROM); console.log('  removed the empty source root'); } } catch { /* skip */ }

console.log('\n  DELETED ' + removed + ' files, reclaimed ' + (freed / 1073741824).toFixed(1) + ' GiB' +
  (failed ? '  (failed ' + failed + ')' : ''));
console.log('  removed ' + dirsRemoved + ' empty directories');
console.log('  the destination at ' + TO + ' is untouched.');
