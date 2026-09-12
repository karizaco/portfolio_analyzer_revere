const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const PREFILTER_WIDTH = 160;
const PREFILTER_HEIGHT = 90;

function splitIssueCodes(issueCodes) {
  return String(issueCodes || '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);
}

function scoreSnapshotCandidate(parsedRow) {
  const issues = splitIssueCodes(parsedRow.issue_codes);
  let score = 0;

  score += Array.isArray(parsedRow.gro_holdings) ? parsedRow.gro_holdings.length * 2 : 0;
  score += Array.isArray(parsedRow.turbo_holdings) ? parsedRow.turbo_holdings.length * 2 : 0;

  if (parsedRow.gro_metrics_raw) {
    score += 4;
  }

  if (parsedRow.turbo_metrics_raw) {
    score += 4;
  }

  if (parsedRow.bottom_line) {
    score += 4;
  }

  if (parsedRow.layout_type === 'legacy_focus' || parsedRow.layout_type === 'gro_turbo' || parsedRow.layout_type === 'gro_only') {
    score += 2;
  }

  if (parsedRow.parse_status === 'ok') {
    score += 4;
  }

  score += Number(parsedRow.ocr_confidence || 0) / 20;
  score -= issues.length * 2;

  return Number(score.toFixed(2));
}

function scoreWhiteboardCandidate(observationRows, ocrConfidence) {
  const rows = Array.isArray(observationRows) ? observationRows : [];
  const groRow = rows.find((row) => row.portfolio === 'GRO') || null;
  const turboRow = rows.find((row) => row.portfolio === 'TURBO') || null;
  let score = 0;

  for (const row of rows) {
    if (row.metrics_raw) {
      score += 6;
    }

    if (row.metric_scalar) {
      score += 1;
    }

    if (row.metric_1) {
      score += 2;
    }

    if (row.metric_2) {
      score += 2;
    }

    if (row.action_text) {
      score += 1;
    }

    if (row.bottom_line) {
      score += 2;
    }

    score -= splitIssueCodes(row.issue_codes).length * 2;
  }

  if (groRow && groRow.metrics_raw && turboRow && turboRow.metrics_raw) {
    score += 4;
  }

  score += Number(ocrConfidence || 0) / 20;
  return Number(score.toFixed(2));
}

function summarizeLumaBuffer(buffer, width, height) {
  let total = 0;
  let totalSquares = 0;
  let brightPixels = 0;
  let darkPixels = 0;
  let edgeHits = 0;
  let edgeComparisons = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    total += value;
    totalSquares += value * value;

    if (value >= 220) {
      brightPixels += 1;
    }

    if (value <= 96) {
      darkPixels += 1;
    }
  }

  for (let rowIndex = 0; rowIndex < height - 1; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < width - 1; columnIndex += 1) {
      const index = (rowIndex * width) + columnIndex;
      const current = buffer[index];
      const right = buffer[index + 1];
      const below = buffer[index + width];

      if (Math.abs(current - right) >= 24) {
        edgeHits += 1;
      }

      if (Math.abs(current - below) >= 24) {
        edgeHits += 1;
      }

      edgeComparisons += 2;
    }
  }

  const pixelCount = Math.max(buffer.length, 1);
  const meanLuma = total / pixelCount;
  const variance = Math.max((totalSquares / pixelCount) - (meanLuma * meanLuma), 0);

  return {
    brightRatio: brightPixels / pixelCount,
    darkRatio: darkPixels / pixelCount,
    edgeRatio: edgeComparisons > 0 ? edgeHits / edgeComparisons : 0,
    meanLuma,
    stdDev: Math.sqrt(variance)
  };
}

async function analyzeFrameBeforeOcr(framePath) {
  const { data, info } = await sharp(framePath)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize({
      background: '#ffffff',
      fit: 'contain',
      height: PREFILTER_HEIGHT,
      width: PREFILTER_WIDTH
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return summarizeLumaBuffer(data, info.width, info.height);
}

function scoreFramePrefilter(stats, outputKind) {
  let score = 0;

  score += Math.max(0, 12 - (Math.abs(stats.brightRatio - 0.72) * 24));
  score += Math.max(0, 8 - (Math.abs(stats.darkRatio - 0.08) * 90));
  score += Math.max(0, 8 - (Math.abs(stats.edgeRatio - 0.09) * 110));
  score += Math.max(0, 6 - (Math.abs(stats.stdDev - 60) / 10));

  if (stats.meanLuma < 160) {
    score -= 8;
  }

  if (stats.brightRatio < 0.45) {
    score -= 12;
  }

  if (stats.darkRatio < 0.01) {
    score -= 4;
  }

  if (stats.darkRatio > 0.35) {
    score -= 8;
  }

  if (outputKind === 'snapshot') {
    score += Math.min(stats.edgeRatio * 25, 2);
  }

  return Number(score.toFixed(2));
}

function groupContiguousCandidates(candidates) {
  const windows = [];
  let currentWindow = [];

  for (const candidate of candidates) {
    if (!currentWindow.length) {
      currentWindow = [candidate];
      continue;
    }

    const previous = currentWindow[currentWindow.length - 1];
    if ((candidate.frameIndex - previous.frameIndex) <= 1) {
      currentWindow.push(candidate);
      continue;
    }

    windows.push(currentWindow);
    currentWindow = [candidate];
  }

  if (currentWindow.length) {
    windows.push(currentWindow);
  }

  return windows;
}

function chooseBestWindow(windows) {
  if (!windows.length) {
    return [];
  }

  return windows
    .slice()
    .sort((left, right) => {
      if (right.length !== left.length) {
        return right.length - left.length;
      }

      const rightAverage = right.reduce((sum, row) => sum + row.score, 0) / right.length;
      const leftAverage = left.reduce((sum, row) => sum + row.score, 0) / left.length;
      if (rightAverage !== leftAverage) {
        return rightAverage - leftAverage;
      }

      return right[right.length - 1].timestamp - left[left.length - 1].timestamp;
    })[0];
}

function chooseBestCandidate(candidates) {
  if (!candidates.length) {
    return null;
  }

  return candidates
    .slice()
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.ocrConfidence !== left.ocrConfidence) {
        return right.ocrConfidence - left.ocrConfidence;
      }

      return right.timestamp - left.timestamp;
    })[0];
}

function selectFramesForOcr(prefilterRows, options = {}) {
  const {
    maxFrames = 60,
    minFrames = 12,
    minScore = 14,
    neighborRadius = 1
  } = options;

  if (!prefilterRows.length) {
    return [];
  }

  const rowsByIndex = new Map(prefilterRows.map((row) => [row.frameIndex, row]));
  const sortedByScore = prefilterRows
    .slice()
    .sort((left, right) => {
      if (right.prefilterScore !== left.prefilterScore) {
        return right.prefilterScore - left.prefilterScore;
      }

      return right.timestamp - left.timestamp;
    });
  const dynamicThreshold = Math.max(minScore, sortedByScore[0].prefilterScore - 2);
  const thresholdSeeds = sortedByScore.filter((row) => row.prefilterScore >= dynamicThreshold);
  const seedTargetCount = Math.min(
    sortedByScore.length,
    Math.max(thresholdSeeds.length, minFrames)
  );
  const selected = new Map();
  const seedRows = sortedByScore.slice(0, Math.min(seedTargetCount, maxFrames));

  for (const row of seedRows) {
    if (selected.size >= maxFrames) {
      break;
    }

    selected.set(row.frameIndex, row);
  }

  for (let distance = 1; distance <= neighborRadius && selected.size < maxFrames; distance += 1) {
    for (const row of seedRows) {
      for (const offset of [-distance, distance]) {
        if (selected.size >= maxFrames) {
          break;
        }

        const neighbor = rowsByIndex.get(row.frameIndex + offset);
        if (neighbor && !selected.has(neighbor.frameIndex)) {
          selected.set(neighbor.frameIndex, neighbor);
        }
      }
    }
  }

  return [...selected.values()].sort((left, right) => left.frameIndex - right.frameIndex);
}

function inferDateKey(videoPath, explicitDateKey = '') {
  const normalizedExplicit = String(explicitDateKey || '').trim();
  if (/^20\d{6}$/.test(normalizedExplicit)) {
    return normalizedExplicit;
  }

  const fileName = path.basename(videoPath);
  const match = fileName.match(/(20\d{6})/);
  if (match) {
    return match[1];
  }

  const stats = fs.statSync(videoPath);
  const date = new Date(stats.mtimeMs);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function allocateOutputPath(outputRoot, outputKind, dateKey) {
  const targetDirectory = path.join(outputRoot, outputKind === 'snapshot' ? 'snapshots' : 'screenshots');
  fs.mkdirSync(targetDirectory, { recursive: true });

  if (outputKind === 'snapshot') {
    const baseStem = `revere_${dateKey}`;
    let candidatePath = path.join(targetDirectory, `${baseStem}.png`);
    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }

    let suffix = 2;
    while (true) {
      candidatePath = path.join(targetDirectory, `${baseStem}_${suffix}.png`);
      if (!fs.existsSync(candidatePath)) {
        return candidatePath;
      }
      suffix += 1;
    }
  }

  const baseStem = `${dateKey}_ps`;
  let candidatePath = path.join(targetDirectory, `${baseStem}.png`);
  if (!fs.existsSync(candidatePath)) {
    return candidatePath;
  }

  let suffix = 2;
  while (true) {
    candidatePath = path.join(targetDirectory, `${baseStem}_${suffix}.png`);
    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }
    suffix += 1;
  }
}

module.exports = {
  analyzeFrameBeforeOcr,
  allocateOutputPath,
  chooseBestCandidate,
  chooseBestWindow,
  groupContiguousCandidates,
  inferDateKey,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreWhiteboardCandidate,
  selectFramesForOcr,
  summarizeLumaBuffer,
  splitIssueCodes
};