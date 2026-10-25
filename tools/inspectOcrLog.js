'use strict';

/**
 * Print the diagnostics of one scan log, so a failed read can be reasoned
 * about without opening the (large) JSON in an editor.
 *
 * Shows: the video that was read, the region fraction that was used, every
 * captured frame with its timestamp and OCR word boxes, the column-filter
 * diagnostic, and the merged position list.
 *
 * Usage:
 *   node tools/inspectOcrLog.js 20231215
 *   node tools/inspectOcrLog.js 20231215 --run-tag qmg-restore-20261024b
 *   node tools/inspectOcrLog.js 20231215 --root data/video_scan_test/_rerun --words
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const dateKey = argv[0];
if (!dateKey) {
  console.error('usage: node tools/inspectOcrLog.js <dateKey> [--run-tag T] [--root R] [--words]');
  process.exit(1);
}
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const runTag = flag('--run-tag', null);
const roots = [
  path.join(ROOT, 'data', 'video_scan_test', '_rerun', runTag || ''),
  path.join(ROOT, 'data'),
].filter((p) => fs.existsSync(p));
const showWords = argv.includes('--words');

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.includes('_snapshot.json') && e.name.startsWith(dateKey)) out.push(p);
  }
}

const found = [];
for (const r of roots) walk(r, found);
if (!found.length) {
  console.log('[inspect] no log for ' + dateKey);
  process.exit(0);
}

for (const file of found) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('='.repeat(78));
  console.log('log      : ' + path.relative(ROOT, file));
  console.log('video    : ' + j.video_path);
  console.log('date_key : ' + j.date_key);
  console.log('status   : ' + j.status + '  captures=' + j.captured_count);
  console.log('engine   : ' + (j.ocr_engine_metadata?.ocr_engine || j._engine || 'unknown'));
  console.log('region   : ' + JSON.stringify(j.phash_region_fraction));
  console.log('merged   : ' + (j.merged_position_list || []).join(', '));

  const caps = j.captured_frames || j.frames || j.captures || [];
  for (const c of caps) {
    console.log('  --- capture frame=' + c.frame_index +
      ' ts=' + c.timestamp + ' tickers=' +
      ((c.chart_stream?.position_list || []).join(',') || 'none'));
    const cf = c.chart_stream?.column_filter;
    if (cf && Object.keys(cf).length) {
      console.log('      column_filter: dominant_x=' + cf.dominant_x +
        ' width=' + cf.column_width +
        ' in_list=' + cf.in_list_token_count);
    }
    if (cf && !Object.keys(cf).length) console.log('      column_filter: (empty)');
    if (showWords && c.ocr?.words) {
      for (const w of c.ocr.words) {
        console.log('      ' + String(w.text).padEnd(10) +
          ' left=' + Math.round(w.left) + ' top=' + Math.round(w.top) +
          ' w=' + Math.round(w.width) + ' conf=' + (w.conf ?? '').toFixed?.(2));
      }
    }
  }
}
