'use strict';

/**
 * Reading a TABLE out of an image: the geometry, the OCR, and the colour.
 *
 * WHY THE PREPROCESSING IS PER CELL
 *
 * A spreadsheet screenshot is easy to read and hard to OCR, because its
 * cells are COLOURED and Tesseract expects dark ink on a light ground.
 * Measured on the 20261112 position log:
 *
 *   - "MSOS" in the ticker column reads perfectly (black on white);
 *   - "BELOW" in the 20D SMA column is WHITE ON SOLID RED and comes back
 *     as "prow";
 *   - the position-sizing stars come back as "w WK" and "R223";
 *   - the grid's own vertical rules come back as "|" characters sitting
 *     between the values they separate.
 *
 * So each cell is normalised on its own: the cell's background colour is
 * found, the ink is what is far from it, and the cell is rewritten as
 * black ink on white. The COLOUR is not lost, because it is measured on
 * the ORIGINAL pixels before they are rewritten -- the red of a negative
 * gain and the red of a "BELOW" are facts about the cell, and a reader
 * wants both.
 *
 * WHY THE SIGN COMES FROM THE COLOUR
 *
 * Tesseract loses the leading minus of "-4.41%" -- and loses it
 * UNEVENLY, reading "-32.09%" correctly and "-4.41%" as "4.41%" with its
 * confidence collapsing to 35. A number that is sometimes negative and
 * sometimes positive, read from an image, is exactly the kind of thing
 * that must not be guessed. The cell's ink colour settles it: red is a
 * loss, green is a gain, black is neither.
 *
 * WHY THE RULES ARE LEFT IN THE IMAGE
 *
 * The grid's lines are one pixel wide and run the full height of the
 * table, and Tesseract reads them as "|" characters. The obvious fix is
 * to erase them, and it makes the reading WORSE: the rules are what give
 * Tesseract the word boundaries it needs. Measured on the same row, the
 * erased version came back as "msos | 441% | 5.0" where the intact one
 * read "MSOS | -4.41% | $5.00". So the rules stay, and the "|" words are
 * filtered out of the cell text instead.
 *
 * They also have to be kept OUT of the colour measurement, because one
 * rule outweighs the red of "-4.41%" in a 99-pixel-wide cell: measured,
 * the red held 128 pixels and the rule held 134, so the cell's ink was
 * called black and the sign was lost. Insetting the measurement by three
 * pixels drops the rule and its anti-aliasing, and the red wins again --
 * 128 against 96.
 *
 * WHY EACH BAND IS OCR'd SEPARATELY
 *
 * A whole-page OCR of the image is 8,340 pixels wide, and Tesseract's
 * layout analysis does badly on something that wide: the 20261112 row
 * came back as "22.00% | **k | 5220 | seo0% | sie". The SAME row, OCR'd
 * on its own at four times, comes back as "MSOS | -4.41% | $5.00 |
 * $3.90 | BELOW | BELOW | -22.00% | $2.20 | -56.00% | $10.60 | 12/1/25".
 *
 * A band that is still too wide -- the title band, which carries the
 * table's name on the left and the cash figures on the right -- is split
 * at its widest ink-free gap, so each OCR call sees one coherent block.
 *
 * WHY THE STARS ARE NOT OCR'd
 *
 * A five-pointed star is not a character in any training set. Measured:
 * "★★" reads as "w WK" and "★" as "R223", consistently. But a star IS a
 * shape -- each one is a 17x16 pixel blob with 130 ink pixels -- so the
 * size is counted as connected components instead. It is a count, not a
 * guess.
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

const {
  bandsBetween,
  cellsBetween,
  findHorizontalRules,
  findVerticalRules,
  inkComponents,
} = require('./tableGrid');

/** How far from the cell's background a pixel must be to count as ink. */
const INK_DISTANCE = 40;

/**
 * How saturated a cell's background has to be before the cell is
 * normalised.
 *
 * The pale green a spreadsheet uses for a shaded row is rgb(226,239,218),
 * a spread of 21, and it is left alone -- which is what keeps the minus
 * signs. The solid red of a "BELOW" cell is rgb(255,0,0), a spread of
 * 255, and it is rewritten.
 */
const SATURATION_MIN = 60;

/**
 * How far a cell's edges are inset when its INK colour is measured.
 *
 * The grid's rules are one pixel of pure black on the cell boundary, and
 * one rule outweighs the red of "-4.41%" in a 99-pixel-wide cell: measured,
 * the red held 128 pixels and the rule held 134, so the cell's ink was
 * called black and the sign was lost. Insetting by three pixels drops
 * the rule and its anti-aliasing, and the red wins again -- 128 against 96.
 */
const COLOUR_INSET = 3;

/**
 * The scale a cell is upscaled by before the OCR.
 *
 * Eight, not five. The corpus's position logs are screenshots at
 * DIFFERENT resolutions -- measured 1342x437, 1378x527, 1844x578, 1973x765
 * and 2085x729 -- so the same cell is 60 pixels wide in one capture and 90
 * in another, and the text in it is correspondingly smaller.
 *
 * The small captures are where the reading breaks: at five times, the
 * 20250910 header comes back as "Tacker | (hampe | Cost Basis | Price |
 * 20D SMA | 50D SMA | Gamfloss % | Soe", and the columns stop matching.
 * At six times the same strip reads "Ticker | Change | Cost Basis |
 * Price | 20D SMA | 50D SMA | Gain/Loss % | Size | STOP | RISK | R2 |
 * Exits | Exit Price | Entry Date | Trade Length", and eight leaves a
 * margin.
 */
const OCR_SCALE = 8;

/** The page segmentation mode: one uniform block of text. */
const OCR_PSM = '6';

/** How wide an ink-free run has to be before a band is split at it. */
const SPLIT_GAP = 60;

/** How many columns a band needs before it is believed to have a grid. */
const MIN_COLUMNS = 5;

/**
 * A band taller than this is read whole rather than cell by cell.
 *
 * The footer of a position log holds the logo, the win-rate table, the
 * position-sizing legend, the disclaimer and the trend model side by
 * side, and its GRID is not the arrangement of those widgets -- so a
 * per-cell read cuts the sentences in half. The data rows are 35 pixels
 * tall and the title band 40; the footer is 258.
 */
const TALL_BAND = 100;

/**
 * The margin a cell's edges are inset by.
 *
 * Two pixels, not one. The grid's rule is ONE pixel of pure black with
 * an anti-aliased pixel beside it, and insetting by one leaves that
 * anti-aliasing inside the crop -- where it is a stray mark that
 * Tesseract reads as part of the text. Insetting by two drops the rule
 * AND its shadow.
 */
const CELL_INSET = 2;

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: OCR_PSM,
          user_defined_dpi: '300',
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
 * A Tesseract worker keeps the event loop alive, so a tool that has
 * finished must call this or the process will hang.
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
 * TSV columns: level page block par line word left top width height conf text
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
 * The background colour of a rectangle, by mode.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @returns {{r: number, g: number, b: number}}
 */
function modalColour(raw, info, rect) {
  const histogram = new Map();
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const key = ((raw[offset] >> 3) << 10) | ((raw[offset + 1] >> 3) << 5) | (raw[offset + 2] >> 3);
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
  }

  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of histogram) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return {
    b: (bestKey & 31) << 3,
    g: ((bestKey >> 5) & 31) << 3,
    r: ((bestKey >> 10) & 31) << 3,
  };
}

/**
 * The dominant colour of a cell's INK.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {{r: number, g: number, b: number}} background
 * @returns {{r: number, g: number, b: number, coverage: number}}
 */
function inkColour(raw, info, rect, background) {
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));

  const histogram = new Map();
  let inkPixels = 0;
  let total = 0;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = raw[offset];
      const g = raw[offset + 1];
      const b = raw[offset + 2];
      total += 1;
      const distance = Math.sqrt(
        (r - background.r) ** 2 + (g - background.g) ** 2 + (b - background.b) ** 2
      );
      if (distance < INK_DISTANCE) continue;
      inkPixels += 1;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
  }

  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of histogram) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return {
    b: (bestKey & 15) << 4,
    coverage: total ? inkPixels / total : 0,
    g: ((bestKey >> 4) & 15) << 4,
    r: ((bestKey >> 8) & 15) << 4,
  };
}

/**
 * Erase the grid rules.
 *
 * They are one pixel of pure black running the length of the table, and
 * they are read as "|" characters and they sit inside a cell and colour
 * its ink black. Both are artefacts of the grid, not of the data.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {number[]} horizontalRules
 * @param {number[][]} verticalRules - one rule list per band
 * @returns {Buffer} a copy with the rules painted white
 */
function eraseRules(raw, info, horizontalRules, verticalRules) {
  const out = Buffer.from(raw);
  const paint = (x0, x1, y0, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(info.height - 1, y1); y += 1) {
      for (let x = Math.max(0, x0); x <= Math.min(info.width - 1, x1); x += 1) {
        const offset = (y * info.width + x) * info.channels;
        out[offset] = 255;
        out[offset + 1] = 255;
        out[offset + 2] = 255;
      }
    }
  };

  for (const rule of horizontalRules) paint(rule, rule, 0, info.height - 1);
  verticalRules.forEach((rules) => {
    for (const rule of rules) paint(rule, rule, 0, info.height - 1);
  });
  return out;
}

/**
 * Rewrite the FILLED cells as black ink on white, and record what the
 * colours were.
 *
 * Only the FILLED cells are rewritten, and that is the whole trick.
 *
 * A cell is filled when its background is a saturated colour -- the solid
 * red behind a white "BELOW", the solid green behind a black "ABOVE".
 * Those cells are unreadable to Tesseract, which expects dark ink on a
 * light ground, so they are normalised to exactly that.
 *
 * The cells that are NOT filled are left ALONE, and that matters more
 * than it looks. The red "-4.41%" on a pale green row keeps its minus
 * sign when the pixels are left as they are; normalising it throws the
 * minus away, because a threshold on the ink either keeps the whole
 * glyph or loses the whole glyph, and a hyphen is one pixel of it.
 * Measured on the same row, the same engine:
 *
 *   raw pixels     ... -4.41% ... -22.00% ... -56.00% ...
 *   all normalised ... 4.41%  ... 22.00%  ... 56.00%  ...
 *
 * So: normalise the fills, leave the rest, and take the sign of a
 * percentage from its COLOUR -- red is a loss, green is a gain, black is
 * neither.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {Array<object>} cells - the cell rectangles
 * @returns {{buffer: Buffer, colour: object[]}} the rewritten pixels and
 *   the per-cell colour facts
 */
function normaliseCells(raw, info, cells) {
  const out = Buffer.from(raw);
  const colour = [];

  for (const cell of cells) {
    const background = modalColour(raw, info, cell);
    const ink = inkColour(raw, info, insetRect(cell, COLOUR_INSET), background);
    colour.push({ background, ink });

    const spread = Math.max(background.r, background.g, background.b)
      - Math.min(background.r, background.g, background.b);
    if (spread < SATURATION_MIN) continue;

    // The direction from the background to the ink. The cell is stretched
    // ALONG it, so the anti-aliasing survives as a grey ramp instead of
    // being thresholded into a hard edge -- a threshold fattens every
    // letter until the gaps in the smaller ones close, and the header
    // row reads "Tooker" and "(hampe" instead of "Ticker" and "Change".
    const dr = ink.r - background.r;
    const dg = ink.g - background.g;
    const db = ink.b - background.b;
    const lengthSquared = dr * dr + dg * dg + db * db;
    if (!lengthSquared) continue;

    const top = Math.max(0, Math.floor(cell.top));
    const bottom = Math.min(info.height - 1, Math.floor(cell.bottom));
    const left = Math.max(0, Math.floor(cell.left));
    const right = Math.min(info.width - 1, Math.floor(cell.right));

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const r = raw[offset];
        const g = raw[offset + 1];
        const b = raw[offset + 2];
        let t = ((r - background.r) * dr + (g - background.g) * dg + (b - background.b) * db)
          / lengthSquared;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const value = Math.round(255 - 255 * t);
        out[offset] = value;
        out[offset + 1] = value;
        out[offset + 2] = value;
      }
    }
  }

  return { buffer: out, colour };
}

/**
 * A rectangle inset by a margin on each side.
 *
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {number} margin
 * @returns {{top: number, bottom: number, left: number, right: number}}
 */
function insetRect(rect, margin) {
  return {
    bottom: rect.bottom - margin,
    left: rect.left + margin,
    right: rect.right - margin,
    top: rect.top + margin,
  };
}

/**
 * The ink-free runs of columns in a band, wide ones only.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @returns {Array<{start: number, end: number, width: number}>}
 */
function inkGaps(raw, info, rect) {
  const top = Math.max(0, Math.floor(rect.top));
  const bottom = Math.min(info.height - 1, Math.floor(rect.bottom));
  const left = Math.max(0, Math.floor(rect.left));
  const right = Math.min(info.width - 1, Math.floor(rect.right));

  const gaps = [];
  let runStart = -1;
  for (let x = left; x <= right + 1; x += 1) {
    let hasInk = false;
    if (x <= right) {
      for (let y = top; y <= bottom; y += 1) {
        const offset = (y * info.width + x) * info.channels;
        const luma = 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2];
        if (luma <= 60) {
          hasInk = true;
          break;
        }
      }
    }
    if (!hasInk) {
      if (runStart === -1) runStart = x;
      continue;
    }
    if (runStart !== -1) {
      const gapWidth = x - runStart;
      if (gapWidth >= SPLIT_GAP) gaps.push({ end: runStart - 1, start: runStart, width: gapWidth });
      runStart = -1;
    }
  }
  return gaps;
}

/**
 * The widest ink-free run of columns in a band.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @returns {{start: number, end: number, width: number}|null}
 */
function widestInkGap(raw, info, rect) {
  const gaps = inkGaps(raw, info, rect);
  if (!gaps.length) return null;
  return gaps.reduce((best, gap) => (gap.width > best.width ? gap : best), gaps[0]);
}

/**
 * The segments of a band, split at every wide ink-free gap.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {{from: number, to: number}} bounds
 * @returns {Array<{left: number, right: number}>}
 */
function segmentsOf(raw, info, rect, bounds) {
  const gaps = inkGaps(raw, info, rect).sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = bounds.from;
  for (const gap of gaps) {
    if (gap.start <= cursor) continue;
    segments.push({ left: cursor, right: gap.start - 1 });
    cursor = gap.end + 1;
  }
  segments.push({ left: cursor, right: bounds.to });
  return segments.filter((segment) => segment.right > segment.left);
}

/**
 * Is this word an artefact of the grid rather than data?
 *
 * Tesseract reads the table's one-pixel vertical rules as "|" characters,
 * and they land inside the cell that owns the rule. They are not values.
 *
 * They are NOT removed from the image, because they HELP: the rules give
 * Tesseract the word boundaries it needs, and an image with them erased
 * reads worse -- measured on the same row, the erased version came back
 * as "msos | 441% | 5.0" where the intact one read "MSOS | -4.41% |
 * $5.00".
 *
 * @param {string} text
 * @returns {boolean}
 */
function isRuleArtefact(text) {
  return /^[|]+$/.test(String(text || '').trim());
}

/**
 * Read the grid of a table out of an image.
 *
 * @param {string} imagePath
 * @param {object} [options]
 * @param {{left: number, top: number, width: number, height: number}} [options.region]
 *   the region of the image the table occupies
 * @param {number} [options.scale=4] the OCR upscale
 * @returns {Promise<object>} the bands, their cells, and the cell colours
 */
async function readTableGrid(imagePath, options = {}) {
  const source = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grid = await readGridFromRaw(source.data, source.info, options);
  grid.raw = source.data;
  grid.info = source.info;
  return grid;
}

/**
 * Read the grid of a table out of raw pixels.
 *
 * The caller needs the raw pixels anyway -- the position-sizing stars
 * are counted as connected components, which is pixel work -- so the
 * pixels are loaded once and passed in.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {object} [options]
 * @returns {Promise<object>} the bands, their cells, and the cell colours
 */
async function readGridFromRaw(raw, info, options = {}) {
  // The scale follows the capture's size. A wide capture (the 2026 logs are
  // 2085 px) reads as well at 5x as at 8x, and 8x costs ~40 s an image
  // against ~25 s; the small captures (1342-1378 px) need the 8x.
  const scale = options.scale || (info.width >= 1900 ? 5 : OCR_SCALE);

  const region = options.region || { height: info.height, left: 0, top: 0, width: info.width };
  const xStart = Math.max(0, Math.floor(region.left));
  const xEnd = Math.min(info.width, Math.floor(region.left + region.width));
  const yStart = Math.max(0, Math.floor(region.top));
  const yEnd = Math.min(info.height, Math.floor(region.top + region.height));

  const horizontalRules = findHorizontalRules(raw, info, { xEnd, xStart });
  const bands = bandsBetween(horizontalRules, { from: yStart, to: yEnd });

  // The vertical rules are measured PER BAND, because a table's columns
  // are only visible inside a row: the title band is one merged cell with
  // no rules through it, and the footer holds several unrelated tables
  // whose rules would not agree with the rows above.
  const ownRules = bands.map((band) => findVerticalRules(raw, info, {
    yEnd: band.bottom,
    yStart: band.top,
  }));

  const rulesForBand = ownRules.map((rules) => (rules.length >= MIN_COLUMNS ? rules : null));
  for (let index = 0; index < bands.length; index += 1) {
    if (rulesForBand[index]) continue;
    for (let offset = 1; offset < bands.length; offset += 1) {
      const above = index - offset;
      if (above >= 0 && rulesForBand[above]) {
        rulesForBand[index] = rulesForBand[above];
        break;
      }
      const below = index + offset;
      if (below < bands.length && rulesForBand[below]) {
        rulesForBand[index] = rulesForBand[below];
        break;
      }
    }
    if (!rulesForBand[index]) rulesForBand[index] = [];
  }

  const clean = raw;

  const bandColumns = bands.map((band, index) => cellsBetween(rulesForBand[index], {
    from: xStart,
    to: xEnd,
  }));

  const allCells = [];
  bands.forEach((band, index) => {
    for (const column of bandColumns[index]) {
      allCells.push({
        bottom: band.bottom,
        left: column.left + CELL_INSET,
        right: column.right - CELL_INSET,
        top: band.top,
      });
    }
  });

  const normalised = normaliseCells(clean, info, allCells);

  // The words are read CELL BY CELL.
  //
  // A band read as one strip loses decimals: the 20261112 STOP cell
  // reads "$2.20" on its own, with a confidence of 94, and "$220" as
  // part of the row. The same is true of the beta, "1.63" -> "163".
  // A cell is a small, well-delimited piece of text, which is what
  // Tesseract is best at.
  //
  // The exception is a TALL band -- the footer, which holds the logo, the
  // win-rate table, the position-sizing legend and the disclaimer side
  // by side. Its cells are not its widgets, so a per-cell read splits
  // sentences in half. A tall band is read whole instead, and split at
  // its widest ink-free gap so each call sees one widget.
  const worker = await getWorker();
  const words = [];

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const columns = bandColumns[index];
    const tall = band.bottom - band.top > TALL_BAND;

    if (tall) {
      const segments = segmentsOf(normalised.buffer, info, band, { from: xStart, to: xEnd - 1 });
      for (const segment of segments) {
        const segLeft = Math.max(0, Math.min(info.width - 1, Math.floor(segment.left)));
        const segRight = Math.max(0, Math.min(info.width - 1, Math.floor(segment.right)));
        const segTop = Math.max(0, Math.min(info.height - 1, Math.floor(band.top)));
        const segBottom = Math.max(0, Math.min(info.height - 1, Math.floor(band.bottom)));
        if (segRight <= segLeft || segBottom < segTop) continue;
        const image = await sharp(normalised.buffer, {
          raw: { channels: info.channels, height: info.height, width: info.width },
        })
          .extract({
            height: segBottom - segTop + 1,
            left: segLeft,
            top: segTop,
            width: segRight - segLeft + 1,
          })
          .resize({ kernel: 'lanczos3', width: Math.round((segRight - segLeft + 1) * scale) })
          .png()
          .toBuffer();
        const result = await worker.recognize(image, {}, { tsv: true });
        for (const word of parseTsvWords(result.data.tsv)) {
          words.push({
            ...word,
            left: word.left / scale + segLeft,
            top: word.top / scale + segTop,
            width: word.width / scale,
          });
        }
      }
      continue;
    }

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex];
      const left = Math.max(0, Math.min(info.width - 1, column.left + CELL_INSET));
      const right = Math.max(0, Math.min(info.width - 1, column.right - CELL_INSET));
      const top = Math.max(0, Math.min(info.height - 1, band.top));
      const bottom = Math.max(0, Math.min(info.height - 1, band.bottom));
      if (right <= left || bottom < top) continue;

      const cellImage = await sharp(normalised.buffer, {
        raw: { channels: info.channels, height: info.height, width: info.width },
      })
        .extract({
          height: bottom - top + 1,
          left,
          top,
          width: right - left + 1,
        })
        .resize({ kernel: 'lanczos3', width: Math.round((right - left + 1) * scale) })
        .png()
        .toBuffer();
      const result = await worker.recognize(cellImage, {}, { tsv: true });
      for (const word of parseTsvWords(result.data.tsv)) {
        words.push({
          ...word,
          left: word.left / scale + left,
          top: word.top / scale + top,
          width: word.width / scale,
        });
      }
    }
  }

  let cellIndex = 0;
  const outBands = bands.map((band, index) => {
    const cells = bandColumns[index].map((column) => {
      const facts = normalised.colour[cellIndex];
      cellIndex += 1;
      const cellWords = words.filter((word) => {
        const centre = word.left + word.width / 2;
        return (
          centre >= column.left && centre <= column.right &&
          word.top >= band.top && word.top <= band.bottom
        );
      });
      cellWords.sort((a, b) => a.left - b.left);
      const valueWords = cellWords.filter((word) => !isRuleArtefact(word.text));
      // The whitespace is collapsed because a cell can hold two lines --
      // the options table's "Position" column reads "01/15/27 5 Call" over
      // "(BTO)" -- and the line break has to survive as a space.
      const text = valueWords.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
      const confidence = valueWords.length
        ? valueWords.reduce((sum, word) => sum + word.conf, 0) / valueWords.length
        : 0;
      return {
        background: facts.background,
        bottom: band.bottom,
        confidence,
        coverage: facts.ink.coverage,
        inkColour: facts.ink,
        left: column.left,
        right: column.right,
        text,
        top: band.top,
        words: valueWords,
      };
    });

    // A tall band's words were read by SEGMENT, not by cell, so its text
    // is the segments' text and its cells are not its widgets.
    const bandWords = words
      .filter((word) => word.top >= band.top && word.top <= band.bottom)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const text = bandWords
      .filter((word) => !isRuleArtefact(word.text))
      .map((word) => word.text)
      .join(' ');

    return { bottom: band.bottom, cells, columns: bandColumns[index], text, top: band.top };
  });

  return {
    bands: outBands,
    columns: bandColumns[0] || [],
    height: info.height,
    horizontalRules,
    region: { height: yEnd - yStart, left: xStart, top: yStart, width: xEnd - xStart },
    verticalRules: rulesForBand,
    width: info.width,
  };
}

/**
 * Read one region of an image and return its text.
 *
 * Used for the widgets that sit OUTSIDE the grid -- the win-rate table
 * and the trend model, which are read as blocks rather than as cells.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{left: number, top: number, width: number, height: number}} rect
 * @param {number} [scale=4]
 * @returns {Promise<string>} the text, whitespace collapsed
 */
async function readRegionText(raw, info, rect, scale = OCR_SCALE) {
  const left = Math.max(0, Math.min(info.width - 1, Math.floor(rect.left)));
  const top = Math.max(0, Math.min(info.height - 1, Math.floor(rect.top)));
  const right = Math.max(left, Math.min(info.width - 1, Math.floor(rect.left + rect.width) - 1));
  const bottom = Math.max(top, Math.min(info.height - 1, Math.floor(rect.top + rect.height) - 1));
  if (right <= left || bottom < top) return '';

  const worker = await getWorker();
  const image = await sharp(raw, {
    raw: { channels: info.channels, height: info.height, width: info.width },
  })
    .extract({ height: bottom - top + 1, left, top, width: right - left + 1 })
    .resize({ kernel: 'lanczos3', width: Math.round((right - left + 1) * scale) })
    .png()
    .toBuffer();
  const result = await worker.recognize(image);
  return String(result.data.text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Read one band of an image as a STRIP, rather than cell by cell.
 *
 * A band's text can be split across its cells by the grid's own rules,
 * and a title band is exactly where that hurts. The 20250910 options
 * title reads cell by cell as
 *
 *     oP | TONS - | WING TI | JADES - | JSIC Aci | ount - | Money | ...
 *
 * because the title is one long string that the sheet's vertical rules
 * cut into pieces. Read as a strip it is
 *
 *     OPTIONS - SWING TRADES - USIC Account - Money Manager ($1MM+) Division
 *
 * and a table can be found by its name.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {number} [scale=OCR_SCALE]
 * @returns {Promise<string>} the text, whitespace collapsed
 */
async function readBandStrip(raw, info, rect, scale = OCR_SCALE) {
  const left = Math.max(0, Math.min(info.width - 1, Math.floor(rect.left)));
  const top = Math.max(0, Math.min(info.height - 1, Math.floor(rect.top)));
  const right = Math.max(left, Math.min(info.width - 1, Math.floor(rect.right)));
  const bottom = Math.max(top, Math.min(info.height - 1, Math.floor(rect.bottom)));
  if (right <= left || bottom < top) return '';

  const worker = await getWorker();
  const image = await sharp(raw, {
    raw: { channels: info.channels, height: info.height, width: info.width },
  })
    .extract({ height: bottom - top + 1, left, top, width: right - left + 1 })
    .resize({ kernel: 'lanczos3', width: Math.round((right - left + 1) * scale) })
    .png()
    .toBuffer();
  const result = await worker.recognize(image);
  return String(result.data.text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Read one CELL of an image, with an optional character whitelist.
 *
 * The whitelist is what keeps a digit from being read as a CURRENCY SIGN.
 * Measured on the 20250910 position log, the RISK cell reads "-£2.41%"
 * when the truth is "-42.41%" -- Tesseract read the "4" as a "£", which
 * are the same shape with a stroke through them. With a whitelist of
 * "0123456789.%+-" the "£" is impossible and the cell reads
 * "-22.41%": still not the right digit, but a NUMBER rather than a
 * currency sign, and one that can be measured instead of silently
 * dropped.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @param {object} [options]
 * @param {number} [options.scale=OCR_SCALE]
 * @param {string} [options.whitelist] - the characters the cell may contain
 * @returns {Promise<{confidence: number, text: string, words: object[]}>}
 */
async function readCell(raw, info, rect, options = {}) {
  const scale = options.scale || OCR_SCALE;
  const left = Math.max(0, Math.min(info.width - 1, Math.floor(rect.left)));
  const top = Math.max(0, Math.min(info.height - 1, Math.floor(rect.top)));
  const right = Math.max(left, Math.min(info.width - 1, Math.floor(rect.right)));
  const bottom = Math.max(top, Math.min(info.height - 1, Math.floor(rect.bottom)));
  if (right <= left || bottom < top) return { confidence: 0, text: '', words: [] };

  const worker = await getWorker();
  const parameters = {
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: OCR_PSM,
    user_defined_dpi: '300',
  };
  // ALWAYS set it, even to the empty string. The worker is shared, and a
  // Tesseract parameter STAYS SET until it is set again: a repair read that
  // left its whitelist behind made every later read in the process come
  // back as garbage -- the same log read 7 positions alone and 0 after
  // another log's repair pass had run.
  parameters.tessedit_char_whitelist = options.whitelist || '';
  if (typeof worker.setParameters === 'function') await worker.setParameters(parameters);

  const image = await sharp(raw, {
    raw: { channels: info.channels, height: info.height, width: info.width },
  })
    .extract({ height: bottom - top + 1, left, top, width: right - left + 1 })
    .resize({ kernel: 'lanczos3', width: Math.round((right - left + 1) * scale) })
    .png()
    .toBuffer();
  const result = await worker.recognize(image, {}, { tsv: true });
  // Hand the worker back as it was found: no whitelist for the next reader.
  if (options.whitelist && typeof worker.setParameters === 'function') {
    await worker.setParameters({ tessedit_char_whitelist: '' });
  }
  const words = parseTsvWords(result.data.tsv);
  const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
  const confidence = words.length
    ? words.reduce((sum, word) => sum + word.conf, 0) / words.length
    : 0;
  return { confidence, text, words };
}

/**
 * Count the star glyphs in a rectangle.
 *
 * A position-size cell holds nothing but stars, and a star is a SHAPE, not
 * a character: a five-pointed star is not in any training set, and
 * Tesseract reads "★★★" as "w WK" and "★" as "R223".
 *
 * So the stars are counted as connected components. The test is SHAPE, not
 * size, because the corpus's position logs are screenshots at five
 * different resolutions -- measured 1342x437, 1378x527, 1844x578, 1973x765
 * and 2085x729 -- and the same star is 130 ink pixels in one capture and 45
 * in another. A fixed area floor therefore finds the stars in one image
 * and none in another.
 *
 * A star is a SOLID blob: its ink fills roughly half of its own bounding
 * box. A letter stroke is much sparser, and a speck of anti-aliasing is
 * small. So the test is a bounding box of at least four pixels each way
 * and an ink fill of at least a third of that box.
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @param {{top: number, bottom: number, left: number, right: number}} rect
 * @returns {number}
 */
function countStars(raw, info, rect) {
  const components = inkComponents(raw, info, rect, { minArea: 8 });
  return components.filter((component) => {
    if (component.width < 4 || component.height < 4) return false;
    const box = component.width * component.height;
    if (!box) return false;
    return component.area / box >= 0.33;
  }).length;
}

module.exports = {
  CELL_INSET,
  INK_DISTANCE,
  MIN_COLUMNS,
  OCR_PSM,
  OCR_SCALE,
  SATURATION_MIN,
  SPLIT_GAP,
  closeWorker,
  countStars,
  eraseRules,
  inkColour,
  modalColour,
  normaliseCells,
  parseTsvWords,
  readBandStrip,
  readCell,
  readGridFromRaw,
  readRegionText,
  readTableGrid,
  segmentsOf,
  widestInkGap,
};
