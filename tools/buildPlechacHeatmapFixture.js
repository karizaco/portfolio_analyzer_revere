'use strict';

// Build the frozen fixture for the treemap reader.
//
// The OCR of the screenshot is a LOCAL artifact (the media directory is
// gitignored, and Discord's attachment URLs expire), so the reader is
// pinned by a FROZEN copy of the OCR's words -- the same pattern the
// XTB table reader's fixture uses.
//
//   node tools/buildPlechacHeatmapFixture.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'data/discord_pipeline/media/plechac-portfolia/9820/1494058673994203176.ocr.full.json';
const OUT_DIR = path.join(ROOT, 'test', 'fixtures', 'plechac_heatmap');

const ocr = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE), 'utf8'));
const payload = JSON.stringify({ words: ocr.words }, null, 1);
const md5 = crypto.createHash('md5').update(payload).digest('hex');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'words.json'), `${payload}\n`, 'utf8');

const manifest = {
  measured_at: '2026-11-27',
  source: SOURCE,
  image: 'Snimek_obrazovky_2026-04-15_v_21.28.00.png',
  image_size: '2133x1128',
  ocr_scale: 2,
  words_file: 'words.json',
  words_md5: md5,
  words: (ocr.words || []).length,
  note: 'the OCR of the whole screenshot, frozen; the media directory is gitignored'
    + ' and Discord\'s attachment URLs expire, so this is the only copy that can be tested against',
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${OUT_DIR}/words.json (${(ocr.words || []).length} words) and manifest.json (md5 ${md5})`);
