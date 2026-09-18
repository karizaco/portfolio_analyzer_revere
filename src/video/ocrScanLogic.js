const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { PREFILTER_PROFILE_DEFAULT } = require('../config/schema');

const PREFILTER_WIDTH = 160;
const PREFILTER_HEIGHT = 90;

// Pure helper: extract a date the OCR engine read off the whiteboard so the
// scan log can record the *content* date separately from the filename/mtime
// date. Two patterns cover the corpus seen so far:
//   1. Long form  "THURSDAY, SEPTEMBER 8, 2026"  (DMI intro / agenda line)
//   2. Short form "TUE, 11/15/22"                (TALE OF THE TAPE header)
// Returns YYYYMMDD matching inferDateKey()'s shape, or null if nothing
// matched. Two-digit years are interpreted as 2000+YY when < 70 else 1900+YY
// (defensive — historical videos in this corpus are 2022-2026).
function extractObservedDate(ocrText) {
  if (!ocrText) {
    return null;
  }

  const longFormPattern = new RegExp(
    '\\b(?:MON(?:DAY)?|TUE(?:S)?(?:DAY)?|WED(?:NES)?(?:DAY)?|THU(?:R(?:S)?)?(?:DAY)?|FRI(?:DAY)?|SAT(?:UR)?(?:DAY)?|SUN(?:DAY)?)\\s*,?\\s+'
    + '(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|'
    + 'AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\\s+'
    + '(\\d{1,2}),?\\s+(\\d{4})\\b',
    'i'
  );

  const longMatch = ocrText.match(longFormPattern);
  if (longMatch) {
    const day = Number(longMatch[2]);
    const year = Number(longMatch[3]);
    const monthName = longMatch[1].slice(0, 3).toUpperCase();
    const monthIndex = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
      .indexOf(monthName);
    if (monthIndex >= 0) {
      return formatDateKey(year, monthIndex + 1, day);
    }
  }

  const shortFormPattern = new RegExp(
    '\\b(?:MON|TUE|WED(?:NES)?|THUR(?:S)?|FRI|SAT(?:UR)?|SUN),?\\s+'
    + '(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})\\b',
    'i'
  );

  const shortMatch = ocrText.match(shortFormPattern);
  if (shortMatch) {
    const month = Number(shortMatch[1]);
    const day = Number(shortMatch[2]);
    const rawYear = Number(shortMatch[3]);
    const year = rawYear < 100 ? (rawYear < 70 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    return formatDateKey(year, month, day);
  }

  return null;
}

function formatDateKey(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

// Shared helper: turn a numeric timestamp (seconds) into HH:MM:SS so the probe
// log and the aggregator stay aligned. Lives next to formatDateKey because it
// is the time-axis sibling of the date-key helper.
function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00:00';
  }
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(remainder)}`;
}

// Pure helper: detect the "WHAT'S THE MARKET TREND?" intro card so it can be
// tagged on the capture without changing detectScreenLayout's classification
// rules. The intro card always contains the title + GROTECTION gauge legend
// and never contains the BULL CASE / HEADWINDS / BOTTOM LINE: blocks that
// appear on real Daily Market Insight / Tale of the Tape slides. We accept
// the OCR-dropped apostrophe ("WHATS THE MARKET TREND") as well.
function detectIntroCard(ocrText) {
  if (!ocrText) {
    return false;
  }

  const upper = String(ocrText).toUpperCase();

  const hasTitle = upper.includes("WHAT'S THE MARKET TREND") || upper.includes('WHATS THE MARKET TREND');
  if (!hasTitle) {
    return false;
  }

  const realSlideNegatives = ['BULL CASE', 'BOTTOM LINE:', 'HEADWINDS', 'PORTFOLIO/RVAB:'];
  for (const negative of realSlideNegatives) {
    if (upper.includes(negative)) {
      return false;
    }
  }

  const introMarkers = ['THE GROTECTION GAUGE', 'CHARTS: OF INTEREST'];
  for (const marker of introMarkers) {
    if (upper.includes(marker)) {
      return true;
    }
  }

  return false;
}

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

// Canonical whiteboard scorer. Returns { total, components } so callers can
// see exactly which bucket pushed a frame over (or below) the threshold.
// Existing callers that only need the total should use scoreWhiteboardCandidate.
function scoreWhiteboardCandidateBreakdown(observationRows, ocrConfidence, ocrResult = null, options = {}) {
  const rows = Array.isArray(observationRows) ? observationRows : [];
  const groRow = rows.find((row) => row.portfolio === 'GRO') || null;
  const turboRow = rows.find((row) => row.portfolio === 'TURBO') || null;
  const prefilterProfile = String(options.prefilterProfile || PREFILTER_PROFILE_DEFAULT);
  const components = {
    chart_likeness: 0,
    keyword_guard: 0,
    ocr_confidence_bonus: 0,
    pair_bonus: 0,
    per_row_issues: 0,
    per_row_metrics: 0,
    text_density: 0
  };

  for (const row of rows) {
    let perRow = 0;
    if (row.metrics_raw) {
      perRow += 6;
    }

    if (row.metric_scalar) {
      perRow += 1;
    }

    if (row.metric_1) {
      perRow += 2;
    }

    if (row.metric_2) {
      perRow += 2;
    }

    if (row.action_text) {
      perRow += 1;
    }

    if (row.bottom_line) {
      perRow += 2;
    }

    components.per_row_metrics += perRow;
    components.per_row_issues -= splitIssueCodes(row.issue_codes).length * 2;
  }

  if (groRow && groRow.metrics_raw && turboRow && turboRow.metrics_raw) {
    components.pair_bonus = 4;
  }

  // Reward text-heavy OCR output even when the parser couldn't extract a
  // structured portfolio summary. Dominant signal for DAILY MARKET INSIGHT /
  // TALE OF THE TAPE style slides that don't have GRO HOLDINGS / TURBO RVAB.
  components.text_density = scoreTextDensity(ocrResult);

  // Defense-in-depth: chart-likeness penalty at the OCR-scoring stage too.
  if (ocrResult && ocrResult.stats) {
    components.chart_likeness = scoreChartLikeness(ocrResult.stats);
  }

  // Strong negative: text but ZERO whiteboard keywords = browser chrome +
  // chart labels. Without this guard, browser chrome alone produces enough
  // line/char density to mis-classify chart pages as tale_of_the_tape.
  // Chart-stream profile deliberately disables this guard: chart streams have
  // no DMI/ToTT keyword content (their value is in the position-list overlay
  // + pHash region-crop). Rely on chart-likeness + parseChartStream for the
  // signal instead.
  if (ocrResult && ocrResult.text && prefilterProfile === 'whiteboard') {
    const keywordHits = countKeywordHits(ocrResult.text);
    if (keywordHits === 0) {
      components.keyword_guard = -18;
    }
  }

  components.ocr_confidence_bonus = Number(ocrConfidence || 0) / 20;

  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { components, total: Number(total.toFixed(2)) };
}

// Backwards-compatible thin wrapper: returns just the numeric total so the
// existing call sites and tests (e.g. assert.ok(scoreWhiteboardCandidate(...) >= 20))
// keep working without modification. Accepts the same options bag as the
// breakdown form so chart-stream callers can pass { prefilterProfile }.
function scoreWhiteboardCandidate(observationRows, ocrConfidence, ocrResult = null, options = {}) {
  return scoreWhiteboardCandidateBreakdown(observationRows, ocrConfidence, ocrResult, options).total;
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

function scoreFramePrefilter(stats, outputKind, profile = 'whiteboard') {
  const table = PREFILTER_PROFILES[profile] || PREFILTER_PROFILES.whiteboard;
  let score = 0;

  score += Math.max(0, table.brightWeight - (Math.abs(stats.brightRatio - table.brightTarget) * table.brightSlope));
  score += Math.max(0, table.darkWeight - (Math.abs(stats.darkRatio - table.darkTarget) * table.darkSlope));
  score += Math.max(0, table.edgeWeight - (Math.abs(stats.edgeRatio - table.edgeTarget) * table.edgeSlope));
  score += Math.max(0, table.stdDevWeight - (Math.abs(stats.stdDev - table.stdDevTarget) / table.stdDevSlope));

  if (stats.meanLuma < table.meanLumaFloor) {
    score -= table.meanLumaPenalty;
  }

  if (stats.brightRatio < table.brightRatioFloor) {
    score -= table.brightRatioPenalty;
  }

  if (stats.darkRatio < table.darkRatioFloor) {
    score -= table.darkRatioFloorPenalty;
  }

  if (stats.darkRatio > table.darkRatioCeil) {
    score -= table.darkRatioCeilPenalty;
  }

  if (outputKind === 'snapshot') {
    score += Math.min(stats.edgeRatio * table.snapshotEdgeBoost, table.snapshotEdgeBoostCap);
  }

  // Defense-in-depth chart rejection: subtract a small chart-likeness
  // penalty so obvious candlestick frames fall below prefilterThreshold and
  // never reach OCR. Text-like frames receive a small boost. The penalty
  // is intentionally gentle (multiplier 1, not 5) because dense text
  // (Daily Market Insight pages) and tabular layouts (Tale of the Tape)
  // produce vertical-edge patterns that look chart-like but are NOT charts —
  // the keyword and chart penalties in scoreWhiteboardCandidate handle the
  // rest at the OCR stage.
  // Chart-stream profile inverts this: chart-likeness is a POSITIVE signal
  // because the content we want to OCR IS a candlestick frame. Boost instead
  // of penalize, but keep it bounded so wildly off-profile frames still drop.
  if (table.chartLikenessBoost > 0) {
    score += scoreChartLikeness(stats) * (table.chartLikenessBoost / 6);
  } else {
    score += scoreChartLikeness(stats);
  }

  return Number(score.toFixed(2));
}

// Prefilter score profiles. Each profile is a flat table of weights
// (positive contribution when the stat lands near its target), slopes
// (how fast the contribution falls off with distance), and floor/ceiling
// penalties. The whiteboard profile matches the original constants — every
// row mirrors the literal numbers that used to be hard-coded inside
// scoreFramePrefilter. The chart_stream profile inverts the bright/dark
// distribution (chart frames are dark on average), drops the meanLuma floor
// so a candlestick chart with mean luma ~70 still scores, and turns
// chart-likeness into a positive boost so the prefilter stops rejecting the
// very frames we want to OCR. prefilterThresholdDefault is the floor below
// which selectFramesForOcr considers the OCR budget "weak signal" — callers
// that drive scanVideoWithOcr use it to set minScore dynamically.
const PREFILTER_PROFILES = Object.freeze({
  whiteboard: Object.freeze({
    brightWeight: 12,
    brightTarget: 0.72,
    brightSlope: 24,
    darkWeight: 8,
    darkTarget: 0.08,
    darkSlope: 90,
    edgeWeight: 8,
    edgeTarget: 0.09,
    edgeSlope: 110,
    stdDevWeight: 6,
    stdDevTarget: 60,
    stdDevSlope: 10,
    meanLumaFloor: 140,
    meanLumaPenalty: 8,
    brightRatioFloor: 0.30,
    brightRatioPenalty: 12,
    darkRatioFloor: 0.01,
    darkRatioFloorPenalty: 4,
    darkRatioCeil: 0.35,
    darkRatioCeilPenalty: 8,
    snapshotEdgeBoost: 25,
    snapshotEdgeBoostCap: 2,
    chartLikenessBoost: -6,
    prefilterThresholdDefault: 14
  }),
  chart_stream: Object.freeze({
    // Chart frames: ~4% bright (axis labels, tickers in overlay), ~55% dark
    // (chart body + dark UI chrome), ~0.10 edge ratio, stdDev ~55.
    brightWeight: 12,
    brightTarget: 0.04,
    brightSlope: 30,
    darkWeight: 8,
    darkTarget: 0.55,
    darkSlope: 20,
    edgeWeight: 8,
    edgeTarget: 0.10,
    edgeSlope: 100,
    stdDevWeight: 6,
    stdDevTarget: 55,
    stdDevSlope: 12,
    // Loosen the meanLuma gate: chart frames have mean luma 50–90 (dark UI
    // chrome dominates). Whiteboard threshold was 140.
    meanLumaFloor: 60,
    meanLumaPenalty: 6,
    // Don't reject for low brightRatio (we WANT dark frames) or for moderate
    // darkRatio (chart bodies are mostly dark).
    brightRatioFloor: 0.005,
    brightRatioPenalty: 6,
    darkRatioFloor: 0.20,
    darkRatioFloorPenalty: 4,
    darkRatioCeil: 0.92,
    darkRatioCeilPenalty: 6,
    snapshotEdgeBoost: 25,
    snapshotEdgeBoostCap: 2,
    // Positive boost: chart-likeness is GOOD. Score 0–6 instead of -6 to 0.
    chartLikenessBoost: 8,
    prefilterThresholdDefault: 8
  })
});

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
  // When the highest-scoring frame is below the configured minScore (common
  // for videos whose brightest scene is a low-contrast DAILY MARKET INSIGHT
  // slide), the dynamic threshold must drop with the best score rather than
  // staying clamped at minScore. Otherwise every frame falls below the cutoff
  // and dense-text trade-line slides get filtered out before OCR ever runs.
  // Floor the relaxed threshold at 60 % of minScore so we never go below a
  // sane minimum (e.g. completely black frames still get rejected).
  const bestScore = sortedByScore[0].prefilterScore;
  const relaxedFloor = minScore * 0.6;
  const dynamicThreshold = bestScore >= minScore
    ? Math.max(minScore, bestScore - 2)
    : Math.max(relaxedFloor, bestScore - 3);
  const thresholdRelaxed = bestScore < minScore;
  const thresholdSeeds = sortedByScore.filter((row) => row.prefilterScore >= dynamicThreshold);
  // Reserve a portion of the OCR budget for timeline-wide uniform sampling so
  // a long dense-text window that scores below the dynamic threshold still
  // gets OCR coverage. The remaining budget goes to the top-scoring seeds.
  // Without this carve-out, high-luma chart frames at the start of the video
  // can eat the entire OCR budget before the uniform-sampling backstop runs.
  // Densify the uniform sample when the threshold had to be relaxed (the luma
  // signal is weak overall — dense-text trade-line slides are short and need
  // tighter stride to be caught at all) OR when the video is short enough that
  // a 12-frame stride would be wider than ~20 s (a typical slide duration).
  let uniformReserve = 0;
  if (uniformSampleCount > 0) {
    const baseline = Math.max(uniformSampleCount, Math.floor(maxFrames * 0.25));
    // Compute how many uniform slots are needed to keep each stride under
    // ~10 s of video. Trade-line slides are typically visible for 30-90 s
    // so a stride wider than ~20 s risks missing them entirely.
    let strideBasedReserve = baseline;
    if (prefilterRows.length > 0) {
      const sample = prefilterRows[Math.min(1, prefilterRows.length - 1)];
      const secondsPerStep = sample.frameIndex > 0
        ? sample.timestamp / sample.frameIndex
        : 4;
      const secondsPerStrideAtBaseline = (prefilterRows.length / baseline) * secondsPerStep;
      if (secondsPerStrideAtBaseline > 10) {
        strideBasedReserve = Math.ceil(prefilterRows.length / Math.max(1, Math.floor(10 / secondsPerStep)));
      }
    }
    if (thresholdRelaxed) {
      // When the luma signal is weak across the whole video (best prefilter
      // score < minScore), dense-text slides are likely missed by the seed
      // branch. Combine the doubled-baseline heuristic with the stride-based
      // heuristic and take the larger of the two.
      uniformReserve = Math.min(maxFrames, Math.max(baseline * 2, strideBasedReserve));
    } else {
      uniformReserve = Math.min(maxFrames, strideBasedReserve);
    }
  }
  const seedBudget = Math.max(0, maxFrames - uniformReserve);
  const seedTargetCount = Math.min(
    sortedByScore.length,
    Math.max(Math.min(thresholdSeeds.length, seedBudget), Math.max(0, minFrames - uniformReserve))
  );
  const selected = new Map();
  const seedRows = sortedByScore.slice(0, Math.min(seedTargetCount, seedBudget));

  for (const row of seedRows) {
    selected.set(row.frameIndex, row);
  }

  for (let distance = 1; distance <= neighborRadius && selected.size < seedBudget; distance += 1) {
    for (const row of seedRows) {
      for (const offset of [-distance, distance]) {
        if (selected.size >= seedBudget) {
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
  // The uniform sample is budgeted BEFORE the seed loop so it cannot be
  // starved by an early burst of high-scoring chart frames.
  if (uniformReserve > 0) {
    const totalRows = prefilterRows.length;
    const stride = Math.max(1, Math.floor(totalRows / uniformReserve));
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

function allocateOutputPath(outputRoot, outputKind, dateKey, suffix = null, basename = 'revere') {
  const safeBasename = String(basename || 'revere').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'revere';
  const targetDirectory = path.join(outputRoot, outputKind === 'snapshot' ? 'snapshots' : 'screenshots');
  fs.mkdirSync(targetDirectory, { recursive: true });

  if (outputKind === 'snapshot') {
    const baseStem = `${safeBasename}_${dateKey}`;
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
  PREFILTER_PROFILES,
  TEXT_DENSITY_KEYWORDS,
  allocateOutputPath,
  analyzeFrameBeforeOcr,
  chooseBestCandidate,
  chooseBestWindow,
  countKeywordHits,
  detectIntroCard,
  extractObservedDate,
  formatDuration,
  groupContiguousCandidates,
  inferDateKey,
  scoreChartLikeness,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreTextDensity,
  scoreWhiteboardCandidate,
  scoreWhiteboardCandidateBreakdown,
  selectFramesForOcr,
  splitIssueCodes,
  summarizeLumaBuffer
};
