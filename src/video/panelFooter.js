'use strict';

// The positions panel's own row count — the strip it lives in, and how to read
// the number out of a line of text.
//
// WHY A SEPARATE STRIP
//
// The panel prints its row count in a footer, and that count is the project's
// only INDEPENDENT check on a reading: the panel says how many rows it has, so
// a reading with a different number of tickers has provably dropped a row or
// invented one.
//
// `readPanelRowCount` (src/parse/parseChartStream.js) already implements the
// reading, but in production it returns `null` on every capture, because the
// footer is not in the pixels the OCR engine is shown. The crops end at source
// y 950 (2022 floating panel) and y 994 (2023 right sidebar); the footer sits
// below both.
//
// Making the main crop taller is NOT the fix. That crop is also the capture
// dedup pHash rectangle, and a taller crop is downscaled more by EasyOCR —
// the measured mechanism behind the `trade_ideas` 9/9 -> 7/9 regression. So
// the footer gets its own small strip, read once per video.
//
// THE GEOMETRY IS MEASURED, NOT ASSUMED
//
// Measured on the tracked ground-truth source snapshots (1920x1080), the
// footer line sits at source y 1000-1040 in both eras. The x window differs
// with the panel: the 2022 floating panel is bottom-right, the 2023 sidebar is
// docked and starts further left, so the strip reuses the era rule rather than
// guessing a single rectangle.
//
// THE ENGINE IS THE OPPOSITE OF THE PROJECT'S DEFAULT
//
// Measured on the same pixels (qmg_20220218.png, "3 of 9 Items in Personal
// WatchList"):
//
//   EasyOCR     "30 Iem inecronal acha LiX"           garbage at 6x, 8x, 12x
//   Tesseract   "3 of 9 Items In Personal Watchlist"  exact
//
// EasyOCR's failure is worse than a miss: "3 of 9" collapses into "30", so the
// count would be read WRONG rather than not at all, and a wrong count is worse
// than no count.
//
// That is consistent with CLAUDE.md's own engine table rather than a surprise:
// the footer is a line of printed prose, which is what Tesseract is trained
// on, while the ticker column is short isolated tokens on a dark panel, which
// is what EasyOCR is trained on. The right engine follows the TEXT.
//
// THE COUNT IS REPORTED, NEVER ACTED ON
//
// Same rule as `readPanelRowCount`: a count misread LOW would truncate a
// correct reading, which is exactly the case where acting on it does the most
// damage. So this module returns a number and a provenance, and nothing
// downstream drops or adds a ticker because of it.
//
// This module holds NO dependency on the OCR stack, so it can be required and
// tested without spawning an engine.

const { chartStreamEraForDate } = require('./chartStreamCrop');

// THE BAND IS TIGHT, AND THERE IS MORE THAN ONE OF THEM
//
// Two things were measured over the 40 fixture dates, and both are
// counter-intuitive enough to be worth stating:
//
// 1. A TALLER band reads WORSE, not better. The footer line is ~6 source px
//    and the rows above and below it (the panel's last holding, the "Last
//    Sorted" line, the clock) are the same size. Giving Tesseract a 70px band
//    instead of a 40px one dropped the reading from 28/40 to 22/40, because it
//    merges neighbouring lines into the footer line. So the band is the height
//    of the line, not a generous window.
//
// 2. The footer's y VARIES BETWEEN FRAMES. Measured: 20220218's footer is in
//    source y 1000-1040, and 20220419's is in 1020-1060. A single tight band
//    therefore cannot reach every frame -- 20220419 reads 14 of 14 at y=0.944
//    and nothing at all at y=0.926.
//
// So the strip is a LIST of tight overlapping bands, scanned per frame.
const FOOTER_H = 0.037;                                  // ~40 source px
// Five bands, 10 source px apart: src y 1000 / 1010 / 1020 / 1030 / 1040.
// Measured need: 20220412's footer reads only in the FIRST band, and
// 20220301's only in the LAST, so a frame's footer can sit anywhere in
// a 40px range and a 3-band set cannot always corroborate it.
const FOOTER_BANDS = Object.freeze([0.9259, 0.9352, 0.9444, 0.9537, 0.9630]);
const FOOTER_Y = FOOTER_BANDS[0];

// The x window follows the panel, by the same era rule as the crop. The 2022
// floating panel is further right than the 2023 sidebar.
const FOOTER_X_FLOATING_PANEL = 0.80;
const FOOTER_X_RIGHT_SIDEBAR = 0.78;

// The strip is small, so it can be upscaled hard without costing much. 8x was
// measured as sufficient; 6x and 12x read the same line, so the choice is not
// on a cliff edge.
const FOOTER_UPSCALE = 8;

/**
 * The footer strip for a date, as fractions of the source frame.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {{x:number,y:number,w:number,h:number,upscale:number,era:string}}
 */
function panelFooterStripForDate(dateKey) {
  const era = chartStreamEraForDate(dateKey);
  const x = era === 'floating_panel' ? FOOTER_X_FLOATING_PANEL : FOOTER_X_RIGHT_SIDEBAR;
  return { x, y: FOOTER_Y, w: 1 - x, h: FOOTER_H, upscale: FOOTER_UPSCALE, era };
}

/**
 * Every band to try for a date, bottom-most LAST.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {Array<{x:number,y:number,w:number,h:number,upscale:number,era:string}>}
 */
function panelFooterStripsForDate(dateKey) {
  const base = panelFooterStripForDate(dateKey);
  return FOOTER_BANDS.map((y) => ({ ...base, y }));
}

// A COUNT IS ONLY REPORTED WHEN TWO BANDS AGREE
//
// Scanning several bands raises coverage and introduces a new way to be wrong:
// a band can read a garbled count confidently. Measured on 20230126, whose
// panel says "8 of 8 Items in Personal WatchList", one band read
//
//   "i | 8.0 2 lems in Personal Watchlist Last Some 16:14 pe |"
//
// — Tesseract rendered "8 of 8" as "8.0 2", so the digit group adjacent to the
// unit word is 2, and a single-band rule would have published a count of 2 for
// an eight-row panel.
//
// That is the one outcome worth engineering against, because a WRONG count is
// worse than no count: the whole value of this number is that it contradicts a
// reading, and a number that is itself wrong turns a working check into a
// source of false alarms.
//
// The guard is the project's own corroboration rule, applied here: the bands
// overlap, so a correctly-read footer is read the SAME WAY by more than one of
// them, while a digit-level garble is a property of one band's pixels. So a
// count needs two votes. Measured: this keeps the three frames whose footer two
// bands agree on, rejects 20230126's wrong reading, and costs the frames that
// only ever read in a single band.
const FOOTER_MIN_VOTES = 2;

/**
 * Resolve one count from several bands' readings.
 *
 * @param {Array<{count:number|null, band:number, text?:string}>} readings
 * @returns {{count:number, votes:number, bands:number[], text:string|null,
 *            rejected:Array<{count:number,votes:number}>}|null}
 */
function resolvePanelFooterVotes(readings) {
  const votes = new Map();
  for (const r of readings || []) {
    if (!r || !Number.isFinite(r.count)) continue;
    if (!votes.has(r.count)) votes.set(r.count, []);
    votes.get(r.count).push(r);
  }
  if (!votes.size) return null;

  const ranked = [...votes.entries()]
    .map(([count, rs]) => ({ count, rs }))
    // Most votes wins. On a tie the BOTTOM-most band wins, because the
    // positions table is the bottom-most widget in the frame -- the same
    // discriminator the table reader uses.
    .sort((a, b) => (b.rs.length - a.rs.length)
      || (Math.max(...b.rs.map((r) => r.band)) - Math.max(...a.rs.map((r) => r.band))));

  const top = ranked[0];
  if (top.rs.length < FOOTER_MIN_VOTES) {
    return null;
  }
  return {
    count: top.count,
    votes: top.rs.length,
    bands: top.rs.map((r) => r.band),
    text: top.rs[0].text || null,
    rejected: ranked.slice(1).map((r) => ({ count: r.count, votes: r.rs.length })),
  };
}

// The three footer forms the panel prints:
//
//   "N Items in Personal WatchList"        the whole list
//   "1 Item in Personal WatchList"         singular when the total is one
//   "K of N Items in Personal WatchList"   a row is selected; K is that row's
//                                          INDEX, not a scroll range
//
// So N is the digit group IMMEDIATELY BEFORE the unit word, and "5 of 7 Items"
// is seven rows with the fifth selected -- reading the first number gives 5,
// which is wrong, and that is the trap the ground-truth audit paid for.
//
// A plural "Items" does not mean the total is above one, and the singular form
// follows the TOTAL rather than the selected row: "1 of 1 Item".
// WHICH TOKENS CAN BE TRUSTED, measured on the real Tesseract readings
//
// The footer is ~6 source px tall, so the WORDS garble badly while the DIGITS
// survive. Measured over 40 fixture dates, "Items" came back as:
//
//   Items  hems  tems  Isems  teams  ems  Rems  itams  Rem  itams
//
// and "WatchList" as:
//
//   Watchlist  WaschLisr  Waschist  Watchliisx  Wanchline  WaschlLs  Waschls
//
// So neither word can be matched literally, and an exact matcher reported
// `null` on 34 of 40 lines whose digits were perfectly readable.
//
// Two things ARE stable:
//
//   * "Personal" survives as Personal / Personad -- it is the longest word in
//     the line and the one the recogniser gets right. It is the ANCHOR.
//   * the unit word keeps its "m" in every single observed garbling. It is a
//     short letters-only token, so "a short token containing m, just left of
//     the anchor" identifies it without naming it.
//
// The count is then the digit group immediately LEFT of that unit word, which
// is what makes the "K of N" form safe: in "3 of 9 Items" the group adjacent
// to the unit word is 9, the total, not 3, the selected row's index.
//
// Requiring the unit word is what keeps a timestamp out. The strip also
// catches "Last Sorted 03:22" and a clock, and without the unit-word step a
// bare "digits near the anchor" rule would happily read 22 or 1537.
// Measured garblings of the anchor word: Personal, Personad, Persona!, Pemonal,
// Personat. The final character is unreliable, so it is not required; the
// third letter is sometimes an m rather than an r.
const PERSONAL_ANCHOR = /pe[rnm]son[ae]/i;
const LETTERS_ONLY = /^[A-Za-z]+$/;

function isUnitWordish(token) {
  const letters = String(token || '').replace(/[^A-Za-z]/g, '');
  if (!LETTERS_ONLY.test(letters)) return false;
  if (letters.length < 2 || letters.length > 6) return false;
  return /m/i.test(letters);
}

/**
 * Read the panel's row count out of a line of OCR text.
 *
 * Tolerant of the garbling a 6px footer produces, and deliberately NOT
 * tolerant about which number it takes: the count is the digit group adjacent
 * to the unit word, so the "K of N" form cannot yield K.
 *
 * @param {string} text OCR text of the footer strip (may hold several lines)
 * @returns {{count:number,text:string,form:string,unit:string}|null}
 */
function readPanelFooterText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  let best = null;
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    const anchor = PERSONAL_ANCHOR.exec(cleaned);
    // No anchor means this is not the footer line. The middle screener's
    // "N Items in WatchList" form has no "Personal" -- and it is also above
    // the strip, so it cannot appear here anyway.
    if (!anchor) continue;

    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) tokens.push({ text: m[0], index: m.index });
    const anchorToken = tokens.findIndex((t) => t.index >= anchor.index);
    if (anchorToken <= 0) continue;

    // Walk LEFT from the anchor for the unit word. A couple of tokens of slack
    // covers the "in"/"an"/"nn" the recogniser puts between them.
    let unitAt = -1;
    for (let i = anchorToken - 1; i >= 0 && i >= anchorToken - 4; i -= 1) {
      if (isUnitWordish(tokens[i].text)) { unitAt = i; break; }
    }
    if (unitAt < 0) continue;

    // The count is the last digit group before the unit word -- or inside it,
    // when the recogniser fused the two ("9Items").
    const fused = tokens[unitAt].text.match(/^(\d+)/);
    let groups;
    if (fused) {
      groups = [fused[1]];
    } else {
      const before = cleaned.slice(0, tokens[unitAt].index);
      groups = before.match(/\d+/g) || [];
    }
    if (!groups.length) continue;
    const count = parseInt(groups[groups.length - 1], 10);
    if (!Number.isFinite(count) || count < 1 || count > 200) continue;

    // The BOTTOM-most footer in the strip is the positions table's, so a later
    // line wins. The strip is cut below every other widget, so in practice
    // there is one.
    best = {
      count,
      text: cleaned,
      form: groups.length > 1 ? 'k_of_n' : 'n',
      unit: tokens[unitAt].text,
    };
  }
  return best;
}

module.exports = {
  FOOTER_Y,
  FOOTER_H,
  FOOTER_BANDS,
  FOOTER_UPSCALE,
  FOOTER_MIN_VOTES,
  FOOTER_X_FLOATING_PANEL,
  FOOTER_X_RIGHT_SIDEBAR,
  panelFooterStripForDate,
  panelFooterStripsForDate,
  readPanelFooterText,
  resolvePanelFooterVotes,
};
