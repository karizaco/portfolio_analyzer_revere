'use strict';

// The Komar PANEL: the full read of the pinned frames.
//
// This suite is MANUAL -- it runs Tesseract over the three pinned
// frames, which is a few seconds each.
//
//   node --test test/manual/komarPanelRead.test.js
//
// WHAT IT PINS, AND WHAT IT ONLY REPORTS
//
// The GEOMETRY is pinned: the era, the region and the header are
// found, and the rows are found. The READINGS are reported and not
// asserted one by one, because they are not yet trustworthy: the
// symbol column carries the row icons (the POWL row reads "VPOWLE"),
// the W/L sign comes from a fill that is not always sampled where the
// sign is, and the detail card under the table is still read as rows
// on some frames.
//
// A wrong holding is worse than a missing one, so the reader is NOT
// wired to a writer yet. This suite is the instrument that says where
// it stands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { closeWorker } = require('../../src/table/tableReader');
const { readKomarPanel } = require('../../src/komar/panelReader');
const { loadKomarLexicon } = require('../../src/komar/lexicon');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'komar_panel');

test('the panel is read out of each pinned frame', async (t) => {
  const lexicon = loadKomarLexicon();
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  t.after(async () => {
    await closeWorker();
  });

  for (const entry of manifest.files) {
    const result = await readKomarPanel(path.join(FIXTURE_DIR, entry.file), {
      dateKey: entry.session_date,
      lexicon,
      mode: 'portfolio',
    });
    const withPrice = result.rows.filter((row) => row.last !== null).length;
    console.log(`--- ${entry.file} (era ${result.era.era}) ---`);
    console.log(`  ${result.rows.length} rows, ${withPrice} with a price, ${result.groups.length} groups`);
    for (const row of result.rows) {
      console.log(`   ${row.symbol.padEnd(8)} ${String(row.last).padEnd(10)} ${String(row.chg).padEnd(9)} ${String(row.chg_pct).padEnd(8)} ${row.group}${row.occluded ? ' [occluded]' : ''}`);
    }

    // PINNED: the reader finds the panel at all, and it finds the
    // header's columns.
    assert.ok(result.rows.length > 0, `${entry.file}: the panel read rows`);
    assert.equal(result.era.era, entry.era, 'the era is the one the frame is');
    assert.deepEqual(result.notes, [], `${entry.file}: nothing was skipped`);
  }
});
