'use strict';

/**
 * The theme TITLES of a Komar market card, found by their COLOUR.
 *
 * WHY THE COLOUR AND NOT THE OCR
 *
 * The card prints the theme names in ORANGE -- "Semis", "Data centers",
 * "Software" -- on a green card, and the OCR reads the whole card as
 * ONE LINE, so the name and its description and its leaders end up in
 * the same string and the name cannot be told from the description.
 *
 * The orange is unmistakable, though: it is the card's only accent
 * colour, and it appears on the theme titles and on the exposure
 * badge. So the theme titles are found as ORANGE INK BANDS, split into
 * their separate titles by the horizontal gap between them, and each
 * one is read on its own.
 *
 * That gives the theme names in the order they are printed, which is
 * the order the leader groups are in -- so the names and the leaders
 * can be matched up.
 *
 * The badge is excluded by POSITION: it is in the card's upper third,
 * and the theme titles are in the lower half.
 */

const { readCell, readRegionText } = require('../table/tableReader');

/**
 * The orange of the theme titles.
 *
 * Measured on the corpus's own cards: rgb(232,151,57) and its
 * neighbours, against a card background of rgb(38,87,25) and white text.
 */
const ORANGE = Object.freeze({ bMax: 120, gMax: 200, gMin: 85, rBlue: 85, rMin: 165 });

/** The fewest orange pixels in a row for the row to count. */
const MIN_ROW_PIXELS = 6;

/**
 * The horizontal gap that separates two theme titles, in pixels.
 */
const TITLE_GAP = 28;

/**
 * Is this pixel the card's accent orange?
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
function isAccentPixel(r, g, b) {
  if (r < ORANGE.rMin || r > 255) return false;
  if (g < ORANGE.gMin || g > ORANGE.gMax) return false;
  if (b > ORANGE.bMax) return false;
  return r - b > ORANGE.rBlue;
}

/**
 * The orange text boxes in an image.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} [options]
 * @param {number} [options.minTop] - the first row to consider
 * @returns {Array<{left:number,top:number,width:number,height:number}>}
 */
function findAccentBoxes(raw, info, options = {}) {
  const minTop = options.minTop || 0;
  const rows = [];

  for (let y = minTop; y < info.height; y += 1) {
    let count = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (!isAccentPixel(raw[offset], raw[offset + 1], raw[offset + 2])) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (count >= MIN_ROW_PIXELS) rows.push({ maxX, minX, y });
  }

  // Group the rows into bands.
  const bands = [];
  let current = null;
  for (const row of rows) {
    if (current && row.y <= current.bottom + 2) {
      current.bottom = row.y;
      current.left = Math.min(current.left, row.minX);
      current.right = Math.max(current.right, row.maxX);
      continue;
    }
    if (current) bands.push(current);
    current = { bottom: row.y, left: row.minX, right: row.maxX, top: row.y };
  }
  if (current) bands.push(current);

  // Split each band into its separate titles, at the gaps.
  const boxes = [];
  for (const band of bands) {
    const columns = [];
    for (let x = band.left; x <= band.right; x += 1) {
      let has = false;
      for (let y = band.top; y <= band.bottom; y += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (isAccentPixel(raw[offset], raw[offset + 1], raw[offset + 2])) {
          has = true;
          break;
        }
      }
      if (!has) continue;
      const last = columns[columns.length - 1];
      if (last && x - last.right <= TITLE_GAP) {
        last.right = x;
        continue;
      }
      columns.push({ left: x, right: x });
    }
    for (const column of columns) {
      boxes.push({
        bottom: band.bottom,
        height: band.bottom - band.top + 1,
        left: column.left,
        right: column.right,
        top: band.top,
        width: column.right - column.left + 1,
      });
    }
  }

  // Merge the WRAPPED titles.
  //
  // A two-word title wraps: "Fiber Optics" prints as "Fiber" over
  // "Optics", and the two words are two accent bands in the same
  // COLUMN. The bands are not adjacent in the list -- they are grouped
  // by row -- so the columns are found first, by horizontal overlap,
  // and the words are merged inside a column.
  const columns = [];
  for (const box of [...boxes].sort((a, b) => a.left - b.left)) {
    const column = columns.find((entry) => (
      box.left < entry.right && box.right > entry.left
    ));
    if (column) {
      column.boxes.push(box);
      column.left = Math.min(column.left, box.left);
      column.right = Math.max(column.right, box.right);
      continue;
    }
    columns.push({ boxes: [box], left: box.left, right: box.right });
  }

  const merged = [];
  for (const column of columns) {
    const sorted = [...column.boxes].sort((a, b) => a.top - b.top);
    for (const box of sorted) {
      const last = merged[merged.length - 1];
      const wraps = last
        && last.column === column
        && box.top > last.bottom
        && box.top - last.bottom <= 16;
      if (wraps) {
        last.bottom = box.bottom;
        last.left = Math.min(last.left, box.left);
        last.right = Math.max(last.right, box.right);
        last.height = last.bottom - last.top + 1;
        last.width = last.right - last.left + 1;
        continue;
      }
      merged.push({ ...box, column });
    }
  }

  merged.sort((a, b) => a.left - b.left);
  return merged;
}

/**
 * Is an accent box a TITLE, or a piece of the card's furniture?
 *
 * THE 2025 CARD'S BOXES ARE DOTTED, AND THE DOTS ARE THE ACCENT
 * COLOUR TOO.
 *
 * The 2025-01-25 card draws its four theme boxes with a DOTTED yellow
 * border, and the dots are the same colour as the titles -- so the
 * accent search finds the BORDERS as well as the titles: 32 boxes
 * where there are four titles, and a name that is off by one is worse
 * than no name at all.
 *
 * THE DISCRIMINATOR IS THE ROWS, NOT THE DENSITY.
 *
 * Density does not separate them: the 2025 titles are thin strokes in
 * a wide box (an ink ratio of 0.035 to 0.070) while a one-pixel
 * fragment of a dotted border has a ratio of 1.0. But a TITLE has ink
 * on EVERY ROW -- it is glyphs -- and a dotted border has empty rows
 * between its dots. So the test is the fraction of the box's rows
 * that carry ink.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {{left:number,top:number,right:number,bottom:number}} box
 * @returns {boolean}
 */
function isTitleBox(raw, info, box) {
  // A title is a WORD, and a word is big enough to be one: the
  // corpus's titles are 22 px tall and the shortest ("Oil") is 38 px
  // wide. A fragment of a dotted border is 7 px across.
  if (box.right - box.left + 1 < 25) return false;
  if (box.bottom - box.top + 1 < 12) return false;
  const left = Math.max(0, Math.floor(box.left));
  const right = Math.min(info.width - 1, Math.floor(box.right));
  const top = Math.max(0, Math.floor(box.top));
  const bottom = Math.min(info.height - 1, Math.floor(box.bottom));
  const rows = Math.max(1, bottom - top + 1);
  let withInk = 0;
  for (let y = top; y <= bottom; y += 1) {
    let ink = 0;
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (isAccentPixel(raw[offset], raw[offset + 1], raw[offset + 2])) ink += 1;
    }
    if (ink) withInk += 1;
  }
  return withInk / rows >= 0.6;
}

/**
 * A copy of the pixels with the ACCENT ink in black and the rest white.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {{left:number,top:number,right:number,bottom:number}} rect
 * @returns {Buffer}
 */
function accentInk(raw, info, rect) {
  const out = Buffer.from(raw);
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const accent = isAccentPixel(raw[offset], raw[offset + 1], raw[offset + 2]);
      out[offset] = accent ? 0 : 255;
      out[offset + 1] = accent ? 0 : 255;
      out[offset + 2] = accent ? 0 : 255;
    }
  }
  return out;
}

/** The smallest width a title crop is read at, in pixels. */
const MIN_TITLE_WIDTH = 300;

/**
 * The theme titles of a card, with their positions.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} [options]
 * @param {number} [options.minTop] - the first row to consider
 * @param {number} [options.scale] - the OCR upscale
 * @returns {Promise<Array<{text: string, left: number, right: number, top: number, bottom: number}>>}
 */
async function readAccentTitleBoxes(raw, info, options = {}) {
  const boxes = findAccentBoxes(raw, info, options);
  const titles = [];
  for (const box of boxes) {
    // The dotted borders of the 2025 card are the accent colour too,
    // and they are not titles.
    if (!isTitleBox(raw, info, box)) continue;
    const width = Math.max(1, box.right - box.left + 1);
    // A title crop is read at a scale that brings it to a readable
    // width: the corpus's titles are 22 px tall, and a 38 px box at 4x
    // is 152 px -- too small for a short word.
    const scale = Math.max(options.scale || 4, Math.ceil(MIN_TITLE_WIDTH / width));
    const rect = {
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      top: box.top,
    };
    // TWO READINGS, and the first that holds up wins.
    //
    // The card prints the titles in orange ON a dark green chart
    // photograph, with a green drop shadow behind them, and Tesseract
    // reading the crop as it is sees the shadow as part of the glyphs.
    // Read as PURE INK the shadow and the chart are not in the picture
    // -- but the 2025 card's titles are a dim gold that the ink
    // threshold drops, and they read better as they are. So both are
    // read, and a reading is only accepted if it looks like WORDS.
    const candidates = [];
    try {
      candidates.push(await readCell(raw, info, rect, { scale }));
    } catch { /* the crop cannot be read */ }
    try {
      const ink = accentInk(raw, info, rect);
      candidates.push(await readCell(ink, info, rect, { scale }));
    } catch { /* the ink cannot be read */ }
    for (const candidate of candidates) {
      const clean = (candidate.words || [])
        .map((word) => String(word.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      // A title is a short, word-like string. A long one is the badge,
      // a footnote or a chart label, and it is dropped.
      if (!clean || clean.length > 28) continue;
      if (!/[A-Za-z]/.test(clean)) continue;
      // A title is WORDS AND NOTHING ELSE. The 2025 card's dotted
      // borders merge with its titles into boxes that read "{i
      // Datacenter || Chips", and a name with braces in it is not a
      // name.
      if (!/^[A-Za-z][A-Za-z ]*$/.test(clean)) continue;
      if ((clean.match(/[A-Za-z]/g) || []).length < 3) continue;
      // A title is WORDS. A band that reads as "ry _ 9.4 [ ] | | J | -— 1"
      // is chart ink that happened to be orange, and it is dropped --
      // a name that is off by one is worse than no name at all.
      const letters = (clean.match(/[A-Za-z]/g) || []).length;
      if (letters / clean.length < 0.72) continue;
      titles.push({
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        text: clean,
        top: box.top,
      });
      break;
    }
  }
  return titles;
}

/**
 * The theme titles of a card, read from the accent ink.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} [options]
 * @param {number} [options.minTop] - the first row to consider
 * @param {number} [options.scale] - the OCR upscale
 * @returns {Promise<string[]>}
 */
async function readAccentTitles(raw, info, options = {}) {
  const titles = await readAccentTitleBoxes(raw, info, options);
  return titles.map((title) => title.text);
}

module.exports = {
  ORANGE,
  TITLE_GAP,
  accentInk,
  findAccentBoxes,
  isAccentPixel,
  isTitleBox,
  readAccentTitleBoxes,
  readAccentTitles,
};




