'use strict';

// Build the frozen fixture for plechac's 2025-12-22 XTB "Overview"
// pictures -- the English table that carries the WEIGHT.
//
// The media directory is gitignored and Discord's attachment URLs
// expire, so the frozen OCR words are the only copy that can be tested
// against.
//
//   node tools/buildPlechacOverviewFixture.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'data', 'discord_pipeline', 'media', 'plechac-portfolia', '9829');
const OUT_DIR = path.join(ROOT, 'test', 'fixtures', 'plechac_portfolio');

// The five pictures of the Overview table, in scroll order. The treemap
// is NOT one of them -- it is a different picture and the treemap reader
// takes it.
const PICTURES = [
  '1452567331791437835',
  '1452567332151890081',
  '1452567332525178983',
  '1452567332835561573',
  '1452567333175427183',
];

const pictures = [];
for (const id of PICTURES) {
  const file = path.join(MEDIA, `${id}.ocr.json`);
  if (!fs.existsSync(file)) {
    console.log(`  ${id}: no OCR on disk -- skipped`);
    continue;
  }
  const ocr = JSON.parse(fs.readFileSync(file, 'utf8'));
  pictures.push({ attachment_id: id, words: ocr.words || [] });
}

const fixture = {
  source: 'plechac-portfolia',
  posted_at: '2025-12-22',
  note: 'the EasyOCR words of the five XTB "Overview" table pictures of 2025-12-22, frozen;'
    + ' the pictures are consecutive scroll positions of one table, and the LAST row of each'
    + ' is cut off by the image edge',
  pictures,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'xtb_overview_20251222.json');
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`, 'utf8');
console.log(`wrote ${path.relative(ROOT, out)} (${pictures.length} pictures,`
  + ` ${pictures.reduce((n, p) => n + p.words.length, 0)} words)`);
