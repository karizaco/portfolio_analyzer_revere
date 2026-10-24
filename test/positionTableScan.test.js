'use strict';

// Tests for the positions-TABLE reader's decision logic.
//
// WHY THESE TESTS EXIST
// The table reader has to answer one question that nothing else can: of the
// several tables stacked in the right-hand panel of a TradingView frame,
// which one is the POSITIONS list? The watchlist and the positions table
// look alike — same "Sym" column, same blue flag icons, same x — so the
// only things that can tell them apart are the title bar and the fact that
// the positions table is the bottom-most one.
//
// That decision is made on OCR text, which is noisy: the title is truncated
// by the panel width and the recogniser reads it as APOSI, APOSIS, AUPOSS
// or POSOS. So the rules that turn those noisy reads into a decision are
// pinned here, against the readings that were actually measured
// (docs/qmg-positions-layout-findings.md, § 'Measured geometry per corpus
// frame' and § 'THE DISCRIMINATOR').
//
// These tests are pure — no OCR, no video. The I/O half is exercised by
// running a real scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  looksLikePositionsTitle,
  looksLikeWatchlistTitle,
  readPositionTable,
  reconcileTitleHeader,
  resolveDataRowStart,
  selectPositionsTable,
  shortlistCandidates,
  stripRowsFor,
  evaluateCandidate,
  perImageTimeoutMs,
  PROBE_ROWS,
  PROBE_STRIP_ROWS
} = require('../src/video/positionTableScan');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');

const LEXICON = loadDecodeLexiconSync();

/** A candidate column, as findTickerColumnByInkRuns would report it. */
function candidate(overrides = {}) {
  const rows = overrides.rows || [];
  return {
    left: 1793,
    rows,
    rowCount: rows.length,
    pitch: 18,
    leftVar: 1,
    medianWidth: 28,
    right: 1827,
    top: rows.length ? rows[0].top : 0,
    bottom: rows.length ? rows[rows.length - 1].bottom : 0,
    ...overrides
  };
}

/** Ladder rows, top to bottom. */
function rows(count, startTop = 600) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const top = startTop + i * 18;
    out.push({ top, bottom: top + 13, left: 1793, right: 1827 });
  }
  return out;
}

/** An interpreted column strip: one row per ladder row. */
function reading(texts) {
  return {
    rows: texts.map((text, i) => ({
      rowIndex: i,
      top: 600 + i * 18,
      bottom: 600 + i * 18 + 13,
      text,
      conf: 0.8,
      words: []
    }))
  };
}

// ---------------------------------------------------------------------------
// The title bar
// ---------------------------------------------------------------------------

test('the measured position titles are recognised', () => {
  // Every one of these is a real reading of "A - Positions" truncated by
  // the panel width (docs/qmg-positions-layout-findings.md, § 'Measured
  // geometry per corpus frame').
  for (const text of ['APOSI', 'APOSIS', 'AUPOSS', 'POSOS']) {
    assert.equal(
      looksLikePositionsTitle(text, { lexicon: LEXICON }),
      true,
      `${text} must be recognised as the positions title`
    );
  }
});

test('a ticker is never mistaken for the title', () => {
  // The title check has to reject real holdings, or a holding called
  // "CPOS" would delete a row from the table.
  for (const ticker of LEXICON.tickers) {
    assert.equal(
      looksLikePositionsTitle(ticker, { lexicon: LEXICON }),
      false,
      `${ticker} must not be read as the title`
    );
  }
});

test('a data row is never mistaken for the title', () => {
  for (const text of ['UPST', 'DVN', 'NRGU', 'MOS', 'TQQQ', 'COPX', 'XIWL', 'XSM']) {
    assert.equal(
      looksLikePositionsTitle(text, { lexicon: LEXICON }),
      false,
      `${text} must not be read as the title`
    );
  }
});

test('a short read is never the title', () => {
  // "POS" is three letters. The title check needs four, so a truncated
  // two-letter read cannot trip it.
  assert.equal(looksLikePositionsTitle('POS', { lexicon: LEXICON }), false);
  assert.equal(looksLikePositionsTitle('', { lexicon: LEXICON }), false);
});

test('a digit-obscured title is not claimed', () => {
  // The recogniser strips every non-A-Z character before the title is
  // looked for (`interpretColumnStrip` in src/ocr/positionCellOcr.js), so a
  // read with a digit in it can never arrive here. "APO5I" would reach the
  // title check as "APOI" — and folding the digit back to a letter would be
  // inventing evidence the OCR did not produce.
  assert.equal(looksLikePositionsTitle('APO5I', { lexicon: LEXICON }), false);
  assert.equal(looksLikePositionsTitle('P0SI', { lexicon: LEXICON }), false);
  // What the stripper actually hands over.
  assert.equal(looksLikePositionsTitle('APOI', { lexicon: LEXICON }), false);
  // Two substitutions away is not enough either.
  assert.equal(looksLikePositionsTitle('PXYZ', { lexicon: LEXICON }), false);
  assert.equal(looksLikePositionsTitle('APQXY', { lexicon: LEXICON }), false);
});

test('the near-miss rule does not fire on a ticker that reads like POS', () => {
  // MOS, SPOT and BROS are all one substitution away from POS in their
  // first three letters. A title rule that caught them would delete a
  // holding from the table.
  for (const ticker of ['MOS', 'SPOT', 'BROS']) {
    assert.equal(
      looksLikePositionsTitle(ticker, { lexicon: LEXICON }),
      false,
      `${ticker} must not be read as the title`
    );
  }
});

test('a near miss on POS is not a title', () => {
  // MEASURED FALSE POSITIVES. On 20230609 c0 the WATCHLIST's title read as
  // "RPISLVE" in one run and "RPISLU" in another, and a third title on the
  // same frame read as "ROSIM". "PIS" and "ROS" are each one substitution
  // from "POS", so a near-miss rule picks the WATCHLIST instead of the
  // positions table — 0 % recall, and the wrong table's holdings (ABNB,
  // AMD, SHOP, RIVN, NVDA, RBLX, ZS, NFLX, DDOG) published as positions.
  //
  // Every near miss measured on a real frame was a false positive, and every
  // true title measured on a real frame contains POS literally. So the
  // near-miss rule is gone: only the literal substring counts.
  for (const text of ['RPISLVE', 'RPISLU', 'ROSIM', 'RPIS']) {
    assert.equal(
      looksLikePositionsTitle(text, { lexicon: LEXICON }),
      false,
      `${text} must not be read as the title`
    );
  }
});

test('the watchlist titles are recognised', () => {
  assert.equal(looksLikeWatchlistTitle('XIWL', { lexicon: LEXICON }), true);
  assert.equal(looksLikeWatchlistTitle('XWL', { lexicon: LEXICON }), true);
  assert.equal(looksLikeWatchlistTitle('WATCHLIST', { lexicon: LEXICON }), true);
  // XSM is what the third watchlist read as — not recognisable, and not
  // treated as one.
  assert.equal(looksLikeWatchlistTitle('XSM', { lexicon: LEXICON }), false);
});

// ---------------------------------------------------------------------------
// Where the holdings start
// ---------------------------------------------------------------------------

test('the holdings start below the title and the header', () => {
  // 20220222 c1: title + header + 7 data rows.
  assert.equal(resolveDataRowStart(rows(9), { titleRow: 0, headerRow: 1 }), 2);
  // 20230608 c0: title + 13 data rows, no header.
  assert.equal(resolveDataRowStart(rows(14), { titleRow: 0, headerRow: -1 }), 1);
  // 20230609 c0: 2 title/header rows + 13 data rows.
  assert.equal(resolveDataRowStart(rows(16), { titleRow: 0, headerRow: 1 }), 2);
  // Neither: everything is data.
  assert.equal(resolveDataRowStart(rows(9), { titleRow: -1, headerRow: -1 }), 0);
});

test('the header is found even when it is glued to the flag column', () => {
  // The wide crop reads the flag column's header as well, so "Sym" comes
  // out as "FUOSYM" — the search has to survive the extra letters.
  const evaluated = evaluateCandidate(candidate({ rows: rows(9) }), reading(['APOSI', 'FUOSYM', 'UPST']), { lexicon: LEXICON });
  assert.equal(evaluated.titleRow, 0);
  assert.equal(evaluated.headerRow, 1);
  assert.equal(evaluated.dataStart, 2);
});

test('the header search starts BELOW the title', () => {
  // The title bar carries a "Syms" column-visibility button, so the title
  // cell can read as both the table's name and the word "Sym". A header
  // search that started at row 0 would read the TITLE as the header, and
  // the real header below it would survive as a holding — "FUOSYM" would
  // be published as a position.
  const evaluated = evaluateCandidate(
    candidate({ rows: rows(9) }),
    reading(['APOSI Syms', 'FUOSYM', 'UPST']),
    { lexicon: LEXICON }
  );
  assert.equal(evaluated.titleRow, 0, 'the title is still the title');
  assert.equal(evaluated.headerRow, 1, 'the real header, not the title’s own button');
  assert.equal(evaluated.dataStart, 2, 'so the header is not published as a holding');
});

// ---------------------------------------------------------------------------
// Choosing the table
// ---------------------------------------------------------------------------

test('the title wins over a longer watchlist', () => {
  // The measured 20220222 c1 shape: the watchlist has MORE rows than the
  // positions table (12 against 9), so "the longest ladder wins" picks the
  // wrong table. Only the title can settle it.
  const watchlist = candidate({
    left: 1792,
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const positions = candidate({
    left: 1794,
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    [reading(['XIWL', 'XSM', 'UPST']), reading(['APOSI', 'FUOSYM', 'DVN'])],
    { lexicon: LEXICON }
  );

  assert.equal(selection.reason, 'title');
  assert.equal(selection.index, 1);
  assert.equal(selection.verified, true, 'a titled table is positively identified');
  assert.equal(selection.titleRow, 0);
  assert.equal(selection.headerRow, 1);
  assert.equal(selection.dataStart, 2);
});

test('two titled candidates are compared, not just counted', () => {
  // Both tables look like positions tables. The one with more of itself
  // readable wins. (A reduce that returned a COMPARISON RESULT instead of
  // the winning element would silently pick nothing here.)
  const weaker = candidate({
    rows: rows(4, 740),
    rowCount: 4,
    top: 740,
    bottom: 740 + 3 * 18 + 13
  });
  const stronger = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [weaker, stronger],
    [reading(['APOSI', 'SYM', 'UPST']), reading(['APOSIS', 'SYM', 'DVN', 'NRGU', 'MOS', 'TQQQ', 'COPX', 'SPY', 'AAOI'])],
    { lexicon: LEXICON }
  );

  assert.equal(selection.reason, 'title');
  assert.equal(selection.index, 1, 'the table with more readable rows must win');
});

test('the bottom-most table wins when no title was read', () => {
  // 20220218 c1: no title was captured on either table. The positions
  // table is docked BELOW the watchlist.
  const watchlist = candidate({
    rows: rows(6, 600),
    rowCount: 6,
    top: 600,
    bottom: 600 + 5 * 18 + 13
  });
  const positions = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    [reading(['UPST', 'DVN', 'NRGU']), reading(['MOS', 'TQQQ', 'COPX'])],
    { lexicon: LEXICON }
  );

  assert.equal(selection.reason, 'bottom_most');
  assert.equal(selection.index, 1);
  assert.equal(selection.verified, true, 'the bottom-most of several tables is positively identified');
});

test('a watchlist title vetoes a candidate', () => {
  const watchlist = candidate({
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const positions = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    [reading(['XIWL', 'XSM', 'UPST']), reading(['MOS', 'TQQQ', 'COPX'])],
    { lexicon: LEXICON }
  );

  assert.equal(selection.index, 1, 'the watchlist must not win');
  assert.notEqual(selection.reason, 'title');
});

test('a table that reads as BOTH a positions title and a watchlist is vetoed', () => {
  // The watchlist's title bar was garbled into something containing "POS",
  // so the candidate reads as a TITLED positions table — and the title
  // rule is decisive. Without the veto it would win and be published: the
  // watchlist's entries would become the portfolio's holdings.
  //
  // The positions table in this frame has no readable title, so nothing
  // else can settle it — the veto is the only thing standing between the
  // watchlist and the published list.
  const watchlist = candidate({
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const positions = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    [reading(['APOSI', 'XIWL', 'UPST']), reading(['MOS', 'TQQQ', 'COPX'])],
    { lexicon: LEXICON }
  );

  assert.equal(selection.index, 1, 'the watchlist must not be published as the positions table');
  assert.equal(selection.reason, 'sole_candidate', 'the survivor is what is left after the veto');
  assert.equal(selection.verified, true, 'and it is claimed, because a watchlist was vetoed');
});

test('nothing is claimed when no candidate looks like a table', () => {
  const chart = candidate({ rows: rows(9, 400), rowCount: 9, top: 400, bottom: 400 + 8 * 18 + 13 });
  const selection = selectPositionsTable(
    [chart],
    [reading(['', '', ''])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.index, -1);
  assert.equal(selection.reason, 'none');
  assert.equal(selection.fallback, true);
});

test('a lone table with no title is not verified', () => {
  // MEASURED FAILURE. On 20220222 c0 the detector produced ONLY the
  // watchlist as a candidate, and its title read as "XSM", which the
  // watchlist rule does not recognise. Publishing that table would put
  // watchlist entries into the portfolio as holdings — worse than
  // publishing nothing.
  const only = candidate({ rows: rows(9, 740), rowCount: 9, top: 740, bottom: 740 + 8 * 18 + 13 });
  const selection = selectPositionsTable(
    [only],
    [reading(['XSM', 'UPST', 'DVN'])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.index, 0, 'the table is still located');
  assert.equal(selection.verified, false, 'but it is not claimed as the positions table');
});

test('a lone table IS verified when a watchlist was identified and vetoed', () => {
  // The watchlist is docked ABOVE the positions table, so once the watchlist
  // has been positively identified, whatever is left below it is the
  // positions table.
  const watchlist = candidate({
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const positions = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    [reading(['XIWL', 'XSM', 'UPST']), reading(['UPST', 'DVN', 'NRGU'])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.index, 1);
  assert.equal(selection.verified, true, 'the vetoed watchlist identifies the survivor');
});

test('a lone table ABOVE the vetoed watchlist is not claimed', () => {
  // The watchlist is docked ABOVE the positions table, so "whatever is
  // left" only means the positions table when the frame agrees. A
  // survivor that sits above the watchlist is some other panel, and
  // publishing it would publish the wrong one.
  const watchlist = candidate({
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const above = candidate({
    rows: rows(9, 300),
    rowCount: 9,
    top: 300,
    bottom: 300 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [above, watchlist],
    [reading(['UPST', 'DVN', 'NRGU']), reading(['XIWL', 'XSM', 'UPST'])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.verified, false, 'the survivor is not below the watchlist, so it is not claimed');
});

test('a holding that reads like the Sym header is not eaten as the header', () => {
  // "Sym" is within two edits of TSM, XOM, ARM, CRM, SOL, STX, VRM, NEM,
  // SWN, SLB, SLV, SLY, TEM, TSEM, SGMO, SSO and SPYM — all real tickers.
  // The 2023-era positions table has NO header row (20230608 c0 is
  // "1 title row + 13 data"), so the header search window reaches the
  // first data rows and one of those holdings would be consumed as the
  // header and silently dropped from the published list. There is no
  // fallback for that: the legacy reader is skipped whenever the table
  // publishes.
  const only = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });
  const evaluation = evaluateCandidate(
    only,
    reading(['APOSI', 'TSM', 'XOM', 'DVN', 'NRGU']),
    { lexicon: LEXICON }
  );

  assert.equal(evaluation.titleRow, 0, 'the title is recognised');
  assert.equal(evaluation.headerRow, -1, 'a holding is never taken for the header');
  assert.equal(evaluation.dataStart, 1, 'the holdings start right below the title');
});

test('a real Sym header is still recognised', () => {
  // The guard must not cost the header: the measured reads are "Sym",
  // "FUOSYM" and "Syrn", and none of them is a lexicon ticker.
  const only = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });
  const evaluation = evaluateCandidate(
    only,
    reading(['APOSI', 'FUOSYM', 'UPST', 'DVN', 'NRGU']),
    { lexicon: LEXICON }
  );

  assert.equal(evaluation.titleRow, 0);
  assert.equal(evaluation.headerRow, 1, 'the header is found');
  assert.equal(evaluation.dataStart, 2, 'the holdings start below the header');
});

test('a Sym header without ticker rows is not a table of holdings', () => {
  // MEASURED. On 20230609 c0 the only candidate carrying a Sym header
  // (it read "TSYMAGSI") had no readable ticker rows at all. A "has a
  // header" test would have claimed that column and published it as
  // holdings.
  const headerOnly = candidate({ rows: rows(4, 613), rowCount: 4, top: 613, bottom: 700 });
  const selection = selectPositionsTable(
    [headerOnly],
    [reading(['SYM', '', '', ''])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.index, -1, 'a column with a header and no tickers is not a table');
  assert.equal(selection.reason, 'none');
});

test('the winner index is the candidate index, not the evaluation index', () => {
  // A candidate whose probe failed to OCR is skipped, so the evaluations
  // array is SHORTER than the candidates array. The index returned has to
  // be the candidate's own, or phase 2 reads the failed candidate's
  // column and publishes the wrong table's holdings.
  const watchlist = candidate({
    rows: rows(12, 500),
    rowCount: 12,
    top: 500,
    bottom: 500 + 11 * 18 + 13
  });
  const positions = candidate({
    rows: rows(9, 740),
    rowCount: 9,
    top: 740,
    bottom: 740 + 8 * 18 + 13
  });

  const selection = selectPositionsTable(
    [watchlist, positions],
    // The first probe read NOTHING, so it is skipped and the evaluations
    // array ends up one entry shorter than the candidates array. Without
    // this the test would pass for the wrong reason: with both probes
    // readable the two arrays are the same length and the distinction
    // this test is about could not show up.
    [reading([]), reading(['APOSI', 'FUOSYM', 'DVN'])],
    { lexicon: LEXICON }
  );
  assert.equal(
    selection.evaluations.length,
    1,
    'the failed probe must leave the evaluations shorter than the candidates'
  );
  assert.equal(selection.reason, 'title');
  assert.equal(selection.index, 1, 'the index must address the candidates array');
  assert.equal(selection.candidate.left, positions.left, 'and name the titled table');
});

test('a single candidate is taken on its own', () => {
  const only = candidate({ rows: rows(9, 740), rowCount: 9, top: 740, bottom: 740 + 8 * 18 + 13 });
  const selection = selectPositionsTable(
    [only],
    [reading(['MOS', 'TQQQ', 'COPX'])],
    { lexicon: LEXICON }
  );
  assert.equal(selection.index, 0);
  assert.equal(selection.reason, 'sole_candidate');
});

// ---------------------------------------------------------------------------
// The candidate shortlist
// ---------------------------------------------------------------------------

test('only columns in the right-hand region are considered', () => {
  // The chat overlay and the chart area are in the left two thirds.
  const chartArea = candidate({ left: 400, rows: rows(12, 400), rowCount: 12 });
  const real = candidate({ left: 1793, rows: rows(9, 740), rowCount: 9 });
  const kept = shortlistCandidates([chartArea, real], 1920);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].left, 1793);
});

test('a ladder at an impossible pitch is rejected', () => {
  const tooTight = candidate({ pitch: 4, rows: rows(9, 740), rowCount: 9 });
  const tooLoose = candidate({ pitch: 90, rows: rows(9, 740), rowCount: 9 });
  const real = candidate({ pitch: 18, rows: rows(9, 740), rowCount: 9 });
  const kept = shortlistCandidates([tooTight, tooLoose, real], 1920);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pitch, 18);
});

test('the shortlist keeps more than one candidate', () => {
  // The watchlist often has more rows than the positions table, so the
  // shortlist must not keep only the longest ladder.
  const watchlist = candidate({ rows: rows(12, 500), rowCount: 12, top: 500, bottom: 500 + 11 * 18 + 13 });
  const positions = candidate({ rows: rows(9, 740), rowCount: 9, top: 740, bottom: 740 + 8 * 18 + 13 });
  const kept = shortlistCandidates([watchlist, positions], 1920);
  assert.equal(kept.length, 2);
});

// ---------------------------------------------------------------------------
// Reconciling the two reads
// ---------------------------------------------------------------------------

test('the title and header rows are reconciled across the two reads', () => {
  // The wide probe crops a strip that reaches LEFT of the ticker column
  // (the truncated title hangs over it); the narrow read crops only the
  // ticker column. The two can therefore disagree about which row the
  // title is on. The LATER of the two wins, because the title sits above
  // the header and the holdings start below both.
  const ladder = rows(9);

  const later = reconcileTitleHeader(
    { titleRow: 0, headerRow: 1 },
    { titleRow: 1, headerRow: -1 },
    ladder
  );
  assert.equal(later.titleRow, 1);
  assert.equal(later.headerRow, 1);
  assert.equal(later.dataStart, 2, 'the holdings start below the title and the header');

  const earlier = reconcileTitleHeader(
    { titleRow: 2, headerRow: 3 },
    { titleRow: 0, headerRow: 1 },
    ladder
  );
  assert.equal(earlier.titleRow, 2);
  assert.equal(earlier.headerRow, 3);
  assert.equal(earlier.dataStart, 4);
});

// ---------------------------------------------------------------------------
// The frame the reader will not read
// ---------------------------------------------------------------------------

test('a frame too narrow to read is refused before any OCR happens', async () => {
  // A position-list glyph is ~6.8 px tall in a 1920-wide source. Below
  // about 1600 px it is under 6 px and the panel stops being readable: at
  // 1280 the same row reads as "US / D / WCU / W / KOCO" instead of
  // "UPST / DVN / NRGU / MOS / TQQQ". Reading it anyway would publish
  // garbage; refusing it hands the frame back to the legacy reader.
  //
  // The refusal has to happen BEFORE the OCR, or a 720p source would cost a
  // full EasyOCR pass per frame to learn nothing. This frame is blank, so
  // a reader that got as far as looking for ticker columns would have come
  // back as 'no_candidates' — the reason is what pins the order.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-table-width-'));
  const file = path.join(dir, 'narrow.png');
  try {
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).png().toFile(file);

    const result = await readPositionTable(file, { timeoutMs: 300000 });

    assert.equal(result.found, false);
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'source_too_narrow');
    assert.equal(result.candidates, 0, 'the column detection that feeds the OCR never ran');
    assert.deepEqual(result.tickers, [], 'nothing is published from a frame that cannot be read');
    assert.deepEqual(result.decoded, []);
  } finally {
    // A setup failure must not be masked by the cleanup, and the temp
    // directory must not be left behind.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The per-image timeout
// ---------------------------------------------------------------------------

test('the per-image timeout is derived from the frame budget', () => {
  // The reader spends two OCR batches per frame (a title probe over every
  // candidate column, then a ticker read over the winner), and the frame
  // budget is split between the phases and then across the images of the
  // phase. The per-image timeout is what keeps a frame with many candidate
  // columns from running for an hour, so it has to scale with the number
  // of images in the batch.
  assert.equal(perImageTimeoutMs(1), 300000, 'one image gets the OCR timeout');
  assert.equal(perImageTimeoutMs(4), 82500, 'four images split the phase budget');
  assert.equal(perImageTimeoutMs(20), 30000, 'the floor keeps a single image from being killed instantly');
});

test('the per-image timeout never exceeds the OCR timeout', () => {
  assert.equal(perImageTimeoutMs(1, { timeoutMs: 60000 }), 60000);
  assert.equal(perImageTimeoutMs(1, { timeoutMs: 5000 }), 30000, 'the floor wins over a tiny cap');
});

test('a smaller frame budget buys a smaller per-image timeout', () => {
  assert.equal(perImageTimeoutMs(1, { frameBudgetMs: 400000 }), 80000);
});

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

test('the probe reads below the title', () => {
  // The title and the header occupy the first couple of rows, but the
  // question "is this column a table of tickers?" is answered by the rows
  // BELOW them. With a probe that stopped at the title, a column with no
  // readable title and no "Sym" header could never be recognised as a
  // table, and the 2023 sidebar claimed nothing at all.
  assert.ok(
    PROBE_STRIP_ROWS > PROBE_ROWS,
    `the probe must cover more rows than the title search looks at (${PROBE_STRIP_ROWS} vs ${PROBE_ROWS})`
  );
  const ladder = rows(12);
  assert.equal(stripRowsFor({ rows: ladder }, PROBE_STRIP_ROWS).length, PROBE_STRIP_ROWS);
  // A short ladder is not padded.
  assert.equal(stripRowsFor({ rows: rows(5) }, PROBE_STRIP_ROWS).length, 5);
});
