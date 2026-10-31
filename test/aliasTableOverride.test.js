'use strict';

// Measuring the curated alias table, without editing it.
//
// THE DEFECT THIS FILE PINS
//
// `config/ticker_ocr_confusions.csv` is the table that maps a recorded OCR
// misread to the ticker it really is (`A -> AI`, `ATR -> PLTR`, ...). To
// measure what a row is worth, the natural move is to delete the row, run
// the measurement, and put it back.
//
// That is exactly what went wrong. The map is cached at module level
// (`loadOcrConfusionMap`), so the table cannot be swapped inside a running
// process, and the CSV file itself is SHARED - every tool in the tree reads
// it. Two measurements in the same working tree therefore raced each other:
// the table flipped between its 20-line and 29-line forms mid-measurement,
// twice, and a wrong "before" column was reported once as a result. A
// reviewer working the same way reported that the `A -> AI` and `AL -> AI`
// rows "never fire" - a conclusion that is true of the parser as it was
// BEFORE the left-edge column fix and false of the parser as it is now.
//
// THE FIX
//
// The alias table is selected by PATH (`setOcrConfusionCsvPath`), and the
// cache is keyed by the resolved path, so two tables can be used in one
// process in either order. `tools/evalParserReplay.js` exposes that as
// `--confusion-csv PATH` and `--drop-aliases A,B`, both of which build the
// modified table in a TEMPORARY FILE - nothing on disk is changed.
//
// What is pinned here:
//   1. the shipped table is what the parser uses by default;
//   2. dropping a row through the override removes that row's rescue;
//   3. the shared config file is byte-identical after the override;
//   4. restoring puts the default back, and the rescue fires again.
//
// The measured EFFECT of the rows is NOT pinned here: the replay corpus is
// untracked, so a fresh clone has no probe logs to score.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseChartStreamPositionList,
  setOcrConfusionCsvPath,
} = require('../src/parse/parseChartStream');
const {
  parseFlags,
  applyAliasTableOverride,
} = require('../tools/evalParserReplay');

const CONFIG_CSV = path.resolve(__dirname, '..', 'config', 'ticker_ocr_confusions.csv');

// The geometry is the one measured on the real 2023-era frame: a 1345 px
// EasyOCR crop whose tickers are ~130 px wide and all start at the same x.
// The one-character token carries a garbled price, which is what makes it
// non-price-aligned and therefore reachable only by the curated-alias
// rescue. This is the same fixture as test/chartStreamColumnTest.test.js.
const LIST_X = 780;
const WIDE_TOKEN_W = 130;
const NARROW_TOKEN_W = 54;

function leftAlignedFrame() {
  const rows = [
    { token: 'POSITIONS', x: 700, w: 90 },
    { token: 'AAPL', x: LIST_X, w: WIDE_TOKEN_W, price: '$214.50' },
    { token: 'MSFT', x: LIST_X, w: WIDE_TOKEN_W, price: '$412.30' },
    { token: 'TSLA', x: LIST_X, w: WIDE_TOKEN_W, price: '$342.10' },
    { token: 'VLO', x: LIST_X, w: WIDE_TOKEN_W, price: '$lO5.OO' },
    { token: 'A', x: LIST_X, w: NARROW_TOKEN_W, price: '$lO5.OO' },
    { token: 'WATCHLIST', x: 700, w: 90 },
    { token: 'GSII', x: LIST_X, w: WIDE_TOKEN_W, price: '$lO8.OO' },
  ];

  const words = [];
  const lines = [];
  rows.forEach((row, i) => {
    row.line = i + 1;
    const parts = [row.token];
    words.push({
      text: row.token,
      left: row.x,
      top: 100 + row.line * 60,
      width: row.w,
      height: 30,
      line: row.line,
    });
    if (row.price) {
      parts.push(row.price);
      words.push({
        text: row.price,
        left: 960,
        top: 100 + row.line * 60,
        width: 60,
        height: 30,
        line: row.line,
      });
    }
    lines.push(parts.join(' '));
  });
  return { text: lines.join('\n'), lines, words };
}

function rescued() {
  const frame = leftAlignedFrame();
  const result = parseChartStreamPositionList({ ocr: frame });
  return Array.isArray(result.position_list) ? result.position_list : [];
}

test('the shipped alias table rescues the row by default', () => {
  assert.ok(rescued().includes('AI'),
    'the default table must rescue A -> AI');
});

test('the override drops a row without touching the shared config file', () => {
  const before = fs.readFileSync(CONFIG_CSV, 'utf8');

  const override = applyAliasTableOverride({ confusionCsv: '', dropAliases: ['A'] });
  try {
    assert.equal(override.describe().rows, 27,
      'the override table must have one row fewer than the shipped one');
    assert.ok(!rescued().includes('AI'),
      `a dropped row must not rescue: ${JSON.stringify(rescued())}`);
  } finally {
    override.restore();
  }

  assert.equal(fs.readFileSync(CONFIG_CSV, 'utf8'), before,
    'the shared config file must be byte-identical after the override');
});

test('restoring the default brings the rescue back', () => {
  const override = applyAliasTableOverride({ confusionCsv: '', dropAliases: ['A'] });
  assert.ok(!rescued().includes('AI'), 'the row is dropped while the override is in force');
  override.restore();

  assert.ok(rescued().includes('AI'),
    'the default table must rescue again once the override is restored');
});

test('an arbitrary table can be selected by path', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'alias-table-'));
  const file = path.join(dir, 'table.csv');
  fs.writeFileSync(file, 'garbled,canonical,note\nZZZZ,AI,synthetic\n');
  try {
    const previous = setOcrConfusionCsvPath(file);
    try {
      assert.ok(!rescued().includes('AI'),
        'a table that does not carry the A row must not rescue A');
    } finally {
      setOcrConfusionCsvPath(previous);
    }
    assert.ok(rescued().includes('AI'), 'the default table must be back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the flags are parsed, and an unknown flag is a usage error', () => {
  const flags = parseFlags([
    '--json',
    '--drop-aliases', 'A,AL',
    '--confusion-csv', 'some/table.csv',
    'root/one',
  ]);

  assert.equal(flags.json, true);
  assert.deepEqual(flags.dropAliases, ['A', 'AL']);
  assert.equal(flags.confusionCsv, 'some/table.csv');
  assert.deepEqual(flags.roots, ['root/one']);

  const equals = parseFlags(['--drop-aliases=A,AL', '--confusion-csv=some/table.csv']);
  assert.deepEqual(equals.dropAliases, ['A', 'AL']);
  assert.equal(equals.confusionCsv, 'some/table.csv');

  assert.throws(() => parseFlags(['--nope']), /unknown flag/);
});
