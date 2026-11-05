'use strict';

// Reading the positions panel's own row count from a video frame.
//
// WHY
//
// The panel prints how many rows it has, and that count is the project's only
// INDEPENDENT check on a reading: a reading with a different number of
// tickers has provably dropped a row or invented one.
//
// `readPanelRowCount` (src/parse/parseChartStream.js) implements the reading,
// but in production it returns `null` on every capture, because the footer is
// below the crop the OCR engine is shown. The crops end at source y 950 (2022
// floating panel) and y 994 (2023 right sidebar), and the footer sits below
// both.
//
// The crop cannot simply be made taller: it is also the capture-dedup pHash
// rectangle, and a taller crop is downscaled more by EasyOCR -- the measured
// mechanism behind the `trade_ideas` 9/9 -> 7/9 regression. So the footer
// gets its own strip.
//
// THE ENGINE IS NOT THE PROJECT'S DEFAULT, AND THAT IS THE POINT
//
// Measured on the same pixels (qmg_20220218.png, "3 of 9 Items in Personal
// WatchList"):
//
//   EasyOCR     "30 Iem inecronal acha LiX"           garbage at 6x, 8x, 12x
//   Tesseract   "3 of 9 Items In Personal Watchlist"  exact
//
// EasyOCR's failure is worse than a miss: "3 of 9" collapses to "30", so the
// COUNT would be read WRONG rather than not at all.
//
// That inversion is consistent with CLAUDE.md's own engine table rather than a
// surprise. The footer is a line of printed prose, which is what Tesseract
// (document-trained) is for; the ticker column is short isolated tokens on a
// dark panel, which is what EasyOCR (scene-text-trained) is for. The right
// engine follows the TEXT.
//
// THE COUNT IS REPORTED, NEVER ACTED ON
//
// Same rule as `readPanelRowCount`: a count misread LOW would truncate a
// correct reading, which is exactly the case where acting on it does the most
// damage. So nothing downstream drops or adds a ticker because of this
// number. It is published in the probe log as a diagnostic.
//
// COST
//
// One Tesseract worker, on up to five small strips, for the SELECTED capture
// of a video -- not per frame. Tesseract is ~2 s per strip against EasyOCR's
// ~60 s, so the whole footer read is a few seconds per video.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const {
  panelFooterStripsForDate,
  readPanelFooterText,
  resolvePanelFooterVotes,
} = require('./panelFooter');

// The source frame, cropped to one band, upscaled. Tesseract wants a plain
// greyscale PNG, and the source is 1080p, so the strip is small.
async function cutFooterStrip(sourcePath, strip, outPath) {
  const meta = await sharp(sourcePath).metadata();
  const left = Math.round(strip.x * meta.width);
  const top = Math.round(strip.y * meta.height);
  const width = Math.min(Math.round(strip.w * meta.width), meta.width - left);
  const height = Math.min(Math.round(strip.h * meta.height), meta.height - top);
  if (width < 16 || height < 8) return null;
  await sharp(sourcePath)
    .extract({ left, top, width, height })
    .resize({ width: width * strip.upscale, kernel: 'lanczos3' })
    .grayscale()
    .normalise()
    .png()
    .toFile(outPath);
  return { left, top, width, height };
}

/**
 * Read the panel's row count from a source frame.
 *
 * @param {string} framePath a full-resolution frame of the video (PNG/JPG)
 * @param {string} dateKey the upload date, which selects the band's x window
 * @returns {Promise<{count:number,votes:number,bands:number[],text:string,
 *                    rejected:Array}|null>}
 */
async function readPanelFooterFromFrame(framePath, dateKey) {
  if (!framePath || !fs.existsSync(framePath)) return null;
  const strips = panelFooterStripsForDate(dateKey);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-footer-'));
  let worker = null;
  const readings = [];
  try {
    for (const strip of strips) {
      const stripPath = path.join(tmpDir, `band_${String(strip.y).replace('.', '_')}.png`);
      const geom = await cutFooterStrip(framePath, strip, stripPath);
      if (!geom) continue;
      if (!worker) worker = await createWorker('eng');
      const result = await worker.recognize(stripPath);
      const read = readPanelFooterText(String((result.data && result.data.text) || ''));
      readings.push({ count: read ? read.count : null, band: strip.y, text: read ? read.text : null });
    }
  } catch (error) {
    // The footer is a diagnostic. A failure to read it must not fail the
    // scan -- the reading itself is unaffected.
    return null;
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* the worker is going away */ }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
  return resolvePanelFooterVotes(readings);
}

module.exports = { readPanelFooterFromFrame, cutFooterStrip };
