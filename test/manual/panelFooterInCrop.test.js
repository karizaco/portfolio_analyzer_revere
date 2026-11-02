'use strict';

// A MANUAL measurement: does the production chart-stream crop actually
// CONTAIN the positions panel's own footer line?
//
// The panel prints its row count in its footer ("11 Items in Personal
// WatchList"). That count is the project's only INDEPENDENT check on a
// reading -- and `readPanelRowCount` reports it in every probe log.
//
// This harness renders, for each era, exactly the rectangle the OCR engine
// is shown (the era-conditional crop), cut out of the tracked ground-truth
// fixture, and writes it to a PNG so a reader can LOOK at it.
//
// The ground-truth fixture is itself a crop of the source frame:
//   source region  x 0.80, y 0.52, w 0.20, h 0.48   (tools/buildGroundTruthFixtures.js)
//   upscaled       x2
// so the production crop's rectangle maps into the fixture as:
//   fixture_x = (source_x - 0.80*srcW) * 2
//   fixture_y = (source_y - 0.52*srcH) * 2
//
// Run it:
//   node --test test/manual/panelFooterInCrop.test.js
//
// The assertions are STRUCTURAL (the crops were produced and are readable).
// The finding -- whether the footer is inside -- is what the PNGs show.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth');

// The fixture crop, from tools/buildGroundTruthFixtures.js.
const FIXTURE_CROP = { x: 0.80, y: 0.52, w: 0.20, h: 0.48 };
const FIXTURE_SCALE = 2;

// The SOURCE frame the fixtures were cut from. It is DERIVED, not assumed:
// the fixture is the source frame's (x 0.80, y 0.52, w 0.20, h 0.48) region
// upscaled x2, so srcW = fixtureWidth / (0.20 * 2) and
// srcH = fixtureHeight / (0.48 * 2). A run whose snapshots were saved at
// 1280x720 would otherwise be measured against a 1920x1080 frame, and every
// pixel below would be wrong.
function deriveSourceSize(meta) {
  return {
    w: Math.round(meta.width / (FIXTURE_CROP.w * FIXTURE_SCALE)),
    h: Math.round(meta.height / (FIXTURE_CROP.h * FIXTURE_SCALE))
  };
}

// The era-conditional production crop, from src/video/chartStreamCrop.js.
const ERAS = [
  { name: '2022-floating-panel', crop: '0.86,0.60,0.14,0.28', fixture: '20220301_c0.png' },
  { name: '2023-right-sidebar', crop: '0.82,0.60,0.18,0.32', fixture: '20230523_c0.png' },
  { name: '2023-right-sidebar-30609', crop: '0.82,0.60,0.18,0.32', fixture: '20230609_c0.png' }
];

function parseCrop(text) {
  const [x, y, w, h] = String(text).split(',').map(Number);
  return { x, y, w, h };
}

// The part of the source frame the production crop shows, in fixture pixels.
function productionRectInFixture(crop, src) {
  const c = parseCrop(crop);
  return {
    left: Math.round((c.x - FIXTURE_CROP.x) * src.w * FIXTURE_SCALE),
    top: Math.round((c.y - FIXTURE_CROP.y) * src.h * FIXTURE_SCALE),
    width: Math.round(c.w * src.w * FIXTURE_SCALE),
    height: Math.round(c.h * src.h * FIXTURE_SCALE)
  };
}

test('the production crop against the panel footer', async () => {
  const outDir = path.join(os.tmpdir(), `panel-footer-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== the production crop, cut out of the tracked fixture ===`);
  console.log(`    fixture crop   x ${FIXTURE_CROP.x} y ${FIXTURE_CROP.y} w ${FIXTURE_CROP.w} h ${FIXTURE_CROP.h} (x${FIXTURE_SCALE})`);
  console.log(`    source size    DERIVED per fixture (a run's snapshots are not always 1920x1080)`);

  for (const era of ERAS) {
    const file = path.join(FIXTURES, era.fixture);
    if (!fs.existsSync(file)) {
      console.log(`  ${era.name.padEnd(26)} (no fixture ${era.fixture} on disk -- skipped)`);
      continue;
    }

    const meta = await sharp(file).metadata();
    const src = deriveSourceSize(meta);
    const rect = productionRectInFixture(era.crop, src);
    const out = path.join(outDir, `${era.fixture.replace('.png', '')}-production-crop.png`);

    await sharp(file).extract(rect).toFile(out);

    const cropSource = parseCrop(era.crop);
    const srcBottom = Math.round((cropSource.y + cropSource.h) * src.h);
    const srcRight = Math.round((cropSource.x + cropSource.w) * src.w);

    console.log(
      `  ${era.name.padEnd(26)} ${era.crop.padEnd(18)}`
      + ` source ${src.w}x${src.h}`
      + ` -> x<=${String(srcRight).padStart(4)} y<=${String(srcBottom).padStart(4)}`
      + `   ${out}`
    );

    // The written crop must be a real image of the expected size.
    const outMeta = await sharp(out).metadata();
    assert.ok(outMeta.width > 0 && outMeta.height > 0, `${out} is not a readable image`);
    assert.ok(
      meta.width > 0 && meta.height > 0,
      `${era.fixture} is not a readable image`
    );
  }

  console.log(`\n  The fixture spans source y ${Math.round(FIXTURE_CROP.y * 1080)}`
    + `..${Math.round((FIXTURE_CROP.y + FIXTURE_CROP.h) * 1080)} of a 1080-tall frame;`
    + ` the production crop's bottom edge is above that in every era.`);
  console.log(`  Look at the PNGs: if the panel's own footer line is NOT in them,`);
  console.log(`  then \`readPanelRowCount\` cannot fire in production, whatever it does`);
  console.log(`  with the words it is given.`);
});
