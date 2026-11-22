'use strict';

/**
 * Vertical split for Clement "Daily Market Plan" dashboards.
 *
 * Human layout (2026-11-22): left gray content cells | white gutter |
 * right blue/white S&P monitor tables. Measured gutter ~42.5% of width
 * on 2989px plans.
 *
 * Uses sharp + raw pixels (no Python). OCR of halves is a separate step.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

/**
 * @param {Buffer|string} input path or buffer
 * @param {object} [options]
 * @param {number} [options.gutterPad=10] pixels excluded from both crops at the split
 * @returns {Promise<{
 *   width: number, height: number, split_x: number, split_frac: number,
 *   method: string, white_at_split: number,
 *   left: Buffer, right: Buffer
 * }>}
 */
async function splitDashboard(input, options = {}) {
  const gutterPad = options.gutterPad == null ? 10 : options.gutterPad;
  const img = sharp(input, { failOn: 'none' });
  const meta = await img.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 100 || height < 100) {
    throw new Error(`dashboard image too small: ${width}x${height}`);
  }

  const { data, info } = await img
    .ensureAlpha(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const channels = info.channels; // 4

  const whiteFrac = new Float64Array(w);
  const midGray = new Float64Array(w);
  const blueDom = new Float64Array(w);

  for (let x = 0; x < w; x += 1) {
    let white = 0;
    let gray = 0;
    let blue = 0;
    for (let y = 0; y < h; y += 1) {
      const i = (y * w + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const mean = (r + g + b) / 3;
      const cmin = Math.min(r, g, b);
      const cmax = Math.max(r, g, b);
      const chroma = cmax - cmin;
      if (mean > 240) white += 1;
      if (mean > 170 && mean < 230 && chroma < 25) gray += 1;
      if (b - r > 20) blue += 1;
    }
    whiteFrac[x] = white / h;
    midGray[x] = gray / h;
    blueDom[x] = blue / h;
  }

  const smooth = (arr, k = 21) => {
    const out = new Float64Array(arr.length);
    const half = Math.floor(k / 2);
    for (let i = 0; i < arr.length; i += 1) {
      let s = 0;
      let n = 0;
      for (let j = i - half; j <= i + half; j += 1) {
        if (j < 0 || j >= arr.length) continue;
        s += arr[j];
        n += 1;
      }
      out[i] = n ? s / n : 0;
    }
    return out;
  };

  const whiteS = smooth(whiteFrac);
  const grayS = smooth(midGray);
  const blueS = smooth(blueDom);

  const lo = Math.floor(w * 0.35);
  const hi = Math.floor(w * 0.72);
  let peakWhite = lo;
  for (let x = lo; x < hi; x += 1) {
    if (whiteS[x] > whiteS[peakWhite]) peakWhite = x;
  }

  let bestX = lo;
  let bestScore = -1;
  for (let x = lo; x < hi; x += 2) {
    let leftG = 0;
    let rightB = 0;
    for (let i = 0; i < x; i += 1) leftG += grayS[i];
    for (let i = x; i < w; i += 1) rightB += blueS[i];
    leftG /= Math.max(1, x);
    rightB /= Math.max(1, w - x);
    let pad = 0;
    let pn = 0;
    for (let j = x - 8; j <= x + 8; j += 1) {
      if (j < 0 || j >= w) continue;
      pad += whiteS[j];
      pn += 1;
    }
    const score = leftG + rightB + 0.75 * (pn ? pad / pn : 0);
    if (score > bestScore) {
      bestScore = score;
      bestX = x;
    }
  }

  let method = 'white_gutter';
  let splitX = peakWhite;
  if (whiteS[peakWhite] < 0.85) {
    splitX = bestX;
    method = 'gray_left_blue_right';
  }
  splitX = Math.max(Math.floor(w * 0.3), Math.min(Math.floor(w * 0.7), splitX));

  const leftW = Math.max(1, splitX - gutterPad);
  const rightX = Math.min(w - 1, splitX + gutterPad);
  const left = await sharp(input, { failOn: 'none' })
    .extract({ left: 0, top: 0, width: leftW, height: h })
    .png()
    .toBuffer();
  const right = await sharp(input, { failOn: 'none' })
    .extract({ left: rightX, top: 0, width: w - rightX, height: h })
    .png()
    .toBuffer();

  return {
    width: w,
    height: h,
    split_x: splitX,
    split_frac: Number((splitX / w).toFixed(4)),
    method,
    white_at_split: Number(whiteFrac[splitX].toFixed(4)),
    left,
    right,
  };
}

/**
 * Write left/right PNGs next to a source path.
 * @param {string} imagePath
 * @param {string} [outDir]
 */
async function splitDashboardToFiles(imagePath, outDir) {
  const abs = path.resolve(imagePath);
  const dir = outDir || path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const result = await splitDashboard(abs);
  const leftPath = path.join(dir, `${stem}_LEFT.png`);
  const rightPath = path.join(dir, `${stem}_RIGHT.png`);
  fs.writeFileSync(leftPath, result.left);
  fs.writeFileSync(rightPath, result.right);
  return {
    ...result,
    left_path: leftPath,
    right_path: rightPath,
    left: undefined,
    right: undefined,
  };
}

module.exports = {
  splitDashboard,
  splitDashboardToFiles,
};
