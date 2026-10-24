'use strict';

const sharp = require('sharp');

const { findTickerColumnByInkRuns, robustRight } = require('./positionColumn.js');
const {
  ocrStrips,
  interpretColumnStrip,
  prepareColumnStrip,
  symWordScore,
  LETTERS_ONLY
} = require('../ocr/positionCellOcr.js');
const { decodeCell, loadCharConfusion } = require('../normalize/tickerDecode.js');
const { loadDecodeLexiconSync } = require('../normalize/tickerScan.js');

// Reading the Qullamaggie POSITIONS table out of a frame, in production.
//
// WHY THIS EXISTS
// The position list is a TradingView GUI TABLE, not a chart overlay. The
// legacy reader assumes it is an overlay: it crops a FIXED rectangle
// (0.86,0.62,0.14,0.22 of the frame) and then guesses which OCR tokens in
// that rectangle are tickers. Both halves of that assumption are wrong for
// the 2023-era sidebar layout, where the table sits at x 1606-1648 of 1920
// and y 444-708 of 1080 — entirely outside the crop
// (docs/qmg-positions-layout-findings.md, § 'Two layouts' and
// § 'Measured geometry per corpus frame').
//
// So the table is LOCATED instead of assumed: the white ink gives candidate
// ticker columns, and the title bar says which one is the positions table.
//
// THE DISCRIMINATOR
// The watchlist and the positions table are nearly identical: both have a
// "Sym" column, both have blue flag icons, and the 2023 sidebar stacks
// them at the SAME column x, so they are the same shape in the same place
// (docs/qmg-positions-layout-findings.md, § 'Two layouts', § 'Why the
// full-frame geometry detector failed' and § 'Blue-flag measurement').
// Neither the header nor the flags can tell them apart.
//
// The TITLE BAR can. "A - Positions" is truncated by the panel width to a
// span that OVERLAPS the ticker column, so it comes out of the column
// strip as a row reading APOSI, APOSIS, AUPOSS or POSOS — every one of
// which contains "POS". That is decisive.
//
// When the title does not overlap the column (20220218) the candidate's
// first row is already a ticker, and the tie-break is that the positions
// table is the BOTTOM-MOST table in the right-hand region: the watchlist is
// docked above it.
//
// TWO CROPS, TWO JOBS
// The title is truncated so that it hangs over the ticker column, which
// means the crop that reads it has to reach further LEFT than the ticker
// column does. But that same crop also swallows the flag column, whose
// blue icons can merge into the ticker text. So the two readings use
// different crops:
//
//   - the WIDE crop (60 px further left) reads the first rows of EVERY
//     candidate, to tell the positions table from the watchlist;
//   - the NARROW crop (the ticker column itself) reads the holdings.
//
// This split is this module's own. The corpus builder
// (tools/buildPositionCorpus.js) probes every candidate at the candidate's
// OWN bounds and over the WHOLE ladder, and identifies the table from the
// "Sym" header label — a signal the watchlist shares, which is why it
// cannot settle the question here
// (docs/qmg-positions-layout-findings.md, § 'Blue-flag measurement' and
// § 'Existing modules'). The title bar can.
//
// WHY THE SOURCE RESOLUTION MATTERS
// The ticker glyphs are ~6.8 SOURCE px tall. A 1280-wide copy of a 1920
// source makes them ~4.5 px, and the same panel then reads
// "US / D / WCU / W / KOCO" instead of "UPST / DVN / NRGU / MOS / TQQQ".
// This module therefore reads the frame it is given at its NATIVE width,
// and the caller must hand it a native frame — the scan does that with
// `extractOcrFrame(..., native)` (tools/scanVideoWithOcr.js). A frame
// narrower than MIN_SOURCE_WIDTH_PX is refused rather than read.

// How many of a candidate's first rows the title probe reads. The title is
// the first row of the ladder in every measured frame that has one
// (20220222 c1: title + header + 7 data; 20230608 c0: title + 13 data;
// 20230609 c0: 2 title/header rows + 13 data), so three rows is enough to
// see the title, the header, and the first ticker.
const PROBE_ROWS = 3;

// How many rows the probe strip actually COVERS.
//
// This is deliberately more than PROBE_ROWS: the title and the header only
// occupy the first couple of rows, but the question "is this column even a
// table of tickers?" is answered by the rows BELOW them. With a three-row
// probe that question could never be answered — a candidate's ticker-shaped
// row count could not exceed one — so a column with no title and no header
// was excluded from the bottom-most rule entirely, and the 2023 sidebar
// (whose positions table has neither a readable title nor a "Sym" header in
// the probe) claimed nothing at all.
const PROBE_STRIP_ROWS = 8;

// How far LEFT of the ticker column the title crop has to reach to catch
// the truncated title text.
const TITLE_WIDEN_LEFT_PX = 60;

// The ticker column is in the right-hand quarter of the frame in both
// measured layouts (2022-era x 1793/1920 = 0.93, 2023-era x 1606/1920 =
// 0.84). Anything further left is the chart or the chat overlay.
const REGION_LEFT_FRACTION = 0.75;

// A position list is a ladder of rows: a few at least, at the measured
// 18 source px pitch.
const MIN_ROWS = 3;
const PITCH_MIN_PX = 10;
const PITCH_MAX_PX = 40;
const MIN_COLUMN_WIDTH_PX = 12;

const DEFAULT_MAX_CANDIDATES = 4;

// Strip variants for the ticker read. The corpus builder read each column
// three ways and gave the decoder all three readings of a cell as
// hypotheses, so the same shape is kept here.
const STRIP_VARIANTS = Object.freeze([
  Object.freeze({ scale: 6, padLeft: 4, padRight: 2, tag: 's6p4' }),
  Object.freeze({ scale: 6, padLeft: 0, padRight: 2, tag: 's6p0' }),
  Object.freeze({ scale: 8, padLeft: 2, padRight: 4, tag: 's8p2' })
]);

// Per-image OCR timeout. The adapter's total budget is
// perImageMs * imageCount + 120000, so this must stay sane: 300000 with 8
// images is already a 42-minute budget
// (docs/qmg-positions-layout-findings.md, § 'Operational constraints').
const DEFAULT_OCR_TIMEOUT_MS = 300000;

/** The letters of a read, uppercased. */
function lettersOnly(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * Is this the positions table's title bar?
 *
 * "A - Positions" is truncated by the panel width to a span that overlaps
 * the ticker column, and the recogniser reads it as APOSI, APOSIS, AUPOSS
 * or POSOS. Every one of those contains the substring POS, and that is the
 * test — the LITERAL substring, and nothing looser.
 *
 * A three-gram within edit distance 1 of "POS" looks like a natural
 * extension of that test, and it is measured to be wrong. On 20230609 c0 the
 * WATCHLIST's title read as "RPISLVE" in one run and "RPISLU" in another,
 * and a third title on the same frame read as "ROSIM". "PIS" and "ROS" are
 * each one substitution from "POS", so a near-miss rule picks the watchlist
 * and publishes its holdings (ABNB, AMD, SHOP, RIVN, NVDA, RBLX, ZS, NFLX,
 * DDOG) as positions. Every near miss that has been measured on a real
 * frame was a false positive, and every true title that has been measured
 * contains POS literally — so the near-miss rule is gone. A title that
 * cannot be read as POS is not a title, and the frame falls back to the
 * legacy reader instead.
 *
 * Two guards keep it from firing on a holding:
 *
 *  - a real ticker is never a title, and none of the 259 lexicon tickers
 *    contains "POS";
 *  - a read of only three letters is not a title either — "POS" is one
 *    character away from a holding, and the real reads are all five or six
 *    letters long.
 *
 * The read that arrives here has already been through the OCR seam, which
 * keeps the letters and drops everything else (`interpretColumnStrip`
 * strips every non-A-Z character), so a digit cannot reach this test: a
 * title the recogniser read as "APO5I" arrives as "APOI", which is not a
 * title, and the frame falls back to the legacy reader.
 *
 * @param {string} text
 * @param {{lexicon?: {tickerSet?: Set<string>}}} [options]
 * @returns {boolean}
 */
function looksLikePositionsTitle(text, options = {}) {
  const raw = String(text || '').trim();
  if (raw.length < 4) return false;
  const letters = lettersOnly(raw);
  if (letters.length < 4) return false;
  const tickerSet = options.lexicon && options.lexicon.tickerSet;
  if (tickerSet && (tickerSet.has(letters) || tickerSet.has(raw.toUpperCase()))) return false;
  return letters.includes('POS');
}

/**
 * Is this read a ticker from the seed lexicon?
 *
 * The titles already refuse to fire on a holding, and the COLUMN HEADER has
 * to refuse the same way. "Sym" is one edit distance from several real
 * holdings — TSM, XOM, ARM, CRM, SOL, STX, VRM, NEM, SWN, SLB, SLV, SLY,
 * TEM, TSEM, SGMO, SSO and SPYM are all within two edits of it — so a
 * header row that swallows one of them silently drops a holding from the
 * published list. There is no fallback for that: the legacy reader is
 * skipped whenever the table publishes.
 *
 * A read that is NOT in the lexicon is left alone. The measured misreads of
 * the header ("Syrn", "Svm", "FUOSYM") are not tickers, and a garbled
 * holding that is not in the lexicon could not have been published anyway:
 * the decoder rejects every read that does not identify a ticker.
 *
 * @param {string} text
 * @param {{lexicon?: {tickerSet?: Set<string>}}} [options]
 * @returns {boolean}
 */
function readsAsLexiconTicker(text, options = {}) {
  const raw = String(text || '').trim();
  const tickerSet = options.lexicon && options.lexicon.tickerSet;
  if (!tickerSet) return false;
  const letters = lettersOnly(raw);
  return tickerSet.has(letters) || tickerSet.has(raw.toUpperCase());
}

/**
 * Is this the watchlist's title bar?
 *
 * The measured watchlist titles read XIWL and XWL (the third, XSM, is not
 * recognisable). A candidate whose title reads this way is VETOED: the
 * watchlist and the positions table look alike in every other respect, so
 * the one positive signal that separates them must not be overridden.
 *
 * A title the recogniser mangled beyond recognition (XSM) simply does not
 * veto anything — which is why a lone table with no readable title is not
 * published: without a positive signal, "the only table in the panel" could
 * just as easily be the watchlist.
 *
 * @param {string} text
 * @param {{lexicon?: {tickerSet?: Set<string>}}} [options]
 * @returns {boolean}
 */
function looksLikeWatchlistTitle(text, options = {}) {
  const letters = lettersOnly(text);
  if (letters.length < 3) return false;
  const tickerSet = options.lexicon && options.lexicon.tickerSet;
  if (tickerSet && tickerSet.has(letters)) return false;
  if (letters.includes('WATCH')) return true;
  return letters.endsWith('WL');
}

/**
 * The index of the first row at or after `from` that satisfies `test`.
 *
 * `depth` limits how far from `from` the row may be: the title only ever
 * sits at the top of the table.
 */
function firstRowIndex(rows, from, test, depth) {
  const limit = depth === undefined ? rows.length : Math.min(rows.length, from + depth);
  for (let i = Math.max(0, from); i < limit; i += 1) {
    if (test(rows[i], i)) return i;
  }
  return -1;
}

/**
 * The candidate ticker columns worth reading.
 *
 * The gate is deliberately narrow: the column must be in the right-hand
 * region, must be a ladder of at least MIN_ROWS rows at a plausible pitch,
 * and must be wide enough to be a column of tickers rather than a
 * scrollbar sliver.
 *
 * @param {Array<object>} candidates  from findTickerColumnByInkRuns
 * @param {number} frameWidth
 * @returns {Array<object>}
 */
function shortlistCandidates(candidates, frameWidth, options = {}) {
  const maxCandidates = options.maxCandidates || DEFAULT_MAX_CANDIDATES;
  const regionLeft = (options.regionLeftFraction === undefined
    ? REGION_LEFT_FRACTION
    : options.regionLeftFraction) * frameWidth;
  const minRows = options.minRows === undefined ? MIN_ROWS : options.minRows;

  const kept = (candidates || []).filter((c) => {
    if (!c || !Array.isArray(c.rows) || c.rows.length < minRows) return false;
    if (frameWidth && c.left < regionLeft) return false;
    if (c.pitch < PITCH_MIN_PX || c.pitch > PITCH_MAX_PX) return false;
    if (robustRight(c.rows) - c.left < MIN_COLUMN_WIDTH_PX) return false;
    return true;
  });

  // Keep the most rows first, but keep MORE THAN ONE: the watchlist often
  // has more rows than the positions table (measured 12 against 9 on
  // 20220222 c1), so "the longest ladder wins" picks the wrong table.
  kept.sort((a, b) => (b.rowCount - a.rowCount) || (a.leftVar - b.leftVar));
  return kept.slice(0, maxCandidates);
}

/**
 * Score one candidate's reading.
 *
 * @param {object} candidate
 * @param {{rows: Array}} read  an interpreted column strip
 * @param {{lexicon?: object}} [options]
 */
function evaluateCandidate(candidate, read, options = {}) {
  const lexicon = options.lexicon || null;
  const rows = (read && read.rows) || [];
  const titleRow = firstRowIndex(
    rows,
    0,
    (row) => looksLikePositionsTitle(row.text, { lexicon }),
    PROBE_ROWS
  );
  // The title bar carries a "Syms" column-visibility button, so the header
  // search must start BELOW the title: otherwise the title's own button
  // would be read as the header and the real header would survive as a
  // holding.
  //
  // A read that is a lexicon ticker is never the header, for the same
  // reason a ticker is never a title: "Sym" is within two edits of TSM,
  // XOM, ARM, CRM, SOL, STX, VRM, NEM, SWN, SLB, SLV, SLY, TEM, TSEM,
  // SGMO, SSO and SPYM, so without this guard a holding can be eaten as
  // the header row and dropped from the published list. There is no
  // fallback for that — the legacy reader is skipped whenever the table
  // publishes.
  const headerRow = firstRowIndex(
    rows,
    titleRow >= 0 ? titleRow + 1 : 0,
    (row) => symWordScore(row.text) >= 0 && !readsAsLexiconTicker(row.text, { lexicon }),
    PROBE_ROWS
  );
  const watchRow = firstRowIndex(
    rows,
    0,
    (row) => looksLikeWatchlistTitle(row.text, { lexicon }),
    PROBE_ROWS
  );

  const dataStart = resolveDataRowStart(rows, { titleRow, headerRow });
  // How many of the remaining rows could BE a holding: a short run of
  // capitals, which is what a ticker column is. This is what tells a
  // table apart from the chart area, which has long labels, prices and
  // axis text in it.
  let tickerishRows = 0;
  for (let i = dataStart; i < rows.length; i += 1) {
    const letters = lettersOnly(rows[i].text);
    if (!letters || letters.length > 5) continue;
    tickerishRows += 1;
  }

  let score = 0;
  if (titleRow >= 0) score += 1000;
  if (watchRow >= 0) score -= 1000;
  if (headerRow >= 0) score += 100;

  return {
    candidate,
    rows,
    titleRow,
    headerRow,
    watchRow,
    dataStart,
    tickerishRows,
    score,
    bottom: candidate.bottom,
    rowCount: candidate.rowCount
  };
}

/**
 * Where the holdings start.
 *
 * The title bar and the header row are not holdings. Everything above the
 * last of them is.
 *
 * @param {Array<object>} rows
 * @param {{titleRow?: number, headerRow?: number}} marks
 * @returns {number} the index of the first data row
 */
function resolveDataRowStart(rows, marks = {}) {
  const titleRow = marks.titleRow === undefined ? -1 : marks.titleRow;
  const headerRow = marks.headerRow === undefined ? -1 : marks.headerRow;
  const last = Math.max(titleRow, headerRow);
  return last >= 0 ? last + 1 : 0;
}

/**
 * Choose the POSITIONS table among the candidate ticker columns.
 *
 * The rules, in order:
 *
 *  1. A candidate whose title bar reads as "positions" wins. This is
 *     decisive and it is what the measurements support.
 *  2. Otherwise the positions table is the BOTTOM-MOST table in the
 *     right-hand region: the watchlist is docked above it. This is the
 *     fallback for the frames where the title does not overlap the column.
 *  3. Otherwise no table is claimed, and the caller falls back to the
 *     legacy crop reader.
 *
 * The reason is returned so that a wrong pick is visible in the output
 * rather than silent.
 *
 * @param {Array<object>} candidates
 * @param {Array<{rows:Array}>} readings
 * @param {{frameWidth?: number, lexicon?: object}} [options]
 * @returns {{index:number, reason:string, evaluations:Array, titleRow:number,
 *            headerRow:number, dataStart:number, fallback:boolean}}
 */
function selectPositionsTable(candidates, readings, options = {}) {
  const evaluations = [];
  for (let i = 0; i < (candidates || []).length; i += 1) {
    const candidate = candidates[i];
    const read = readings && readings[i];
    if (!candidate || !read || !read.rows || !read.rows.length) continue;
    // The index into the CANDIDATE list is carried on the evaluation, not
    // derived from the evaluations array: a candidate whose probe failed to
    // OCR is skipped here, so the two arrays are not the same length and
    // `evaluations.indexOf(winner)` would point at the wrong candidate.
    evaluations.push({ ...evaluateCandidate(candidate, read, options), candidateIndex: i });
  }

  const nothing = {
    index: -1,
    reason: 'none',
    verified: false,
    evaluations,
    titleRow: -1,
    headerRow: -1,
    dataStart: 0,
    fallback: true
  };
  if (!evaluations.length) return nothing;

  // A watchlist title vetoes a candidate outright.
  const eligible = evaluations.filter((e) => e.watchRow < 0);
  // A watchlist was positively identified somewhere. That makes the single
  // remaining table identifiable by elimination: the watchlist is docked
  // ABOVE the positions table, so whatever is left below it is the
  // positions table.
  const watchVetoed = evaluations.some((e) => e.watchRow >= 0);

  const titled = eligible.filter((e) => e.titleRow >= 0);
  if (titled.length) {
    const winner = titled.reduce((a, b) => betterByScore(a, b));
    return decision(winner, evaluations, 'title', true);
  }

  // No title anywhere. Take the bottom-most table that actually LOOKS like a
  // table of holdings.
  //
  // The test is two or more ticker-shaped rows below the header, NOT "has a
  // Sym header". A header alone is not a table of holdings: on 20230609 c0
  // the only candidate carrying a Sym header had no readable ticker rows at
  // all, and claiming it would have published a column of prices.
  const tableLike = eligible.filter((e) => e.tickerishRows >= 2);
  if (!tableLike.length) return nothing;
  if (tableLike.length === 1) {
    // One table, no title, no identified watchlist. That table could be the
    // watchlist — on 20220222 c0 the detector produced ONLY the watchlist,
    // and its title read as "XSM", which the watchlist rule does not
    // recognise. Publishing it would put watchlist entries into the
    // portfolio as holdings, which is worse than publishing nothing.
    // So a lone table is only claimed when a watchlist was positively
    // identified and vetoed.
    //
    // AND the survivor has to be the table BELOW that watchlist. The
    // watchlist is docked above the positions table, so "whatever is left"
    // only means the positions table when the survivor really is lower
    // down the frame. A survivor that sits above the watchlist — or
    // overlaps it, which is what a merged sidebar cluster looks like — is
    // some other panel, and publishing it would publish the wrong one.
    const survivor = tableLike[0];
    const belowWatchlist = evaluations
      .filter((e) => e.watchRow >= 0)
      .every((watchEval) => startsBelow(survivor, watchEval));
    return decision(survivor, evaluations, 'sole_candidate', watchVetoed && belowWatchlist);
  }
  const winner = tableLike.reduce((a, b) => betterByBottom(a, b));
  return decision(winner, evaluations, 'bottom_most', true);
}

/**
 * Does the survivor start BELOW the vetoed watchlist?
 *
 * The watchlist is docked above the positions table, so the survivor is the
 * positions table only when the frame agrees. A candidate whose geometry is
 * missing cannot be shown to be below the watchlist, so it is not claimed.
 */
function startsBelow(survivor, watchEval) {
  const survivorCandidate = survivor && survivor.candidate;
  const watchCandidate = watchEval && watchEval.candidate;
  if (!survivorCandidate || !watchCandidate) return false;
  if (!Number.isFinite(survivorCandidate.top) || !Number.isFinite(watchCandidate.bottom)) return false;
  return survivorCandidate.top >= watchCandidate.bottom;
}

/**
 * Which of two candidates is the better positions table?
 *
 * The title score comes first (a title is worth more than any number of
 * ticker-shaped rows), then how much of the table was readable, then how
 * many rows it has.
 */
function betterByScore(a, b) {
  if (b.score !== a.score) return b.score > a.score ? b : a;
  if (b.tickerishRows !== a.tickerishRows) return b.tickerishRows > a.tickerishRows ? b : a;
  return b.rowCount > a.rowCount ? b : a;
}

/**
 * Which of two candidates is the LOWER table?
 *
 * The positions table is docked below the watchlist, so the bottom-most
 * table in the right-hand region is the positions table.
 */
function betterByBottom(a, b) {
  if (b.bottom !== a.bottom) return b.bottom > a.bottom ? b : a;
  if (b.tickerishRows !== a.tickerishRows) return b.tickerishRows > a.tickerishRows ? b : a;
  return b.rowCount > a.rowCount ? b : a;
}

function decision(winner, evaluations, reason, verified) {
  return {
    // The index into the CANDIDATE list, not into `evaluations` — the two
    // are not the same length when a candidate's probe failed to OCR.
    index: winner.candidateIndex,
    reason,
    // "verified" means the table was POSITIVELY identified as the
    // positions table: by its title, by being the bottom-most of several
    // tables, or by a watchlist having been identified and vetoed above it.
    // An unverified table is not published — a wrong table is worse than no
    // table.
    verified: Boolean(verified),
    evaluations,
    titleRow: winner.titleRow,
    headerRow: winner.headerRow,
    dataStart: winner.dataStart,
    candidate: winner.candidate,
    fallback: reason !== 'title'
  };
}

/**
 * The rows of a strip: the candidate's ladder, or its first few rows.
 */
function stripRowsFor(candidate, count) {
  const ladder = candidate.rows.map((r) => ({
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right: r.right
  }));
  return count && count < ladder.length ? ladder.slice(0, count) : ladder;
}

/**
 * The narrowest frame the table reader can read.
 *
 * A position-list glyph is ~6.8 px tall in a 1920-wide source. Below about
 * 1600 px wide it is under 6 px, and the panel stops being readable at all:
 * at 1280 the same row reads as "US / D / WCU / W / KOCO" instead of
 * "UPST / DVN / NRGU / MOS / TQQQ". A narrower frame is REFUSED rather than
 * read into garbage, because a refused frame is a frame the legacy reader
 * gets to try.
 */
const MIN_SOURCE_WIDTH_PX = 1600;

/**
 * The wall-clock budget for ONE frame — the title probe plus the ticker
 * read.
 *
 * The adapter budgets `perImageMs * imageCount + 120000`, so a fixed
 * per-image timeout makes the cost of a frame depend on how many candidate
 * columns there are. Four probe strips at 300 s each is a 22-minute probe
 * on its own, which is how a frame came to carry a 39-minute budget and
 * take 82 minutes. The budget is the thing the caller asks for; the
 * per-image timeout is derived from it.
 */
const DEFAULT_FRAME_BUDGET_MS = 900000;

/**
 * The per-image OCR timeout for a batch of `count` images.
 *
 * `runEasyOcrBatch` spends `perImageMs * count + 120000`, so the batch's
 * worst case is `count` times the per-image timeout. The frame budget is
 * split between the two phases and then across the images of the phase, so
 * that the whole frame stays inside it.
 *
 * @param {number} count  how many images the batch holds
 * @param {{timeoutMs?: number, frameBudgetMs?: number}} [options]
 * @returns {number} milliseconds
 */
function perImageTimeoutMs(count, options = {}) {
  const cap = options.timeoutMs || DEFAULT_OCR_TIMEOUT_MS;
  const frameBudget = options.frameBudgetMs || DEFAULT_FRAME_BUDGET_MS;
  const phaseBudget = Math.floor(frameBudget / 2);
  const byBudget = Math.floor((phaseBudget - 120000) / Math.max(1, count));
  // The floor keeps a single image from being killed instantly; past it the
  // frame can overrun its budget, which is the lesser evil next to never
  // reading anything at all.
  return Math.max(30000, Math.min(cap, byBudget));
}

/**
 * Reconcile the title and header rows the two crops found.
 *
 * The WIDE probe and the NARROW read can both see the title bar and the
 * header row, and they do not always read them the same way. The later of
 * the two wins for each: skipping one row too many loses a holding, but
 * skipping one too few turns the title into a holding.
 *
 * This is the rule that decides which ladder rows are holdings, so it is
 * a function of its own and it is tested as one.
 *
 * @param {{titleRow: number, headerRow: number}} selection  the probe's verdict
 * @param {{titleRow: number, headerRow: number}} narrowEval  the narrow read's verdict
 * @param {Array} ladder  the candidate's rows
 * @returns {{titleRow: number, headerRow: number, dataStart: number}}
 */
function reconcileTitleHeader(selection, narrowEval, ladder) {
  const titleRow = Math.max(selection.titleRow, narrowEval.titleRow);
  const headerRow = Math.max(selection.headerRow, narrowEval.headerRow);
  const dataStart = resolveDataRowStart(ladder, { titleRow, headerRow });
  return { titleRow, headerRow, dataStart };
}

/**
 * Read the positions table out of one frame.
 *
 * @param {string} framePath  a frame at the SOURCE resolution
 * @param {object} [options]
 * @param {number} [options.frameBudgetMs]  wall-clock budget for this frame
 * @returns {Promise<object>} the reading; `found` says whether a positions
 *   table was located at all
 */
async function readPositionTable(framePath, options = {}) {
  const lexicon = options.lexicon || loadDecodeLexiconSync();
  const confusion = options.confusion || loadCharConfusion();
  const meta = await sharp(framePath).metadata();
  const frameWidth = meta.width || 0;

  const base = {
    framePath,
    frameWidth,
    sourceWidth: frameWidth,
    candidates: 0,
    candidate_scores: []
  };

  // A frame too narrow to read is refused before anything is spent on it.
  if (frameWidth && frameWidth < MIN_SOURCE_WIDTH_PX) {
    return {
      ...base,
      found: false,
      verified: false,
      reason: 'source_too_narrow',
      detail: `frame is ${frameWidth}px wide; the table needs at least ${MIN_SOURCE_WIDTH_PX}px`,
      tickers: [],
      decoded: []
    };
  }

  const ink = await findTickerColumnByInkRuns(framePath, options);
  const candidates = shortlistCandidates(ink.candidates, frameWidth, options);
  base.candidates = candidates.length;

  if (!candidates.length) {
    return { ...base, found: false, reason: 'no_candidates', tickers: [], decoded: [] };
  }

  const ocrOptions = {
    timeoutMs: options.timeoutMs || DEFAULT_OCR_TIMEOUT_MS,
    pythonPath: options.pythonPath,
    allowlist: LETTERS_ONLY,
    engine: options.engine
  };

  // ---- PHASE 1: the title probe -------------------------------------
  // One WIDE crop per candidate, covering only its first few rows. The
  // title is truncated so that it hangs over the ticker column, so the
  // crop has to reach further left than the ticker column does.
  const probeVariant = STRIP_VARIANTS[0];
  const widenLeft = options.titleWidenLeft === undefined
    ? TITLE_WIDEN_LEFT_PX
    : options.titleWidenLeft;
  const probes = [];
  for (const candidate of candidates) {
    const column = {
      left: candidate.left - widenLeft,
      right: robustRight(candidate.rows)
    };
    const rows = stripRowsFor(candidate, PROBE_STRIP_ROWS);
    const strip = await prepareColumnStrip(framePath, column, rows, {
      scale: probeVariant.scale,
      padLeft: probeVariant.padLeft,
      padRight: probeVariant.padRight
    });
    if (strip) probes.push({ candidate, strip });
  }
  if (!probes.length) {
    return { ...base, found: false, reason: 'no_probes', tickers: [], decoded: [] };
  }

  const probeOcr = await ocrStrips(probes.map((p) => p.strip), {
    ...ocrOptions,
    timeoutMs: perImageTimeoutMs(probes.length, options)
  });
  const probeReadings = probes.map((p, i) => ({
    ...interpretColumnStrip(probeOcr[i], p.strip),
    candidate: p.candidate
  }));

  const selection = selectPositionsTable(
    probes.map((p) => p.candidate),
    probeReadings,
    { frameWidth, lexicon }
  );

  const candidateScores = selection.evaluations.map((e) => ({
    left: e.candidate.left,
    rows: e.rowCount,
    bottom: e.bottom,
    score: e.score,
    title: e.titleRow >= 0 ? String(e.rows[e.titleRow].text || '') : null,
    header: e.headerRow >= 0 ? String(e.rows[e.headerRow].text || '') : null,
    watch: e.watchRow >= 0 ? String(e.rows[e.watchRow].text || '') : null,
    tickerish_rows: e.tickerishRows
  }));

  if (selection.index < 0) {
    return {
      ...base,
      found: false,
      verified: false,
      reason: selection.reason,
      candidate_scores: candidateScores,
      tickers: [],
      decoded: []
    };
  }

  // ---- PHASE 2: the ticker read --------------------------------------
  // The NARROW crop: the ticker column itself, without the flag column
  // that the wide crop had to swallow.
  const winner = probes[selection.index];
  const variants = (options.variants || STRIP_VARIANTS)
    .slice(0, options.variantCount || STRIP_VARIANTS.length);
  const ladder = stripRowsFor(winner.candidate);
  const narrowColumn = {
    left: winner.candidate.left,
    right: robustRight(winner.candidate.rows)
  };
  const strips = [];
  for (const variant of variants) {
    const strip = await prepareColumnStrip(framePath, narrowColumn, ladder, {
      scale: variant.scale,
      padLeft: variant.padLeft,
      padRight: variant.padRight
    });
    if (strip) strips.push({ variant, strip });
  }
  if (!strips.length) {
    return {
      ...base,
      found: false,
      verified: false,
      reason: 'no_strips',
      candidate_scores: candidateScores,
      tickers: [],
      decoded: []
    };
  }

  // The ticker read is the expensive half, and it can fail on its own: a
  // timeout or a crashed OCR process must not throw away what phase 1
  // established. The table was already positively identified by then, so
  // the failure is reported as a diagnostic and the frame falls back to
  // the legacy reader.
  let tickOcr;
  try {
    tickOcr = await ocrStrips(strips.map((s) => s.strip), {
      ...ocrOptions,
      timeoutMs: perImageTimeoutMs(strips.length, options)
    });
  } catch (error) {
    return {
      ...base,
      found: false,
      verified: false,
      reason: 'ticker_read_failed',
      detail: error.message,
      titleRow: selection.titleRow,
      headerRow: selection.headerRow,
      discriminator: selection.reason,
      candidate_scores: candidateScores,
      tickers: [],
      decoded: []
    };
  }
  const variantReadings = strips.map((s, i) => ({
    variant: s.variant.tag,
    ...interpretColumnStrip(tickOcr[i], s.strip)
  }));

  // The title and the header can be seen in both crops, and they do not
  // always read the same way in both. Take the later of the two for each:
  // skipping one row too many loses a holding, but skipping one too few
  // turns the title into a holding.
  const narrowEval = evaluateCandidate(winner.candidate, { rows: variantReadings[0].rows }, { lexicon });
  const { titleRow, headerRow, dataStart } = reconcileTitleHeader(selection, narrowEval, ladder);

  // The title and the header can be read in either crop, and the two reads
  // do not always agree. The NARROW read covers the whole ladder, so it is
  // preferred; the wide probe only covers the first three rows.
  const rowText = (index) => {
    if (index < 0) return '';
    const narrow = (variantReadings[0].rows || [])[index];
    if (narrow) return String(narrow.text || '');
    const probe = (probeReadings[selection.index].rows || [])[index];
    return probe ? String(probe.text || '') : '';
  };

  // One row of each variant is one hypothesis for the same cell.
  const rows = ladder.map((r, i) => {
    const hypotheses = [];
    for (const reading of variantReadings) {
      const row = reading.rows[i];
      if (!row) continue;
      const text = lettersOnly(row.text);
      if (!text) continue;
      hypotheses.push({ text, conf: row.conf, source: reading.variant });
    }
    return { index: i, hypotheses };
  }).slice(dataStart);

  const decoded = decodeRows(rows, { lexicon, confusion });
  const tickers = decoded.map((d) => d.ticker).filter(Boolean);
  const rejected = decoded.filter((d) => !d.ticker);

  // The narrow strip's words, back in SOURCE coordinates, so a caller can
  // draw them on the frame they came from. interpretColumnStrip already
  // un-scales them; it just needs the box reshaped.
  const words = [];
  for (const reading of variantReadings) {
    for (const row of reading.rows) {
      for (const w of row.words || []) {
        words.push({
          text: String(w.text || ''),
          left: Number(w.left || 0),
          top: Number(w.top || 0),
          width: Math.max(0, Number(w.right || 0) - Number(w.left || 0)),
          height: Math.max(0, Number(w.bottom || 0) - Number(w.top || 0)),
          conf: Number(w.conf || 0),
          line: row.rowIndex
        });
      }
    }
    break; // one variant's worth is enough for a picture
  }

  return {
    ...base,
    found: true,
    // "verified" says the table was POSITIVELY identified as the positions
    // table. A table that was only "the last one standing" is not
    // verified: it could be the watchlist, and publishing the watchlist as
    // holdings is worse than publishing nothing.
    verified: Boolean(selection.verified),
    reason: selection.reason,
    discriminator: selection.reason,
    fallback: selection.fallback,
    column: {
      left: winner.candidate.left,
      right: robustRight(winner.candidate.rows)
    },
    titleText: rowText(titleRow),
    headerText: rowText(headerRow),
    titleRow,
    headerRow,
    dataRowStart: dataStart,
    rows: decoded.length,
    variants: variantReadings.map((r) => r.variant),
    tickers,
    decoded,
    rejected: rejected.map((r) => r.raw),
    words,
    candidate_scores: candidateScores
  };
}

/**
 * Decode the reads of a column's rows against the lexicon.
 *
 * A row that does not decode is recorded as rejected, never guessed: the
 * decoder refuses a substitution the confusion model has not seen, and an
 * unexplained one-character difference must not be turned into some other
 * ticker.
 */
function decodeRows(rows, options = {}) {
  return (rows || []).map((row) => {
    const decoded = decodeCell(row.hypotheses || [], options);
    return {
      raw: (row.hypotheses || []).map((h) => h.text).join('|'),
      ticker: decoded ? decoded.ticker : null,
      cost: decoded ? decoded.cost : Infinity,
      confidence: decoded ? decoded.confidence : 0
    };
  });
}

module.exports = {
  DEFAULT_FRAME_BUDGET_MS,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_OCR_TIMEOUT_MS,
  MIN_SOURCE_WIDTH_PX,
  PROBE_ROWS,
  PROBE_STRIP_ROWS,
  REGION_LEFT_FRACTION,
  STRIP_VARIANTS,
  TITLE_WIDEN_LEFT_PX,
  decodeRows,
  evaluateCandidate,
  looksLikePositionsTitle,
  looksLikeWatchlistTitle,
  perImageTimeoutMs,
  readPositionTable,
  readsAsLexiconTicker,
  reconcileTitleHeader,
  resolveDataRowStart,
  selectPositionsTable,
  shortlistCandidates,
  stripRowsFor
};
