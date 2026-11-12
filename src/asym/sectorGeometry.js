/**
 * The GEOMETRY of the sector table inside a frame.
 *
 * WHY THIS EXISTS
 *
 * The table is a screen of a charting platform, and the screen is a
 * screen SHARE -- so the table is not laid out the same way in every
 * video. Measured over the twenty four posts in the corpus:
 *
 *   - the "Company" column is a different width in every post, because
 *     the chart window is a different size, and the sector names are
 *     truncated to fit it ("Communication Se" in one post,
 *     "Communication Services" in the next);
 *   - the number of checkmark columns between the one month rate of
 *     change and the percent change changes too -- two of them in the
 *     2024 posts, four of them in the 2025 posts;
 *   - and in several posts another widget of the screen share overlaps
 *     the right hand side of the table, so the one year column is
 *     partly or wholly covered.
 *
 * A parser that hard codes the column positions therefore reads the
 * WRONG COLUMN on most posts, not merely nothing: on one post the
 * percent change column sat at x 289..328 while the parser was looking
 * at 240..300, so it read the left half of one number and the right
 * half of the next, and stored them together.
 *
 * So the columns are found, per frame, instead of assumed.
 *
 * HOW THE COLUMNS ARE FOUND
 *
 * The table is a GRID, and the grid's vertical rules are the panel's
 * most consistent feature: they are dim grey lines that run the full
 * height of the table, and they are found by counting, for every
 * column of pixels, how many rows of the table are crossed by a grey
 * line. A column of pixels that is crossed by a quarter of the table's
 * rows is a rule; a column of pixels that only meets the occasional
 * letter is not.
 *
 * The rules cut the table into CELLS. Which cell is which column is
 * then decided by what is IN it:
 *
 *   - the NAME cell is the first cell that holds sector names;
 *   - the one month rate of change is the cell right after it;
 *   - the percent change cell is the first cell to the right that
 *     holds a percent sign;
 *   - the one year rate of change is the cell right after THAT.
 *
 * The content decides, so a post with two checkmark columns and a post
 * with four are read the same way.
 */
'use strict';

/**
 * The grey of the grid rules.
 *
 * A rule is DARK: it is a hairline, not a glyph, so it is dimmer than
 * the white numbers and it is neither the red of a falling number nor
 * the green of a rising one. The band below excludes both, which is
 * what keeps the numbers themselves from being read as rules.
 */
const RULE_MIN = 30;
const RULE_MAX = 140;
const RULE_SPREAD = 12;

/**
 * How much of the scanned height a column of pixels must be crossed by
 * before it counts as a rule.
 *
 * A quarter of the table's height is far above what a letter or a
 * number can produce, and far below what a rule produces.
 */
const RULE_COVERAGE = 0.25;

/**
 * Two rules closer than this are the same rule.
 */
const RULE_MERGE_GAP = 3;

/**
 * Count the rows of the table that a rule crosses, for every column of
 * pixels.
 *
 * @param {Buffer} raw - the frame's raw pixels
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, height: number, xMax: number}} options
 * @returns {Int32Array} the count, per column of pixels
 */
function ruleCounts(raw, info, options) {
  const top = options.top === undefined ? 0 : options.top;
  const height = options.height === undefined ? info.height : options.height;
  const xMax = Math.max(0, Math.min(options.xMax === undefined ? info.width : options.xMax, info.width));
  const yStart = Math.max(0, Math.min(info.height, top + 30));
  const yEnd = Math.max(yStart, Math.min(info.height, top + height - 20));
  const counts = new Int32Array(xMax);
  for (let x = 0; x < xMax; x += 1) {
    let n = 0;
    for (let y = yStart; y < yEnd; y += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = raw[offset];
      const g = raw[offset + 1];
      const b = raw[offset + 2];
      if (Math.abs(r - g) >= RULE_SPREAD) continue;
      if (Math.abs(g - b) >= RULE_SPREAD) continue;
      if (r <= RULE_MIN || r >= RULE_MAX) continue;
      n += 1;
    }
    counts[x] = n;
  }
  return counts;
}

/**
 * The vertical rules of the table, in frame pixels.
 *
 * @param {Buffer} raw - the frame's raw pixels
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, height: number, xMax: number}} options
 * @returns {number[]} the x positions of the rules, left to right
 */
function detectSeparators(raw, info, options = {}) {
  const top = options.top === undefined ? 0 : options.top;
  const height = options.height === undefined ? info.height : options.height;
  const xMax = Math.max(0, Math.min(options.xMax === undefined ? info.width : options.xMax, info.width));
  const yStart = Math.max(0, Math.min(info.height, top + 30));
  const yEnd = Math.max(yStart, Math.min(info.height, top + height - 20));
  const rows = Math.max(1, yEnd - yStart);
  const threshold = Math.max(20, Math.round(rows * RULE_COVERAGE));
  const counts = ruleCounts(raw, info, { top, height, xMax });

  const peaks = [];
  for (let x = 2; x < xMax - 2; x += 1) {
    const value = counts[x];
    if (value < threshold) continue;
    if (value < counts[x - 1] || value < counts[x + 1]) continue;
    if (value < counts[x - 2] || value < counts[x + 2]) continue;
    peaks.push({ x, value });
  }

  // Two rules one pixel apart are one thick rule.
  const merged = [];
  for (const peak of peaks) {
    const last = merged[merged.length - 1];
    if (last && peak.x - last.x < RULE_MERGE_GAP) {
      if (peak.value > last.value) merged[merged.length - 1] = peak;
      continue;
    }
    merged.push(peak);
  }
  return merged.map((peak) => peak.x);
}

/**
 * The cells the rules cut the panel into.
 *
 * @param {number[]} separators - the rules, left to right
 * @param {number} xEnd - the right hand edge of the region scanned
 * @returns {Array<{left: number, right: number}>}
 */
function cellsFromSeparators(separators, xEnd) {
  const edges = [0];
  for (const separator of separators) {
    if (separator > edges[edges.length - 1]) edges.push(separator);
  }
  edges.push(xEnd);
  const cells = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (edges[i + 1] > edges[i]) cells.push({ left: edges[i], right: edges[i + 1] });
  }
  return cells;
}

/**
 * The cell a pixel belongs to.
 *
 * @param {Array<{left: number, right: number}>} cells
 * @param {number} x - the pixel's position
 * @returns {number} the cell's index, or -1 when it is outside them
 */
function cellAt(cells, x) {
  for (let i = 0; i < cells.length; i += 1) {
    if (x >= cells[i].left && x < cells[i].right) return i;
  }
  return -1;
}

module.exports = {
  RULE_COVERAGE,
  RULE_MAX,
  RULE_MERGE_GAP,
  RULE_MIN,
  RULE_SPREAD,
  cellAt,
  cellsFromSeparators,
  detectSeparators,
  ruleCounts,
};
