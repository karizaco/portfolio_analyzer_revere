'use strict';

const sharp = require('sharp');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runEasyOcrBatch, adaptToParserSchema } = require('./easyocrAdapter');

// Reading a Qullamaggie position list is a two-step problem: work out WHERE
// the tickers are, then read them. `positionTable.js` does the first step
// geometrically. This module does the second: it slices the ticker column
// into one cell per row and OCRs those cells.
//
// Two decisions that matter:
//
//   * Cells, not the whole panel. A ticker cell contains only a ticker, so a
//     ticker can never be merged with the price column beside it. Measured on
//     the 20220218 panel: whole-panel OCR read 7/9 tickers and produced 43
//     junk detections; per-cell OCR read 8/9 with 1 junk detection per cell.
//
//   * A stitched column, not one call per cell. EasyOCR's detector cost is
//     per call, not per pixel: 60 individual cell reads took ~8 minutes,
//     while one stitched column is a single call.
//
// The recogniser is restricted to A-Z. Prices, %, commas and dots then become
// unrepresentable, so a stray numeric column can never be mistaken for a
// ticker.

const LETTERS_ONLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Gap between stitched cells, in scaled pixels. Wide enough that the
// recogniser cannot merge two cells into one box.
const STITCH_GAP_PX = 24;

// Words that identify a TradingView column-header row.
const HEADER_COLUMN_WORDS = /^(flag|sym|symbol|change|vol|buzz|qty|quantity|price|last|bid|ask|close|open|high|low|pre|avg|volume|dollar|pct|chg)$/i;
// "Sym" has to survive being fused with a neighbouring stroke ("ISym"), so
// the test is containment rather than equality. The length cap keeps tickers
// that merely contain those letters out.
const SYM_WORD = /sym/i;
const FLAG_WORD = /flag/i;
const isFlagWord = (t) => t.length <= 6 && FLAG_WORD.test(t);

/**
 * How many characters differ between two short strings.
 *
 * Used to recognise a misread column header. The header row is read at ~10 px
 * cap height and the recogniser does not always land on the exact word: on
 * 20230608 the header read "Syrn" where the column is "Sym". An exact match
 * would have thrown away the whole table.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/**
 * Is this word a mangled "Sym"?
 *
 * The tolerance is 2 for a 3-5 letter word, which covers the measured
 * misreads ("Syrn", "Svm") without admitting a ticker that merely looks
 * similar. A word that is a superstring of "sym" ("ISym", "Sym g") is an
 * exact-containment match and needs no distance.
 */
function symWordScore(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return -1;
  if (t.includes('sym')) return 0;
  if (t.length < 3 || t.length > 5) return -1;
  const d = editDistance(t, 'sym');
  return d <= 2 ? d : -1;
}


// The title bar ("A - Positions", the "Sym" column-visibility button) is NOT
// the column-header row, even though it also contains the word "Sym". A slot
// whose text names the table is the title bar; a slot whose text names
// COLUMNS is the header row.
//
// Matching is deliberately loose (the first five letters of a title word):
// EasyOCR reads "Positions" as "Positi", and a rule that only fires on the
// exact word would let the title bar win.
const TITLE_WORD = /posit|watchl|marketw/i;

function tempPath(suffix) {
  return path.join(os.tmpdir(), `qmg-pos-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}${suffix}`);
}

/**
 * Extract a region of an image, optionally upscaled.
 * Coordinates in the result are (source - left) * scale.
 *
 * `options.blacken` lists x ranges (in SOURCE coordinates) to paint black
 * before scaling. That is how the vertical grid lines are removed from a
 * header strip: a 1px separator line is a perfectly good vertical stroke for
 * a recogniser, which reads it as "I" and glues it to the next word
 * ("Sym" -> "ISym").
 */
async function extractRegion(imagePath, region, scale, options = {}) {
  const { left, top, width, height } = region;
  const blacken = options.blacken || [];

  if (!blacken.length) {
    let pipeline = sharp(imagePath).extract({ left, top, width, height });
    if (scale && scale !== 1) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        kernel: 'lanczos3',
      });
    }
    return pipeline.png().toBuffer();
  }

  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (const range of blacken) {
    const x0 = Math.max(0, Math.round(range.start - left));
    const x1 = Math.min(info.width - 1, Math.round(range.end - left));
    for (let y = 0; y < info.height; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = (y * info.width + x) * info.channels;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
      }
    }
  }

  let pipeline = sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
  if (scale && scale !== 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      kernel: 'lanczos3',
    });
  }
  return pipeline.png().toBuffer();
}

/**
 * Stack regions of the same width vertically into one image.
 * Returns { buffer, spans } where spans[i] = { top, bottom } of region i in
 * the stitched image (stitched-image pixels, already scaled).
 */
async function stitchVertical(imagePath, regions, scale, gapPx, options = {}) {
  const gap = gapPx === undefined ? STITCH_GAP_PX : gapPx;
  const width = Math.max(1, Math.round(Math.max(...regions.map((r) => r.width)) * scale));
  const composite = [];
  const spans = [];
  let y = 0;
  for (const region of regions) {
    const buffer = await extractRegion(imagePath, region, scale, options);
    const meta = await sharp(buffer).metadata();
    const scaled = meta.width === width
      ? buffer
      : await sharp(buffer).resize({ width, height: meta.height, fit: 'fill' }).png().toBuffer();
    composite.push({ input: scaled, top: y, left: 0 });
    spans.push({ top: y, bottom: y + meta.height - 1, height: meta.height });
    y += meta.height + gap;
  }
  const totalHeight = Math.max(1, y - gap);
  const out = await sharp({
    create: { width, height: totalHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(composite).png().toBuffer();
  return { buffer: out, spans, width, height: totalHeight };
}

/**
 * Assign OCR words to the stitched regions they fall in.
 * Word y coordinates are already in stitched-image pixels, so they compare
 * directly with the span bounds.
 */
function assignWordsToSpans(words, spans) {
  const out = spans.map(() => []);
  for (const w of words) {
    const cy = w.top + w.height / 2;
    let best = -1;
    for (let i = 0; i < spans.length; i++) {
      if (cy >= spans[i].top && cy <= spans[i].bottom) { best = i; break; }
    }
    if (best < 0) {
      let bestDist = Infinity;
      for (let i = 0; i < spans.length; i++) {
        const mid = (spans[i].top + spans[i].bottom) / 2;
        const d = Math.abs(cy - mid);
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    out[best].push(w);
  }
  return out;
}

async function ocrTempImage(buffer, options, tuning) {
  const tmp = tempPath('.png');
  fs.writeFileSync(tmp, buffer);
  try {
    const results = await runEasyOcrBatch([tmp], {
      pythonPath: options.pythonPath,
      timeoutMs: options.timeoutMs,
      ...(tuning || {}),
    });
    return results[0];
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Find the column slot a header word belongs to.
 *
 * A label is left-aligned in its column, so the word box usually starts a few
 * pixels LEFT of the column's separator (measured: "Sym" at x 712 while the
 * Sym column is 719-892). Comparing left edges therefore picks the previous
 * column. Overlap between the word box and the column is the right test;
 * the word's centre is the fallback.
 */
function columnForWord(columns, word) {
  if (!columns || !columns.length || !word) return null;
  const left = word.sourceLeft;
  const right = word.sourceRight === undefined ? word.sourceLeft : word.sourceRight;
  const centre = (left + right) / 2;

  let best = null;
  let bestOverlap = 0;
  for (const c of columns) {
    const overlap = Math.min(right, c.right) - Math.max(left, c.left) + 1;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = c; }
  }
  if (best) return best;

  let bestDist = Infinity;
  for (const c of columns) {
    const d = centre < c.left ? c.left - centre : centre > c.right ? centre - c.right : 0;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

/**
 * Build the stitched image for a set of row slots, without OCRing it.
 *
 * Splitting "make the pixels" from "read the pixels" is what makes a corpus
 * sweep affordable: EasyOCR loads an ~80MB model per PROCESS, so reading 200
 * strips one process at a time would spend all the wall-clock loading models.
 * Building every strip first and handing them to one batch call loads the
 * model once.
 */
async function prepareHeaderStrip(imagePath, table, slotIndexes, options = {}) {
  const scale = options.scale || 4;
  const slots = slotIndexes.map((i) => table.slots[i]).filter(Boolean);
  if (!slots.length) return null;

  const regions = slots.map((s) => ({
    left: table.left,
    top: s.top,
    width: Math.max(1, table.right - table.left + 1),
    height: Math.max(1, s.bottom - s.top + 1),
  }));

  const { buffer, spans } = await stitchVertical(imagePath, regions, scale, options.gapPx, {
    // Erase the vertical grid lines: a separator is a 1px vertical stroke and
    // the recogniser reads it as "I".
    blacken: options.blacken === undefined
      ? (table.separators || []).map((s) => ({ start: s.start, end: s.end }))
      : options.blacken,
  });
  return { buffer, spans, slotIndexes, scale };
}

/**
 * Interpret an OCR result for a prepared header strip.
 *
 * Scores each slot: it is the header row if it names COLUMNS.
 */
function interpretHeaderStrip(ocr, table, strip) {
  if (!ocr || ocr.error || !strip) {
    return { slotIndex: -1, words: [], text: '', symColumn: null, score: -1, error: ocr && ocr.error };
  }
  const { spans, slotIndexes, scale } = strip;
  const perSlot = assignWordsToSpans(ocr.words || [], spans);
  const slotWords = perSlot.map((words) => words.map((w) => ({
    ...w,
    text: String(w.text || '').trim(),
    // Map back to source-image x so the column can be located.
    sourceLeft: w.left / scale + table.left,
    sourceRight: (w.left + w.width) / scale + table.left,
  })));

  // Score each slot: it is the header row if it names columns.
  let best = { slotIndex: -1, score: -1, symWord: null, words: [] };
  slotWords.forEach((words, i) => {
    const slotIndex = slotIndexes[i];
    const texts = words.map((w) => w.text);
    const joined = texts.join(' ').replace(/[^a-z0-9]/gi, '').toLowerCase();
    // The "Sym" header is the one word that matters: it says which column
    // holds the tickers. It is also the word the recogniser most often
    // mangles, so an exact match is not required.
    let symWord = null;
    let symDistance = -1;
    for (const w of words) {
      const d = symWordScore(w.text);
      if (d >= 0 && (symDistance < 0 || d < symDistance)) { symDistance = d; symWord = w; }
    }
    const hasSym = symDistance >= 0;
    const hasFlag = texts.some((t) => isFlagWord(t));
    const isTitle = TITLE_WORD.test(joined);
    const headerWordCount = words.filter((w) => HEADER_COLUMN_WORDS.test(w.text)).length;
    let score = 0;
    if (hasSym) score += 4 - symDistance;
    if (hasFlag) score += 3;
    score += Math.min(headerWordCount, 5);
    // A title bar names the TABLE, not the columns. It also carries a "Sym"
    // column-visibility button, so without this penalty it can out-score the
    // real header row.
    if (isTitle) score -= 8;
    if (score > best.score) {
      best = {
        slotIndex,
        score,
        symWord,
        words,
      };
    }
  });

  let symColumn = null;
  if (best.symWord) {
    symColumn = columnForWord(table.columns, best.symWord);
  }

  return {
    slotIndex: best.slotIndex,
    words: best.words,
    text: best.words.map((w) => w.text).join(' '),
    symColumn,
    score: best.score,
  };
}

/**
 * OCR a set of row slots of a table and report the best column-header
 * candidate among them.
 *
 * The slots are stitched into ONE image so the whole search costs a single
 * OCR invocation.
 */
async function readHeaderSlots(imagePath, table, slotIndexes, options = {}) {
  const slots = slotIndexes.map((i) => table.slots[i]).filter(Boolean);
  if (!slots.length) {
    return { slotIndex: -1, words: [], text: '', symColumn: null, score: -1 };
  }
  const strip = await prepareHeaderStrip(imagePath, table, slotIndexes, options);
  const ocr = await ocrTempImage(strip.buffer, options, options.headerTuning);
  return interpretHeaderStrip(ocr, table, strip);
}

/**
 * Read the column-header row of a table.
 *
 * The header row names the columns: "Flag | Sym | % Change | Dol Vol | Pre
 * Buzz". Which of them is the ticker column is decided here, not guessed.
 *
 * The TradingView title bar ALSO contains a "Sym" button (the column
 * visibility toggle), so the header slot cannot be found by looking for the
 * word "Sym" alone. Two mechanisms cooperate:
 *
 *   1. GEOMETRY. The table detector locates the header row from the column
 *      separators (see findHeaderSlotIndex). This is one OCR call.
 *   2. CONTENT FALLBACK. If the geometric slot yields no "Sym", the first few
 *      slots are OCRed together and the one that names COLUMNS (rather than
 *      the table) wins.
 *
 * The geometric slot is the ANCHOR. The content search can confirm the
 * geometric slot or replace it, but it must never REPLACE it with a slot that
 * names nothing: a slot with no readable words scores zero, and if that zero
 * wins, the caller starts reading the ticker column one or more rows too
 * low. When neither pass finds a "Sym", the geometric slot is still the best
 * answer for WHERE the header is.
 *
 * @returns {Promise<{slotIndex, words, text, symColumn}>}
 */
async function readTableHeader(imagePath, table, options = {}) {
  if (!table.slots.length) {
    return { slotIndex: -1, words: [], text: '', symColumn: null };
  }

  const geometric = Number.isInteger(table.headerSlotIndex) ? table.headerSlotIndex : -1;
  let geometricResult = null;

  // Pass 1: the geometrically located header slot, one OCR call.
  if (geometric >= 0 && geometric < table.slots.length) {
    geometricResult = await readHeaderSlots(imagePath, table, [geometric], options);
    if (geometricResult.symColumn) {
      return { ...geometricResult, source: 'geometry' };
    }
  }

  // Pass 2: content search over the first few slots.
  const count = Math.min(options.headerSearchSlots || 4, table.slots.length);
  const order = [];
  for (let i = 0; i < count; i++) {
    if (i !== geometric) order.push(i);
  }
  const res = await readHeaderSlots(imagePath, table, order, options);
  if (res.symColumn) {
    return { ...res, source: 'content' };
  }

  // Neither pass named the ticker column. The geometry still knows where the
  // header row is, and that is what the caller needs most.
  if (geometricResult) return { ...geometricResult, source: 'geometry' };
  return { ...res, source: 'content' };
}

/**
 * Build the stitched image of a table's ticker column, without OCRing it.
 *
 * Same reason as prepareHeaderStrip: pixels first, recognition later, so a
 * corpus sweep can hand every strip to one EasyOCR process.
 */
async function prepareTickerStrip(imagePath, table, options = {}) {
  const scale = options.scale || 4;
  const column = options.column;
  if (!column) return null;

  // Data rows are the slots AFTER the column-header row.
  const startIndex = options.dataRowStart === undefined
    ? (table.headerSlotIndex >= 0 ? table.headerSlotIndex + 1 : 0)
    : options.dataRowStart;
  const slots = table.slots.slice(startIndex);
  if (!slots.length) return null;

  // Pad the column sideways.
  //
  // The cell crop starts exactly at the column separator, but TradingView
  // left-aligns the ticker text with only a pixel or two of padding, so a
  // separator that lands one pixel to the right of the glyph CLIPS the
  // leading letter: "FCX" read as "KX". The separator's exact position moves
  // by a pixel or two with the crop geometry, so the crop is widened to make
  // the leading glyph unreachable by the edge.
  const padLeft = options.padLeft === undefined ? 4 : options.padLeft;
  const padRight = options.padRight === undefined ? 2 : options.padRight;
  const left = Math.max(0, column.left - padLeft);
  const right = column.right + padRight;

  const regions = slots.map((s) => ({
    left,
    top: s.top,
    width: Math.max(1, right - left + 1),
    height: Math.max(1, s.bottom - s.top + 1),
  }));

  const { buffer, spans } = await stitchVertical(imagePath, regions, scale, options.gapPx);
  return { buffer, spans, slots, startIndex, scale };
}

/**
 * Interpret an OCR result for a prepared ticker strip.
 */
function interpretTickerStrip(ocr, strip) {
  if (!ocr || ocr.error || !strip) {
    return { rows: [], error: ocr && ocr.error };
  }
  const { spans, slots, startIndex } = strip;
  const perCell = assignWordsToSpans(ocr.words || [], spans);
  const rows = perCell.map((words, i) => {
    const slot = slots[i];
    const text = words
      .map((w) => String(w.text || '').replace(/[^A-Z]/gi, '').toUpperCase())
      .join('');
    const conf = words.length
      ? words.reduce((sum, w) => sum + Number(w.conf || 0), 0) / words.length
      : 0;
    return {
      rowIndex: i,
      slotIndex: startIndex + i,
      top: slot.top,
      bottom: slot.bottom,
      text,
      conf,
      words,
    };
  });
  return { rows };
}

/**
 * Read every data row of a table's ticker column.
 *
 * @returns {Promise<{rows:Array, error?:string}>}
 */
async function readTickerColumn(imagePath, table, options = {}) {
  const strip = await prepareTickerStrip(imagePath, table, options);
  if (!strip) return { rows: [] };
  const ocr = await ocrTempImage(strip.buffer, options, {
    allowlist: options.allowlist === undefined ? LETTERS_ONLY : options.allowlist,
  });
  return interpretTickerStrip(ocr, strip);
}

/**
 * OCR many prepared strips in ONE EasyOCR process.
 *
 * This is the whole point of splitting prepare from interpret: EasyOCR loads
 * an ~80MB model per process, so a corpus of 200 strips read one at a time
 * would spend 200 model loads reading 200 images. One batch call loads it once.
 *
 * @param {Array<{buffer: Buffer}>} strips
 * @returns {Promise<Array>} one OCR result per strip, in order
 */
async function ocrStrips(strips, options = {}) {
  const usable = strips.filter(Boolean);
  if (!usable.length) return [];
  const tmpPaths = usable.map((_, i) => tempPath(`-${i}.png`));
  try {
    usable.forEach((s, i) => fs.writeFileSync(tmpPaths[i], s.buffer));
    return await runEasyOcrBatch(tmpPaths, options);
  } finally {
    for (const p of tmpPaths) fs.rmSync(p, { force: true });
  }
}

/**
 * Crop an image to the bounding box of its white-ish ink.
 *
 * The recogniser normalises whatever it is given to a fixed height. Handed a
 * whole table row — 84 crop px tall with a ~34px glyph somewhere inside it —
 * the glyph ends up small and its vertical position inside the frame changes
 * how it reads ("FCX" and "FX" and "KX" from the same glyph depending on
 * where the row boundary fell). Cropping to the ink puts the glyph in the
 * frame on its own terms.
 *
 * The ink mask is deliberately narrow: bright AND nearly achromatic. The
 * position list puts green and red percentages and a blue flag icon in the
 * same row, and those are excluded by the chroma test rather than by
 * guessing which column they belong to.
 */
async function trimToInk(buffer, options = {}) {
  const minLuma = options.inkMinLuma === undefined ? 120 : options.inkMinLuma;
  const maxSpread = options.inkMaxSpread === undefined ? 80 : options.inkMaxSpread;
  const margin = options.inkMargin === undefined ? 2 : options.inkMargin;

  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width; let maxX = -1; let minY = height; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const r = data[o]; const g = data[o + 1]; const b = data[o + 2];
      const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
      if (mx < minLuma) continue;
      if (mx - mn > maxSpread) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { buffer, trimmed: false };
  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const right = Math.min(width - 1, maxX + margin);
  const bottom = Math.min(height - 1, maxY + margin);
  const outWidth = right - left + 1;
  const outHeight = bottom - top + 1;
  if (outWidth <= 0 || outHeight <= 0) return { buffer, trimmed: false };
  const out = await sharp(buffer).extract({ left, top, width: outWidth, height: outHeight }).png().toBuffer();
  return { buffer: out, trimmed: true, box: { left, top, width: outWidth, height: outHeight } };
}

/**
 * Build ONE image of the whole ticker column, at natural spacing.
 *
 * This is the preparation that works. Measured on the two reference panels:
 *
 *   preparation                          20220218   20230609
 *   whole panel read                     7/9        7/13
 *   stitched column (cells + gaps)        5/9        4/13
 *   NATURAL STRIP (this)                  8/9        9/13
 *
 * The difference is the spacing. Stitching the rows together with black
 * gaps gives the detector a strip of isolated words, and the recogniser
 * then normalises each of them into a box that does not match the word's
 * own proportions — "UPST" comes back as "JPSI". A natural strip keeps the
 * rows where the application drew them, the detector finds each row's box
 * on its own, and the recogniser gets the crop it would have got from the
 * screen.
 *
 * The strip contains only the ticker column, so a price can never be
 * merged into a ticker: the price is not in the picture.
 */
async function prepareColumnStrip(imagePath, column, rows, options = {}) {
  if (!column || !rows || !rows.length) return null;
  const scale = options.scale || 6;
  const padLeft = options.padLeft === undefined ? 4 : options.padLeft;
  const padRight = options.padRight === undefined ? 2 : options.padRight;
  const padTop = options.padTop === undefined ? 2 : options.padTop;
  const padBottom = options.padBottom === undefined ? 2 : options.padBottom;

  const meta = await sharp(imagePath).metadata();
  const left = Math.max(0, Math.round(column.left) - padLeft);
  const right = Math.min(meta.width - 1, Math.round(column.right) + padRight);
  const top = Math.max(0, Math.round(rows[0].top) - padTop);
  const bottom = Math.min(meta.height - 1, Math.round(rows[rows.length - 1].bottom) + padBottom);
  if (right <= left || bottom <= top) return null;

  const buffer = await sharp(imagePath)
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize({
      width: Math.max(1, Math.round((right - left + 1) * scale)),
      height: Math.max(1, Math.round((bottom - top + 1) * scale)),
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
  return { buffer, left, top, right, bottom, scale, rows };
}

/**
 * Assign the OCR words of a column strip to its rows.
 *
 * A row may be read as one word or as several ("TSLA" came back as "TSU"
 * once), so a row's text is its words concatenated in reading order.
 */
function interpretColumnStrip(ocr, strip) {
  if (!ocr || ocr.error || !strip) return { rows: [], error: ocr && ocr.error };
  const { scale, left, top } = strip;
  const perRow = strip.rows.map(() => []);
  for (const w of ocr.words || []) {
    const wl = w.left / scale + left;
    const wr = (w.left + w.width) / scale + left;
    const wt = w.top / scale + top;
    const wb = (w.top + w.height) / scale + top;
    const cy = (wt + wb) / 2;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < strip.rows.length; i++) {
      const r = strip.rows[i];
      const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best < 0 || bestDist > 4) continue;
    perRow[best].push({ text: String(w.text || ''), left: wl, right: wr, top: wt, bottom: wb, conf: w.conf });
  }
  const rows = perRow.map((words, i) => {
    const ordered = [...words].sort((a, b) => a.left - b.left);
    const text = ordered.map((w) => w.text.replace(/[^A-Z]/gi, '').toUpperCase()).join('');
    const conf = ordered.length
      ? ordered.reduce((s, w) => s + Number(w.conf || 0), 0) / ordered.length
      : 0;
    return {
      rowIndex: i,
      top: strip.rows[i].top,
      bottom: strip.rows[i].bottom,
      text,
      conf,
      words: ordered,
    };
  });
  return { rows };
}

/**
 * Read the whole ticker column as one natural strip.
 */
async function readColumnStrip(imagePath, column, rows, options = {}) {
  const strip = await prepareColumnStrip(imagePath, column, rows, options);
  if (!strip) return { rows: [] };
  const [ocr] = await ocrStrips([{ buffer: strip.buffer }], {
    timeoutMs: options.timeoutMs || 600000,
    pythonPath: options.pythonPath,
    allowlist: options.allowlist === undefined ? LETTERS_ONLY : options.allowlist,
  });
  return { ...interpretColumnStrip(ocr, strip), strip };
}

/**
 * Build one image per data row of the ticker column, without OCRing them.
 *
 * This is the per-cell counterpart of prepareTickerStrip: no stitching, one
 * image per row, so each can be recognised on its own.
 */
async function prepareTickerCells(imagePath, table, options = {}) {
  const scale = options.scale || 1;
  const column = options.column;
  if (!column) return [];

  const startIndex = options.dataRowStart === undefined
    ? (table.headerSlotIndex >= 0 ? table.headerSlotIndex + 1 : 0)
    : options.dataRowStart;
  const slots = table.slots.slice(startIndex);
  if (!slots.length) return [];

  const padLeft = options.padLeft === undefined ? 4 : options.padLeft;
  const padRight = options.padRight === undefined ? 2 : options.padRight;
  const left = Math.max(0, column.left - padLeft);
  const right = column.right + padRight;

  const cells = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    let buffer = await extractRegion(imagePath, {
      left,
      top: s.top,
      width: Math.max(1, right - left + 1),
      height: Math.max(1, s.bottom - s.top + 1),
    }, scale, options);
    let box = null;
    if (options.trimInk !== false) {
      const trimmed = await trimToInk(buffer, options);
      buffer = trimmed.buffer;
      box = trimmed.box;
    }
    cells.push({ buffer, rowIndex: i, slotIndex: startIndex + i, top: s.top, bottom: s.bottom, inkBox: box });
  }
  return cells;
}

/**
 * Read every data row of the ticker column, one recogniser call per cell.
 *
 * Unlike readTickerColumn this does NOT run EasyOCR's text detector: the cell
 * IS the box, so the recogniser is handed the pixels directly. On the
 * Qullamaggie position list the ticker glyphs are ~6 src px tall and the
 * detector's box merging drops the leading letter of a ticker — "FCX" came
 * back as "KX" from pixels that plainly show FCX.
 */
async function readTickerCells(imagePath, table, options = {}) {
  const cells = await prepareTickerCells(imagePath, table, options);
  if (!cells.length) return { rows: [] };
  const results = await ocrStrips(cells, {
    ...options,
    recognize_only: options.recognize_only === undefined ? true : options.recognize_only,
    allowlist: options.allowlist === undefined ? LETTERS_ONLY : options.allowlist,
  });
  const rows = cells.map((cell, i) => {
    const r = results[i];
    const words = (r && r.words) || [];
    const text = words
      .map((w) => String(w.text || '').replace(/[^A-Z]/gi, '').toUpperCase())
      .join('');
    const conf = words.length
      ? words.reduce((sum, w) => sum + Number(w.conf || 0), 0) / words.length
      : 0;
    return {
      rowIndex: cell.rowIndex,
      slotIndex: cell.slotIndex,
      top: cell.top,
      bottom: cell.bottom,
      text,
      conf,
      words,
      error: r && r.error,
    };
  });
  return { rows };
}

module.exports = {
  extractRegion,
  stitchVertical,
  assignWordsToSpans,
  columnForWord,
  prepareHeaderStrip,
  interpretHeaderStrip,
  prepareTickerStrip,
  interpretTickerStrip,
  prepareColumnStrip,
  interpretColumnStrip,
  readColumnStrip,
  prepareTickerCells,
  readTickerCells,
  readHeaderSlots,
  readTableHeader,
  readTickerColumn,
  ocrStrips,
  trimToInk,
  symWordScore,
  editDistance,
  LETTERS_ONLY,
  adaptToParserSchema,
};
