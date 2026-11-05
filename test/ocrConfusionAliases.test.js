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
  // The two rows added 2026-11-02. Both were PIXEL-VERIFIED before they
  // were proposed: the marked token box was located on the source pixels.
  //
  //   WHX -> LHX   W rendered as H, 20220412. The marked box sits on the
  //                LHX glyphs in the Sym column's first row of the pinned
  //                crop `20220412_c0.png`. Worth a hit on the wide corpus
  //                (133/168 against 132/168) with no false positive.
  //   CBO -> CBIO  I dropped, 20220606. Pixel-verified by COLUMN-INTENSITY
  //                COSINE SIMILARITY against batch1's CBIO row: 0.9990,
  //                against 0.73-0.81 for every other row of that panel.
  //                It earns nothing today because the column detector
  //                latched onto the % Change column (dominant_left 684)
  //                instead of the Sym column (x 450), so the token was
  //                never inside the detected column. It is kept on the
  //                2026-10-31 precedent: a recorded, verified misread that
  //                does not fire today can fire on the next frame that
  //                reads that way.
  ['WHX', 'LHX'],
  ['CBO', 'CBIO'],
  // The two rows added 2026-11-02 (second batch). Both were pixel-verified
  // against the corpus frame `data/video_ocr_probe/batch15-v2/snapshots/
  // revere_20230523.png`: the panel reads QBTS, FTCH, DNA, AI, SOUN, PLTR,
  // APLD, IMGN, MNDY, LI, CVNA, and the OCR read the LI row as `V` and the
  // FTCH row as `Nch`.
  //
  //   V   -> LI    L and I merged into one V glyph, 20230523.
  //   NCH -> FTCH  FT rendered as N and C, 20230523.
  //
  // `U -> LI` was REJECTED for the same row: `U` is a seed ticker (row 85) and
  // a genuine holding on 20221117, so aliasing it would rewrite a real
  // holding and break the "a garbled form may not be in a lexicon" invariant.
  // The 20230522 capture reads that same LI row as `U`, so the misread has two
  // spellings in the corpus and only one of them may be rescued.
  ['V', 'LI'],
  ['NCH', 'FTCH'],
  // The row added 2026-11-02 (third batch). Pixel-verified against the corpus
  // frame `data/video_ocr_probe/qmg-easyocr-20261017/snapshots/qmg_20230605.png`,
  // whose "A - Positions" panel reads, top to bottom:
  //
  //   IMGN, ARQQ, CVNA, IOT, PLTR, GSIT, MNDY, APLD, AI, QBTS, DNA
  //
  // The OCR read that column as INGN, AQQ, CVNA, IOT, ATR, GS0T, MNDY, APLD,
  // **N**, OBTS, DNA — so the AI row came through as a bare `N`.
  //
  // `N` is in neither lexicon (the seed's one-letter tickers are U, X and P),
  // `AI` is in the seed, and the table has no row keyed `N` and no canonical
  // `N` — so the row is legal on every one of the table's invariants.
  //
  // This is the third row whose canonical is `AI`, after `A -> AI` and
  // `AL -> AI`: the 2023-era sidebar's two-character tickers lose their first
  // glyph in three different ways.
  ['N', 'AI'],
  // The row added 2026-11-02 (fourth batch). Found by the PRODUCTION SMOKE
  // SCAN of 20230609 (`qmg-crop-20261102-smoke`), not by the replay corpus.
  //
  // The 20230609 panel's FIRST row is RGTI, and the EasyOCR read of that row
  // came through as `Rgn` / `RGn` in two of the six OCR'd frames. Normalised,
  // that is `RGN` — which is one edit away from `REGN`, a REAL ticker in the
  // seed, so the distance-1 repair pass published REGN instead of RGTI: a
  // wrong holding, in a portfolio report, on a date whose ground truth holds
  // RGTI and not REGN.
  //
  // Pixel-verified: the panel crops of the same video at t=1944, 972, 3888,
  // 2916 and 0 all read RGTI in the first row of the Sym column.
  //
  // `RGN` is in neither lexicon, `RGTI` is in the seed, and the table has no
  // row keyed `RGN` and no canonical `RGN` — legal on every invariant.
  //
  // It is the fourth row whose canonical is RGTI, after `RGI`, `ROII` and
  // `RLI`: that row is the most-misread holding on the 2023-era sidebar, and
  // every one of its misreadings lands on a different ticker.
  ['RGN', 'RGTI'],
  // The five rows added 2026-11-03, from the 2022-ERA PRODUCTION SCAN
  // (`qmg-easyocr-20261103-era2022`, twelve dates). Every one of them was
  // located on the source pixels BEFORE it was proposed, and every occurrence
  // of every garbled form in the whole corpus was inventoried.
  //
  //   RX   -> FCX   F rendered as R and the C dropped, 20220318. The panel
  //                  reads KWEB, REGN, COPX, NUGT, FCX, X, URA, URNM and the
  //                  OCR read the FCX row as `RX` at left 688 = the column's
  //                  dominant_left. The log contains NEITHER `FCX` NOR `ERX`:
  //                  the published ERX was INVENTED by the distance-1 repair
  //                  (RX->ERX is one insertion; FCX is two edits away, so the
  //                  repair could not reach it). The confusion map is
  //                  consulted BEFORE that fallback, so the row turns a wrong
  //                  holding into the right one. 20220323 read the same row as
  //                  `RX` too (row 6 of 10).
  //   FX   -> FCX   the C dropped, 20220321. Here the price cell is garbled
  //                  (`~0zi`), so FX is NOT price-aligned: the post-pass
  //                  repair skips it and the column gate rejects it. Only the
  //                  curated-alias rescue can reach it.
  //   UI   -> LMT   L and M merged into one U glyph and the T rendered as I,
  //                  20220413. The panel reads WEAT, REGN, COPX, FCX, LHX,
  //                  LMT, X, URA, URNM, JNUG, NUGT ("7 of 11 Items in
  //                  Personal WatchList") and the OCR read that column as
  //                  WEAT, REGN, COPX, FCX, WHX, UI, X, URA, URNM, JNUG,
  //                  NUGI -- the same eleven rows in the same order. `UI` is
  //                  in NEITHER lexicon; the distance-1 repair turned it into
  //                  `AI`, a false positive on a date whose panel holds no
  //                  AI at all.
  //   NUGI -> NUGT  the T rendered as I, 20220413 (the same column, last
  //                  row). `NUGI` is in neither lexicon, so a row whose
  //                  price cell is garbled is rejected at the gate and only
  //                  the rescue reaches it. On 20220405, 20220406 and
  //                  20220412 the same misread is REPAIRED to NUGT by the
  //                  distance-1 pass, so the row is inert there.
  //   O    -> LMT   the three-glyph LMT cell collapsed into ONE glyph,
  //                  20220412 -- captures 5 and 6 of that scan read it as
  //                  `O` where captures 1-4 read it as `OI` (an existing row).
  //                  The collapsed cell's price read cleanly ("30,18"), so
  //                  the row IS price-aligned and the distance-1 repair
  //                  turned it into `ON` -- a false positive, and a second
  //                  spelling of a holding the reading already had. `O` is in
  //                  neither lexicon (the seed's one-letter tickers are U, X
  //                  and P), and the panel's own row 2 is LMT.
  //
  // The recorded production output is 95/112 with 4 false positives. A
  // replay of the CURRENT parser over the twelve selected captures, with
  // these five rows dropped, is 95/112 with 2 false positives; with the rows
  // present it is 99/112 with 0 false positives. This is the replay's
  // `rebuilt_current` arm, not a claim that the old recorded cluster table was
  // rewritten: production's clusterer saw every OCR'd candidate frame, while
  // the log retains only selected captures.
  ['RX', 'FCX'],
  ['FX', 'FCX'],
  ['UI', 'LMT'],
  ['NUGI', 'NUGT'],
  ['O', 'LMT'],
  // The row added 2026-11-03 (sixth batch). Pixel-verified against the
  // 20220421 production scan log (`qmg-easyocr-20261103-era2022-next`):
  // row 11 of 14 in the Sym column reads `UC` (left=736, width=94,
  // height=52, conf=0.839), while the panel at that moment holds LAC as
  // its 12th row. Every other Sym-column member sits at left 731-736, and
  // the box width (94 px) matches the three-glyph cells above and below —
  // so the whole three-glyph LAC cell was read as UC: the `LA` glyphs
  // collapsed into a single `U` (the same mechanism as `LI→V` on
  // 20230523) and the `C` was read alone.
  //
  // `UC` ∉ seed, `UC` ∉ decode lexicon, `LAC` ∈ seed (pixel-verified
  // 2026-11-01), no duplicate key, no chain. Occurs exactly once in the
  // corpus (two run-tags of the same 20220421 video).
  //
  // The union score masked it: `UCO` is also in the GT union (it was
  // opened 30 minutes later in the session), so the WRONG reading scored
  // as a hit while the CORRECT reading at that instant (`LAC`) counted as
  // a miss. Neither recall nor row-count check can see this — only the
  // alias table catches it.
  ['UC', 'LAC'],
  // The four rows added 2026-11-04, from the first scans of 20231201 and
  // 20231215. Each garbled form was located in the OCR words of a frame whose
  // panel was then read by eye (ground truth added the same day): the
  // garbled token sits in the Sym column, on the row of the canonical.
  //
  //   MNS  -> PINS  PI merged into an M glyph. 20231201 and 20231215.
  //                 MNS is ONE edit from GNS, so before the row the repair
  //                 pass published GNS -- a seed ticker no panel held.
  //   AIR  -> PLTR  PL merged into an A glyph, T read as I. 20231201.
  //   UXND -> LMND  L read as U, M as X. 20231215.
  //   BUIX -> BITX  I read as U, T as I. 20231201.
  ['MNS', 'PINS'],
  ['AIR', 'PLTR'],
  ['UXND', 'LMND'],
  ['BUIX', 'BITX'],
  // Pixel-verified production scans 20220606/07/08 and 20230126 read the
  // TNA row as INA. The source panels show TNA in that row; the same token
  // occurs eleven times in the current logs, always in the Sym column.
  ['INA', 'TNA'],
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

test('the curated aliases are present with the right canonical', () => {
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
