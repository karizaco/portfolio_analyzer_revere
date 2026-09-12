const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const PREFILTER_WIDTH = 160;
const PREFILTER_HEIGHT = 90;

// Tokens whose presence in OCR text is a strong positive signal that a frame
// is a "text-heavy screen" (Daily Market Insight, Tale of the Tape, etc.)
// rather than a stock-chart frame. Intentionally restricted to content-
// specific phrases: sidebar-shared terms like GROTECTION, MAG7, RAI100,
// 21/21, and HOLDINGS also appear on individual stock chart pages (the
// Revere website sidebar), so counting them as positive signals would let
// stock-chart pages through the keyword guard.
const TEXT_DENSITY_KEYWORDS = Object.freeze([
  'DAILY MARKET INSIGHT',
  'TALE OF THE TAPE',
  'MARKET STATE',
  'WHAT HAPPENED TODAY',
  'BOTTOM LINE'
]);

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

function scoreWhiteboardCandidate(observationRows, ocrConfidence, ocrResult = null) {
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

  // New: reward text-heavy OCR output even when the parser couldn't extract
  // a structured portfolio summary. This is the dominant signal that lets
  // DAILY MARKET INSIGHT / TALE OF THE TAPE style slides clear the threshold
  // even though they don't have a GRO HOLDINGS / TURBO RVAB layout.
  score += scoreTextDensity(ocrResult);

  // Defense-in-depth: also penalize chart-likeness at the OCR-scoring stage,
  // even if the prefilter missed it. Uses the same stats as the prefilter.
  if (ocrResult && ocrResult.stats) {
    score += scoreChartLikeness(ocrResult.stats);
  }

  // Strong negative signal: a frame with text but ZERO whiteboard-specific
  // keywords is almost certainly a stock-chart screenshot wrapped in browser
  // chrome (Safari File Edit View History Bookmarks Window Help + chart
  // labels). Without this guard, browser chrome alone produces enough
  // line/char density to mis-classify chart pages as tale_of_the_tape.
  if (ocrResult && ocrResult.text) {
    const keywordHits = countKeywordHits(ocrResult.text);
    if (keywordHits === 0) {
      score -= 18;
    }
  }

  score += Number(ocrConfidence || 0) / 20;
  return Number(score.toFixed(2));
}

function countKeywordHits(text) {
  const upper = String(text || '').toUpperCase();
  let keywordHits = 0;
  for (const token of TEXT_DENSITY_KEYWORDS) {
    if (upper.includes(token)) {
      keywordHits += 1;
    }
  }
  return keywordHits;
}

// Pure helper: given an OCR result { text, lines }, score how "text-heavy"
// the frame is. Daily Market Insight pages yield ~20 OCR lines / 400 chars
// and 3+ keyword hits; stock-chart pages yield ~4 lines / 100 chars and 0
// hits. The delta between the two is the discriminator the previous scoring
// formula was missing.
function scoreTextDensity(ocrResult) {
  if (!ocrResult) {
    return 0;
  }

  const text = String(ocrResult.text || '');
  const lines = Array.isArray(ocrResult.lines) ? ocrResult.lines.length : 0;
  const compactText = text.replace(/\s+/g, '');
  const charCount = compactText.length;
  const keywordHits = countKeywordHits(text);

  const lineScore = lines * 1.5;
  const charScore = charCount / 50;
  const keywordScore = keywordHits * 4;
  const base = lineScore + charScore + keywordScore;

  // Without any TEXT_DENSITY_KEYWORDS hit, the line/char signal is just
  // browser chrome + chart-label noise. A stock-chart screenshot wrapped in
  // Google Chrome yields ~30 OCR lines / ~2300 chars → score 90, which
  // would otherwise swamp the keyword and chart penalties downstream.
  // Cap at 8 so non-whiteboard OCR cannot dominate.
  if (keywordHits === 0) {
    return Number(Math.min(base, 8).toFixed(2));
  }
  return Number(base.toFixed(2));
}

// Pure helper: given prefilter stats, return a positive bonus for text-like
// frames and a negative penalty for chart-like frames. Charts have roughly
// equal horizontal and vertical edge ratios (candles + oscillator + grid
// lines); text on a white background has mostly horizontal edges (text rows)
// and far fewer vertical edges.
function scoreChartLikeness(stats) {
  if (!stats) {
    return 0;
  }

  const horizontal = Number(stats.horizontalEdgeRatio || 0);
  const vertical = Number(stats.verticalEdgeRatio || 0);
  const totalEdgeDensity = horizontal + vertical;

  // Without enough edge activity to discriminate, return 0 (uniform scenes
  // are neither text nor chart).
  if (totalEdgeDensity < 0.05) {
    return 0;
  }

  const ratio = vertical / (horizontal + 0.01);

  if (ratio > 1.2) {
    // Chart-like: penalize, capped at -6.
    return -Math.min((ratio - 1.2) * 8, 6);
  }
  if (ratio < 0.7) {
    // Text-like: small positive bonus, capped at +2.
    return Math.min((0.7 - ratio) * 4, 2);
  }
  return 0;
}

function summarizeLumaBuffer(buffer, width, height) {
  let total = 0;
  let totalSquares = 0;
  let brightPixels = 0;
  let darkPixels = 0;
  let horizontalEdgeHits = 0;
  let verticalEdgeHits = 0;
  let horizontalComparisons = 0;
  let verticalComparisons = 0;

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
        horizontalEdgeHits += 1;
      }

      if (Math.abs(current - below) >= 24) {
        verticalEdgeHits += 1;
      }

      horizontalComparisons += 1;
      verticalComparisons += 1;
    }
  }

  const pixelCount = Math.max(buffer.length, 1);
  const meanLuma = total / pixelCount;
  const variance = Math.max((totalSquares / pixelCount) - (meanLuma * meanLuma), 0);

  const totalEdgeHits = horizontalEdgeHits + verticalEdgeHits;
  const totalComparisons = horizontalComparisons + verticalComparisons;

  return {
    brightRatio: brightPixels / pixelCount,
    darkRatio: darkPixels / pixelCount,
    edgeRatio: totalComparisons > 0 ? totalEdgeHits / totalComparisons : 0,
    horizontalComparisons,
    horizontalEdgeHits,
    horizontalEdgeRatio: horizontalComparisons > 0 ? horizontalEdgeHits / horizontalComparisons : 0,
    meanLuma,
    stdDev: Math.sqrt(variance),
    verticalComparisons,
    verticalEdgeHits,
    verticalEdgeRatio: verticalComparisons > 0 ? verticalEdgeHits / verticalComparisons : 0
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

  if (stats.meanLuma < 140) {
    score -= 8;
  }

  if (stats.brightRatio < 0.30) {
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

  // Defense-in-depth chart rejection: subtract a small chart-likeness
  // penalty so obvious candlestick frames fall below prefilterThreshold and
  // never reach OCR. Text-like frames receive a small boost. The penalty
  // is intentionally gentle (multiplier 1, not 5) because dense text
  // (Daily Market Insight pages) and tabular layouts (Tale of the Tape)
  // produce vertical-edge patterns that look chart-like but are NOT charts —
  // the keyword and chart penalties in scoreWhiteboardCandidate handle the
  // rest at the OCR stage.
  score += scoreChartLikeness(stats);

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
    neighborRadius = 1,
    uniformSampleCount = 12
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

  // Defense in depth for short-duration whiteboard screens: also pick
  // uniformly-spaced frames across the whole timeline so a 4-second DMI
  // window that fell between the top-scoring clusters still gets sampled.
  // Without this, the top-scoring frames tend to cluster around the highest-
  // luma chart transitions, missing dense-text slides that score lower on
  // luma alone but high on text density once OCR runs.
  if (uniformSampleCount > 0 && selected.size < maxFrames) {
    const totalRows = prefilterRows.length;
    const stride = Math.max(1, Math.floor(totalRows / uniformSampleCount));
    for (let offset = 0; offset < totalRows && selected.size < maxFrames; offset += stride) {
      const row = prefilterRows[offset];
      if (!selected.has(row.frameIndex)) {
        selected.set(row.frameIndex, row);
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

function allocateOutputPath(outputRoot, outputKind, dateKey, suffix = null) {
  const targetDirectory = path.join(outputRoot, outputKind === 'snapshot' ? 'snapshots' : 'screenshots');
  fs.mkdirSync(targetDirectory, { recursive: true });

  if (outputKind === 'snapshot') {
    const baseStem = `revere_${dateKey}`;
    let candidatePath = path.join(targetDirectory, `${baseStem}.png`);
    if (!suffix && !fs.existsSync(candidatePath)) {
      return candidatePath;
    }

    let numericSuffix = Number.isFinite(suffix) ? suffix : 2;
    while (true) {
      candidatePath = path.join(targetDirectory, `${baseStem}_${numericSuffix}.png`);
      if (!fs.existsSync(candidatePath)) {
        return candidatePath;
      }
      numericSuffix += 1;
    }
  }

  const baseStem = `${dateKey}_ps`;
  let candidatePath = path.join(targetDirectory, `${baseStem}.png`);
  if (!suffix && !fs.existsSync(candidatePath)) {
    return candidatePath;
  }

  let numericSuffix = Number.isFinite(suffix) ? suffix : 2;
  while (true) {
    candidatePath = path.join(targetDirectory, `${baseStem}_${numericSuffix}.png`);
    if (!fs.existsSync(candidatePath)) {
      return candidatePath;
    }
    numericSuffix += 1;
  }
}

module.exports = {
  TEXT_DENSITY_KEYWORDS,
  allocateOutputPath,
  analyzeFrameBeforeOcr,
  chooseBestCandidate,
  chooseBestWindow,
  countKeywordHits,
  groupContiguousCandidates,
  inferDateKey,
  scoreChartLikeness,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreTextDensity,
  scoreWhiteboardCandidate,
  selectFramesForOcr,
  splitIssueCodes,
  summarizeLumaBuffer
};
