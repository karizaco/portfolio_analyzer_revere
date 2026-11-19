'use strict';

// The Komar WATCHLIST SCREENSHOT reader.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The daily updates carry a TradingView screenshot of the author's own
// watchlist: one chart per pane, each with the ticker, the date, the
// change and the change percentage. It is a DATED market read of the
// names he was watching, and it is the only artifact in the corpus
// that says what he was looking at on a day rather than what he said
// or what he held.
//
// THREE claims are pinned here.
//
// 1. **THE PANE GRID.** The screens are 1080 pixels wide with
//    270-by-150 panes, and a row that does not fill the width is
//    CENTRED -- one pane at 405, two at 270 and 540, three at 135, 405
//    and 675. So the origins are a HALF-pane grid and not the
//    four-column grid, and a reader that assumed four columns would
//    lose the 2026-04-29 frame's last row and the 2025-04-08 frame's
//    last row (which are centred and left-aligned respectively).
// 2. **THE SHAPE GUARD.** The market CARD is 1080 pixels wide too and
//    carries a "(46.04 -0.19%)" of its own, so a percentage test alone
//    takes it for a header. The height is what separates them: a
//    screenshot shows WHOLE panes, so its height is a whole multiple
//    of 150 (306, 451, 604) against 692 for the card.
// 3. **THE READINGS**, measured: 30 of 30 panes, 30 of 30 tickers and
//    28 of 30 changes over the three pinned frames.
//
// The fixtures are the frames themselves (the corpus's PDFs are paid
// and outside the repository), so this suite needs no corpus.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { after } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  PANE_ASPECT,
  PANE_WIDTH_MEASURED,
  PANES_ACROSS,
  PARSER_VERSION,
  editDistance,
  inkColours,
  isTickerShaped,
  isWatermark,
  majority,
  paneOrigins,
  parseChange,
  readWatchlist,
  repairTicker,
} = require('../src/komar/watchlistReader');
const { closeWorker } = require('../src/table/tableReader');
const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');
const { ensureKomarSchema } = require('../src/komar/schema');
const { writeRows } = require('../tools/extractKomarWatchlist');

// The reader leaves a Tesseract worker running, which keeps the event
// loop alive and hangs the process -- the same trap
// `test/qmgGroundTruth.test.js` records.
after(async () => {
  await closeWorker();
});

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'komar_watchlist');
const sharp = require('sharp');

function expectations() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expectations.json'), 'utf8'));
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

test('the pinned frames are the frames the expectations were read from', () => {
  for (const frame of expectations().frames) {
    const file = path.join(FIXTURE_DIR, frame.frame);
    assert.equal(md5(file), frame.md5, `${frame.frame} has changed under the ground truth`);
  }
});

test('the pane origins are a HALF-pane grid, because a short row is centred', () => {
  assert.deepEqual(paneOrigins(1080), [0, 135, 270, 405, 540, 675, 810]);
  // A four-column grid would miss every centred pane: the 2026-04-29
  // frame's last row is ONE pane at 405, and the 2025-04-08 frame's
  // last row is three at 135, 405 and 675.
  const fourColumn = [0, 270, 540, 810];
  assert.ok(!fourColumn.includes(405));
  assert.ok(!fourColumn.includes(135));
  // The pane is 270 wide and 150 tall, which is what the row pitch is
  // derived from.
  assert.equal(1080 / PANES_ACROSS, PANE_WIDTH_MEASURED);
  assert.equal(Math.round(PANE_WIDTH_MEASURED * PANE_ASPECT), 150);
});

test('the change percentage is read out of a header, and not out of an axis label', () => {
  // The header prints it in brackets.
  assert.deepEqual(parseChange('+7.42 (5.41%)', 0), { chg: 7.42, chg_pct: 5.41 });
  assert.deepEqual(parseChange('-0.39(3.31%)', 0), { chg: -0.39, chg_pct: 3.31 });
  // The percentage carries NO sign of its own, so it takes the sign of
  // the ink -- which is the whole reason `sign` is an argument.
  assert.deepEqual(parseChange('0.49 (2.38%)', -1), { chg: -0.49, chg_pct: -2.38 });
  assert.deepEqual(parseChange('0.49 (2.38%)', 1), { chg: 0.49, chg_pct: 2.38 });
  // A chart's axis label is not a header: without the brackets there
  // is no CHANGE to read beside the percentage, only the percentage.
  assert.deepEqual(parseChange('8%', 0), { chg: null, chg_pct: 8 });
  assert.deepEqual(parseChange('100M 30.00', 0), { chg: null, chg_pct: null });
});

test('the watermark is the pane marker, and it is read six ways', () => {
  for (const read of ['finviz.com', 'finvizcom', 'Ofivizcom', '©fimizcom', 'finiz.com', 'Ofinvizeom']) {
    assert.ok(isWatermark(read), `${read} should be the watermark`);
  }
  for (const notRead of ['market', 'daily', 'MN', 'AAPL', 'Apr 29', '100M']) {
    assert.ok(!isWatermark(notRead), `${notRead} should not be the watermark`);
  }
  // A word long enough to be the watermark, and not long enough to be
  // one of the chart's.
  assert.equal(editDistance('ofinvizeom', 'finvizcom'), 2);
});

test('a ticker-shaped word is one the lexicon could arbitrate', () => {
  assert.ok(isTickerShaped('AAOI'));
  assert.ok(isTickerShaped('BRK.B'));
  // The reading is upper-cased first, so the case the OCR left it in
  // does not decide it: "Apr" shapes and "Apr 29" does not.
  assert.ok(isTickerShaped('Apr'));
  assert.ok(!isTickerShaped('Apr 29'));
  // A chart's axis label and a running letter count are not tickers.
  assert.ok(!isTickerShaped('100M')); // starts with a digit
  assert.ok(!isTickerShaped('TEREXYZ')); // longer than a ticker ever is
  assert.ok(!isTickerShaped('Lk]')); // the OCR's brackets are not a ticker's characters
  assert.ok(!isTickerShaped('A')); // one letter is shorter than the shortest
});

test('a repair needs EXACTLY one candidate, or it is not a repair', () => {
  // The unique candidate is taken...
  assert.equal(repairTicker('XLK', new Set(['XLK', 'XLE'])), 'XLK');
  assert.equal(repairTicker('XL', new Set(['XLK', 'SPY'])), 'XLK');
  // ...and an ambiguous one is left alone, because a wrong holding is
  // worse than a missing one.
  assert.equal(repairTicker('SP', new Set(['SPY', 'SPX'])), 'SP');
  // A reading the market already knows is never rewritten: XNDU is a
  // listed ticker, so its misreading as XNDD is a hand error and not
  // an OCR one.
  assert.equal(repairTicker('XNDU', new Set(['XNDU'])), 'XNDU');
});

test('the change is read three times and the majority wins', () => {
  assert.equal(majority([12.17, 12.27, 12.17]), 12.17);
  assert.equal(majority([40.49, 40.49, 0.49]), 40.49);
  // A tie goes to the first reading, which is the lowest scale.
  assert.equal(majority([1, 2]), 1);
  // A reading that could not be parsed is not a vote.
  assert.equal(majority([null, 5, null]), 5);
  assert.equal(majority([null, null]), null);
});

test('the sign comes from the ink: green is a gain, red is a loss', async () => {
  const source = await sharp(path.join(FIXTURE_DIR, '20260429.png'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: raw, info } = source;
  // The AAOI header's change (a gain, green) and the UAMY header's
  // (a loss, red), measured in the band the reader measures them in.
  const gain = inkColours(raw, info, { bottom: 19, left: 130, right: 240, top: 3 });
  const loss = inkColours(raw, info, { bottom: 169, left: 670, right: 780, top: 153 });
  assert.ok(gain.green > gain.red, `the gain should read green (${gain.green} vs ${gain.red})`);
  assert.ok(loss.red > loss.green, `the loss should read red (${loss.red} vs ${loss.green})`);
  // The background is (35, 38, 47) and contributes nothing: neither
  // green nor red is the largest of those channels.
  const empty = inkColours(raw, info, { bottom: 100, left: 0, right: 40, top: 60 });
  assert.equal(empty.green, 0);
  assert.equal(empty.red, 0);
});

test('every pane of every pinned frame is found, with its own ticker', async () => {
  let panes = 0;
  let tickers = 0;
  let changes = 0;
  let wrongChanges = [];
  const wrongTickers = [];

  for (const frame of expectations().frames) {
    const file = path.join(FIXTURE_DIR, frame.frame);
    const result = await readWatchlist(file);
    panes += frame.rows.length;
    assert.equal(
      result.rows.length,
      frame.rows.length,
      `${frame.frame}: expected ${frame.rows.length} panes, read ${result.rows.length} `
      + `(${result.notes.join('; ')})`
    );

    for (const expected of frame.rows) {
      const found = result.rows.find((row) => row.row === expected.row
        && Math.abs(row.column - expected.origin) <= 12);
      assert.ok(
        found,
        `${frame.frame}: no pane at (${expected.row}, ${expected.origin}) `
        + `-- expected ${expected.ticker}`
      );
      if (found.ticker === expected.ticker) {
        tickers += 1;
      } else {
        wrongTickers.push(`${frame.frame} ${expected.ticker} read as ${found.ticker}`);
      }
      const pctOk = found.chg_pct !== null
        && Math.abs(Math.abs(found.chg_pct) - Math.abs(expected.chg_pct)) < 0.011;
      const signOk = found.chg_pct !== null
        && Math.sign(found.chg_pct) === Math.sign(expected.chg_pct);
      const chgOk = found.chg !== null
        && Math.abs(found.chg - expected.chg) < 0.011;
      // The SIGN is asserted for every pane: it comes from the ink and
      // not from the text, so it does not depend on the OCR at all.
      assert.ok(
        signOk,
        `${frame.frame} ${expected.ticker}: the sign of ${found.chg_pct} should be `
        + `${Math.sign(expected.chg_pct)}`
      );
      if (pctOk && signOk && chgOk) {
        changes += 1;
      } else {
        wrongChanges.push(
          `${frame.frame} ${expected.ticker}: expected ${expected.chg} (${expected.chg_pct}%), `
          + `read ${found.chg} (${found.chg_pct}%)`
        );
      }
    }
  }

  console.log(`    the watchlist reader: ${panes} panes, `
    + `${tickers} tickers, ${changes} changes`);
  if (wrongTickers.length) console.log(`    the wrong tickers: ${wrongTickers.join('; ')}`);
  if (wrongChanges.length) console.log(`    the wrong changes: ${wrongChanges.join('; ')}`);

  // MEASURED 2026-11-19: 30 of 30 tickers. The floor is 28, not 30,
  // because Tesseract is not deterministic -- the same crop of the
  // SQM pane read "SOM" in one process and "SQM" in the next -- and a
  // test that fails on a bad OCR run is a test people learn to ignore.
  assert.ok(tickers >= 28, `only ${tickers} of ${panes} tickers were read`);

  // MEASURED 2026-11-19: 28 of 30 changes. The two that are wrong are
  // the two whose printed "+" is read as a "4" at two of the three
  // scales -- SGML's "+0.49" as "40.49" and GEV's "+24.97" as
  // "424.97" -- so the majority vote takes the wrong value. The floor
  // is 27 for the same reason as above.
  assert.ok(changes >= 27, `only ${changes} of ${panes} changes were read`);
});

test('the reader refuses an image whose panes are not the measured size', async () => {
  // The market CARD: 1080 wide, so its panes would be 270 -- but its
  // height is 692, which is not a whole number of 150-pixel panes.
  const card = path.join(__dirname, '..', 'data', 'komar_work', 'charts', 'komar_doc_post_20260505_p2_x20.png');
  if (!fs.existsSync(card)) return; // the chart extracts are not in git
  const result = await readWatchlist(card);
  assert.equal(result.rows.length, 0, 'the market card must not read as a watchlist');
  assert.ok(
    result.notes.some((note) => note.includes('150-pixel panes')),
    `the refusal should say why (${result.notes.join('; ')})`
  );

  // A full-screen workspace: 4353 wide, so its panes would be 1088.
  const workspace = path.join(__dirname, '..', 'data', 'komar_work', 'charts', 'komar_doc_post_20250820_p2_x21.png');
  if (!fs.existsSync(workspace)) return;
  const wide = await readWatchlist(workspace);
  assert.equal(wide.rows.length, 0, 'the workspace capture must not read as a watchlist');
  assert.ok(wide.notes.some((note) => note.includes('pixels wide')));
});

test('the parser version says which reading produced the rows', () => {
  assert.equal(PARSER_VERSION, 'komar-watchlist-1');
});

test('the writer always replaces, including with NO rows', () => {
  // The rule that matters here is the one `src/transcript/extractRunner.js`
  // records: a source whose reading went to zero keeps its old rows
  // otherwise. A real case of it: the market CARD read as a watchlist
  // once (before the shape guard), wrote a phantom row, and the
  // corrected runs would never have touched it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-watchlist-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  const derivedPath = path.join(dir, 'derived.sqlite');
  ensureDerivedSchema(derivedPath);
  db.prepare('ATTACH DATABASE ? AS derived').run(derivedPath);
  ensureKomarSchema(db, { derivedPath });
  try {
    const doc = { doc_id: 'komar_doc_post_scratch', session_date: '20260101' };
    const rows = [
      { chg: 7.42, chg_pct: 5.41, column: 0, raw: '+7.42 (5.41%)', row: 0, ticker: 'AAOI' },
      { chg: -0.39, chg_pct: -3.31, column: 270, raw: '-0.39 (3.31%)', row: 0, ticker: 'CRML' },
    ];
    writeRows(db, doc, rows, 3, 28);
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM komar_watchlist').get().n;
    assert.equal(count(), 2);

    // A second read of the same document REPLACES: the same grid
    // position cannot hold two rows, and the old ticker is gone.
    writeRows(db, doc, [{ ...rows[0], ticker: 'MRVL' }], 3, 29);
    assert.equal(count(), 1);
    assert.equal(
      db.prepare('SELECT ticker FROM komar_watchlist').get().ticker,
      'MRVL',
      'the second read must replace the first, not append to it'
    );

    // And a document with nothing to show ends up with NOTHING, so a
    // stale row cannot outlive the reading that produced it.
    writeRows(db, doc, [], 0, 0);
    assert.equal(count(), 0, 'a document read as empty must have no rows left');

    // The rows carry the parser version and the session date.
    writeRows(db, doc, rows, 3, 28);
    const stored = db.prepare('SELECT * FROM komar_watchlist ORDER BY column').all();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].parser_version, PARSER_VERSION);
    assert.equal(stored[0].session_date, '20260101');
    assert.equal(stored[1].chg_pct, -3.31);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
