'use strict';

// The panel's own row count — the footer strip, and the number in it.
//
// This is the project's only INDEPENDENT check on a reading: the panel prints
// how many rows it has, so a reading with a different number of tickers has
// provably dropped a row or invented one.
//
// The rules below are all measured, not designed. The readings are the REAL
// Tesseract output from the tracked ground-truth fixtures, so the test fails
// if the reader stops handling the garbling the engine actually produces.
//
//   node --test test/panelFooterCount.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FOOTER_BANDS,
  FOOTER_MIN_VOTES,
  panelFooterStripForDate,
  panelFooterStripsForDate,
  readPanelFooterText,
  resolvePanelFooterVotes,
} = require('../src/video/panelFooter');

test('the count is the TOTAL, not the selected row index', () => {
  // "K of N Items" — N is the total, K is the selected row's index. Reading
  // the first number is the trap the ground-truth audit paid for.
  const read = readPanelFooterText('3 of 9 Items in Personal WatchList');
  assert.equal(read.count, 9);
  assert.equal(read.form, 'k_of_n');
});

test('the plain form reads its number', () => {
  assert.equal(readPanelFooterText('9 Items in Personal WatchList').count, 9);
});

test('the singular form is read, and the plural follows the total', () => {
  assert.equal(readPanelFooterText('1 Item in Personal WatchList').count, 1);
  assert.equal(readPanelFooterText('1 of 1 Item in Personal WatchList').count, 1);
});

test('a footer with no "Personal" is not the positions table\'s', () => {
  // The middle screener prints "N Items in WatchList". It is not the
  // positions table, so it must not be read as one.
  assert.equal(readPanelFooterText('3 Items in WatchList'), null);
  assert.equal(readPanelFooterText('no footer here'), null);
  assert.equal(readPanelFooterText(''), null);
});

test('the garblings the engine really produces are read', () => {
  // Every line below is real Tesseract output from the fixture strips, with
  // the count the panel itself prints.
  const measured = [
    ['EE. | 13 of 14 hems in Personal Watchlist Last INTE | - JE', 14],
    ['EE. | 16 of 16 tems in Personal WaschLisr Last m= meg G3) mm e=i', 16],
    ['[TH ey FE 4 Items in Personal Watchlist Last Somed', 4],
    ['MCAT FE 4 Items in Personal Watchlist Last Sorted 03:22 Ree o BE Ax 15:24 —', 4],
    ['LILA — Il = —_— 8 of 8 Isems In Personal Watchlist Last Somes 0333 Re-% PEE oe I” 15:48 — |', 8],
    ['— hdl e000 7 tems In Personal Watchlist Last Soned 03:34 Re-Som ° PEE 1539 — |', 7],
    ['wdmmrtt SR L258 9 teams in Personal Watchlist Last Somted 03:31 Re-Sont ¥ PE 1532 —', 9],
    ['I 11 ems nn Personal WaschlLs Last Somed 03323 ReSomr w Xm 4. 1559 — |', 11],
    ['dss) l #3 of 11 Items in Personad Wanchline Last Sonmed 0335 Re-Son @ PE 1541 — |', 11],
    ['ee E 13 Items in Personal Watchliisx Last Soned 034% Re-Son @ a. Em a. 1605 — |', 13],
    ['AEA � 4 11 Items in Persona! Watchls: Last Somed EO | J ��', 11],
  ];
  for (const [text, count] of measured) {
    const read = readPanelFooterText(text);
    assert.ok(read, `no reading for: ${text}`);
    assert.equal(read.count, count, `wrong count for: ${text}`);
  }
});

test('a clock is not a count', () => {
  // The strip also catches "Last Sorted 03:22" and a clock time. The unit
  // word is what keeps those out: without it a bare "digits near the anchor"
  // rule would happily read 22 or 1537.
  const read = readPanelFooterText('. Lo a Last Sommed 03:39 Re.S - ar A. 15:44 —');
  assert.equal(read, null);
});

test('a count needs two agreeing bands', () => {
  // A wrong count is worse than no count: the whole value of the number is
  // that it contradicts a reading, and a wrong number turns a working check
  // into a source of false alarms. On 20230126 one band read "8.0 2" for an
  // eight-row panel, so a single band cannot be trusted.
  assert.equal(resolvePanelFooterVotes([{ count: 8, band: 0.9259 }]), null);
  assert.equal(resolvePanelFooterVotes([]), null);
  assert.equal(resolvePanelFooterVotes([{ count: null, band: 0.9259 }]), null);

  const agreed = resolvePanelFooterVotes([
    { count: 8, band: 0.9352 },
    { count: 8, band: 0.9444 },
  ]);
  assert.equal(agreed.count, 8);
  assert.equal(agreed.votes, 2);
});

test('the most-voted count wins, and the loser is recorded', () => {
  const resolved = resolvePanelFooterVotes([
    { count: 9, band: 0.9259 },
    { count: 9, band: 0.9352 },
    { count: 3, band: 0.9444 },
  ]);
  assert.equal(resolved.count, 9);
  assert.deepEqual(resolved.rejected, [{ count: 3, votes: 1 }]);
});

test('a tie is broken toward the bottom-most band', () => {
  // The positions table is the BOTTOM-most widget in the frame, so the same
  // discriminator the table reader uses applies here. A tie only arises
  // between counts that EACH clear the two-vote threshold -- a 1-1 tie is
  // simply an uncorroborated reading, and reports nothing.
  assert.equal(resolvePanelFooterVotes([
    { count: 7, band: 0.9352 },
    { count: 2, band: 0.9444 },
  ]), null);

  const resolved = resolvePanelFooterVotes([
    { count: 7, band: 0.9259 },
    { count: 7, band: 0.9352 },
    { count: 2, band: 0.9444 },
    { count: 2, band: 0.9537 },
  ]);
  assert.equal(resolved.count, 2, 'the bottom-most count wins the tie');
  assert.equal(resolved.votes, 2);
});

test('the strip is tight, and there is more than one of it', () => {
  // A taller band reads WORSE: the rows above and below the footer are the
  // same height, and Tesseract merges them into the footer line. Measured:
  // 70px band 22/40, 40px band 28/40.
  const strip = panelFooterStripForDate('20220218');
  assert.ok(strip.h <= 0.04, `the band must stay tight, got ${strip.h}`);

  // The footer's y varies between frames, so a single band cannot reach all
  // of them.
  const strips = panelFooterStripsForDate('20220218');
  assert.ok(strips.length >= 3, 'several bands are needed');
  assert.deepEqual(strips.map((s) => s.y), [...FOOTER_BANDS]);

  // The x window follows the panel, by the same era rule as the crop.
  assert.ok(panelFooterStripForDate('20220218').x > panelFooterStripForDate('20231215').x,
    'the 2022 floating panel is further right than the 2023 sidebar');
});

test('the minimum vote count is two', () => {
  assert.equal(FOOTER_MIN_VOTES, 2);
});
