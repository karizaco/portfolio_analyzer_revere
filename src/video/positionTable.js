'use strict';

const sharp = require('sharp');

// TradingView renders the Qullamaggie position list as a real GUI table, not a
// chart overlay:
//
//   ┌──────────────────────────────────────────────┐
//   │ A - Positions   (+)  Sym   ▮▮   ☰           │  title bar
//   ├──────┬───────────┬────────────────┬──────────┤
//   │ Flag │    Sym    │   % Change     │    ▲     │  column-header row
//   ├──────┼───────────┼────────────────┼──────────┤
//   │  🚩  │   UPST    │   +12.4%       │          │  data row
//   │  🚩  │   DVN     │   -3.1%        │          │  data row
//   └──────┴───────────┴────────────────┴──────────┘
//
// The geometry of that table is far more reliable than any OCR read of it, so
// this module recovers the structure from pixels alone:
//
//   * grid lines        -> row slots and column slots
//   * column-header row -> which column is the ticker column ("Sym")
//   * data rows         -> one cell per holding
//
// Nothing here depends on OCR. The caller OCRs the header strip to name the
// columns and the cells to read the tickers.
//
// Why geometry rather than OCR word boxes: at 1080p the ticker glyphs are
// ~6.8 src px tall and ~6 src px wide. That is below the resolution at which
// a detector reliably splits a ticker from the price column next to it —
// measured on 20230608, EasyOCR merged ticker+%change into a single box
// ("42122831 13,33"). Grid lines and row pitch survive that; text detection
// does not.

// --- pixel classification -------------------------------------------------
//
// Measured on the 20220218 panel crop (a 5x upscale of src 1795-1821):
//   table cell background   rgb(0,0,0)      exactly black
//   table grid line         rgb(40..86)     achromatic, mid-toned
//   panel background        rgb(26..28)     darker than a grid line
//   chart background        rgb(27..69)     often achromatic — must not match
//   ticker glyphs           chroma-fringed white, sometimes achromatic
//
// The separator band is therefore narrow: a grid line is BRIGHTER than the
// panel background and DARKER than text. Anything looser (the earlier
// luma 26..210 test) matched the chart background and produced horizontal
// lines that ran off the end of the table.
//
// The chroma test is a SATURATION RATIO, not an absolute channel spread.
//
// An absolute spread of 12 assumed the grid line is perfectly grey. It is
// not: TradingView tints the table, and the tint shows up most strongly on
// the row that is highlighted (hover/selection). On 20230518 the rule
// between the IMGN and APLD rows measured rgb(72,73,57) — spread 16, luma
// 73 — and was rejected, which cost the table its last two rows.
//
// A ratio separates the two cases that matter: a grid line is a LOW
// saturation grey (16/73 = 0.22), while the panel's coloured content — the
// green and red percentages, the blue flag icon — is fully saturated
// (spread/luma approaching 1). Scaling by luma also keeps dark pixels from
// qualifying on the strength of a couple of counts.
const SEP_MAX_SATURATION = 0.3;
const SEP_MIN_LUMA = 32;     // above the panel background
const SEP_MAX_LUMA = 105;    // below white text

// A grid line must run at least this fraction of the image in its direction.
// A table clipped by the search window can still be a third of the crop.
const MIN_VERTICAL_RUN_FRACTION = 0.08;
const MIN_VERTICAL_RUN_PX = 12;

// Anti-aliasing spreads a 1px line over 2-8px; candidate pixels within this
// many px of each other belong to the same drawn line.
const LINE_MERGE_PX = 6;

// Fraction of a table's interior that must be separator-coloured for a row
// to count as a horizontal separator.
const SEPARATOR_ROW_FRACTION = 0.9;

async function loadRawRgb(imagePath) {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function medianOf(values) {
  if (!values.length) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function isSeparatorPixel(r, g, b, options = {}) {
  const minLuma = options.minLuma === undefined ? SEP_MIN_LUMA : options.minLuma;
  const maxLuma = options.maxLuma === undefined ? SEP_MAX_LUMA : options.maxLuma;
  const maxSaturation = options.maxSaturation === undefined ? SEP_MAX_SATURATION : options.maxSaturation;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < minLuma || mx > maxLuma) return false;
  return (mx - mn) <= mx * maxSaturation;
}

/**
 * Build the separator mask plus per-row prefix sums.
 *
 * The prefix sums make "how much of this span on this row is separator
 * coloured?" an O(1) query, which is what lets the table search try many
 * candidate spans without rescanning pixels.
 */
function buildSeparatorIndex(raw, options = {}) {
  const { data, width, height, channels } = raw;
  const mask = new Uint8Array(width * height);
  const rowPrefix = new Int32Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const rowBase = y * (width + 1);
    let acc = 0;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const sep = isSeparatorPixel(data[o], data[o + 1], data[o + 2], options) ? 1 : 0;
      mask[y * width + x] = sep;
      acc += sep;
      rowPrefix[rowBase + x + 1] = acc;
    }
  }
  return { mask, rowPrefix, width, height };
}

function separatorFraction(rowPrefix, width, y, left, right) {
  if (right < left) return 0;
  const base = y * (width + 1);
  const count = rowPrefix[base + right + 1] - rowPrefix[base + left];
  return count / (right - left + 1);
}

/** Longest contiguous separator run along one column. */
function longestRunInColumn(mask, width, height, x) {
  let best = { start: -1, length: 0 };
  let runStart = -1;
  for (let y = 0; y <= height; y++) {
    const on = y < height && mask[y * width + x] === 1;
    if (on) {
      if (runStart < 0) runStart = y;
    } else if (runStart >= 0) {
      if (y - runStart > best.length) best = { start: runStart, length: y - runStart };
      runStart = -1;
    }
  }
  return best.length > 0 ? best : null;
}

/**
 * Where a drawn vertical line starts, in a column.
 *
 * The topmost separator pixel is not the answer: the chart behind the panel
 * draws horizontal grid lines that cross the table's column separators, so
 * the topmost separator pixel of a column can be 150px above the table. What
 * distinguishes the table's own vertical line is that it is CONTINUOUS — so
 * the answer is the first y whose forward run is at least `minRun` pixels
 * long.
 */
function runStartInColumn(mask, width, height, x, minRun) {
  let y = 0;
  while (y < height) {
    if (mask[y * width + x] !== 1) { y++; continue; }
    let end = y;
    while (end < height && mask[end * width + x] === 1) end++;
    if (end - y >= minRun) return y;
    y = end;
  }
  return -1;
}

/** Merge candidate line pixels into drawn lines. */
function mergeLineBands(candidates, mergePx) {
  const bands = [];
  for (const cand of candidates) {
    const last = bands[bands.length - 1];
    if (last && cand.start <= last.end + mergePx) {
      last.end = cand.end;
    } else {
      bands.push({ start: cand.start, end: cand.end });
    }
  }
  return bands;
}

/**
 * Detect the vertical grid lines (column separators) of a frame.
 */
function detectVerticalLines(index) {
  const { mask, width, height } = index;
  const minRun = Math.max(MIN_VERTICAL_RUN_PX, Math.floor(height * MIN_VERTICAL_RUN_FRACTION));
  const candidates = [];
  for (let x = 0; x < width; x++) {
    const run = longestRunInColumn(mask, width, height, x);
    if (run && run.length >= minRun) {
      candidates.push({ start: x, end: x, runLength: run.length, y0: run.start, y1: run.start + run.length - 1 });
    }
  }
  return mergeLineBands(candidates, LINE_MERGE_PX).map((band) => {
    const members = candidates.filter((c) => c.start >= band.start && c.start <= band.end);
    const starts = members.map((c) => c.y0).sort((a, b) => a - b);
    // Where the drawn line FIRST appears. This is the top of the separator,
    // which is what locates the column-header row: TradingView draws the
    // column separators from the header row downwards and breaks them where
    // the first data row starts, so the longest run begins BELOW the header
    // and is useless for locating it.
    const minRun = Math.max(8, Math.floor(height * 0.02));
    const tops = members.map((c) => runStartInColumn(mask, width, height, c.start, minRun));
    return {
      start: band.start,
      end: band.end,
      runLength: members.reduce((m, c) => Math.max(m, c.runLength), 0),
      // Where the drawn line starts, ignoring chart grid lines that merely
      // cross it. The MEDIAN across the band's columns keeps one broken or
      // chart-polluted column from deciding the answer.
      yTop: medianOf(tops.filter((t) => t >= 0)),
      // Where the drawn line starts. The MEDIAN start across the band's
      // columns is where the separator is present along the whole band: a
      // single broken column must not drag the estimate down, and a stray
      // gray pixel must not drag it up.
      y0: starts[Math.floor(starts.length / 2)],
      y1: members.reduce((m, c) => Math.max(m, c.y1), 0),
    };
  });
}

/**
 * Do two vertical lines occupy the same rows of the frame?
 *
 * A search window can hold SEVERAL tables stacked on top of each other: the
 * 2023 sidebar carries a watchlist above the positions list, and both are
 * inside the window. Merging them would produce one table with the union of
 * both column sets and a row list that interleaves two different tables.
 *
 * The bridge test alone cannot tell them apart: the chart draws horizontal
 * grid lines that cross the gap between the two stacked tables, so a chart
 * line "bridges" a line of the upper table to a line of the lower one. What
 * separates them is that they occupy DISJOINT rows. A table's separators run
 * from its own header row to its own bottom border, so two lines of the same
 * table overlap vertically while two lines of different tables do not.
 *
 * The test is a fraction rather than a strict overlap: the chart behind the
 * panel breaks a separator here and there, so the shorter line's extent can
 * be a little shorter than the table's.
 */
const MIN_VERTICAL_OVERLAP = 0.5;

function overlapsVertically(a, b) {
  const top = Math.max(a.y0, b.y0);
  const bottom = Math.min(a.y1, b.y1);
  if (bottom < top) return false;
  const span = bottom - top + 1;
  const shorter = Math.min(a.y1 - a.y0 + 1, b.y1 - b.y0 + 1);
  if (!(shorter > 0)) return false;
  return span / shorter >= MIN_VERTICAL_OVERLAP;
}

/**
 * Group vertical lines into tables.
 *
 * Two vertical lines belong to the same table when some row is a horizontal
 * separator spanning the gap between them — i.e. a row that is separator
 * coloured across that whole gap — AND the two lines occupy the same rows.
 * A chart's own vertical lines are never bridged by a table separator, so
 * they stay separate.
 */
function clusterVerticalLines(index, verticalLines) {
  const { rowPrefix, width, height } = index;
  const parent = verticalLines.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < verticalLines.length; i++) {
    for (let j = i + 1; j < verticalLines.length; j++) {
      const left = verticalLines[i].end;
      const right = verticalLines[j].start;
      if (right < left) continue;
      if (!overlapsVertically(verticalLines[i], verticalLines[j])) continue;
      let bridged = false;
      for (let y = 0; y < height && !bridged; y++) {
        if (separatorFraction(rowPrefix, width, y, left, right) >= SEPARATOR_ROW_FRACTION) {
          bridged = true;
        }
      }
      if (bridged) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < verticalLines.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(verticalLines[i]);
  }
  return [...groups.values()].map((lines) => lines.sort((a, b) => a.start - b.start));
}

/**
 * Find the horizontal separator rows of a table whose interior is
 * [left, right].
 */
function detectSeparatorRows(index, left, right) {
  const { rowPrefix, width, height } = index;
  const rows = [];
  for (let y = 0; y < height; y++) {
    if (separatorFraction(rowPrefix, width, y, left, right) >= SEPARATOR_ROW_FRACTION) {
      rows.push(y);
    }
  }
  // Group consecutive rows into drawn separator bands.
  const bands = [];
  for (const y of rows) {
    const last = bands[bands.length - 1];
    if (last && y <= last.bottom + 1) last.bottom = y;
    else bands.push({ top: y, bottom: y });
  }
  return bands;
}

/**
 * Find the column-header row of a table.
 *
 * TradingView draws a title bar ("A - Positions" plus a column-visibility
 * button that is ALSO labelled "Sym") above the real column-header row
 * ("Flag | Sym | % Change"). The interior column separators are drawn from
 * the header row downwards and stop at the title bar, so the TOPMOST pixel of
 * an interior separator is the horizontal rule that sits directly above the
 * column-header row.
 *
 * Measured on 20220218: the interior separators first appear at y=193 (the
 * rule between the title bar and the header) and the header row is the slot
 * y 201-275. With no title bar (the 2023 sidebar), the separators start at
 * the table top and the header row is slot 0.
 *
 * The longest run of a separator is NOT the right statistic: the vertical
 * line breaks where the first data row starts, so its longest run begins
 * BELOW the header row.
 */
function findHeaderSlotIndex(cluster, slots) {
  if (!slots.length) return -1;
  if (cluster.length < 3) return 0;   // no interior separator to learn from
  const interior = cluster.slice(1, -1);
  const tops = interior.map((s) => (s.yTop === undefined ? s.y0 : s.yTop)).filter((t) => t >= 0);
  if (!tops.length) return 0;
  const startY = Math.min(...tops);
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].top > startY) return i;
  }
  return 0;
}

/**
 * Fit a regular row grid to the detected separator bands.
 *
 * The data rows of a table are evenly spaced — on 20220218 exactly 90 crop
 * px (18 src px) apart — but the DETECTED bands drift by a pixel or two,
 * and one rule can be lost almost entirely (measured: a band detected as
 * only 2px tall, which stretched the row above it by 4px).
 *
 * A 1px error in a row boundary is enough to turn "TSLA" into "TSUA", so the
 * rows are re-derived from a fitted grid rather than from the raw bands:
 * the pitch is the median gap between consecutive bands and the anchor is the
 * FIRST data band (the one directly under the header row, which is a long
 * clean rule; the later ones are the noisy ones).
 *
 * The NUMBER of rows comes from the grid's extent, not from the number of
 * detected bands. A rule lost in the middle leaves two bands a double-pitch
 * apart, so band count under-counts the rows by one — and the last row of the
 * table would then be dropped entirely.
 *
 * @returns {Array<{top,bottom}>|null} the regularised data rows.
 */
function fitRowGrid(dataBands) {
  if (!dataBands || dataBands.length < 4) return null;
  const tops = dataBands.map((b) => b.top);
  const diffs = [];
  for (let i = 1; i < tops.length; i++) diffs.push(tops[i] - tops[i - 1]);
  const pitch = medianOf(diffs);
  if (!(pitch > 1)) return null;
  const heights = dataBands.map((b) => b.bottom - b.top + 1);
  const bandHeight = medianOf(heights);
  if (!(bandHeight > 0)) return null;

  const anchor = tops[0];

  // Refuse to regularise if the raw bands do not actually lie on the grid.
  //
  // The check must tolerate a MISSING band: when a rule is lost, every band
  // below it shifts by a whole pitch, so comparing band i against grid slot i
  // would reject a grid that is otherwise perfect. Each band is therefore
  // compared against the NEAREST grid slot.
  const maxResidual = Math.max(...tops.map((t) => {
    const k = Math.round((t - anchor) / pitch);
    return Math.abs(t - (anchor + k * pitch));
  }));
  if (maxResidual > pitch * 0.25) return null;

  // How many rows the grid spans, from the anchor to the LAST detected band.
  const lastTop = tops[tops.length - 1];
  const rowCount = Math.round((lastTop - anchor) / pitch);
  if (!(rowCount >= 1)) return null;

  const rows = [];
  for (let k = 0; k < rowCount; k++) {
    // The band occupies [top, top + bandHeight - 1]; the row starts right
    // after it and ends on the pixel before the next band.
    const top = anchor + k * pitch + bandHeight;
    const bottom = anchor + (k + 1) * pitch - 1;
    if (bottom > top) rows.push({ top, bottom });
  }
  return rows.length ? rows : null;
}

/**
 * Detect TradingView-style tables in a frame.
 *
 * @param {string} imagePath PNG/JPEG on disk.
 * @returns {Promise<{width,height,tables:Array}>}
 */
async function detectPositionTables(imagePath, options = {}) {
  const raw = await loadRawRgb(imagePath);
  const index = buildSeparatorIndex(raw, options);
  const verticalLines = detectVerticalLines(index);
  const clusters = clusterVerticalLines(index, verticalLines);

  const tables = [];
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;  // need at least two separators to bound a table
    const left = cluster[0].start;
    const right = cluster[cluster.length - 1].end;

    // The table's own vertical extent.
    //
    // The chart behind the panel draws its own horizontal grid lines, and a
    // wide search window catches the ones below the table. Those produce
    // separator bands far below the table and a bogus final "row" hundreds of
    // pixels tall. The table's own column separators say where the table
    // ends: the interior separators are drawn from the header row down to the
    // bottom border. The OUTER separators are not usable — the panel's left
    // border runs the full height of the frame.
    const interior = cluster.length >= 3 ? cluster.slice(1, -1) : cluster.slice(1);
    const tableBottomY = interior.length
      ? interior.reduce((m, s) => Math.max(m, s.y1), -1)
      : -1;

    let separatorBands = detectSeparatorRows(index, left, right);
    if (tableBottomY >= 0) {
      separatorBands = separatorBands.filter((b) => b.top <= tableBottomY);
    }
    if (separatorBands.length < 2) continue;

    // Row slots: the bands between consecutive separator bands. Each slot
    // remembers which band it starts at, because the height filter below can
    // drop slots and break the slot <-> band correspondence.
    let slots = [];
    for (let i = 0; i < separatorBands.length - 1; i++) {
      const top = separatorBands[i].bottom + 1;
      const bottom = separatorBands[i + 1].top - 1;
      if (bottom > top) slots.push({ top, bottom, left, right, bandIndex: i });
    }

    // A row slot must be a plausible row. Measured on 20220218, real rows are
    // 75-88px tall in that 5x crop while a stray 1px separator artefact
    // produces a 10px slot. Filtering by a fraction of the MEDIAN height
    // keeps the rule scale-free — it works the same on a 1080p frame where a
    // real row is ~16px.
    if (slots.length >= 3) {
      const heights = slots.map((s) => s.bottom - s.top + 1).sort((a, b) => a - b);
      const medianHeight = heights[Math.floor(heights.length / 2)];
      const minHeight = Math.max(4, Math.floor(medianHeight * 0.35));
      slots = slots.filter((s) => s.bottom - s.top + 1 >= minHeight);
    }

    // Column slots: the bands between consecutive vertical separators.
    const columns = [];
    for (let i = 0; i < cluster.length - 1; i++) {
      const cLeft = cluster[i].end + 1;
      const cRight = cluster[i + 1].start - 1;
      if (cRight >= cLeft) columns.push({ left: cLeft, right: cRight });
    }
    if (columns.length) {
      columns[0].left = left;
      columns[columns.length - 1].right = right;
    }

    const headerSlotIndex = findHeaderSlotIndex(cluster, slots);

    // Replace the data rows with a regularised grid. The bands that delimit
    // the data rows are those below the band the header row starts at.
    const headerSlot = slots[headerSlotIndex];
    const dataBandStart = headerSlot ? headerSlot.bandIndex + 1 : 0;
    const grid = dataBandStart < separatorBands.length
      ? fitRowGrid(separatorBands.slice(dataBandStart))
      : null;
    if (grid && grid.length) {
      const merged = slots.slice(0, headerSlotIndex + 1)
        .concat(grid.map((r, i) => ({
          ...r,
          left,
          right,
          bandIndex: dataBandStart + i,
        })));
      slots = merged;
    }

    tables.push({
      left,
      right,
      top: separatorBands[0].top,
      bottom: separatorBands[separatorBands.length - 1].bottom,
      separators: cluster,
      separatorBands,
      columns,
      slots,
      headerSlotIndex,
    });
  }

  tables.sort((a, b) => b.slots.length - a.slots.length);
  return { width: raw.width, height: raw.height, tables, verticalLines };
}

/**
 * Find the ticker column from the ink alone, without reading the header.
 *
 * The header row is the natural way to find the ticker column, but the panel
 * does not always show it: the 2022 crops are a narrow slice of the frame
 * (x 0.86..1.0) that contains the ticker column and nothing to its left, so
 * the "Sym" label is outside the crop entirely. The 2022 crops also come
 * from the 1280-wide source, where the header text is too small to read.
 *
 * Ink is a good substitute. TradingView draws ticker symbols in white and
 * the rest of the row in colour — green/red percentages, a blue flag icon —
 * so a white-ink mask isolates the symbols by construction.
 *
 * White ink is not on its own enough: the "Dol Vol" column is white too, and
 * on 20230518 it carries MORE white pixels than the symbol column (557
 * against 501). What separates them is ALIGNMENT. A symbol is left-aligned
 * in its column, so every symbol starts at the same x; a right-aligned
 * number ends at the same x instead. The symbol column is therefore the one
 * whose ink has a consistent LEFT edge.
 *
 * @returns {Promise<{column: object|null, candidates: Array}>}
 */
async function findTickerColumnByInk(imagePath, table, options = {}) {
  if (!table || !table.columns || !table.columns.length) return { column: null, candidates: [] };
  const minLuma = options.inkMinLuma === undefined ? 90 : options.inkMinLuma;
  const maxSpread = options.inkMaxSpread === undefined ? 70 : options.inkMaxSpread;
  const minInkPerRow = options.minInkPerRow === undefined ? 5 : options.minInkPerRow;

  const raw = await loadRawRgb(imagePath);
  const { data, width, height, channels } = raw;

  const startIndex = options.dataRowStart === undefined
    ? (table.headerSlotIndex >= 0 ? table.headerSlotIndex + 1 : 0)
    : options.dataRowStart;
  const slots = table.slots.slice(startIndex);
  if (!slots.length) return { column: null, candidates: [] };

  const candidates = table.columns.map((column) => {
    let totalInk = 0;
    let rowsWithInk = 0;
    const leftEdges = [];
    for (const slot of slots) {
      let rowInk = 0;
      let left = Infinity;
      for (let y = Math.max(0, slot.top); y <= Math.min(height - 1, slot.bottom); y++) {
        for (let x = Math.max(0, column.left); x <= Math.min(width - 1, column.right); x++) {
          const o = (y * width + x) * channels;
          const r = data[o]; const g = data[o + 1]; const b = data[o + 2];
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          if (mn < minLuma || mx - mn > maxSpread) continue;
          rowInk++;
          if (x < left) left = x;
        }
      }
      totalInk += rowInk;
      if (rowInk > 0) { rowsWithInk++; leftEdges.push(left); }
    }

    // Spread of the ink's left edge. A left-aligned column has almost none.
    let leftVar = 0;
    if (leftEdges.length > 1) {
      const mean = leftEdges.reduce((a, b) => a + b, 0) / leftEdges.length;
      leftVar = Math.sqrt(leftEdges.reduce((s, v) => s + (v - mean) ** 2, 0) / leftEdges.length);
    } else if (leftEdges.length === 1) {
      leftVar = 0;
    } else {
      leftVar = 999;
    }

    return {
      column,
      totalInk,
      rowsWithInk,
      rowCount: slots.length,
      inkPerRow: rowsWithInk ? totalInk / rowsWithInk : 0,
      coverage: rowsWithInk / slots.length,
      leftVar,
    };
  });

  const viable = candidates.filter((c) => c.coverage >= 0.8 && c.inkPerRow >= minInkPerRow);
  if (!viable.length) return { column: null, candidates };
  // Left-alignment first, then ink density. A column that is left-aligned but
  // nearly empty is a stray mark, not a symbol column.
  viable.sort((a, b) => (a.leftVar - b.leftVar) || (b.inkPerRow - a.inkPerRow));
  return { column: viable[0].column, candidates, viable };
}

module.exports = {
  detectPositionTables,
  detectVerticalLines,
  clusterVerticalLines,
  detectSeparatorRows,
  findHeaderSlotIndex,
  findTickerColumnByInk,
  isSeparatorPixel,
  buildSeparatorIndex,
  separatorFraction,
  loadRawRgb,
};
