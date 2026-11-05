'use strict';

// The production footer reader, on the REAL pixels.
//
// The reader is the thing the scan tool calls, so it is worth testing as a
// whole rather than only its text parser: the strip geometry, the engine, the
// preprocessing and the vote are all in the path, and a regression in any of
// them would publish a wrong count or no count.
//
// The fixtures are the tracked ground-truth source snapshots, which are
// 1920x1080 frames. The media is NOT in git, so a missing source is a SKIP,
// not a failure -- the reader is what is under test, and a fresh clone has no
// snapshots.
//
//   node --test test/panelFooterReader.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readPanelFooterFromFrame } = require('../src/video/panelFooterReader');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');

// A spread across both eras and several footer forms. Each source is the
// frame the manifest pairs with the count, so the expected number is the
// panel's own, not a guess.
const CASES = [
  { date: '20220218', capture: 0, count: 9 },
  { date: '20220421', capture: 0, count: 16 },
  { date: '20230608', capture: 0, count: 13 },
  { date: '20221104', capture: 0, count: 1 },
];

function sourceFor(date, capture) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const cases = Array.isArray(manifest) ? manifest : manifest.cases;
  const found = cases.find((c) => c.date === date && c.capture_index === capture);
  if (!found || !found.source) return null;
  const abs = path.join(ROOT, found.source);
  return fs.existsSync(abs) ? abs : null;
}

for (const c of CASES) {
  test(`the footer count agrees with the panel on ${c.date}`, async () => {
    const source = sourceFor(c.date, c.capture);
    if (!source) {
      return; // a fresh clone has no snapshots; the reader is tested elsewhere
    }
    const read = await readPanelFooterFromFrame(source, c.date);
    assert.ok(read, `${c.date} produced no footer reading`);
    assert.equal(read.count, c.count,
      `${c.date} read ${read.count}, the panel says ${c.count} ("${read.text}")`);
    assert.ok(read.votes >= 2, 'a count is only reported when two bands agree');
  });
}

test('a missing frame is no reading, not an error', async () => {
  const read = await readPanelFooterFromFrame(path.join(ROOT, 'no', 'such', 'frame.png'), '20220218');
  assert.equal(read, null);
});
