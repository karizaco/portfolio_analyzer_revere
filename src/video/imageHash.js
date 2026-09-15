'use strict';

// Perceptual hash (pHash) using a 2D DCT over a 32x32 grayscale image and
// thresholding the 8x8 low-frequency block against its median. Two visually
// similar frames (same slide, different compression / crop) should hash to
// the same 64-bit value or differ by only a handful of bits.
//
// Why not just use a Sharp-provided hash? Sharp intentionally omits a perceptual
// hash; rolling a small DCT-based one in-process keeps the dependency footprint
// flat and lets the test suite assert exact hex equality.

const sharp = require('sharp');

const SOURCE_SIZE = 32;
const SAMPLE_SIZE = 8;
const TOTAL_BITS = SOURCE_SIZE * SOURCE_SIZE; // 1024 -> but we only use 64 bits

const ALPHA_HEX = '0123456789abcdef';

function toGrayscale32(imagePath) {
  return sharp(imagePath)
    .grayscale()
    .resize(SOURCE_SIZE, SOURCE_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      if (info.width !== SOURCE_SIZE || info.height !== SOURCE_SIZE) {
        throw new Error(`unexpected grayscale size ${info.width}x${info.height}`);
      }
      return Uint8Array.from(data);
    });
}

// 1D type-II DCT (unnormalized), length-N. Coefficients match the standard
// textbook formulation used by phash.org.
function dct1d(values) {
  const n = values.length;
  const result = new Array(n);
  const scale = Math.sqrt(2 / n);
  for (let k = 0; k < n; k += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += values[i] * Math.cos(((Math.PI / n) * (i + 0.5)) * k);
    }
    if (k === 0) {
      result[k] = sum * Math.sqrt(1 / n);
    } else {
      result[k] = sum * scale;
    }
  }
  return result;
}

// 2D DCT applied row-first then column-first. Operates on a flat Uint8Array
// length N*N (N=32) and returns a flat Array<number> length N*N.
function dct2d(pixels, n) {
  const transpose = new Array(n);
  for (let y = 0; y < n; y += 1) {
    transpose[y] = new Array(n);
    for (let x = 0; x < n; x += 1) {
      transpose[y][x] = pixels[y * n + x];
    }
  }

  const rowDct = transpose.map((row) => dct1d(row));

  const transposed = new Array(n);
  for (let y = 0; y < n; y += 1) {
    transposed[y] = new Array(n);
    for (let x = 0; x < n; x += 1) {
      transposed[y][x] = rowDct[x][y];
    }
  }

  const colDct = transposed.map((row) => dct1d(row));

  const out = new Array(n * n);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      out[y * n + x] = colDct[y][x];
    }
  }
  return out;
}

function extractTopLeft(dctValues, n, sampleSize) {
  const block = new Array(sampleSize * sampleSize);
  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      block[y * sampleSize + x] = dctValues[y * n + x];
    }
  }
  return block;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function bitsToHex(bits) {
  const hexChars = [];
  for (let index = 0; index < bits.length; index += 4) {
    const nibble = (bits[index] << 3) | (bits[index + 1] << 2) | (bits[index + 2] << 1) | bits[index + 3];
    hexChars.push(ALPHA_HEX[nibble]);
  }
  return hexChars.join('');
}

async function computePerceptualHash(imagePath) {
  const pixels = await toGrayscale32(imagePath);
  const dct = dct2d(pixels, SOURCE_SIZE);
  const topLeft = extractTopLeft(dct, SOURCE_SIZE, SAMPLE_SIZE);
  // Drop the DC term (index 0) before thresholding so absolute brightness does
  // not flip every bit when the slide has a different background tint.
  const acTerms = topLeft.slice(1);
  const medianValue = median(acTerms);
  const bits = topLeft.map((value) => (value > medianValue ? 1 : 0));
  return bitsToHex(bits);
}

function computePerceptualHashFromPixels(pixels) {
  const expected = SOURCE_SIZE * SOURCE_SIZE;
  const input = pixels instanceof Uint8Array ? pixels : Uint8Array.from(pixels);
  if (input.length !== expected) {
    throw new Error(`pixels must be length ${expected}, got ${input.length}`);
  }
  const dct = dct2d(input, SOURCE_SIZE);
  const topLeft = extractTopLeft(dct, SOURCE_SIZE, SAMPLE_SIZE);
  const acTerms = topLeft.slice(1);
  const medianValue = median(acTerms);
  const bits = topLeft.map((value) => (value > medianValue ? 1 : 0));
  return bitsToHex(bits);
}

function popcount32(value) {
  let count = 0;
  let v = value >>> 0;
  while (v) {
    v &= v - 1;
    count += 1;
  }
  return count;
}

function hammingDistance(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') {
    throw new TypeError('hammingDistance requires two hex strings');
  }
  if (hexA.length !== hexB.length) {
    throw new Error(`hammingDistance requires equal-length hex strings (got ${hexA.length} vs ${hexB.length})`);
  }
  let total = 0;
  for (let index = 0; index < hexA.length; index += 1) {
    const left = parseInt(hexA[index], 16);
    const right = parseInt(hexB[index], 16);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      throw new Error(`invalid hex character at index ${index}`);
    }
    total += popcount32(left ^ right);
  }
  return total;
}

module.exports = {
  SOURCE_SIZE,
  SAMPLE_SIZE,
  computePerceptualHash,
  computePerceptualHashFromPixels,
  dct1d,
  dct2d,
  hammingDistance
};
