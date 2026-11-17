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

const { readRegionText } = require('../table/tableReader');

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
  const boxes = findAccentBoxes(raw, info, options);
  const titles = [];
  for (const box of boxes) {
    const scale = options.scale || 4;
    try {
      const text = await readRegionText(raw, info, box, scale);
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      // A title is a short, word-like string. A long one is the badge,
      // a footnote or a chart label, and it is dropped.
      if (!clean || clean.length > 28) continue;
      if (!/[A-Za-z]/.test(clean)) continue;
      // A title is WORDS. A band that reads as "ry _ 9.4 [ ] | | J | -— 1"
      // is chart ink that happened to be orange, and it is dropped --
      // a name that is off by one is worse than no name at all.
      const letters = (clean.match(/[A-Za-z]/g) || []).length;
      if (letters / clean.length < 0.72) continue;
      titles.push(clean);
    } catch {
      // A title that cannot be read is skipped, not fatal.
    }
  }
  return titles;
}

module.exports = {
  ORANGE,
  TITLE_GAP,
  findAccentBoxes,
  isAccentPixel,
  readAccentTitles,
};




