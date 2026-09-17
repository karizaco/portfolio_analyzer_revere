'use strict';

// Region-cropped perceptual hash: feed `sharp(...).extract({left,top,width,height})`
// into the same DCT machinery as `imageHash.js`. Used by Qullamaggie chart-stream
// runs to dedup "same chart, different position-list overlay" without losing
// the overlay's identity. Full-frame pHash is still computed alongside (`phash`
// vs `phash_overlay`) so existing Revere dedup behaviour is unchanged.

const sharp = require('sharp');

const {
  SOURCE_SIZE,
  SAMPLE_SIZE,
  dct2d,
  median,
  bitsToHex,
  computePerceptualHashFromPixels
} = require('./imageHash');

function clampRegion({ x, y, width, height }, sourceWidth, sourceHeight) {
  const left = Math.max(0, Math.min(Math.trunc(x), Math.max(0, sourceWidth - 1)));
  const top = Math.max(0, Math.min(Math.trunc(y), Math.max(0, sourceHeight - 1)));
  const maxWidth = Math.max(1, sourceWidth - left);
  const maxHeight = Math.max(1, sourceHeight - top);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(Math.trunc(width), maxWidth)),
    height: Math.max(1, Math.min(Math.trunc(height), maxHeight))
  };
}

// Pure helper: turn a fractional region {xFraction, yFraction, wFraction, hFraction}
// into absolute pixels against the source dimensions. Fractional regions
// make the caller code independent of resolution — the chart-stream overlay
// sits at ~70%/84% for almost every YouTube layout, so a fraction-based
// input is the right default for the channel.
function resolveFractionalRegion(sourceWidth, sourceHeight, fractionRegion) {
  if (!fractionRegion) {
    return null;
  }
  const xFraction = Number(fractionRegion.xFraction);
  const yFraction = Number(fractionRegion.yFraction);
  const wFraction = Number(fractionRegion.wFraction);
  const hFraction = Number(fractionRegion.hFraction);
  if (![xFraction, yFraction, wFraction, hFraction].every(Number.isFinite)) {
    return null;
  }
  const x = Math.round(xFraction * sourceWidth);
  const y = Math.round(yFraction * sourceHeight);
  const width = Math.round(wFraction * sourceWidth);
  const height = Math.round(hFraction * sourceHeight);
  return clampRegion({ x, y, width, height }, sourceWidth, sourceHeight);
}

async function loadGrayscale32FromRegion(imagePath, region) {
  return sharp(imagePath)
    .metadata()
    .then((meta) => {
      const sourceWidth = meta.width || 0;
      const sourceHeight = meta.height || 0;
      if (!sourceWidth || !sourceHeight) {
        throw new Error(`could not read ${imagePath} dimensions`);
      }
      const safe = clampRegion(region, sourceWidth, sourceHeight);
      return sharp(imagePath)
        .extract({ left: safe.x, top: safe.y, width: safe.width, height: safe.height })
        .grayscale()
        .resize(SOURCE_SIZE, SOURCE_SIZE, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data }) => Uint8Array.from(data));
    });
}

async function computePerceptualHashOfRegion(imagePath, region) {
  const pixels = await loadGrayscale32FromRegion(imagePath, region);
  return computePerceptualHashFromPixels(pixels);
}

async function computePerceptualHashOfFractionalRegion(imagePath, fractionRegion) {
  if (!fractionRegion) {
    return null;
  }
  const meta = await sharp(imagePath).metadata();
  const region = resolveFractionalRegion(meta.width || 0, meta.height || 0, fractionRegion);
  if (!region) {
    return null;
  }
  return computePerceptualHashOfRegion(imagePath, region);
}

// Convenience: returns the absolute `region` so it can be cached alongside
// the hash (the aggregator needs to render the region to humans). Returns
// `null` for invalid fractional input so the CLI/parser layer can short-circuit.
async function hashOfRegionWithMetadata(imagePath, fractionRegion) {
  if (!fractionRegion) {
    return null;
  }
  const meta = await sharp(imagePath).metadata();
  const sourceWidth = meta.width || 0;
  const sourceHeight = meta.height || 0;
  const region = resolveFractionalRegion(sourceWidth, sourceHeight, fractionRegion);
  if (!region) {
    return null;
  }
  const hash = await computePerceptualHashOfRegion(imagePath, region);
  return { hash, region };
}

module.exports = {
  computePerceptualHashOfRegion,
  computePerceptualHashOfFractionalRegion,
  hashOfRegionWithMetadata,
  resolveFractionalRegion
};

// Re-export the underlying helpers for callers that want raw access without
// pulling imageHash.js separately. Keeps the dependency surface tiny.
module.exports.dct2d = dct2d;
module.exports.SOURCE_SIZE = SOURCE_SIZE;
module.exports.SAMPLE_SIZE = SAMPLE_SIZE;
module.exports.median = median;
module.exports.bitsToHex = bitsToHex;
