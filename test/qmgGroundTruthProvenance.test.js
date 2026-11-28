'use strict';

// The Qullamaggie ground truth must agree with the pixels it describes.
//
// `data/qmg_ground_truth.json` is a HAND-MADE reading of a TradingView
// positions panel. For months nothing compared it to the images it was read
// from, so five classes of defect survived:
//
//   1. a MISREAD TICKER -- 20220606's third capture read `BOIL` where the
//      panel reads `GOVX`, while all eleven sibling captures of the same
//      video read GOVX. A substitution inside an otherwise identical capture
//      is a misread, not a changed position list, and it put a phantom
//      holding into every score that touched that date.
//   2. a MISSING CAPTURE -- 20221104 had captures 0 and 2 and no capture 1,
//      although the snapshot exists and reads the same single holding.
//   3. a WRONG ANCHOR -- a capture index is RUN-RELATIVE, and 20220406's
//      captures are anchored to two runs with the ground truth's order the
//      reverse of one of them.
//   4. a WRONG WIDGET -- 20220301's old capture was read off the upper
//      WATCHLIST, not off the positions table. The two widgets print the
//      same footer form, so the count invariant could not tell them apart.
//   5. a DUPLICATE TOP-LEVEL KEY -- 24 of the file's 45 keys appeared twice.
//      JSON.parse keeps the last one silently, so the duplicate was
//      invisible to every reader.
//
// The fixture set (test/fixtures/qmg_ground_truth/) is the evidence: a crop
// of the panel showing the ticker column AND the footer that prints the
// panel's own row count, md5-pinned in manifest.json.
//
// This file pins the checker (tools/checkGroundTruthConsistency.js) and, more
// importantly, that the checker HAS TEETH: a perturbed ground truth or
// manifest must make it fail. A checker that only ever passes proves
// nothing.
//
// The corpus the crops are cut from is NOT in git, so nothing here needs it:
// the crops and their manifest are tracked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  checkGroundTruthConsistency,
  footerTotal,
  sameTickers,
  topLevelKeys,
} = require('../tools/checkGroundTruthConsistency.js');

const REPO = path.resolve(__dirname, '..');
const GT_PATH = path.join(REPO, 'data', 'qmg_ground_truth.json');
const MANIFEST_PATH = path.join(REPO, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');
const BENCHMARK_PATH = path.join(REPO, 'test', 'fixtures', 'qmg_benchmark', 'manifest.json');
const FIXTURE_DIR = path.dirname(MANIFEST_PATH);

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('the ground truth agrees with the pinned pixels', () => {
  const result = checkGroundTruthConsistency();
  assert.deepEqual(
    result.problems,
    [],
    `ground-truth problems:\n${result.problems.map((p) => `  [${p.code}] ${p.message}`).join('\n')}`,
  );
  assert.equal(result.ok, true);
});

test('every fixture is tracked and still hashes to its pinned md5', () => {
  const manifest = readJson(MANIFEST_PATH);
  assert.ok(manifest.cases.length > 0, 'the manifest pins no cases at all');
  for (const c of manifest.cases) {
    const file = path.join(FIXTURE_DIR, c.file);
    assert.ok(fs.existsSync(file), `${c.file} is missing from the fixture set`);
    assert.equal(md5(file), c.md5, `${c.file} does not match its pinned md5`);
  }
});

test("the panel's own row count is the number of tickers read from it", () => {
  const manifest = readJson(MANIFEST_PATH);
  for (const c of manifest.cases) {
    assert.equal(
      c.panel_count,
      c.tickers.length,
      `${c.date} capture ${c.capture_index}: the panel counts ${c.panel_count} but ${c.tickers.length} tickers were read`,
    );
  }
});

test('the recorded footer text carries the count it claims', () => {
  const manifest = readJson(MANIFEST_PATH);
  for (const c of manifest.cases) {
    const footer = footerTotal(c.panel_count_text);
    assert.ok(footer, `${c.date} capture ${c.capture_index}: cannot read a count out of ${JSON.stringify(c.panel_count_text)}`);
    assert.equal(
      footer.total,
      c.panel_count,
      `${c.date} capture ${c.capture_index}: the footer says ${footer.total} items, the manifest counts ${c.panel_count}`,
    );
  }
});

test('the footer forms the panels actually print are all readable', () => {
  // "N Items in Personal WatchList"   -- the whole list
  // "1 Item in Personal WatchList"    -- singular when the total is one
  // "K of N Items in Personal WatchList" -- a row is selected; K is that
  //                                        row's index, NOT a scroll range
  assert.deepEqual(footerTotal('9 Items in Personal WatchList'), { selected: null, total: 9 });
  assert.deepEqual(footerTotal('1 Item in Personal WatchList'), { selected: null, total: 1 });
  assert.deepEqual(footerTotal('3 of 9 Items in Personal WatchList'), { selected: 3, total: 9 });
  assert.deepEqual(footerTotal('2 of 5 Items in Personal WatchList'), { selected: 2, total: 5 });
  assert.deepEqual(footerTotal('1 of 1 Item in Personal WatchList'), { selected: 1, total: 1 });

  // The MIDDLE widget ("S - A Scan", a screener panel) prints the plain
  // "N Items in WatchList" -- no "Personal". That is a different panel, and
  // reading its count as the positions count would invent or lose a holding.
  assert.equal(footerTotal('12 Items in WatchList'), null);
  assert.equal(footerTotal('21 of 35 Items in WatchList'), null);
});

test('the upper watchlist prints the SAME footer form as the positions table', () => {
  // The 2022-era frame carries THREE right-hand widgets:
  //
  //   top     "1 - WL"         "8 Items in Personal WatchList"
  //   middle  "S - A Scan"     "3 Items in WatchList"
  //   bottom  "A - Positions"  "5 of 7 Items in Personal WatchList"
  //
  // So "Personal WatchList" does NOT identify the positions table. The
  // positions table is identified by its title, and every manifest case
  // records the widget it was read from so that a reading off the wrong
  // widget cannot pass for a positions reading.
  //
  // This is why the count invariant alone is not enough: the wrong widget
  // prints its own count just as faithfully as the right one.
  const manifest = readJson(MANIFEST_PATH);
  for (const c of manifest.cases) {
    assert.equal(
      c.panel,
      'positions',
      `${c.date} capture ${c.capture_index}: the reading must say which panel it came from`,
    );
  }
});

test('the benchmark frames and the fixture set name the same frames', () => {
  const benchmark = readJson(BENCHMARK_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const byKey = new Map(manifest.cases.map((c) => [`${c.date}#${c.capture_index}`, c]));

  for (const frame of benchmark.frames) {
    const key = `${frame.date_key}#${frame.capture_index}`;
    const pinned = byKey.get(key);
    assert.ok(pinned, `benchmark case ${frame.case} (${key}) is not pinned by the fixture manifest`);
    assert.equal(
      pinned.source,
      frame.source,
      `benchmark case ${frame.case} was cut from ${frame.source}, the fixture manifest from ${pinned.source}`,
    );
  }
});

test('the known defects are gone', () => {
  const gt = readJson(GT_PATH);

  // 20220606's third capture read BOIL where the panel reads GOVX.
  assert.deepEqual(
    gt['20220606']['3'],
    ['GOVX', 'LABU', 'UCO', 'ALB', 'CBIO', 'VLO', 'TNA', 'NFLX'],
    '20220606 capture 3 must read GOVX, the ticker the panel shows',
  );
  assert.ok(!gt['20220606']['3'].includes('BOIL'), 'BOIL was a misread of GOVX');

  // 20221104 had no capture 1, although the snapshot exists.
  assert.deepEqual(gt['20221104']['1'], ['OIH'], '20221104 capture 1 was missing');
  assert.deepEqual(Object.keys(gt['20221104']).sort(), ['0', '1', '2']);
});

test('the checker catches a misread ticker in the ground truth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const gt = readJson(GT_PATH);
    // Put back the defect the audit found.
    gt['20220606']['3'][0] = 'BOIL';
    const gtCopy = path.join(dir, 'gt.json');
    fs.writeFileSync(gtCopy, JSON.stringify(gt));

    const result = checkGroundTruthConsistency({ gtPath: gtCopy });
    assert.equal(result.ok, false, 'the checker let a misread ticker through');
    assert.ok(
      result.problems.some((p) => p.code === 'gt-disagrees' && p.date === '20220606' && p.capture_index === 3),
      `expected a gt-disagrees problem for 20220606 capture 3, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker catches a panel count that disagrees with the footer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const manifest = readJson(MANIFEST_PATH);
    const target = manifest.cases.find((c) => c.date === '20220429' && c.capture_index === 0);
    assert.ok(target, 'the manifest does not pin 20220429 capture 0');
    target.panel_count = 4; // the panel says six
    const manifestCopy = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestCopy, JSON.stringify(manifest));

    const result = checkGroundTruthConsistency({ manifestPath: manifestCopy, fixtureDir: FIXTURE_DIR });
    assert.equal(result.ok, false, 'the checker let a wrong panel count through');
    assert.ok(
      result.problems.some((p) => p.code === 'footer-disagrees'),
      `expected a footer-disagrees problem, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker catches a fixture whose md5 no longer matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const manifest = readJson(MANIFEST_PATH);
    const target = manifest.cases.find((c) => c.date === '20221104' && c.capture_index === 0);
    assert.ok(target, 'the manifest does not pin 20221104 capture 0');
    target.md5 = '0'.repeat(32);
    const manifestCopy = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestCopy, JSON.stringify(manifest));

    const result = checkGroundTruthConsistency({ manifestPath: manifestCopy, fixtureDir: FIXTURE_DIR });
    assert.equal(result.ok, false, 'the checker let a replaced fixture through');
    assert.ok(
      result.problems.some((p) => p.code === 'fixture-md5'),
      `expected a fixture-md5 problem, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker catches a missing capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const gt = readJson(GT_PATH);
    delete gt['20221104']['1']; // the defect the audit found
    const gtCopy = path.join(dir, 'gt.json');
    fs.writeFileSync(gtCopy, JSON.stringify(gt));

    const result = checkGroundTruthConsistency({ gtPath: gtCopy });
    assert.equal(result.ok, false, 'the checker let a missing capture through');
    assert.ok(
      result.problems.some((p) => p.code === 'gt-missing' && p.date === '20221104' && p.capture_index === 1),
      `expected a gt-missing problem for 20221104 capture 1, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker catches a reading taken off the watchlist rather than the positions table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const manifest = readJson(MANIFEST_PATH);
    const target = manifest.cases.find((c) => c.date === '20220301' && c.capture_index === 0);
    assert.ok(target, 'the manifest does not pin 20220301 capture 0');
    // The defect the audit found: a reading off the upper watchlist widget,
    // whose footer prints the same "Personal WatchList" form.
    target.panel = 'watchlist';
    const manifestCopy = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestCopy, JSON.stringify(manifest));

    const result = checkGroundTruthConsistency({ manifestPath: manifestCopy, fixtureDir: FIXTURE_DIR });
    assert.equal(result.ok, false, 'the checker let a watchlist reading through');
    assert.ok(
      result.problems.some((p) => p.code === 'wrong-panel' && p.date === '20220301' && p.capture_index === 0),
      `expected a wrong-panel problem for 20220301 capture 0, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker catches a duplicate top-level key in the ground truth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    // Insert a second copy of a date INSIDE the object, the way the file once
    // had 24 of them. JSON.parse keeps the last occurrence and reports
    // nothing, so this is invisible to every reader of the file -- and the
    // value that survives is the later one.
    const raw = fs.readFileSync(GT_PATH, 'utf8');
    const gtCopy = path.join(dir, 'gt.json');
    fs.writeFileSync(
      gtCopy,
      raw.replace('{', '{\n  "20230609": { "0": ["OVERWRITTEN"] },', 1),
    );

    const result = checkGroundTruthConsistency({ gtPath: gtCopy });
    assert.equal(result.ok, false, 'the checker let a duplicate top-level key through');
    assert.ok(
      result.problems.some((p) => p.code === 'duplicate-key' && p.date === '20230609'),
      `expected a duplicate-key problem for 20230609, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker reports an unparsable ground truth instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-consistency-'));
  try {
    const gtCopy = path.join(dir, 'gt.json');
    fs.writeFileSync(gtCopy, '{ "20220218": { "0": [ "UPST", } }');
    const result = checkGroundTruthConsistency({ gtPath: gtCopy });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p.code === 'gt-unparsable'),
      `expected a gt-unparsable problem, got:\n${JSON.stringify(result.problems, null, 2)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ground truth has no duplicate top-level key', () => {
  // The file shipped with 24 of its 45 keys appearing twice. JSON.parse keeps
  // the last one silently, so the duplicate was invisible -- the two copies
  // just happened to carry the same values.
  const seen = new Map();
  for (const { key, line } of topLevelKeys(fs.readFileSync(GT_PATH, 'utf8'))) {
    assert.ok(
      !seen.has(key),
      `${key} appears twice (lines ${seen.get(key)} and ${line}); JSON.parse would keep only the second`,
    );
    seen.set(key, line);
  }
});

test('sameTickers compares the holding set, not the order', () => {
  assert.equal(sameTickers(['A', 'B'], ['B', 'A']), true);
  assert.equal(sameTickers(['A', 'B'], ['A', 'B', 'C']), false);
  assert.equal(sameTickers(['A', 'A'], ['A', 'B']), false);
});
