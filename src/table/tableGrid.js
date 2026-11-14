'use strict';

/**
 * The GEOMETRY of a table in an image.
 *
 * WHY A SHARED MODULE
 *
 * Two sources in this project now read a table out of an image: the
 * AsymTrading sector table, and the O'Connell position log. They are the
 * same problem with different column sets -- a grid whose cells have to be
 * found rather than assumed, because the table is a screen of a charting
 * platform or a screenshot of a spreadsheet and neither is laid out the
 * same way twice.
 *
 * This module holds the mechanics, and the source-specific code holds the
 * column names. `src/asym/sectorGeometry.js` is NOT touched: it measures
 * DIM GREY rules on a dark video frame, which is a different problem from
 * the PURE BLACK rules on a white spreadsheet, and the project's standing
 * rule is that shared code does not change underneath a source that
 * depends on it without its own measurement.
 *
 * WHAT THE RULES LOOK LIKE
 *
 * A spreadsheet screenshot draws its grid in pure black, and its cell
 * borders are the only continuous black lines in the image. The FILLED
 * cells are coloured -- a solid red (#FF0000, luma 53) behind a white
 * "BELOW", a solid green behind a black "ABOVE" -- and those fills are
 * what makes a naive detector fail: a column of pixels running through a
 * red cell is "dark" for the whole height of the cell, so it looks
 * exactly like a rule.
 *
 * So the rules are found by NEAR-BLACK (luma <= 40), which the fills are
 * not, and by CONTINUITY: a rule is black down the whole band, while
 * text is black only where a glyph stroke happens to be.
 *
 * Measured on the 20261112 position log, whose rules are at y =
 * 8, 49, 99, 136, 171, 206, 241, 268, 310, 362, 400, 435, 470 and whose
 * columns are at x = 6, 85, 184, 270, 443, 548, 653, 762, 854, 937,
 * 1029, 1352, 1443, 1552, 1657.
 */

/** The luma at or below which a pixel counts as ink-black. */
const INK_LUMA = 40;

/** How much of a band a rule must cross to be a rule. */
const RULE_COVERAGE = 0.85;

/**
 * The luma of a pixel.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The raw pixels of an image, as RGB triples.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number} x
 * @param {number} y
 * @returns {{r: number, g: number, b: number}}
 */
function pixelAt(raw, info, x, y) {
  const offset = (y * info.width + x) * info.channels;
  return { b: raw[offset + 2], g: raw[offset + 1], r: raw[offset] };
}

/**
 * The horizontal rules of a table: the rows of pixels that a border
 * crosses from end to end.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{xStart: number, xEnd: number, minCoverage?: number}} options
 * @returns {number[]} the y positions of the rules, ascending
 */
function findHorizontalRules(raw, info, options) {
  const xStart = Math.max(0, Math.floor(options.xStart || 0));
  const xEnd = Math.min(info.width, Math.floor(options.xEnd || info.width));
  const span = Math.max(1, xEnd - xStart);
  const minCoverage = options.minCoverage === undefined ? 0.6 : options.minCoverage;
  const threshold = Math.max(4, Math.round(span * minCoverage));

  const rules = [];
  for (let y = 0; y < info.height; y += 1) {
    let dark = 0;
    for (let x = xStart; x < xEnd; x += 1) {
      const pixel = pixelAt(raw, info, x, y);
      if (luma(pixel.r, pixel.g, pixel.b) <= INK_LUMA) dark += 1;
    }
    if (dark >= threshold) rules.push(y);
  }
  return rules;
}

/**
 * The vertical rules of a table, over a band of rows.
 *
 * The band matters: measuring over a band that crosses a FILLED cell
 * finds the fill's columns as well as the rules, and a filled column
 * reads as "dark down the whole band". Measuring over a band of DATA
 * ROWS only, and with near-black, avoids it.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{yStart: number, yEnd: number, minCoverage?: number}} options
 * @returns {number[]} the x positions of the rules, ascending
 */
function findVerticalRules(raw, info, options) {
  const yStart = Math.max(0, Math.floor(options.yStart || 0));
  const yEnd = Math.min(info.height, Math.floor(options.yEnd || info.height));
  const span = Math.max(1, yEnd - yStart);
  const minCoverage = options.minCoverage === undefined ? RULE_COVERAGE : options.minCoverage;
  const threshold = Math.max(4, Math.round(span * minCoverage));

  const rules = [];
  for (let x = 0; x < info.width; x += 1) {
    let dark = 0;
    for (let y = yStart; y < yEnd; y += 1) {
      const pixel = pixelAt(raw, info, x, y);
      if (luma(pixel.r, pixel.g, pixel.b) <= INK_LUMA) dark += 1;
    }
    if (dark >= threshold) rules.push(x);
  }
  return rules;
}

/**
 * The bands between consecutive rules.
 *
 * @param {number[]} rules - the rule positions, ascending
 * @param {{from: number, to: number}} bounds
 * @returns {Array<{top: number, bottom: number}>} the bands, top to bottom
 */
function bandsBetween(rules, bounds) {
  const edges = [bounds.from];
  for (const rule of rules) {
    if (rule > edges[edges.length - 1] && rule < bounds.to) edges.push(rule);
  }
  edges.push(bounds.to);

  const bands = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (edges[i + 1] > edges[i]) bands.push({ bottom: edges[i + 1] - 1, top: edges[i] });
  }
  return bands;
}

/**
 * The cells the rules cut a band into.
 *
 * @param {number[]} rules - the vertical rules, ascending
 * @param {{from: number, to: number}} bounds
 * @returns {Array<{left: number, right: number}>}
 */
function cellsBetween(rules, bounds) {
  const edges = [bounds.from];
  for (const rule of rules) {
    if (rule > edges[edges.length - 1] && rule < bounds.to) edges.push(rule);
  }
  edges.push(bounds.to);

  const cells = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (edges[i + 1] > edges[i]) cells.push({ left: edges[i], right: edges[i + 1] - 1 });
  }
  return cells;
}

/**
 * How much ink a band holds, and how many separate runs of it.
 *
 * The run count is what tells a TITLE band from a HEADER band: a title is
 * one line of text across the middle, so it is one or two runs, and a
 * header is a row of column names, so it is a dozen.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @returns {{ink: number, runs: number, pixels: number}}
 */
function bandInk(raw, info, rect) {
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));

  let ink = 0;
  const columnHasInk = new Uint8Array(Math.max(0, right - left + 1));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const pixel = pixelAt(raw, info, x, y);
      if (luma(pixel.r, pixel.g, pixel.b) > INK_LUMA) continue;
      ink += 1;
      columnHasInk[x - left] = 1;
    }
  }

  let runs = 0;
  let previous = 0;
  for (let i = 0; i < columnHasInk.length; i += 1) {
    if (columnHasInk[i] && !previous) runs += 1;
    previous = columnHasInk[i];
  }

  return { ink, pixels: Math.max(1, (bottom - top + 1) * (right - left + 1)), runs };
}

/**
 * The connected components of dark ink inside a rectangle.
 *
 * This is how the position-sizing STARS are counted. Tesseract cannot
 * read them -- it returns "w WK" for "★★" and "R223" for "★" -- because
 * a five-pointed star is not a character in any training set. But a star
 * IS a shape: measured on the 20261112 position log, each star is a
 * 17x16 pixel blob with 130 ink pixels, and a cell holding three of them
 * holds exactly three.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {{minArea?: number, maxInk?: number}} [options]
 * @returns {Array<{area: number, height: number, left: number, top: number, width: number}>}
 */
function inkComponents(raw, info, rect, options = {}) {
  const minArea = options.minArea === undefined ? 40 : options.minArea;
  const maxInk = options.maxInk === undefined ? INK_LUMA : options.maxInk;

  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));
  const width = Math.max(0, right - left + 1);
  const height = Math.max(0, bottom - top + 1);
  if (!width || !height) return [];

  const seen = new Uint8Array(width * height);
  const components = [];

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = (y - top) * width + (x - left);
      if (seen[index]) continue;
      const pixel = pixelAt(raw, info, x, y);
      if (luma(pixel.r, pixel.g, pixel.b) > maxInk) continue;

      const stack = [[x, y]];
      seen[index] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < left || nx > right || ny < top || ny > bottom) continue;
            const nextIndex = (ny - top) * width + (nx - left);
            if (seen[nextIndex]) continue;
            const nextPixel = pixelAt(raw, info, nx, ny);
            if (luma(nextPixel.r, nextPixel.g, nextPixel.b) > maxInk) continue;
            seen[nextIndex] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      if (area >= minArea) {
        components.push({
          area,
          height: maxY - minY + 1,
          left: minX,
          top: minY,
          width: maxX - minX + 1,
        });
      }
    }
  }

  return components;
}

module.exports = {
  INK_LUMA,
  RULE_COVERAGE,
  bandsBetween,
  cellsBetween,
  findHorizontalRules,
  findVerticalRules,
  inkComponents,
  luma,
  pixelAt,
};
