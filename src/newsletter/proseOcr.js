'use strict';

/**
 * Reading the PROSE out of a rendered page.
 *
 * WHY THE PROSE NEEDS OCR AT ALL
 *
 * These documents are "Microsoft Print to PDF" renders of a Substack
 * post, and the body text of those renders is drawn as VECTOR OUTLINES
 * rather than as text. Measured on 20261112.pdf page 21:
 *
 *     BT / ET / TJ text blocks .... 6      the headings and the chrome
 *     `l` (lineto) operators ...... 2,221   the prose, as outlines
 *     `c` (curveto) operators ..... 2,336   the prose, as outlines
 *
 * and cross-checked with a second engine: `pypdf` returns exactly what
 * `pymupdf` returns -- the two headings, and none of the paragraph
 * under them. The text layer is a free, exact index of the STRUCTURE
 * and is useless for the CONTENT.
 *
 * So the prose has to be OCR'd, and the pages have to be rasterised.
 *
 * WHY THE PROSE IS FILTERED BY HEIGHT
 *
 * A page is not only prose. It carries chart screenshots, screener
 * tables, tickers and axis labels, and Tesseract reads all of them --
 * the 20261112 screener table comes back as "11/29/2006 | 21 | 0 | LIE."
 *
 * The prose is set in the author's serif face at about 11 points, and
 * the chart ink is 6 to 8 points. At 200 DPI that is a difference of
 * roughly 30 pixels against 17 to 22, so the words that are PROSE are
 * the TALL ones, and the words that are chart ink are the short ones.
 *
 * The two are not a filter and a discard: a chart that carries a real
 * reading is a reading, and the setup extractor reads it separately.
 * What this filter does is stop a chart's axis labels from being
 * mistaken for the author's thesis.
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

/** The page segmentation mode: one uniform block of text. */
const OCR_PSM = '6';

/** The scale a page is rasterised at before the OCR. */
const PAGE_SCALE = 200;

/**
 * The height, in pixels at 200 DPI, below which a word is chart ink and
 * not prose.
 *
 * The prose is set at about 11 points, which is 30 pixels at 200 DPI.
 * The chart ink is 6 to 8 points, which is 17 to 22 pixels. The
 * threshold sits between them.
 */
const PROSE_MIN_HEIGHT = 24;

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: OCR_PSM,
          user_defined_dpi: String(PAGE_SCALE),
        });
      }
      return worker;
    })();
  }
  return workerPromise;
}

/**
 * Release the OCR worker.
 *
 * @returns {Promise<void>}
 */
async function closeWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

/**
 * Parse Tesseract's TSV output into per-word position records.
 *
 * @param {string} tsv
 * @returns {Array<{conf: number, height: number, left: number, text: string, top: number, width: number}>}
 */
function parseTsvWords(tsv) {
  if (!tsv || typeof tsv !== 'string') return [];
  const out = [];
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split('\t');
    if (cols.length < 12) continue;
    if (Number(cols[0]) !== 5) continue;
    const text = (cols[11] || '').trim();
    if (!text) continue;
    out.push({
      conf: Number(cols[10]),
      height: Number(cols[9]),
      left: Number(cols[6]),
      text,
      top: Number(cols[7]),
      width: Number(cols[8]),
    });
  }
  return out;
}

/**
 * OCR a page and return its words with their positions.
 *
 * The image is expected to be ALREADY rasterised at the scale the
 * thresholds are written for, so the word positions come back in the
 * image's own pixels and are not rescaled.
 *
 * @param {string} imagePath
 * @param {object} [options]
 * @param {number} [options.scale=PAGE_SCALE] the scale the image was rasterised at
 * @returns {Promise<{height: number, width: number, words: object[]}>}
 */
async function ocrPage(imagePath, options = {}) {
  const scale = options.scale || PAGE_SCALE;
  const source = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const worker = await getWorker();
  const result = await worker.recognize(imagePath, {}, { tsv: true });
  const words = parseTsvWords(result.data.tsv);
  return {
    height: source.info.height,
    scale,
    width: source.info.width,
    words,
  };
}

/**
 * The words that are prose rather than chart ink.
 *
 * @param {object[]} words
 * @param {number} [minHeight=PROSE_MIN_HEIGHT]
 * @returns {object[]}
 */
function selectProse(words, minHeight = PROSE_MIN_HEIGHT) {
  return (words || []).filter((word) => word.height >= minHeight && word.conf > 20);
}

/**
 * The words grouped into LINES.
 *
 * The grouping is by the vertical CENTRE, and the anchor of a line is
 * FIXED for the life of that line. A running average drifts, and a
 * drifting anchor pulls the next visual line up into this one -- which
 * is how "reclaim could is its direct" ended up on one line.
 *
 * @param {object[]} words
 * @returns {Array<{bottom: number, height: number, members: object[], top: number}>}
 */
function groupLines(words) {
  const list = (words || []).filter((word) => word.text && word.text.trim());
  if (!list.length) return [];

  const heights = list.map((word) => word.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;
  const tolerance = Math.max(6, medianHeight * 0.4);

  const centred = list
    .map((word) => ({ ...word, centre: word.top + word.height / 2 }))
    .sort((a, b) => a.centre - b.centre);

  const groups = [];
  let anchor = null;
  for (const word of centred) {
    if (anchor === null || Math.abs(word.centre - anchor) > tolerance) {
      anchor = word.centre;
      groups.push({ members: [word] });
      continue;
    }
    groups[groups.length - 1].members.push(word);
  }

  return groups.map((group) => ({
    bottom: Math.max(...group.members.map((word) => word.top + word.height)),
    height: Math.max(...group.members.map((word) => word.height)),
    members: group.members.slice().sort((a, b) => a.left - b.left),
    top: Math.min(...group.members.map((word) => word.top)),
  }));
}

/**
 * The vertical gap that starts a new paragraph.
 *
 * The prose is set at about 11 points with generous leading, so a line
 * of it is about 40 pixels apart at 200 DPI and a PARAGRAPH break is
 * about 90. A gap of 55 pixels therefore joins the lines of a paragraph
 * and separates the paragraphs.
 */
const PROSE_LINE_GAP = 55;

/**
 * The prose words, assembled into lines and paragraphs.
 *
 * The filter is on the LINE and not on the WORD, and that matters more
 * than it looks. A word's box is as tall as its own glyphs, and the
 * short words of English -- "a", "we", "to", "see" -- have no ascender
 * and no descender, so their boxes are barely half the height of the
 * line they sit in. Filtering the words by height drops exactly those
 * words, and a prose line comes out as "AVGO is direct competitor NVDA.
 * With all the uncertainty around NVDA" with the small words gone.
 *
 * A LINE always has a tall word in it -- the one with an ascender -- so
 * the height of the line says whether it is prose, and then every word
 * in it is kept.
 *
 * @param {object[]} words
 * @param {number} [lineGap=PROSE_LINE_GAP] the vertical gap that starts a new paragraph
 * @param {number} [minHeight=PROSE_MIN_HEIGHT] the height a prose line must reach
 * @returns {Array<{text: string, top: number}>}
 */
function assembleProse(words, lineGap = PROSE_LINE_GAP, minHeight = PROSE_MIN_HEIGHT) {
  const lines = groupLines(words).filter((line) => line.height >= minHeight);

  const paragraphs = [];
  for (const line of lines) {
    const text = line.members.map((word) => word.text).join(' ');
    const last = paragraphs[paragraphs.length - 1];
    if (!last || line.top - last.bottom > lineGap) {
      paragraphs.push({ bottom: line.bottom, text, top: line.top });
      continue;
    }
    last.text += ` ${text}`;
    last.bottom = line.bottom;
  }
  return paragraphs;
}

/**
 * The prose of a page, between two y positions.
 *
 * The bounds are in PDF POINTS -- the same unit the document's own text
 * blocks are measured in -- and the words are in the rasterised image's
 * pixels, so they are converted at 72 points to the inch.
 *
 * @param {object[]} words
 * @param {number} startY - where the prose starts, in page points
 * @param {number} [endY] - where it stops, in page points
 * @param {object} [options]
 * @returns {string} the prose, paragraphs separated by a blank line
 */
function proseBetween(words, startY, endY, options = {}) {
  const scale = (options.scale || PAGE_SCALE) / 72;
  const from = startY * scale;
  const to = endY === undefined || endY === null ? Infinity : endY * scale;
  const selected = (words || []).filter((word) => word.top >= from && word.top <= to);
  return assembleProse(selected, options.lineGap, options.minHeight || PROSE_MIN_HEIGHT)
    .map((paragraph) => paragraph.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The prose of a page, below a given y.
 *
 * @param {object[]} words
 * @param {number} topY - the y the prose starts at, in page points
 * @param {object} [options]
 * @returns {string}
 */
function proseBelow(words, topY, options = {}) {
  return proseBetween(words, topY, options.endY, options);
}

module.exports = {
  OCR_PSM,
  PAGE_SCALE,
  PROSE_LINE_GAP,
  PROSE_MIN_HEIGHT,
  assembleProse,
  closeWorker,
  groupLines,
  ocrPage,
  parseTsvWords,
  proseBelow,
  proseBetween,
  selectProse,
};
