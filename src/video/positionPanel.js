'use strict';

const sharp = require('sharp');

const { findTickerColumnByInkRuns, robustRight } = require('./positionColumn.js');
const { ocrStrips, symWordScore, editDistance } = require('../ocr/positionCellOcr.js');

// Finding the Qullamaggie position list in a frame, end to end.
//
// The position list is a TradingView GUI table. Its geometry is recovered
// from the white ink (see positionColumn.js); this module adds the one thing
// ink cannot settle on its own — WHICH of the candidate columns is the
// ticker column.
//
// WHY THE HEADER IS NEEDED
// A position list has several left-aligned columns of white ink: the flag
// column, the ticker column and the "Dol Vol" column. The flag icon is
// blue, but at a 7 px glyph height enough of it passes the achromatic test
// to form its own candidate column, so ink alone cannot tell the two apart.
//
// The header row settles it: the ticker column's header is labelled "Sym"
// and the flag column's is labelled "Flag".
//
// WHERE THE HEADER IS
// The header row sits next to the first data row, but on either side of it:
// the header's own left edge may or may not line up with the tickers'. So
// the band that is read spans from one row-pitch above the ladder's first
// row down to two row-pitches below it, and the "Sym" label is then
// located inside that band by its x position.
//
// The band needs slack: measured on the 20230609 panel the header glyphs
// are at y 207..215 and the first data row at y 229..235, so the header's
// top is 22 px above the first data row — one pitch (18) plus 4. A band of
// exactly one pitch cuts the header's top four rows off and the recogniser
// then reads "Sym" as noise.
//
// THE TITLE BAR IS NOT THE HEADER
// The title bar ("A - Positions | Filter | Edit | Sym ▣") sits above the
// header and also carries a "Sym" button — the column-visibility toggle.
// Two things reject it: the button is not over the ticker column, and a
// line that names the TABLE is not the line that names the COLUMNS.
//
// ROWS
// If the "Sym" label is itself one of the ladder's rows, that row is the
// header and is dropped from the data rows. If the header sits above the
// ladder, every ladder row is data.

const HEADER_SLACK = 6;

// Words that name a TradingView column.
const HEADER_COLUMN_WORDS = /^(flag|sym|symbol|change|vol|buzz|qty|quantity|price|last|bid|ask|close|open|high|low|pre|avg|volume|dollar|pct|chg)$/i;

// Words that name the TABLE rather than a column. Matching is loose because
// the recogniser mangles them: "Positions" comes back as "Positi".
const TITLE_WORD = /posit|watchl|marketw/i;

/**
 * Crop a horizontal band of a frame.
 *
 * The band is normally cut to the column's neighbourhood rather than to the
 * full frame width: the "Sym" label is inside the column, and a narrow band
 * is a fraction of the pixels for the detector to chew on. The title bar's
 * "Sym" button can still fall inside the band, which is why the band is
 * wide enough to hold the neighbouring column labels — they are what tells
 * a header row from a title bar.
 */
async function cropBand(imagePath, top, bottom, options = {}) {
  const scale = options.scale || 4;
  const meta = await sharp(imagePath).metadata();
  const t = Math.max(0, Math.round(top));
  const b = Math.min(meta.height - 1, Math.round(bottom));
  if (b <= t) return null;
  const left = Math.max(0, Math.round(options.left === undefined ? 0 : options.left));
  const right = Math.min(meta.width - 1, Math.round(options.right === undefined ? meta.width - 1 : options.right));
  if (right <= left) return null;
  const buffer = await sharp(imagePath)
    .extract({ left, top: t, width: right - left + 1, height: b - t + 1 })
    .resize({
      width: Math.max(1, Math.round((right - left + 1) * scale)),
      height: Math.max(1, Math.round((b - t + 1) * scale)),
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
  return { buffer, top: t, bottom: b, left, right, scale };
}

function overlapX(a0, a1, b0, b1) {
  return Math.min(a1, b1) - Math.max(a0, b0) + 1;
}

/**
 * Locate the position list's ticker column and rows in a frame.
 *
 * Split into two halves so a corpus sweep can batch the expensive half:
 * `preparePanelBands` does the pixel work and returns the header bands to
 * read, `resolvePanel` turns the readings into a column and a row list.
 *
 * @returns {Promise<{column:object|null, rows:Array, headerText:string}>}
 */
async function findPositionPanel(imagePath, options = {}) {
  const prepared = await preparePanelBands(imagePath, options);
  if (!prepared.candidates.length) {
    return { column: null, rows: [], candidates: prepared.candidates, headerText: '' };
  }
  const results = await ocrStrips(prepared.bands, {
    timeoutMs: options.timeoutMs || 600000,
    pythonPath: options.pythonPath,
  });
  return resolvePanel(prepared, results);
}

/**
 * The pixel half of the panel search: the ink candidates and the header
 * bands that would name the ticker column.
 */
async function preparePanelBands(imagePath, options = {}) {
  const ink = await findTickerColumnByInkRuns(imagePath, options);
  const candidates = ink.candidates.slice(0, options.maxCandidates || 5);
  if (!candidates.length) {
    return { imagePath, candidates, bands: [], ink };
  }

  // One band per candidate column. The band covers the row above the
  // ladder (where the header may be), the ladder's first row, and the rows
  // below it, so the header can be on either side of the first data row.
  const bands = [];
  for (const c of candidates) {
    const pitch = Math.round(c.pitch);
    const top = Math.max(0, c.rows[0].top - pitch - HEADER_SLACK);
    const bottom = c.rows[0].top + 2 * pitch;
    const columnRight = robustRight(c.rows);
    // Wide enough to hold the neighbouring column labels, narrow enough to
    // keep the band cheap.
    const left = Math.max(0, c.left - (options.bandMargin === undefined ? 60 : options.bandMargin));
    const right = columnRight + (options.bandMargin === undefined ? 60 : options.bandMargin);
    bands.push(await cropBand(imagePath, top, bottom, { ...options, left, right }));
  }
  return { imagePath, candidates, bands, ink };
}

/**
 * The reading half: turn the header bands' readings into a column and rows.
 */
function resolvePanel(prepared, results) {
  const candidates = prepared.candidates;
  const bands = prepared.bands;
  let chosen = null;
  const reports = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const strip = bands[i];
    const ocr = results[i];
    if (!strip || !ocr || ocr.error) continue;

    // The column's provisional right edge: the ladder's rows are not all
    // tickers (the title bar can be one of them), so the widest row is not
    // trusted.
    const columnRight = robustRight(c.rows);
    const column = { left: c.left, right: columnRight };

    // Map every OCR word back to source-image coordinates.
    const words = (ocr.words || []).map((w) => ({
      text: String(w.text || '').trim(),
      left: strip.left + w.left / strip.scale,
      right: strip.left + (w.left + w.width) / strip.scale,
      top: strip.top + w.top / strip.scale,
      bottom: strip.top + (w.top + w.height) / strip.scale,
      line: w.line === undefined ? -1 : w.line,
      conf: w.conf,
    }));

    // Group by OCR line: the title bar and the header row are different
    // lines, and only the header row names COLUMNS.
    const lines = new Map();
    for (const w of words) {
      const key = w.line === -1 ? 'all' : w.line;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(w);
    }

    const report = {
      candidate: c,
      column,
      words,
      sym: null,
      score: -Infinity,
      lineIsTitle: false,
      headerWords: 0,
    };

    for (const [, lineWords] of lines) {
      const joined = lineWords.map((w) => w.text).join(' ').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const lineIsTitle = TITLE_WORD.test(joined);
      const headerWordCount = lineWords.filter((w) => HEADER_COLUMN_WORDS.test(w.text)).length;

      for (const w of lineWords) {
        const d = symWordScore(w.text);
        if (d < 0) continue;
        // The "Sym" that names the ticker column is centred over it. A
        // centre test, not an overlap test: the title bar's "Sym" button
        // can still overlap the column's right edge.
        const centre = (w.left + w.right) / 2;
        if (centre < column.left - 4 || centre > column.right + 4) continue;
        let score = 6 + (2 - d) + Math.min(headerWordCount, 5);
        if (lineIsTitle && headerWordCount === 0) score -= 10;
        if (score > report.score) {
          report.score = score;
          report.sym = w;
          report.lineIsTitle = lineIsTitle;
          report.headerWords = headerWordCount;
        }
      }
    }
    reports.push(report);

    if (report.sym && (!chosen || report.score > chosen.score)) {
      chosen = report;
    }
  }

  if (!chosen) {
    // No header could be read. Fall back to the best ink candidate: the
    // caller can still try it, and a wrong guess is visible in the output
    // rather than silently dropped.
    const best = candidates[0];
    return {
      column: { left: best.left, right: robustRight(best.rows) },
      rows: best.rows,
      candidates: prepared.ink ? prepared.ink.candidates : candidates,
      headerText: '',
      fallback: true,
      reports,
    };
  }

  const c = chosen.candidate;
  // The ink gives the column's exact edges: the left edge of the first
  // letter of a ticker and the right edge of the widest one. The header
  // says WHICH column that is.
  const column = {
    left: Math.max(0, Math.min(c.left, Math.round(chosen.sym.left))),
    right: Math.max(robustRight(c.rows), Math.round(chosen.sym.right)),
  };

  // If the "Sym" label IS one of the ladder's rows, it is the header row
  // and must not be read as a ticker.
  let rows = c.rows;
  let headerRowDropped = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (overlapX(chosen.sym.left, chosen.sym.right, r.left, r.right) > 0
      && overlapX(chosen.sym.top, chosen.sym.bottom, r.top, r.bottom) > 0) {
      rows = rows.slice(i + 1);
      headerRowDropped = true;
      break;
    }
  }
  // Rows above the header are the table's title bar, not holdings.
  rows = rows.filter((r) => r.top > chosen.sym.bottom - 1);

  return {
    column,
    rows,
    candidates: prepared.ink ? prepared.ink.candidates : candidates,
    headerText: chosen.words.map((w) => w.text).join(' '),
    headerSource: 'sym',
    headerRowDropped,
    reports,
  };
}

/**
 * The index of the row that holds the column's "Sym" label.
 *
 * The header label is LEFT-ALIGNED with the tickers (measured on 20230609:
 * "Sym" at x 66-82, tickers at x 66-85), so it is one of the ink ladder's
 * own rows and it comes out of the column strip as one of the strip's rows.
 *
 * The recogniser mangles it ("ISY", "Syrn", "sy"), so the test is an edit
 * distance of at most 2 against "SYM". The first matching row wins: the
 * header is above the data, so an earlier match is the header and a later
 * one is a ticker that happens to look like it.
 *
 * @returns {number} the row index, or -1 when no row names the column
 */
function symRowIndex(rows) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < (rows || []).length; i++) {
    const text = String((rows[i] && rows[i].text) || '').toUpperCase();
    if (!text) continue;
    const d = editDistance(text, 'SYM');
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
    if (bestDistance <= 2) break;
  }
  return bestDistance <= 2 ? best : -1;
}

/**
 * Resolve the ticker column from readings of the candidate columns' strips.
 *
 * The header band approach (resolvePanel) needs to know where the header
 * ROW is before it can read it, and it can only guess that from the ladder's
 * first row. That guess is wrong whenever the ladder spans more than one
 * table — the 2023 sidebar stacks a watchlist above the positions list, and
 * both are evenly spaced, so the ladder starts in the watchlist and the
 * positions header is many rows down.
 *
 * Reading the column as a strip sidesteps that: the strip contains the
 * header label itself, so the label is FOUND rather than guessed for. The
 * same reading also says which candidate is the ticker column, because a
 * watchlist's header says "WL" and not "Sym".
 *
 * @param {Array<{candidate:object, column:object, rows:Array}>} candidates
 * @param {Array<{rows:Array}>} readings  one per candidate, in the same order
 * @returns {{column, rows, headerText, symRow, candidate, fallback}}
 */
function resolvePanelFromStrips(candidates, readings) {
  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const read = readings[i];
    if (!cand || !read || !read.rows || !read.rows.length) continue;
    const symRow = symRowIndex(read.rows);
    const dataRows = symRow >= 0 ? read.rows.slice(symRow + 1) : read.rows;
    const score = (symRow >= 0 ? 1000 : 0) + dataRows.length;
    if (!best || score > best.score) {
      best = { score, symRow, dataRows, candidate: cand, column: cand.column, read, index: i };
    }
  }

  if (!best) {
    return { column: null, rows: [], headerText: '', symRow: -1, candidateIndex: -1, fallback: true };
  }

  // Without a "Sym" label the column is a guess. Say so.
  const fallback = best.symRow < 0;
  const headerText = best.symRow >= 0
    ? String((best.read.rows[best.symRow] || {}).text || '')
    : '';

  return {
    column: best.column,
    rows: best.dataRows,
    headerText,
    symRow: best.symRow,
    candidateIndex: best.index,
    fallback,
  };
}

module.exports = {
  findPositionPanel,
  preparePanelBands,
  resolvePanel,
  resolvePanelFromStrips,
  symRowIndex,
  cropBand,
  HEADER_COLUMN_WORDS,
  TITLE_WORD,
};
