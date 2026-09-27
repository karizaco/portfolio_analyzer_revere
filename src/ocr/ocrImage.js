const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const { TEXT_DENSITY_KEYWORDS } = require('../video/ocrScanLogic');

const createWorker = Tesseract.createWorker;
const BOTTOM_CROP_RATIO = 0.7;
const OCR_DPI = 300;

let workerPromise;

function splitRecognizedLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Tokens whose presence in OCR text indicates a structured whiteboard layout
// (legacy) or a text-heavy screen (new). Used to choose between OCR profiles.
const STRUCTURED_KEYWORDS = Object.freeze([
  'BOTTOM LINE',
  'HOLDINGS',
  'FOCUS',
  'PORTFOLIO',
  'GRO',
  'TURBO',
  'RVAB',
  'REBAR'
]);

function scoreOcrResult(text) {
  const upper = text.toUpperCase();
  let score = 0;
  for (const token of STRUCTURED_KEYWORDS) {
    if (upper.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function findKeywords(text) {
  const upper = String(text || '').toUpperCase();
  const found = [];
  for (const token of TEXT_DENSITY_KEYWORDS) {
    if (upper.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

async function preprocessImage(filePath, profileName, preprocessOptions = {}) {
  // overlayScale default raised from 3 → 5 (2026-09-25): the maxcrop test showed
  // 5x scale + black padding + sharpen 2.0 lifts Tesseract recall ~5pp on dense
  // position lists. Larger image = more pixels per character for Tesseract.
  const { overlayRegion = null, overlayScale = 5 } = preprocessOptions;
  let pipeline = sharp(filePath);

  // --- bottom-half profiles (legacy whiteboard) ---
  if (profileName === 'bottom-threshold' || profileName === 'bottom-normalized') {
    const metadata = await pipeline.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const top = Math.max(0, Math.floor(height * BOTTOM_CROP_RATIO));
    pipeline = sharp(filePath).extract({
      height: Math.max(1, height - top),
      left: 0,
      top,
      width
    });
  }

  // --- chart-stream profile: crop overlay region, upscale, enhance ---
  if (profileName === 'chart-stream' && overlayRegion) {
    const metadata = await pipeline.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const { x, y, w, h } = overlayRegion;
    // Convert fractional coords to absolute pixels
    const left = Math.round(x * width);
    const top = Math.round(y * height);
    const cropW = Math.round(w * width);
    const cropH = Math.round(h * height);
    // Pipeline order: negate FIRST (white-on-dark → dark-on-white), then
    // linear contrast boost, then normalize. The old order (normalize before
    // linear) washed out contrast by stretching values before the boost could
    // differentiate text from background.
    // Test 2026-09-25: bumping sharpen sigma 1.5 → 2.0 and adding a 100px black
    // padding around the image lifts Tesseract recall ~5pp on dense position
    // lists. Black padding gives Tesseract clear page boundaries; higher
    // sharpening helps on already-upscaled text.
    pipeline = sharp(filePath)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(Math.round(cropW * overlayScale), Math.round(cropH * overlayScale), { kernel: 'lanczos3' })
      .grayscale()
      .negate()   // invert: white-on-dark → black-on-white
      .linear(1.8, -64)  // contrast boost first
      .normalize()         // then stretch to full range
      .sharpen({ sigma: 2.0 })
      .extend({
        top: 100, bottom: 100, left: 100, right: 100,
        background: { r: 0, g: 0, b: 0 }
      });
    return pipeline
      .withMetadata({ density: OCR_DPI })
      .png()
      .toBuffer();
  }

  pipeline = pipeline
    .flatten({ background: '#ffffff' })
    .grayscale()
    .normalize()
    .sharpen();

  if (profileName === 'threshold' || profileName === 'bottom-threshold') {
    pipeline = pipeline.threshold(176);
  }

  return pipeline
    .withMetadata({ density: OCR_DPI })
    .png()
    .toBuffer();
}

function extractBottomCandidate(text) {
  const lines = splitRecognizedLines(text)
    .map((line) => line.replace(/^[*>\-\s]+/, '').trim())
    .filter(Boolean);
  if (!lines.length) {
    return '';
  }

  const joined = lines.join(' ');
  const labeledMatch = joined.match(/BOTTOM\s+LINE\s*[:.]?\s*(.*)$/i);
  if (labeledMatch && labeledMatch[1]) {
    return labeledMatch[1].replace(/[|]+/g, ' ').trim();
  }

  return joined.replace(/[|]+/g, ' ').trim();
}

function scoreBottomCandidate(candidate, confidence) {
  const normalized = (candidate || '').trim();
  if (!normalized || /BOTTOM\s+LINE/i.test(normalized)) {
    return -1;
  }

  const alphaMatches = normalized.match(/[A-Z]/gi) || [];
  const wordMatches = normalized.match(/[A-Z]{2,}/gi) || [];

  if (alphaMatches.length < 5 || wordMatches.length < 2) {
    return -1;
  }

  return alphaMatches.length + (wordMatches.length * 4) + (confidence / 10);
}

function hasBottomLineContent(text) {
  return /BOTTOM\s+LINE\s*[:.]?\s*[A-Z0-9]/i.test(text || '');
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (typeof createWorker !== 'function') {
        throw new Error('tesseract.js createWorker API is unavailable.');
      }

      const worker = await createWorker('eng');
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: String(OCR_DPI)
        });
      }

      return worker;
    })();
  }

  return workerPromise;
}

// Parse Tesseract TSV output into per-word position records.
// TSV columns: level page block par line word left top width height conf text
// Returns array of { text, left, top, width, height, conf } for level=5 (word) only.
function parseTsvWords(tsvString) {
  if (!tsvString || typeof tsvString !== 'string') {
    return [];
  }
  const out = [];
  const lines = tsvString.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    if (Number(cols[0]) !== 5) continue;
    const text = (cols[11] || '').trim();
    if (!text) continue;
    out.push({
      conf: Number(cols[10]),
      height: Number(cols[9]),
      left: Number(cols[6]),
      text,
      top: Number(cols[7]),
      width: Number(cols[8])
    });
  }
  return out;
}

async function runProfile(worker, filePath, profileName, preprocessOptions) {
  const imageBuffer = await preprocessImage(filePath, profileName, preprocessOptions);
  // Request tsv output so callers can use word positions for column-aware
  // parsing. Backwards-compatible: callers that only read text/lines/confidence
  // see no change.
  const result = await worker.recognize(imageBuffer, {}, { tsv: true });
  const text = result.data.text || '';
  return {
    confidence: Number(result.data.confidence || 0),
    keywords: findKeywords(text),
    lines: splitRecognizedLines(text),
    profileName,
    score: scoreOcrResult(text),
    text,
    words: parseTsvWords(result.data.tsv)
  };
}

async function ocrImage(filePath, preprocessOptions = {}) {
  const worker = await getWorker();

  // When chartStream mode is active, use the dedicated overlay-crop profile
  if (preprocessOptions.chartStream) {
    const chartStreamResult = await runProfile(worker, filePath, 'chart-stream', preprocessOptions);
    return {
      ...chartStreamResult,
      bottomConfidence: 0,
      bottomProfile: '',
      bottomText: ''
    };
  }

  const thresholdResult = await runProfile(worker, filePath, 'threshold', preprocessOptions);

  let selectedResult = thresholdResult;
  if (thresholdResult.score < 3 && thresholdResult.lines.length < 3) {
    const normalizedResult = await runProfile(worker, filePath, 'normalized', preprocessOptions);
    selectedResult = normalizedResult.score > thresholdResult.score
    ? normalizedResult
    : thresholdResult;
  }

  if (!hasBottomLineContent(selectedResult.text)) {
    const bottomThresholdResult = await runProfile(worker, filePath, 'bottom-threshold', preprocessOptions);
    const bottomNormalizedResult = await runProfile(worker, filePath, 'bottom-normalized', preprocessOptions);
    const bottomCandidates = [bottomThresholdResult, bottomNormalizedResult]
      .map((result) => ({
        confidence: result.confidence,
        profileName: result.profileName,
        text: extractBottomCandidate(result.text)
      }))
      .sort((left, right) => scoreBottomCandidate(right.text, right.confidence) - scoreBottomCandidate(left.text, left.confidence));
    const bestBottomCandidate = bottomCandidates[0];
    const bestBottomScore = bestBottomCandidate
      ? scoreBottomCandidate(bestBottomCandidate.text, bestBottomCandidate.confidence)
      : -1;

    return {
      ...selectedResult,
      bottomConfidence: bestBottomCandidate ? bestBottomCandidate.confidence : 0,
      bottomProfile: bestBottomCandidate ? bestBottomCandidate.profileName : '',
      bottomText: bestBottomScore >= 0 ? bestBottomCandidate.text : ''
    };
  }

  return {
    ...selectedResult,
    bottomConfidence: 0,
    bottomProfile: '',
    bottomText: ''
  };
}

async function closeWorker() {
  if (!workerPromise) {
    return;
  }

  const worker = await workerPromise;
  if (typeof worker.terminate === 'function') {
    await worker.terminate();
  }

  workerPromise = undefined;
}

module.exports = {
  closeWorker,
  ocrImage
};
