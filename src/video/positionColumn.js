'use strict';

const sharp = require('sharp');

// Locating the Qullamaggie position list from pixels alone.
//
// WHY NOT THE GRID LINES
// TradingView draws the position list as a GUI table, so its grid lines look
// like a natural way to find the ticker column. Measured on the 2023 layout,
// they are not usable:
//
//   * The panel's background is grey (rgb 30) and the table's own rules are
//     grey (rgb 69-97) — but the TITLE BAR is a wide light-grey band
//     (rgb 172) that spans the whole panel. Any "row of separator-coloured
//     pixels" test matches it, on every row of it.
//   * The panel's left border is a 19px-wide vertical strip that runs the
//     full height of the frame. It therefore overlaps EVERY table in the
//     window and merges a stacked watchlist table with the positions table
//     below it.
//
// WHAT THE INK LOOKS LIKE INSTEAD
// TradingView draws ticker symbols in white. Everything else in a row is
// coloured: the flag icon is blue, the % Change and Pre Buzz values are
// green or red. A white-ink mask therefore isolates the symbols, the "Dol
// Vol" figures and the header labels — and nothing else.
//
// Two things then separate the symbol column from the "Dol Vol" column, and
// neither needs OCR:
//
//   * ALIGNMENT. A symbol is left-aligned in its column, so every symbol
//     starts at the same x. "Dol Vol" is right-aligned, so its values start
//     at a different x depending on their width.
//   * REGULARITY. The position list has one row per holding at an even
//     pitch, so a symbol column produces a regular ladder of words.
//
// The column found this way is narrow and exact, which is what the reader
// needs: the crop cannot include the price column beside it, so a ticker can
// never be merged with its percentage.
//
// A ticker's LETTERS are separate ink blobs ("R" at x 67, "GTI" at x 74..91),
// so the left edge of a symbol is the left edge of its FIRST letter. The
// letters are chained back together per row, which is also what fixes the
// column's right edge: the first letters alone are too narrow a crop, and a
// crop that stops short of the last letter reads "GTLB" as "G".

// A word is white-ish ink: every channel bright enough and the colour
// nearly achromatic. Chroma is what removes the green/red percentages and
// the blue flag icon.
const INK_MIN_LUMA = 90;
const INK_MAX_SPREAD = 70;

// A ticker is 2-5 letters. At 1920 source a glyph is ~6 px wide, so a
// symbol is 12-30 px. The bounds leave room for the longest symbols
// TradingView shows (5 letters) and for a wide numeral in "Dol Vol".
const WORD_MIN_WIDTH = 3;
const WORD_MAX_WIDTH = 64;
const WORD_MAX_HEIGHT = 14;

// How much of the LONGER of two runs a run must cover to continue the same
// glyph. A letter tapers — the stem of a "T" is 1 px inside a 7 px bar,
// the vertex of a "V" the same — so a stem has to keep merging. The 1 px
// panel border under a 51 px header rule has to stop. The floor sits
// between the two ratios: below the 1-in-20 stem (0.05) and above the
// 1-in-51 border (0.02).
const MIN_MERGE_SUPPORT = 0.03;

// Anti-aliasing drops single columns out of the middle of a glyph often
// enough that a strict run test splits "TQQQ" in two. Closing the mask with
// a 3x3 structuring element fills those gaps before anything else runs.
const CLOSE_RADIUS = 1;

const DEFAULT_MIN_ROWS = 3;

/**
 * The white-ink mask of an image, closed to fill anti-aliasing gaps.
 */
async function buildInkMask(imagePath, options = {}) {
  const minLuma = options.inkMinLuma === undefined ? INK_MIN_LUMA : options.inkMinLuma;
  const maxSpread = options.inkMaxSpread === undefined ? INK_MAX_SPREAD : options.inkMaxSpread;

  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const raw = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < raw.length; i++, p += channels) {
    const r = data[p]; const g = data[p + 1]; const b = data[p + 2];
    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);
    if (mn >= minLuma && mx - mn <= maxSpread) raw[i] = 1;
  }
  const mask = closeMask(raw, width, height, options.closeRadius === undefined ? CLOSE_RADIUS : options.closeRadius);
  return { mask, width, height };
}

/**
 * Morphological closing: dilate, then erode.
 *
 * Closing fills holes and one-pixel gaps without moving the boundary, which
 * is exactly what is needed for anti-aliased text: the glyph gets solid
 * while its position and size are unchanged.
 */
function closeMask(raw, width, height, radius) {
  if (!radius) return raw;
  const dilate = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (raw[yy * width + xx]) { on = 1; break; }
        }
      }
      dilate[y * width + x] = on;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = 1;
      for (let dy = -radius; dy <= radius && all; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) { all = 0; break; }
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || !dilate[yy * width + xx]) { all = 0; break; }
        }
      }
      out[y * width + x] = all;
    }
  }
  return out;
}

/**
 * The maximal horizontal ink runs of one row.
 */
function rowRuns(mask, width, height, y) {
  const runs = [];
  const base = y * width;
  let x = 0;
  while (x < width) {
    if (!mask[base + x]) { x++; continue; }
    let end = x;
    while (end < width && mask[base + end]) end++;
    runs.push({ x0: x, x1: end - 1 });
    x = end;
  }
  return runs;
}

/**
 * Group the row runs into glyphs.
 *
 * A glyph is ~6 px tall, so it is a stack of overlapping runs across
 * consecutive rows. Runs are matched to the glyph above them by x overlap,
 * and every run the glyph covers is consumed — otherwise each of a ticker's
 * letters would emit its own copy of the same glyph.
 */
function extractWords(mask, width, height, options = {}) {
  const runsByRow = [];
  for (let y = 0; y < height; y++) runsByRow.push(rowRuns(mask, width, height, y));

  const words = [];
  const used = new Set();
  const consume = (top, bottom, x0, x1) => {
    for (let cy = top; cy <= bottom; cy++) {
      const cands = runsByRow[cy];
      for (let k = 0; k < cands.length; k++) {
        const c = cands[k];
        const overlap = Math.min(x1, c.x1) - Math.max(x0, c.x0) + 1;
        if (overlap > 0) used.add(`${cy}:${k}`);
      }
    }
  };

  for (let y = 0; y < height; y++) {
    const runs = runsByRow[y];
    for (let i = 0; i < runs.length; i++) {
      if (used.has(`${y}:${i}`)) continue;
      const run = runs[i];
      let x0 = run.x0;
      let x1 = run.x1;
      let top = y;
      let bottom = y;

      for (const dir of [-1, 1]) {
        let cy = y + dir;
        while (cy >= 0 && cy < height) {
          const cands = runsByRow[cy];
          let bestIdx = -1;
          let bestOverlap = 0;
          for (let k = 0; k < cands.length; k++) {
            const c = cands[k];
            const overlap = Math.min(x1, c.x1) - Math.max(x0, c.x0) + 1;
            const shorter = Math.min(x1 - x0 + 1, c.x1 - c.x0 + 1);
            // A run only continues the glyph if it covers a real part of the
            // LONGER of the two, not just of the shorter one. The "shorter"
            // test alone lets a 1 px run join a 51 px one in either
            // direction, because the small run is wholly inside the big one.
            // That is how the positions table's header RULE (51 px) fuses
            // with the panel BORDER (1 px) below it into one glyph spanning
            // the whole table — and the consume step then deletes the
            // ticker of every row in between.
            const longer = Math.max(x1 - x0 + 1, c.x1 - c.x0 + 1);
            if (overlap > 0
              && overlap / shorter > 0.4
              && overlap / longer >= MIN_MERGE_SUPPORT
              && overlap > bestOverlap) {
              bestOverlap = overlap;
              bestIdx = k;
            }
          }
          if (bestIdx < 0) break;
          const c = runsByRow[cy][bestIdx];
          x0 = Math.min(x0, c.x0);
          x1 = Math.max(x1, c.x1);
          if (dir < 0) top = cy; else bottom = cy;
          cy += dir;
        }
      }
      consume(top, bottom, x0, x1);
      words.push({ x0, x1, top, bottom });
    }
  }
  return words;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * The right edge of a column, ignoring outliers.
 *
 * The ladder can contain a row that is not a ticker — the table's title bar
 * is one wide word that happens to start at the column's left edge. Taking
 * the maximum right edge over all rows then puts the column's right edge
 * inside the NEXT column, and the crop starts swallowing prices.
 *
 * A median-absolute-deviation cut removes them: a ticker is 2-5 letters, so
 * a row much wider than its neighbours is not a ticker.
 */
function robustRight(rows) {
  if (!rows.length) return 0;
  const widths = rows.map((r) => r.right - r.left + 1);
  const med = median(widths);
  const mad = median(widths.map((w) => Math.abs(w - med)));
  const limit = med + 3 * mad + 4;
  const kept = rows.filter((r) => (r.right - r.left + 1) <= limit);
  return Math.max(...(kept.length ? kept : rows).map((r) => r.right));
}

/**
 * Fit a regular ladder of row positions to a set of word centres.
 *
 * Neither the pitch nor the anchor is assumed. Every gap between
 * consecutive centres is tried as a candidate pitch, and for each pitch
 * every centre is tried as a candidate anchor; the combination that puts the
 * most centres on a grid wins. Anchoring on the first centre instead — the
 * obvious shortcut — fails whenever the group also holds a word from
 * another table: the whole grid shifts by a fraction of a pitch and the
 * real rows drop off it.
 *
 * A window can hold two tables at the same pitch — the 2023 sidebar stacks
 * a watchlist above the positions list and both are evenly spaced — so the
 * grid is cut into CONTIGUOUS runs and the longest run is returned. A run
 * may skip one slot (a rule lost in the middle) but not several.
 *
 * @returns {{pitch:number, rows:Array<{centre:number}>}|null}
 */
/**
 * Split a set of row centres into blocks of consecutive rows.
 *
 * The 2023 sidebar stacks two tables — a watchlist above the positions
 * list — and they share the SAME left edge, so they land in the same
 * left-edge group. Their rows are evenly spaced within each table but far
 * apart between tables.
 *
 * Without this split the ladder fit sees one group with two tables in it
 * and keeps only the longer run: the positions table is simply not among
 * the candidates. Measured on 20230609, the watchlist's 17 rows won and
 * the positions table was invisible.
 *
 * A gap larger than a few times the typical gap ends a block.
 */
function splitBlocks(centres, gapFactor = 2.5) {
  const sorted = [...centres].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const typical = median(gaps);
  const limit = Math.max(typical * gapFactor, typical + 6);
  const blocks = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > limit) {
      blocks.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  blocks.push(current);
  return blocks;
}

function fitLadder(centres) {
  if (centres.length < 2) return null;
  const sorted = [...centres].sort((a, b) => a - b);
  const pitches = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 1) pitches.push(d);
  }
  if (!pitches.length) return null;

  let best = null;
  for (const pitch of pitches) {
    const tol = Math.max(1.5, pitch * 0.3);
    for (const anchor of sorted) {
      const onGrid = sorted.filter((c) => {
        const k = Math.round((c - anchor) / pitch);
        if (k < 0) return false;
        return Math.abs(c - (anchor + k * pitch)) <= tol;
      });
      if (!best || onGrid.length > best.onGrid.length) {
        best = { pitch, onGrid, anchor };
      }
    }
  }
  if (!best || best.onGrid.length < 2) return null;

  // Cut the grid into contiguous runs and keep the longest. Two glyphs on
  // the SAME row (a ticker whose letters do not touch) land on one grid
  // slot, so a slot is filled by one row however many glyphs are on it.
  const slots = new Map();
  for (const c of best.onGrid) {
    const k = Math.round((c - best.anchor) / best.pitch);
    if (!slots.has(k)) slots.set(k, c);
  }
  const keys = [...slots.keys()].sort((a, b) => a - b);
  const runs = [];
  let current = [];
  let lastK = null;
  for (const k of keys) {
    if (lastK !== null && k - lastK > 2) {
      runs.push(current);
      current = [];
    }
    current.push({ centre: slots.get(k), k });
    lastK = k;
  }
  if (current.length) runs.push(current);
  runs.sort((a, b) => b.length - a.length);
  const longest = runs[0];
  if (!longest || longest.length < 2) return null;
  return { pitch: best.pitch, anchor: best.anchor, rows: longest };
}

/**
 * Chain the glyphs of one row into a word.
 *
 * The glyphs of a ticker are separate ink blobs a few pixels apart. They are
 * chained left to right while the gap stays small — "about one glyph wide",
 * which is well under the gap to the next column (20+ px).
 */
function chainGlyphs(glyphs, gapTol) {
  if (!glyphs.length) return null;
  const sorted = [...glyphs].sort((a, b) => a.x0 - b.x0);
  let left = sorted[0].x0;
  let right = sorted[0].x1;
  let top = sorted[0].top;
  let bottom = sorted[0].bottom;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i];
    const gap = g.x0 - right - 1;
    if (gap > gapTol) break;
    right = Math.max(right, g.x1);
    top = Math.min(top, g.top);
    bottom = Math.max(bottom, g.bottom);
  }
  return { x0: left, x1: right, top, bottom };
}

/**
 * Find the ticker column of a position list from white ink alone.
 *
 * @returns {Promise<{column: object|null, rows: Array, candidates: Array}>}
 *   `column` is {left, right} in image pixels; `rows` is one entry per
 *   detected holding, each with the word's bounding box.
 */
async function findTickerColumnByInkRuns(imagePath, options = {}) {
  const { mask, width, height } = await buildInkMask(imagePath, options);
  const allWords = extractWords(mask, width, height, options);
  const words = allWords.filter((w) => {
    const wpx = w.x1 - w.x0 + 1;
    const hpx = w.bottom - w.top + 1;
    if (wpx < (options.wordMinWidth || WORD_MIN_WIDTH)) return false;
    if (wpx > (options.wordMaxWidth || WORD_MAX_WIDTH)) return false;
    if (hpx > (options.wordMaxHeight || WORD_MAX_HEIGHT)) return false;
    // A real glyph has some area: a 3x1 speck is noise.
    if (wpx * hpx < 6) return false;
    return true;
  });

  // Group the glyphs by their left edge: a left-aligned column puts every
  // symbol's FIRST letter at the same x.
  const tol = options.leftTolerance === undefined ? 2 : options.leftTolerance;
  const groups = [];
  for (const w of words) {
    let g = groups.find((x) => Math.abs(x.left - w.x0) <= tol);
    if (!g) { g = { left: w.x0, words: [] }; groups.push(g); }
    g.words.push(w);
  }

  const minRows = options.minRows === undefined ? DEFAULT_MIN_ROWS : options.minRows;

  const candidates = [];
  for (const g of groups) {
    if (g.words.length < minRows) continue;
    const centres = g.words.map((w) => (w.top + w.bottom) / 2);
    // One left-edge group can hold SEVERAL tables: the 2023 sidebar stacks a
    // watchlist above the positions list and both are left-aligned to the
    // same x. Each stack of consecutive rows is a table of its own.
    for (const block of splitBlocks(centres)) {
      if (block.length < minRows) continue;
      const ladder = fitLadder(block);
      if (!ladder) continue;

      // The ladder's rows, matched back to their glyphs.
      const rowGlyphs = ladder.rows.map((row) => {
        const picked = [];
        for (const w of g.words) {
          const c = (w.top + w.bottom) / 2;
          if (Math.abs(c - row.centre) <= Math.max(2, ladder.pitch * 0.3)) picked.push(w);
        }
        return picked;
      }).filter((r) => r.length);

      // Chain each row's glyphs into one word. The first glyph of the row is
      // the one at the column's left edge; the rest are its letters.
      const glyphHeight = median(g.words.map((w) => w.bottom - w.top + 1));
      const gapTol = options.gapTolerance === undefined
        ? Math.max(2, Math.round(glyphHeight * 1.2))
        : options.gapTolerance;

      const rows = [];
      for (const picked of rowGlyphs) {
        const chain = chainGlyphs(picked, gapTol);
        if (!chain) continue;
        rows.push({
          top: chain.top,
          bottom: chain.bottom,
          left: chain.x0,
          right: chain.x1,
          glyphs: picked.length,
        });
      }
      if (rows.length < minRows) continue;

      const lefts = rows.map((r) => r.left);
      const meanLeft = lefts.reduce((a, b) => a + b, 0) / lefts.length;
      const leftVar = Math.sqrt(lefts.reduce((s, v) => s + (v - meanLeft) ** 2, 0) / lefts.length);
      const widths = rows.map((r) => r.right - r.left + 1);

      candidates.push({
        left: g.left,
        rows,
        rowCount: rows.length,
        pitch: ladder.pitch,
        leftVar,
        medianWidth: median(widths),
        right: Math.max(...rows.map((r) => r.right)),
        top: Math.min(...rows.map((r) => r.top)),
        bottom: Math.max(...rows.map((r) => r.bottom)),
      });
    }
  }

  if (!candidates.length) return { column: null, rows: [], candidates, words: allWords };

  // Score: a position list is a LONG regular ladder of left-aligned words.
  // More rows wins; then alignment; then a narrower word (a ticker, not a
  // wide label such as "Filter" or a multi-digit figure).
  candidates.sort((a, b) => (
    (b.rowCount - a.rowCount)
    || (a.leftVar - b.leftVar)
    || (a.medianWidth - b.medianWidth)
  ));
  const best = candidates[0];

  const padLeft = options.padLeft === undefined ? 2 : options.padLeft;
  const padRight = options.padRight === undefined ? 2 : options.padRight;
  const column = {
    left: Math.max(0, best.left - padLeft),
    right: Math.min(width - 1, best.right + padRight),
  };
  return {
    column,
    rows: best.rows.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })),
    candidates,
    words: allWords,
    ladder: { pitch: best.pitch, leftVar: best.leftVar },
  };
}

module.exports = {
  buildInkMask,
  closeMask,
  extractWords,
  rowRuns,
  fitLadder,
  splitBlocks,
  chainGlyphs,
  robustRight,
  findTickerColumnByInkRuns,
  INK_MIN_LUMA,
  INK_MAX_SPREAD,
};
