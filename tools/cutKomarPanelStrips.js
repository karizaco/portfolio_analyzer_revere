'use strict';

/**
 * Cut a panel frame into readable strips, so the panel can be READ.
 *
 * The expectation the reader is scored against is read off the frames
 * by eye, and a 9-13 px panel cannot be read in a whole-frame view.
 * So each frame's panel region is cut into strips and upscaled, and the
 * strips are what gets read.
 *
 *   node tools/cutKomarPanelStrips.js <frame.png> [outDir]
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { panelRegionForFrame } = require('../src/komar/panelLayout');

/** The strip's height in source pixels. */
const STRIP = 300;

/** The upscale a strip is read at. */
const SCALE = 4;

async function main() {
  const framePath = process.argv[2];
  if (!framePath) {
    console.log('usage: node tools/cutKomarPanelStrips.js <frame.png> [outDir]');
    return;
  }
  const outDir = process.argv[3] || path.join(path.dirname(framePath), 'strips');
  fs.mkdirSync(outDir, { recursive: true });

  const source = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { info } = source;
  const region = panelRegionForFrame('20260101', info);
  const name = path.basename(framePath, '.png');

  const strips = Math.ceil(region.height / STRIP);
  for (let index = 0; index < strips; index += 1) {
    const top = region.top + index * STRIP;
    const height = Math.min(STRIP, region.top + region.height - top);
    const out = path.join(outDir, `${name}_s${index}.png`);
    await sharp(framePath)
      .extract({ height, left: region.left, top, width: region.width })
      .resize({ kernel: 'lanczos3', width: region.width * SCALE })
      .png()
      .toFile(out);
    console.log(`${out} (source y ${top}..${top + height})`);
  }
  console.log(`the panel region: ${JSON.stringify(region)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
