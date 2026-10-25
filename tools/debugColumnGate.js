'use strict';

// Scratch: dump the per-frame word geometry and the column-gate decisions
// for one scan log, so a lost ground-truth ticker can be traced to the
// exact frame and x-position where it was dropped.
//
// Usage: node tools/debugColumnGate.js <logfile.json> [ticker]

const fs = require('node:fs');
const path = require('node:path');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const file = process.argv[2];
const focus = (process.argv[3] || '').toUpperCase();
const log = JSON.parse(fs.readFileSync(file, 'utf8'));

const region = log.phash_region_fraction || log.phash_region;
const cropWidth = region && Number.isFinite(region.w) ? Math.round(region.w * 1920 * 5) : null;

console.log(file);
console.log('date_key', log.date_key, 'cropWidth', cropWidth,
  'engine', log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine);
console.log('merged', (log.merged_position_list || []).join(','));

for (const c of log.top_candidates || []) {
  const words = Array.isArray(c.ocr_words) ? c.ocr_words : [];
  if (!words.length) continue;
  const linesByIndex = new Map();
  for (const w of words) {
    const line = Number.isFinite(w.line) ? w.line : 0;
    if (!linesByIndex.has(line)) linesByIndex.set(line, []);
    linesByIndex.get(line).push(w.text);
  }
  const lines = [...linesByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.join(' '));

  const mk = (gate) => ({
    text: c.ocr_text || lines.join('\n'),
    lines,
    words,
    _cropWidth: cropWidth,
    _engine: (log.ocr_engine_metadata && log.ocr_engine_metadata.ocr_engine) || null,
    _columnGate: gate,
  });
  const off = parseChartStreamPositionList({ ocr: mk(false) });
  const on = parseChartStreamPositionList({ ocr: mk(true) });

  console.log(`\n--- frame ${c.frame_index} ts=${c.timestamp} ` +
    `cf=${JSON.stringify(off.column_filter)}`);
  console.log('   off accepted:', (off.position_list || []).join(',') || '(none)');
  console.log('   on  accepted:', (on.position_list || []).join(',') || '(none)');
  const dropped = (off.position_list || []).filter((t) => !(on.position_list || []).includes(t));
  if (dropped.length) console.log('   DROPPED BY GATE:', dropped.join(','));

  if (focus) {
    for (const w of words) {
      const up = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!up) continue;
      if (up !== focus && !(up.includes(focus))) continue;
      console.log(`   word ${JSON.stringify(w.text)} line=${w.line} ` +
        `left=${Math.round(w.left)} w=${Math.round(w.width)} center=${Math.round(w.left + w.width / 2)}`);
    }
  }
}
