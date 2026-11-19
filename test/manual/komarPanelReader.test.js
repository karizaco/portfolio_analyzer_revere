'use strict';

// The Komar PANEL READER, scored against the panels' own pixels.
//
// WHY IT IS MANUAL
//
// It runs the real OCR over the three pinned frames, and it takes
// minutes. It is also NOT deterministic in the way a unit test needs
// to be: **Tesseract's reading of the same pixels depends on what the
// shared worker read before it.** Measured on the 2026-04-25 frame,
// the same region read twice in one process gave "nue" and "MU" for
// the same ticker. The project's own Revere notes say the same about
// that path.
//
// So the assertions here are STRUCTURAL -- every frame produced rows,
// every row has a symbol, the group headers were found -- and the
// SCORE is reported, not asserted. A test that fails on a bad OCR
// reading is a test people learn to ignore.
//
//   node --test test/manual/komarPanelReader.test.js
//
// The expectation is `test/fixtures/komar_panel/expectations.json`:
// the rows read off the frames' own pixels, one frame per era.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readKomarPanel } = require('../../src/komar/panelReader');
const { loadKomarLexicon } = require('../../src/komar/lexicon');
const { closeWorker } = require('../../src/table/tableReader');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'komar_panel');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
const lexicon = loadKomarLexicon();

/**
 * Do two numbers agree, allowing for the reading's tolerance?
 *
 * @param {number|null} expected
 * @param {number|null} actual
 * @returns {boolean}
 */
function sameNumber(expected, actual) {
  if (expected === null || expected === undefined) return true;
  if (actual === null || actual === undefined) return false;
  return Math.abs(Number(expected) - Number(actual)) <= Math.max(0.02, Math.abs(expected) * 0.002);
}

test('the panel reader, scored against the panels\' own pixels', async () => {
  let symbolHits = 0;
  let totalRows = 0;
  let priceHits = 0;
  let priceCount = 0;

  for (const entry of manifest.files) {
    const expected = expectations.frames[entry.file];
    const result = await readKomarPanel(path.join(FIXTURES, entry.file), {
      dateKey: expected.session_date,
      lexicon,
      mode: expected.mode,
    });

    const symbols = result.rows.map((row) => row.symbol);

    // STRUCTURAL: the frame produced rows, and they are ticker-shaped.
    assert.ok(result.rows.length > 0, `${entry.file}: the reader found no rows`);
    for (const row of result.rows) {
      assert.match(row.symbol, /^[A-Z][A-Z0-9.\-]{0,6}$/, `${entry.file}: "${row.symbol}" is not a ticker`);
    }

    // The group headers were found -- the author's own theme names.
    const groups = result.groups.map((entry_) => entry_.group.toUpperCase());
    for (const header of expected.group_headers) {
      assert.ok(
        groups.some((group) => group.includes(header.toUpperCase())),
        `${entry.file}: the group header ${header} was not found (${groups.join(' | ')})`,
      );
    }

    // THE SCORE, reported.
    const hits = expected.rows.filter((row, index) => symbols[index] === row.symbol).length;
    symbolHits += hits;
    totalRows += expected.rows.length;
    for (const row of expected.rows) {
      const read = result.rows.find((candidate) => candidate.symbol === row.symbol);
      if (!read) continue;
      for (const field of ['last', 'chg', 'chg_pct']) {
        if (row[field] === null || row[field] === undefined) continue;
        priceCount += 1;
        if (sameNumber(row[field], read[field])) priceHits += 1;
      }
    }

    console.log(`  ${entry.file} (${result.era}): ${symbols.length} rows read, ${expected.rows.length} expected`);
    console.log(`    read:     ${symbols.join(' ')}`);
    console.log(`    expected: ${expected.rows.map((row) => row.symbol).join(' ')}`);
  }

  const symbolShare = symbolHits / Math.max(1, totalRows);
  const priceShare = priceHits / Math.max(1, priceCount);
  console.log(`\n  THE PANEL READER: ${symbolHits}/${totalRows} symbols in order `
    + `(${(symbolShare * 100).toFixed(1)} %), ${priceHits}/${priceCount} prices `
    + `(${(priceShare * 100).toFixed(1)} %)`);

  await closeWorker();
});
