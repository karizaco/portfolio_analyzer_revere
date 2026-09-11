const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const createWorker = Tesseract.createWorker;

let workerPromise;

function splitRecognizedLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function scoreOcrResult(text) {
  const upper = text.toUpperCase();
  let score = 0;
  for (const token of ['BOTTOM LINE', 'HOLDINGS', 'FOCUS', 'PORTFOLIO', 'GRO', 'TURBO', 'RVAB', 'REBAR']) {
    if (upper.includes(token)) {
      score += 1;
    }
  }

  return score;
}

async function preprocessImage(filePath, profileName) {
  let pipeline = sharp(filePath)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .normalize()
    .sharpen();

  if (profileName === 'threshold') {
    pipeline = pipeline.threshold(176);
  }

  return pipeline.png().toBuffer();
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
          preserve_interword_spaces: '1'
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
    lines: splitRecognizedLines(text),
    profileName,
    score: scoreOcrResult(text),
    text
  };
}

async function ocrImage(filePath) {
  const worker = await getWorker();
  const thresholdResult = await runProfile(worker, filePath, 'threshold');

  if (thresholdResult.score >= 3 || thresholdResult.lines.length >= 3) {
    return thresholdResult;
  }

  const normalizedResult = await runProfile(worker, filePath, 'normalized');
  return normalizedResult.score > thresholdResult.score
    ? normalizedResult
    : thresholdResult;
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
