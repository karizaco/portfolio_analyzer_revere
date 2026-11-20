'use strict';

/**
 * Tesseract OCR of a downloaded photo, cached by content.
 *
 * Two uses: a FREE first reading of every image (its words, a v1 class, the
 * tickers it shows), and the EVIDENCE the vision reader's rows are checked
 * against (src/x/images/crossCheck.js).
 *
 * The cache key is (md5, engine, parser version) in the untracked index:
 * the same file is never read twice, and a change to this reader (bump
 * OCR_VERSION) invalidates its own entries and nothing else -- the
 * asym_frame_ocr rule. Sparse-text page segmentation (PSM 11) is used
 * because a screenshot is not a page: its text sits in scattered cells.
 *
 * EasyOCR is NOT used here. If a later measurement shows Tesseract fails a
 * class of screenshot, EasyOCR goes through src/ocr/easyocrAdapter.js and
 * `--low-cpu`, never directly.
 */

const fs = require('node:fs');
const path = require('node:path');

const OCR_VERSION = 'x-ocr-1';
const ENGINE = 'tesseract';
const ROOT = path.resolve(__dirname, '..', '..', '..');

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // eslint-disable-next-line global-require
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng');
      await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '11' });
      return worker;
    })();
  }
  return workerPromise;
}

/** A Tesseract worker keeps the event loop alive; a finished tool must close it. */
async function closeWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

/**
 * Parse Tesseract TSV into words (with their line, for line grouping).
 *
 * @param {string} tsv
 * @returns {Array<{text: string, conf: number, left: number, top: number, width: number, height: number, line: string}>}
 */
function parseTsv(tsv) {
  const out = [];
  for (const line of String(tsv || '').split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12 || Number(cols[0]) !== 5) continue;
    const text = (cols[11] || '').trim();
    if (!text) continue;
    out.push({
      text,
      conf: Number(cols[10]),
      left: Number(cols[6]),
      top: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      line: `${cols[2]}.${cols[3]}.${cols[4]}`,
    });
  }
  return out;
}

/**
 * OCR one image file.
 *
 * @param {string} file
 * @returns {Promise<{words: object[], text: string, width: number, height: number, meanConf: number|null}>}
 */
async function ocrFile(file) {
  // eslint-disable-next-line global-require
  const sharp = require('sharp');
  const meta = await sharp(file).metadata();
  const scale = meta.width && meta.width < 1600 ? 2 : 1;
  const width = Math.round((meta.width || 0) * scale);
  const height = Math.round((meta.height || 0) * scale);
  const buffer = await sharp(file).resize({ width: width || undefined }).grayscale().png().toBuffer();
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer, {}, { tsv: true });
  const words = parseTsv(data.tsv);
  const lines = new Map();
  for (const word of words) {
    if (!lines.has(word.line)) lines.set(word.line, []);
    lines.get(word.line).push(word.text);
  }
  const confs = words.map((word) => word.conf).filter((conf) => conf >= 0);
  return {
    words,
    text: [...lines.values()].map((parts) => parts.join(' ')).join('\n'),
    width,
    height,
    meanConf: confs.length ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1)) : null,
  };
}

/**
 * The cached OCR of an image, or a fresh one (then cached).
 *
 * @param {import('node:sqlite').DatabaseSync} indexDb
 * @param {{md5: string, local_path: string}} media
 * @returns {Promise<{words: object[], text: string, width: number, height: number, meanConf: number|null, cached: boolean}>}
 */
async function ocrMedia(indexDb, media) {
  const cached = indexDb.prepare('SELECT * FROM x_image_ocr WHERE md5 = ? AND engine = ? AND parser_version = ?')
    .get(media.md5, ENGINE, OCR_VERSION);
  if (cached) {
    const extra = JSON.parse(cached.words_json || '{}');
    return { words: extra.words || [], text: cached.text, width: extra.width, height: extra.height, meanConf: cached.mean_conf, cached: true };
  }
  const file = path.resolve(ROOT, media.local_path);
  if (!fs.existsSync(file)) throw new Error(`image missing on disk: ${media.local_path}`);
  const result = await ocrFile(file);
  indexDb.prepare(`INSERT OR REPLACE INTO x_image_ocr (md5, engine, parser_version, text, words_json, mean_conf, ocr_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(media.md5, ENGINE, OCR_VERSION, result.text,
    JSON.stringify({ words: result.words, width: result.width, height: result.height }), result.meanConf, new Date().toISOString());
  return { ...result, cached: false };
}

module.exports = { ENGINE, OCR_VERSION, closeWorker, ocrFile, ocrMedia, parseTsv };
