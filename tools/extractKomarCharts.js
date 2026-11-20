'use strict';

/**
 * The DAILY UPDATES' CHARTS: what they are, and whether the OCR can
 * read them.
 *
 * The corpus's seven "post" documents (the daily and mid-week updates)
 * each carry a chart image -- 4353x2682, which is the highest
 * resolution anything in the corpus holds. The market CARDS are a
 * different artifact (the author's own summary slide, with the trend
 * arrows, the exposure and the theme leaders), so the question is
 * whether the charts carry anything the cards do not.
 *
 *   node tools/extractKomarCharts.js
 *   node tools/extractKomarCharts.js --doc-id komar_doc_post_20260429
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { extractEmbeddedImage, readMeta } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = process.env.KOMAR_SOURCE_DIR || 'D:\\courses_nosync\\julian_komar';
const OUT = path.join(ROOT, 'data', 'komar_work', 'charts');

const argv = process.argv.slice(2);
const only = (() => {
  const index = argv.indexOf('--doc-id');
  return index === -1 ? '' : argv[index + 1];
})();

const DOCS = {
  komar_doc_post_20250408: 'komar_20260408.pdf',
  komar_doc_post_20250625: '20250625_daily_update.pdf',
  komar_doc_post_20250820: '20250820_daily_update.pdf',
  komar_doc_post_20260415: 'komar_20260415.pdf',
  komar_doc_post_20260429: 'komar_20260429.pdf',
  komar_doc_post_20260505: 'komar_20260505.pdf',
  komar_doc_post_20260506: 'komar_20260506.pdf',
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [docId, fileName] of Object.entries(DOCS)) {
    if (only && docId !== only) continue;
    const pdfPath = path.join(SOURCE_DIR, fileName);
    if (!fs.existsSync(pdfPath)) {
      console.log(`${docId}: ${fileName} is not there`);
      continue;
    }
    const meta = readMeta(pdfPath);
    (meta.pages || []).forEach((page, index) => {
      for (const image of (page.images || [])) {
        console.log(`${docId} page ${index + 1}: the image xref ${image.xref} `
          + `${image.width ? ` ${image.width}x${image.height}` : ''}`);
      }
    });
    // The biggest image on each page is the chart.
    for (const [index, page] of (meta.pages || []).entries()) {
      const images = (page.images || []).filter((image) => (image.width || 0) > 800);
      for (const image of images) {
        const out = path.join(OUT, `${docId}_p${index + 1}_x${image.xref}.png`);
        try {
          const result = await extractEmbeddedImage(pdfPath, index + 1, image.xref, out);
          console.log(`  -> ${path.basename(out)} (${result.width}x${result.height})`);
        } catch (error) {
          console.log(`  -> ${error.message}`);
        }
      }
    }
  }
  void spawnSync;
  console.log(`\nthe charts -> ${OUT}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
