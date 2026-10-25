'use strict';

/**
 * Dump the word boxes of one log's first frame so a specific token can be
 * located in the overlay: its line, left edge, and the panel headers.
 *
 * Usage:
 *   node tools/dumpColumnWords.js <log-basename> [token]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const want = process.argv[2];
const token = (process.argv[3] || '').toUpperCase();

function collectLogFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectLogFiles(p, out);
    else if (e.name.endsWith('.json') && e.name.includes('_snapshot.json')) out.push(p);
  }
  return out;
}

const files = collectLogFiles(path.join(ROOT, 'data', 'video_scan_test', '_rerun'), []);
const file = files.find((f) => path.basename(f).startsWith(want));
if (!file) {
  console.error('no log matching ' + want);
  process.exit(1);
}
const log = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('log: ' + path.relative(ROOT, file));
console.log('crop: ' + JSON.stringify(log.phash_region_fraction || log.phash_region));
const c = (log.top_candidates || [])[0];
console.log('frame: ' + c.frame_index + ' ts=' + c.timestamp);
const words = c.ocr_words || [];
const byLine = new Map();
for (const w of words) {
  const line = Number.isFinite(w.line) ? w.line : 0;
  if (!byLine.has(line)) byLine.set(line, []);
  byLine.get(line).push(w);
}
for (const [line, ws] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
  ws.sort((a, b) => a.left - b.left);
  const txt = ws.map((w) => `${w.text}@${Math.round(w.left)}`).join(' ');
  const mark = token && ws.some((w) => (w.text || '').toUpperCase().includes(token)) ? ' <<< ' + token : '';
  console.log(String(line).padStart(3) + ': ' + txt + mark);
}
