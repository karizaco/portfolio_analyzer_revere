'use strict';

// The curated OCR-confusion table: `config/ticker_ocr_confusions.csv`.
//
// A row is a RECORDED, human-verified misread of a position-list ticker:
// `garbled,canonical,note`. It is applied ONLY to tokens that landed in the
// detected position-list column, so a coincidental match in chart text is
// never rewritten.
//
// WHY THE TABLE EXISTS
//
// `inListTickers` is the PRICE-ALIGNED subset of the detected column. A row
// whose price is garbled ("$lO5.OO" for "$105.00") is therefore NOT
// price-aligned, so the column gate rejects its ticker — the holding is lost
// BEFORE the repair pass can ever see it. The table substitutes the canonical
// for a token that is spatially inside the column, whether or not the gate
// accepted it.
//
// THE ROWS ADDED 2026-10-31
//
// Nine rows, all from the 2023-era ground-truth captures, that the replay
// scored as misses:
//
//   INGN -> IMGN   G rendered as N
//   KOT  -> IOT    leading I dropped and T rendered as O
//   AQQ  -> ARQQ   R rendered as Q
//   GS0T -> GSIT   I rendered as 0
//   RLI  -> RGTI   G and T rendered as L and dropped
//   QBIS -> QBTS   T rendered as S
//   ATR  -> PLTR   P and L rendered as A and dropped
//   A    -> AI     single-letter read of the two-letter ticker
//   AL   -> AI     I rendered as L
//
// Measured with `node tools/evalParserReplay.js` (no OCR; replays the
// captured probe logs through the current parser):
//
//   default roots : 59/89 (66.3 %) -> 66/89 (74.2 %) recall.
//                   Predictions 62 -> 69, so the three false positives are
//                   UNCHANGED and precision rises 95.2 % -> 95.7 %.
//   wide corpus   : 110/170 (64.7 %) -> 113/170 (66.5 %) recall.
//                   Predictions 134 -> 136, so one false positive fewer and
//                   precision 82.1 % -> 83.1 %.
//
// The benchmark's four curated frames are NOT moved by these rows: a fresh
// EasyOCR run over the four md5-pinned fixtures reproduces the documented
// per-case numbers exactly (8/9, 1/1, 7/8, 7/13 — with 2, 3, 3 and 3 false
// positives). The gain is on the replay corpus, which covers seventeen
// dates, not four frames.
//
// TWO OF THE NINE ROWS CANNOT FIRE ON A REAL FRAME, AND THE TESTS BELOW DO
// NOT CHANGE THAT.
//
// `A -> AI` and `AL -> AI` are recorded misreads — the captured frames show a
// one- and a two-character glyph in the ticker column where the `AI` row
// belongs — but the rescue asks whether a token is inside the column by
// comparing the token's CENTRE with the column's median centre, within a
// hardcoded +-25 px (`columnWidth = 50`, `parseChartStream.js:401`). A
// position list is a LEFT-aligned table, so a four-character ticker's centre
// sits ~64 px right of a one-character glyph's centre even though both start
// at the same x.
//
// Measured on the real `20230609` capture: every ticker in the column starts
// at x 515-518 and the `A` glyph starts at x 518 too, but its centre is 545
// against a median centre of 581.5 — `|545 - 581.5| = 36.5 > 25`, so the
// token is rejected before the alias is consulted. `Al` on `20230608` is the
// same: centre 87, median centre 125.5.
//
// The synthetic frame below gives EVERY token the same width, so a short one
// has the same centre as the rest and passes. That is why the test below
// passes while the corpus does not move: the test proves the alias table is
// wired up correctly, not that the column test can reach a short ticker.
//
// The replay corpus is UNTRACKED, so those numbers cannot be asserted here —
// a fresh clone has no probe logs. What IS assertable is the table's
// INVARIANT, and the parser's behaviour on it, and both are pinned below.
//
// `ATR -> PLTR` is the interesting row: `ATR` is in `TICKER_BLOCKLIST`, so
// the blocklist filter would have deleted it — but the alias pass runs
// BEFORE the blocklist, so the row is rescued instead of dropped. That is
// the only thing that keeps PLTR on the 2023-era table.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadSeedLexiconSync, loadDecodeLexiconSync } = require('../src/normalize/tickerScan');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const CONFUSION_CSV = path.join(ROOT, 'config', 'ticker_ocr_confusions.csv');

// The nine rows added on 2026-10-31.
const NEW_ALIASES = [
  ['INGN', 'IMGN'],
  ['KOT', 'IOT'],
  ['AQQ', 'ARQQ'],
  ['GS0T', 'GSIT'],
  ['RLI', 'RGTI'],
  ['QBIS', 'QBTS'],
  ['ATR', 'PLTR'],
  ['A', 'AI'],
  ['AL', 'AI'],
];

function confusionRows() {
  const raw = fs.readFileSync(CONFUSION_CSV, 'utf8');
  const rows = [];
  let isHeader = true;
  for (const line of raw.split(/\r?\n/)) {
    if (isHeader) {
      isHeader = false;
      if (/^garbled\s*,/i.test(line)) continue;
    }
    if (!line.trim()) continue;
    const [garbled, canonical] = line.split(',').map((v) => String(v || '').trim().toUpperCase());
    if (garbled && canonical && garbled !== canonical) rows.push({ garbled, canonical });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

test('the nine 2026-10-31 aliases are present with the right canonical', () => {
  const rows = confusionRows();
  for (const [garbled, canonical] of NEW_ALIASES) {
    const found = rows.filter((r) => r.garbled === garbled);
    assert.equal(found.length, 1,
      `${garbled} must appear exactly once in the confusion table, found ${found.length}`);
    assert.equal(found[0].canonical, canonical,
      `${garbled} must map to ${canonical}, not ${found[0].canonical}`);
  }
});

test('no confusion row shadows a real ticker', () => {
  // The garbled form must NOT be in either lexicon. If it were, the read
  // would be a legitimate ticker and rewriting it would replace a real
  // holding with a different one.
  //
  // This is the property the deleted seed-variant rows used to violate:
  // `PLIR` was a SEED row, so it published verbatim and never competed with
  // `PLTR`.
  const seed = loadSeedLexiconSync();
  const decode = loadDecodeLexiconSync();
  for (const { garbled, canonical } of confusionRows()) {
    assert.ok(!seed.tickerSet.has(garbled),
      `${garbled} is a seed ticker — a curated alias must not rewrite a real holding to ${canonical}`);
    assert.ok(!decode.tickerSet.has(garbled),
      `${garbled} is in the decode lexicon — a curated alias must not rewrite a real holding to ${canonical}`);
  }
});

test('every confusion row names a canonical the seed lexicon will report', () => {
  // The seed is the ALLOW list: what may be REPORTED. A canonical outside it
  // would be resolved and then discarded, so the row would buy a miss and
  // publish nothing.
  const seed = loadSeedLexiconSync();
  for (const { garbled, canonical } of confusionRows()) {
    assert.ok(seed.tickerSet.has(canonical),
      `${garbled} -> ${canonical}: the canonical is not in the seed lexicon, so it cannot be reported`);
  }
});

test('no confusion row has a duplicate key or a chain', () => {
  // A duplicate key means the table resolves the same read two different
  // ways depending on file order. A chain (`A -> B` and `B -> C`) means a
  // rescued canonical could be rescued again.
  const rows = confusionRows();
  const byKey = new Map();
  for (const { garbled, canonical } of rows) {
    assert.ok(!byKey.has(garbled),
      `${garbled} appears twice in the confusion table (${byKey.get(garbled)} and ${canonical})`);
    byKey.set(garbled, canonical);
  }
  const canonicals = new Set(rows.map((r) => r.canonical));
  for (const { garbled } of rows) {
    assert.ok(!canonicals.has(garbled),
      `${garbled} is both a garbled form and a canonical — the table would chain`);
  }
});

// ---------------------------------------------------------------------------
// THE PARSER
// ---------------------------------------------------------------------------
//
// The synthetic position list below is the one `test/chartStream.test.js`
// uses. The alias row carries a GARBLED price ("$lO5.OO" — the letter O
// where a digit belongs), so the row is not price-aligned even though its
// ticker sits in the column. That is exactly the situation the rescue
// exists for: the column gate rejects the token, and only the curated-alias
// rescue can recover it.

const LIST_X = 780;
const PRICE_X = 900;

// The CONTROL alias. It is in the column in every frame the tests build, so
// the frame always contains at least one rescue. Without it the two boundary
// tests could pass vacuously — if the rescue machinery were broken outright,
// "the canonical is absent" would be true for the wrong reason.
//
// `DIA -> DNA` is a pre-existing row of the table. `DNA` is not one of the
// nine canonicals and is not otherwise in the frame, so the control's
// liveness cannot be confused with the alias under test.
const CONTROL_GARBLED = 'DIA';
const CONTROL_CANONICAL = 'DNA';

function positionListFrame({ alias = 'OBTS', aliasPrice = '$lO5.OO', aliasX = LIST_X, aliasBelowWatchlist = false } = {}) {
  // `GSII` is a chart-area decoy at x=300 and `PLIR` sits below the
  // watchlist header. Both are curated aliases that must NOT be rescued, so
  // the frame keeps them: an alias table that rescued everything would fail
  // this frame, and a frame without them would not notice.
  const listRows = [
    { token: 'AAPL', x: LIST_X, w: 40, price: '$214.50' },
    { token: 'MSFT', x: LIST_X, w: 40, price: '$412.30' },
    { token: 'GSII', x: 300, w: 40 },
    { token: 'TSLA', x: LIST_X, w: 40, price: '$342.10' },
    { token: CONTROL_GARBLED, x: LIST_X, w: 40, price: '$lO5.OO' },
  ];
  const aliasRow = { token: alias, x: aliasX, w: 40, price: aliasPrice };
  const rows = [{ token: 'POSITIONS', x: 700, w: 90 }];
  for (const row of listRows) rows.push(row);
  if (!aliasBelowWatchlist) rows.push(aliasRow);
  rows.push({ token: 'WATCHLIST', x: 700, w: 90 });
  rows.push({ token: 'PLIR', x: LIST_X, w: 40, price: '$lO8.OO' });
  if (aliasBelowWatchlist) rows.push(aliasRow);
  rows.forEach((row, i) => { row.line = i + 1; });

  const words = [];
  const lines = [];
  for (const row of rows) {
    const parts = [row.token];
    words.push({ text: row.token, left: row.x, top: 100 + row.line * 60, width: row.w, height: 30, line: row.line });
    if (row.price) {
      parts.push(row.price);
      words.push({ text: row.price, left: PRICE_X, top: 100 + row.line * 60, width: 60, height: 30, line: row.line });
    }
    lines.push(parts.join(' '));
  }
  return { text: lines.join('\n'), lines, words };
}

test('each new alias is rescued into its canonical when it sits in the column', () => {
  for (const [garbled, canonical] of NEW_ALIASES) {
    const result = parseChartStreamPositionList({ ocr: positionListFrame({ alias: garbled }) });
    const list = Array.isArray(result.position_list) ? result.position_list : [];
    assert.ok(list.includes(canonical),
      `${garbled} was not rescued into ${canonical}: ${JSON.stringify(list)}`);
    assert.ok(!list.includes(garbled),
      `the garbled form ${garbled} was published verbatim: ${JSON.stringify(list)}`);
  }
});

test('a new alias outside the column is not rescued', () => {
  // The column is the structural evidence; a curated alias on its own is not.
  // x=300 is the chart area, the same place `test/chartStream.test.js` puts
  // its `GSII` decoy.
  for (const [garbled, canonical] of NEW_ALIASES) {
    const result = parseChartStreamPositionList({
      ocr: positionListFrame({ alias: garbled, aliasX: 300 })
    });
    const list = Array.isArray(result.position_list) ? result.position_list : [];
    // The control proves the rescue machinery is alive in this frame, so the
    // absence of the canonical below is a decision and not a broken frame.
    assert.ok(list.includes(CONTROL_CANONICAL),
      `the control alias must still be rescued: ${JSON.stringify(list)}`);
    assert.ok(!list.includes(canonical),
      `a chart-area ${garbled} must not be rescued into ${canonical}: ${JSON.stringify(list)}`);
  }
});

test('a new alias below the Personal WatchList header is not rescued', () => {
  // That panel sits at the SAME x as the position list, so a row below it is
  // a watchlist row however well it lines up.
  for (const [garbled, canonical] of NEW_ALIASES) {
    const result = parseChartStreamPositionList({
      ocr: positionListFrame({ alias: garbled, aliasBelowWatchlist: true })
    });
    const list = Array.isArray(result.position_list) ? result.position_list : [];
    assert.ok(list.includes(CONTROL_CANONICAL),
      `the control alias must still be rescued: ${JSON.stringify(list)}`);
    assert.ok(!list.includes(canonical),
      `a watchlist-row ${garbled} must not be rescued into ${canonical}: ${JSON.stringify(list)}`);
  }
});
