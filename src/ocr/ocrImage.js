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

async function preprocessImage(filePath, profileName) {
  let pipeline = sharp(filePath);

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

async function runProfile(worker, filePath, profileName) {
  const imageBuffer = await preprocessImage(filePath, profileName);
  const result = await worker.recognize(imageBuffer);
  const text = result.data.text || '';
  return {
    confidence: Number(result.data.confidence || 0),
    keywords: findKeywords(text),
    lines: splitRecognizedLines(text),
    profileName,
    score: scoreOcrResult(text),
    text
  };
}

async function ocrImage(filePath) {
  const worker = await getWorker();
  const thresholdResult = await runProfile(worker, filePath, 'threshold');

  let selectedResult = thresholdResult;
  if (thresholdResult.score < 3 && thresholdResult.lines.length < 3) {
    const normalizedResult = await runProfile(worker, filePath, 'normalized');
    selectedResult = normalizedResult.score > thresholdResult.score
    ? normalizedResult
    : thresholdResult;
  }

  if (!hasBottomLineContent(selectedResult.text)) {
    const bottomThresholdResult = await runProfile(worker, filePath, 'bottom-threshold');
    const bottomNormalizedResult = await runProfile(worker, filePath, 'bottom-normalized');
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
