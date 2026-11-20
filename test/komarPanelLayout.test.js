'use strict';

// The Komar PANEL's layout: which era a session is in, where the
// panel is, and what a group header is.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The panel is the right ~15 % of the screen in EVERY era, and its row
// pitch is a FRACTION of the height rather than a pixel count -- 25px
// at 1080 and 17px at 720, which is 0.023 of the height in both. That
// is what makes one crop work at every resolution the corpus holds
// (960x540, 1280x720, 1920x1080, 2560x1440).
//
// The ERAS differ in one thing that matters to a reader: era A and B
// print FOUR columns (Symbol | Last | Chg | Chg%) and era C prints
// three (Symbol | Last | Chg%). And the header says "Symbol", not
// "Sym".

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PANEL_ERAS,
  PANEL_REGION,
  PANEL_ROW_PITCH,
  WEBCAM_TOP,
  isGroupHeader,
  isOccluded,
  panelEraForDate,
  panelRegionForFrame,
  panelRowPitch,
} = require('../src/komar/panelLayout');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'komar_panel');

test('the fixtures are the panel crops they claim to be', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 3, 'one frame per era');
  assert.deepEqual(manifest.files.map((entry) => entry.era), ['A', 'B', 'C']);
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, entry.file));
    assert.equal(crypto.createHash('md5').update(bytes).digest('hex'), entry.md5, entry.file);
    // The crop is the region, in the frame's own pixels.
    assert.equal(entry.crop.left, Math.floor(parseInt(entry.frame_size, 10) * PANEL_REGION.left));
  }
});

test('a session is in the era its date says', () => {
  assert.equal(panelEraForDate('20220114').era, 'A', 'January 2022 is era A');
  assert.equal(panelEraForDate('20231119').era, 'A', 'November 2022 is era A');
  assert.equal(panelEraForDate('20250601').era, 'B', 'June 2025 is era B');
  assert.equal(panelEraForDate('20260125').era, 'C', 'January 2026 is era C');
  assert.equal(panelEraForDate('20260509').era, 'C', 'May 2026 is era C');
  // A session with no date reads the CURRENT layout and lets the
  // header decide.
  assert.equal(panelEraForDate('').era, 'C');
});

test('the eras differ in their column count', () => {
  const a = PANEL_ERAS.find((era) => era.era === 'A');
  const c = PANEL_ERAS.find((era) => era.era === 'C');
  assert.equal(a.columns.length, 4, 'era A prints a fourth column');
  assert.equal(c.columns.length, 3, 'era C does not');
  assert.equal(a.columns[0], 'symbol');
  assert.ok(c.group_headers.includes('CLOSED'), 'era C has a CLOSED group');
});

test('the panel is the right of the screen at every resolution', () => {
  for (const frame of [
    { width: 960, height: 540 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    const region = panelRegionForFrame('20260125', frame);
    assert.ok(region.left > frame.width * 0.8, 'the region starts at the right');
    assert.ok(region.left + region.width <= frame.width, 'and it fits on the screen');
    assert.ok(region.width >= 150, 'and it is wide enough for the table');
  }
});

test('the row pitch is a fraction of the height, not a pixel count', () => {
  const at1080 = panelRowPitch({ height: 1080 });
  const at720 = panelRowPitch({ height: 720 });
  assert.ok(Math.abs(at1080 - 25) <= 1, `25px at 1080, measured ${at1080}`);
  assert.ok(Math.abs(at720 - 17) <= 1, `17px at 720, measured ${at720}`);
  assert.ok(Math.abs(PANEL_ROW_PITCH - 0.0231) < 0.001);
});

test('a row behind the webcam circle is OCCLUDED, not absent', () => {
  assert.equal(isOccluded(500, { height: 1080 }), false, 'a row above the circle');
  assert.equal(isOccluded(700, { height: 1080 }), true, 'a row below it');
  assert.ok(WEBCAM_TOP > 0.5 && WEBCAM_TOP < 0.9);
});

test('a group header is one of the era\'s own labels', () => {
  const eraC = panelEraForDate('20260125');
  const eraA = panelEraForDate('20220114');
  assert.ok(isGroupHeader('CLOSED', eraC));
  assert.ok(isGroupHeader('data center', eraC), 'the match is not case-sensitive');
  assert.ok(isGroupHeader('LITHIUM / RARE EARTH', eraC));
  assert.ok(isGroupHeader('STOCKS', eraA));
  // A row with prices is a position, whatever it says.
  assert.equal(isGroupHeader('DELL 216.09 1.86%', eraC), false);
  // And a lone symbol is a position too: a row whose prices could not
  // be read leaves the symbol alone, and a shape rule would drop it.
  assert.equal(isGroupHeader('AAPL', eraC), false);
  assert.equal(isGroupHeader('', eraC), false);
  // "CLOSED" is era C's label, not era A's.
  assert.equal(isGroupHeader('CLOSED', eraA), false);
});
