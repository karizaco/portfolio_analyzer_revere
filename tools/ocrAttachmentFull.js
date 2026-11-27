'use strict';

/**
 * Re-OCR one attachment with the FULL image, and cache it beside the
 * existing one.
 *
 * The pipeline's OCR region is the chart-stream overlay -- the LEFT 70 %
 * of the image -- because that is where a TradingView panel lives. The
 * 2026-04-15 screenshot is not a chart panel: it is a full-width treemap
 * of the whole book, and 30 % of it was never read.
 *
 *   node tools/ocrAttachmentFull.js <message_id> <attachment_id> [scale]
 */

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { preprocessChartStreamRawToBuffer } = require('../src/ocr/ocrImage');
const { runEasyOcr } = require('../src/ocr/easyocrAdapter');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

const messageId = process.argv[2];
const attachmentId = process.argv[3];
const scale = Number(process.argv[4] || 2);

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const attachment = db.prepare(
    'SELECT local_path, file_name, width, height FROM discord_attachments WHERE message_id = ? AND attachment_id = ?',
  ).get(messageId, attachmentId);
  if (!attachment) throw new Error(`no attachment ${attachmentId} on message ${messageId}`);
  db.close();

  const file = path.join(ROOT, attachment.local_path);
  console.log(`[ocr-full] ${attachment.file_name} (${attachment.width}x${attachment.height}) scale ${scale}`);
  const started = Date.now();
  const buffer = await preprocessChartStreamRawToBuffer(file, {
    overlayRegion: { x: 0, y: 0, w: 1, h: 1 },
    overlayScale: scale,
  });
  const tmp = path.join(path.dirname(file), `.ocr-full-input.png`);
  fs.writeFileSync(tmp, buffer);
  const result = await runEasyOcr(tmp, {});
  try { fs.unlinkSync(tmp); } catch { /* the temp file is not worth a failure */ }
  const seconds = Math.round((Date.now() - started) / 1000);

  const cachePath = path.join(
    path.dirname(file),
    `${path.basename(file, path.extname(file))}.ocr.full.json`,
  );
  const payload = { text: result.text, words: result.words || [], seconds, scale };
  fs.writeFileSync(cachePath, JSON.stringify(payload));
  console.log(`[ocr-full] ${payload.words.length} words in ${seconds}s -> ${path.relative(ROOT, cachePath)}`);
}

main().catch((error) => {
  console.error(`[ocr-full] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
