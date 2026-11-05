'use strict';

// The LAYOUT-SCOPED alias table: `config/ticker_ocr_confusions_right_sidebar.csv`.
//
// The shared table (`config/ticker_ocr_confusions.csv`) may not hold a garbled
// form that is itself a lexicon ticker, because a row that applies everywhere
// would rewrite a real holding. That rule kept `U -> LI` out of it: `U` is a
// seed ticker and a genuine Qullamaggie holding on 20221117.
//
// But 20221117 is the 2022 FLOATING-PANEL layout. In the 2023 RIGHT-SIDEBAR
// layout every `U` the OCR has published is the collapsed `LI` cell:
//
//   20230518  merged U, LI missed      ground truth holds LI, not U
//   20230522  merged U, LI missed      ground truth holds LI, not U
//   20230523  merged U, LI missed      ground truth holds LI, not U
//
// and the stray `U` words on 20230602, 20230608 and 20230609 (none of which
// holds LI) sit outside the column or the panel, so the rescue never fires on
// them. A table keyed by layout says that without saying it for 2022.
//
// Measured with `node tools/evalParserReplay.js` against
// `--no-layout-aliases` (the replay corpus is untracked, so the numbers are
// recorded here and not asserted):
//
//   default roots   83/85/83 -> 84/85/84   20230522: LI recovered
//   wide corpus    242/269/266 -> 243/269/265
//                  20230518: LI recovered, U removed
//                  20230523: U removed
//   wide, video-level (rebuilt_current) 239 -> 240 hits, 20230518 8/8
//
// No other date moved on either corpus.
//
// THE DATE WINDOW IS NARROWER THAN THE CROP'S ERA RULE, ON PURPOSE.
// `chartStreamEraForDate()` returns 'right_sidebar' for an unknown or
// out-of-range date, because the sidebar CROP still contains the 2022 panel.
// An alias that rewrites a ticker has the opposite safety, so it applies only
// to a KNOWN sidebar upload: 20230518..20231215 (the channel's last upload).
// `qmg-fixed-20260921c` dated nine Qullamaggie videos by the RUN date,
// 20260921 -- those may be 2022 uploads, where U is real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');
const {
  parseChartStreamPositionList,
  LAYOUT_CONFUSION_CSVS,
} = require('../src/parse/parseChartStream');
const {
  layoutAliasEraForDate,
  CHART_STREAM_RIGHT_SIDEBAR_FROM,
  CHART_STREAM_RIGHT_SIDEBAR_LAST,
  FLOATING_PANEL_NFU_ALIAS_FROM,
  FLOATING_PANEL_NFU_ALIAS_TO,
} = require('../src/video/chartStreamCrop');
const { loadQmgGroundTruth, listGroundTruthCaptures } = require('../src/qmg/qmgGroundTruth');

const ROOT = path.resolve(__dirname, '..');
const SHARED_CSV = path.join(ROOT, 'config', 'ticker_ocr_confusions.csv');

function readRows(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const [garbled, canonical] = line.split(',').map((v) => String(v || '').trim().toUpperCase());
      return { garbled, canonical };
    });
}

// ---------------------------------------------------------------------------
// THE DATE WINDOW
// ---------------------------------------------------------------------------

test('layout aliases apply only to a known right-sidebar upload', () => {
  assert.equal(CHART_STREAM_RIGHT_SIDEBAR_FROM, '20230518');
  assert.equal(CHART_STREAM_RIGHT_SIDEBAR_LAST, '20231215');

  for (const d of ['20230518', '20230522', '20230523', '20230609', '20231201', '20231215']) {
    assert.equal(layoutAliasEraForDate(d), 'right_sidebar', `${d} is a sidebar upload`);
  }
  // The floating-panel NFU rescue is date-scoped: NFU is a real seed ticker,
  // so the row must not apply to the rest of the 2022 era.
  assert.equal(FLOATING_PANEL_NFU_ALIAS_FROM, '20220606');
  assert.equal(FLOATING_PANEL_NFU_ALIAS_TO, '20220608');
  for (const d of ['20220606', '20220607', '20220608']) {
    assert.equal(layoutAliasEraForDate(d), 'floating_panel_nfu_20220606_08', `${d} is in the verified NFU window`);
  }
  for (const d of ['20220605', '20220609', '20221117', '20230126']) {
    assert.equal(layoutAliasEraForDate(d), null, `${d} must not receive the NFU rewrite`);
  }
  // After the channel's last upload: a mis-dated file, not a sidebar video.
  for (const d of ['20231216', '20260921']) {
    assert.equal(layoutAliasEraForDate(d), null, `${d} is not a known upload`);
  }
  // Not a date at all.
  for (const d of ['', null, undefined, 'x', '2023051']) {
    assert.equal(layoutAliasEraForDate(d), null, `${String(d)} is not a date`);
  }
});

// ---------------------------------------------------------------------------
// THE TABLE'S INVARIANTS
// ---------------------------------------------------------------------------

test('the right-sidebar table exists and every canonical is allow-listed', () => {
  const file = LAYOUT_CONFUSION_CSVS.right_sidebar;
  assert.ok(fs.existsSync(file), `${file} must exist`);
  const rows = readRows(file);
  assert.ok(rows.length > 0, 'the table has rows');
  const seed = loadSeedLexiconSync().tickerSet;
  for (const { canonical } of rows) {
    assert.ok(seed.has(canonical),
      `${canonical} is not in the seed lexicon, so a rescue into it would be discarded`);
  }
});

test('the floating-panel NFU table is date-scoped and pixel-backed', () => {
  const file = LAYOUT_CONFUSION_CSVS.floating_panel_nfu_20220606_08;
  assert.ok(fs.existsSync(file), `${file} must exist`);
  const rows = readRows(file);
  assert.deepEqual(rows, [
    { garbled: 'NFU', canonical: 'NFLX' },
    { garbled: 'NF', canonical: 'NFLX' },
  ]);
  const seed = loadSeedLexiconSync().tickerSet;
  assert.ok(seed.has('NFU'), 'NFU remains a real seed ticker');
  assert.ok(seed.has('NFLX'), 'NFLX is reportable');
  for (const date of ['20220606', '20220607', '20220608']) {
    const held = listGroundTruthCaptures(loadQmgGroundTruth(), { dates: [date] })
      .flatMap((c) => c.tickers || []).map((t) => String(t).toUpperCase());
    assert.ok(held.includes('NFLX'), `${date} ground truth holds NFLX`);
    assert.ok(!held.includes('NFU'), `${date} ground truth does not hold NFU`);
  }
});


test('the right-sidebar table does not fight the shared table', () => {
  const layoutRows = readRows(LAYOUT_CONFUSION_CSVS.right_sidebar);
  const shared = readRows(SHARED_CSV);
  const sharedKeys = new Map(shared.map((r) => [r.garbled, r.canonical]));
  const allCanonicals = new Set([...shared, ...layoutRows].map((r) => r.canonical));
  const seen = new Set();
  for (const { garbled, canonical } of layoutRows) {
    assert.ok(!seen.has(garbled), `${garbled} appears twice in the layout table`);
    seen.add(garbled);
    assert.ok(!sharedKeys.has(garbled),
      `${garbled} is already a shared row (-> ${sharedKeys.get(garbled)}); one read must resolve one way`);
    assert.ok(!allCanonicals.has(garbled),
      `${garbled} is also a canonical, so the tables would chain`);
    assert.notEqual(garbled, canonical);
  }
});

test('within the sidebar window, no garbled form is a real holding and every canonical is one', () => {
  // The reason the row is legal here and not in the shared table is a claim
  // about the ground truth -- so it is checked against the ground truth.
  const rows = readRows(LAYOUT_CONFUSION_CSVS.right_sidebar);
  const held = new Map();
  for (const capture of listGroundTruthCaptures(loadQmgGroundTruth())) {
    const date = capture.date || capture.dateKey;
    if (layoutAliasEraForDate(date) !== 'right_sidebar') continue;
    if (!held.has(date)) held.set(date, new Set());
    for (const t of capture.tickers || []) held.get(date).add(String(t).toUpperCase());
  }
  assert.ok(held.size >= 5, `expected the sidebar-era ground truth to be readable, got ${held.size} dates`);
  for (const { garbled, canonical } of rows) {
    for (const [date, set] of held) {
      assert.ok(!set.has(garbled),
        `${garbled} is a real holding on sidebar date ${date}; rewriting it would publish a wrong holding`);
    }
    assert.ok([...held.values()].some((set) => set.has(canonical)),
      `${canonical} is held on no sidebar date in the ground truth, so the row has no evidence`);
  }
});

// ---------------------------------------------------------------------------
// THE PARSER
// ---------------------------------------------------------------------------

const LIST_X = 780;
const PRICE_X = 900;

function sidebarFrame({ oneGlyphX = LIST_X, oneGlyphBelowWatchlist = false } = {}) {
  // A position list whose LI cell the OCR collapsed to a bare `U`, with a
  // readable price beside it -- the 20230518 shape.
  const listRows = [
    { token: 'PLTR', x: LIST_X, w: 40, price: '$14.10' },
    { token: 'AI', x: LIST_X, w: 40, price: '$31.20' },
    { token: 'SHOP', x: LIST_X, w: 40, price: '$56.80' },
    { token: 'MNDY', x: LIST_X, w: 40, price: '$160.30' },
  ];
  const glyphRow = { token: 'U', x: oneGlyphX, w: 40, price: '$37.90' };
  const rows = [{ token: 'POSITIONS', x: 700, w: 90 }];
  for (const row of listRows) rows.push(row);
  if (!oneGlyphBelowWatchlist) rows.push(glyphRow);
  rows.push({ token: 'WATCHLIST', x: 700, w: 90 });
  rows.push({ token: 'CVNA', x: LIST_X, w: 40, price: '$11.20' });
  if (oneGlyphBelowWatchlist) rows.push(glyphRow);
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

function listOf(result) {
  return Array.isArray(result.position_list) ? result.position_list : [];
}

test('in the sidebar layout the collapsed U cell is published as LI', () => {
  const list = listOf(parseChartStreamPositionList({ ocr: sidebarFrame(), layoutEra: 'right_sidebar' }));
  assert.ok(list.includes('LI'), `LI was not published: ${JSON.stringify(list)}`);
  assert.ok(!list.includes('U'), `U was published verbatim: ${JSON.stringify(list)}`);
});

test('without a layout -- and in the 2022 layout -- U stays U', () => {
  // 20221117 holds U for real; the shared table must not touch it.
  for (const layoutEra of [null, undefined, layoutAliasEraForDate('20221117')]) {
    const list = listOf(parseChartStreamPositionList({ ocr: sidebarFrame(), layoutEra }));
    assert.ok(list.includes('U'), `U must survive with layoutEra=${String(layoutEra)}: ${JSON.stringify(list)}`);
    assert.ok(!list.includes('LI'), `LI must not appear with layoutEra=${String(layoutEra)}: ${JSON.stringify(list)}`);
  }
});

test('the verified floating-panel NFU cell is rewritten only in its date window', () => {
  // The column gate needs three PRICE-ALIGNED rows before it engages, and the
  // alias rescue only runs when the gate is active -- so the frame carries
  // four list rows with readable prices, the shape the June captures have.
  const rows = [
    ['POSITIONS', 700, 1],
    ['NFU', LIST_X, 2], ['$12.00', PRICE_X, 2],
    ['PLTR', LIST_X, 3], ['$31.20', PRICE_X, 3],
    ['ALB', LIST_X, 4], ['$5.29', PRICE_X, 4],
    ['UCO', LIST_X, 5], ['$4.36', PRICE_X, 5],
    ['WATCHLIST', 700, 6],
  ];
  const words = rows.map(([text, left, line]) => ({
    text, left, top: 100 + line * 60, width: 40, height: 30, line,
  }));
  const ocr = { text: rows.map((r) => r[0]).join('\n'), lines: [], words };
  const scoped = listOf(parseChartStreamPositionList({
    ocr,
    layoutEra: 'floating_panel_nfu_20220606_08',
  }));
  assert.ok(scoped.includes('NFLX'), `NFU should become NFLX: ${JSON.stringify(scoped)}`);
  assert.ok(!scoped.includes('NFU'), `NFU should not survive the verified scoped rescue: ${JSON.stringify(scoped)}`);

  const ordinary = listOf(parseChartStreamPositionList({ ocr, layoutEra: 'floating_panel' }));
  assert.ok(ordinary.includes('NFU'), `NFU must remain real outside the date scope: ${JSON.stringify(ordinary)}`);
  assert.ok(!ordinary.includes('NFLX'), `NFLX must not be guessed outside the date scope: ${JSON.stringify(ordinary)}`);
});


test('the two-glyph read of the same cell is rescued, and NFU is not invented', () => {
  // 20220607's panel reads NFLX; EasyOCR dropped the L and the X on one
  // frame and read "NF". NF is one edit from NFU, which IS a seed ticker, so
  // the distance-1 repair would otherwise publish a real-but-wrong holding.
  const rows = [
    ['POSITIONS', 700, 1],
    ['NF', LIST_X, 2], ['$12.00', PRICE_X, 2],
    ['PLTR', LIST_X, 3], ['$31.20', PRICE_X, 3],
    ['ALB', LIST_X, 4], ['$5.29', PRICE_X, 4],
    ['UCO', LIST_X, 5], ['$4.36', PRICE_X, 5],
    ['WATCHLIST', 700, 6],
  ];
  const words = rows.map(([text, left, line]) => ({
    text, left, top: 100 + line * 60, width: 40, height: 30, line,
  }));
  const ocr = { text: rows.map((r) => r[0]).join('\n'), lines: [], words };
  const scoped = listOf(parseChartStreamPositionList({
    ocr,
    layoutEra: 'floating_panel_nfu_20220606_08',
  }));
  assert.ok(scoped.includes('NFLX'), `NF should become NFLX: ${JSON.stringify(scoped)}`);
  assert.ok(!scoped.includes('NFU'), `the repair must not invent NFU: ${JSON.stringify(scoped)}`);

  // Outside the window the same read is left alone: NF is not a holding, and
  // the scoped rescue is the only thing that may claim it is NFLX.
  const ordinary = listOf(parseChartStreamPositionList({ ocr, layoutEra: 'floating_panel' }));
  assert.ok(!ordinary.includes('NFLX'), `NFLX must not be guessed outside the date scope: ${JSON.stringify(ordinary)}`);
});

test('a sidebar-layout U outside the column or below the watchlist is not rewritten', () => {
  const chartArea = listOf(parseChartStreamPositionList({
    ocr: sidebarFrame({ oneGlyphX: 300 }), layoutEra: 'right_sidebar',
  }));
  assert.ok(!chartArea.includes('LI'), `a chart-area U must not become LI: ${JSON.stringify(chartArea)}`);

  const belowWatchlist = listOf(parseChartStreamPositionList({
    ocr: sidebarFrame({ oneGlyphBelowWatchlist: true }), layoutEra: 'right_sidebar',
  }));
  assert.ok(!belowWatchlist.includes('LI'), `a watchlist-row U must not become LI: ${JSON.stringify(belowWatchlist)}`);
  // Control: the frame still parses its real holdings.
  assert.ok(belowWatchlist.includes('PLTR'), `the frame must still read its holdings: ${JSON.stringify(belowWatchlist)}`);
});
