'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { closeWorker, ocrImage } = require('../src/ocr/ocrImage');
const { parseScreenshot } = require('../src/parse/parseScreenshot');
const {
  detectScreenLayout,
  parseWhiteboardScreenshot
} = require('../src/parse/parseWhiteboardScreenshot');
const {
  analyzeFrameBeforeOcr,
  allocateOutputPath,
  chooseBestCandidate,
  detectIntroCard,
  extractObservedDate,
  formatDuration,
  groupContiguousCandidates,
  inferDateKey,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreWhiteboardCandidateBreakdown,
  selectFramesForOcr,
  splitIssueCodes
} = require('../src/video/ocrScanLogic');
const { computePerceptualHash, hammingDistance } = require('../src/video/imageHash');
const { computePerceptualHashOfRegion, computePerceptualHashOfFractionalRegion } = require('../src/video/imageHashRegion');
const { extractTickersFromOcrText } = require('../src/normalize/tickerScan');
const { createProbeKey, parseArgs, printHelp } = require('../src/video/ocrScanArgs');
const { PREFILTER_PROFILE_DEFAULT } = require('../src/config/schema');
const { parseChartStreamPositionList, mergeMultiplePositionLists, clusterRawOcrTokens } = require('../src/parse/parseChartStream');
const { runEasyOcr, adaptToParserSchema } = require('../src/ocr/easyocrAdapter');
const { preprocessChartStreamToBuffer, preprocessChartStreamRawToBuffer } = require('../src/ocr/ocrImage');

const OCR_TEXT_SNIPPET_MAX_CHARS = 200;
const CAPTURE_MIN_FRAME_GAP = 10;

function sortCandidatesDescending(candidates) {
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
    });
}

// Pick the top-scoring candidates above `threshold`, skipping any that fall
// inside the same window as an already-picked candidate (within `minFrameGap`
// frame indices) OR whose overlay pHash is within `phashHammingMax` bits of
// an already-picked candidate. The latter deduplicates near-identical position
// lists across the stream (e.g. the same chart frame with the same overlay
// appearing 10 minutes apart with no meaningful change in tickers).
// Returns both the kept candidates and the top few that fell below `threshold`
// so reviewers can audit why a frame was rejected.
function pickTopDistinctCandidates(candidates, threshold, maxCaptures, minFrameGap = CAPTURE_MIN_FRAME_GAP, phashHammingMax = 6) {
  const strong = sortCandidatesDescending(candidates.filter((candidate) => candidate.score >= threshold));
  const picked = [];
  for (const candidate of strong) {
    if (picked.length >= maxCaptures) {
      break;
    }

    const tooClose = picked.some((other) => Math.abs(other.frameIndex - candidate.frameIndex) < minFrameGap);
    if (tooClose) {
      continue;
    }

    // pHash-overlay Hamming dedup: if this candidate's overlay hash is very
    // similar to an already-picked candidate, skip it — the position list
    // hasn't meaningfully changed.
    if (phashHammingMax > 0 && candidate.phashOverlay) {
      const tooSimilar = picked.some((other) => {
        if (!other.phashOverlay) return false;
        const dist = hammingDistance(candidate.phashOverlay, other.phashOverlay);
        return dist <= phashHammingMax;
      });
      if (tooSimilar) {
        continue;
      }
    }

    picked.push(candidate);
  }
  return {
    picked,
    rejected: sortCandidatesDescending(candidates.filter((candidate) => candidate.score < threshold)).slice(0, 8)
  };
}

function extractOcrTextSnippet(text, maxChars = OCR_TEXT_SNIPPET_MAX_CHARS) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3)}...`;
}

function collectIssueCodes(parsedRows) {
  const codes = new Set();
  if (!Array.isArray(parsedRows)) {
    return [];
  }
  for (const row of parsedRows) {
    for (const code of splitIssueCodes(row.issue_codes)) {
      codes.add(code);
    }
  }
  return [...codes];
}

function logProgress({ bestCandidate, outputKind, processedCount, startedAt, totalFrames }) {
  const percent = totalFrames > 0 ? ((processedCount / totalFrames) * 100).toFixed(1) : '0.0';
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const bestSummary = bestCandidate
    ? `best score ${bestCandidate.score.toFixed(2)} at ${formatDuration(bestCandidate.timestamp)} (ocr ${bestCandidate.ocrConfidence.toFixed(1)})`
    : 'no viable candidate yet';

  console.log(
    `[scan:${outputKind}] OCR ${processedCount}/${totalFrames} frames (${percent}%) after ${formatDuration(elapsedSeconds)}; ${bestSummary}`
  );
}

function resolveFfmpegBin(explicitValue) {
  if (explicitValue && explicitValue !== 'ffmpeg') {
    return explicitValue;
  }

  const localPath = process.env.PATH || '';
  if (localPath.toLowerCase().includes('ffmpeg')) {
    return 'ffmpeg';
  }

  const directCandidates = [
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe'
  ];
  for (const candidate of directCandidates) {
    try {
      require('node:fs').accessSync(candidate);
      return candidate;
    } catch {
    }
  }

  const wingetRoot = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    const vendorDirectories = require('node:fs').readdirSync(wingetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Gyan.FFmpeg'))
      .map((entry) => path.join(wingetRoot, entry.name));

    for (const vendorDirectory of vendorDirectories) {
      const nestedEntries = require('node:fs').readdirSync(vendorDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(vendorDirectory, entry.name, 'bin', 'ffmpeg.exe'));
      const match = nestedEntries.find((candidate) => require('node:fs').existsSync(candidate));
      if (match) {
        return match;
      }
    }
  } catch {
  }

  return explicitValue || 'ffmpeg';
}

// Sibling helper: locate ffprobe.exe in the same install as ffmpeg. Returns
// `null` (instead of throwing) when no candidate exists so callers can fall
// back to "keyframe lookup skipped" without aborting the scan.
function resolveFfprobeBin(explicitValue) {
  if (explicitValue && explicitValue !== 'ffprobe') {
    return explicitValue;
  }

  const localPath = process.env.PATH || '';
  if (localPath.toLowerCase().includes('ffmpeg') || localPath.toLowerCase().includes('ffprobe')) {
    return 'ffprobe';
  }

  const ffmpegBin = resolveFfmpegBin(null);
  if (ffmpegBin && ffmpegBin !== 'ffmpeg') {
    const sibling = path.join(path.dirname(ffmpegBin), 'ffprobe.exe');
    try {
      require('node:fs').accessSync(sibling);
      return sibling;
    } catch {
    }
  }

  const directCandidates = [
    'C:/ffmpeg/bin/ffprobe.exe',
    'C:/Program Files/ffmpeg/bin/ffprobe.exe'
  ];
  for (const candidate of directCandidates) {
    try {
      require('node:fs').accessSync(candidate);
      return candidate;
    } catch {
    }
  }

  return null;
}

// Run ffprobe once per video to harvest the list of keyframe PTS values,
// then find the nearest keyframe to each capture's timestamp. Returns
// `{ptsList, skipped}` so callers can flag the run as "no ffprobe available"
// rather than silently filling the field with `null` everywhere.
function collectKeyframeTimestamps(videoPath, ffprobeBin) {
  if (!ffprobeBin) {
    return { ptsList: [], skipped: true };
  }

  const command = [
    ffprobeBin,
    '-v', 'error',
    '-select_streams', 'v',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time',
    '-of', 'csv=p=0',
    videoPath
  ];

  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    console.log(`[scan] ffprobe failed (${result.error ? result.error.message : result.stderr || 'no stderr'}); skipping keyframe lookup`);
    return { ptsList: [], skipped: true };
  }

  const ptsList = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  return { ptsList, skipped: false };
}

function nearestKeyframe(ptsList, target) {
  if (!Array.isArray(ptsList) || !ptsList.length) {
    return null;
  }
  if (!Number.isFinite(target)) {
    return null;
  }

  let lo = 0;
  let hi = ptsList.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ptsList[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const candidate = ptsList[lo];
  const previous = lo > 0 ? ptsList[lo - 1] : candidate;
  return Math.abs(candidate - target) <= Math.abs(previous - target) ? candidate : previous;
}

function computeOcrEngineMetadata() {
  let tesseractVersion = 'unknown';
  try {
    tesseractVersion = require('tesseract.js/package.json').version;
  } catch {
  }

  return {
    tesseract_version: tesseractVersion,
    language: 'eng',
    dpi: 300,
    psm: null,
    preserve_interword_spaces: '1',
    deskew: false
  };
}

async function ensureDirectoryExists(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

function buildIsoDate(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function buildFrameMetadata(framePath, dateKey, frameIndex) {
  return {
    asOfDate: buildIsoDate(dateKey),
    fileName: path.basename(framePath),
    sequence: frameIndex + 1
  };
}

function buildFrameTimestamp(frameIndex, fps) {
  return Number((frameIndex / fps).toFixed(3));
}

function buildScaleFilter(width) {
  return `scale=${Math.max(2, Math.trunc(width))}:-2`;
}

function extractSampleFrames(videoPath, frameDirectory, ffmpegBin, fps, sampleWidth) {
  const command = [
    resolveFfmpegBin(ffmpegBin),
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${fps},${buildScaleFilter(sampleWidth)}`,
    path.join(frameDirectory, 'frame_%06d.png')
  ];

  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: 'pipe'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'ffmpeg frame extraction failed.');
  }
}

async function listFramePaths(frameDirectory) {
  const entries = await fs.readdir(frameDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(frameDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function summarizeTopCandidates(candidates, outputKind, limit) {
  return sortCandidatesDescending(candidates)
    .slice(0, limit)
    .map((candidate) => summarizeCandidate(candidate, outputKind));
}

// Find the candidates whose frame index is within `±radius` of `targetIndex`
// in the same scan run. Used by summarizeCapture to surface "near-miss"
// candidates alongside each saved capture so reviewers can tell whether a
// strong-but-too-close candidate was suppressed by the dedup window or by the
// score thresholds.
function findAdjacentCandidates(allCandidates, targetIndex, radius) {
  const safeRadius = Math.max(0, Number(radius) || 0);
  if (!Array.isArray(allCandidates) || !allCandidates.length || safeRadius === 0) {
    return [];
  }

  return sortCandidatesDescending(allCandidates.filter(
    (candidate) => Math.abs(candidate.frameIndex - targetIndex) <= safeRadius
    && candidate.frameIndex !== targetIndex
  )).map((candidate) => ({
    frame_index: candidate.frameIndex,
    timestamp: candidate.timestamp,
    prefilter_score: candidate.prefilterScore == null ? null : Number(Number(candidate.prefilterScore).toFixed(2)),
    score: candidate.score,
    score_breakdown: candidate.scoreBreakdown || null,
    screen_layout: candidate.screenLayout || 'unknown'
  }));
}

async function writeScanLog(logsDirectory, probeKey, payload) {
  const logPath = path.join(logsDirectory, `${probeKey}.json`);
  await fs.writeFile(logPath, JSON.stringify(payload, null, 2), 'utf8');
  return logPath;
}

async function safeDeleteFile(filePath) {
  await fs.rm(filePath, { force: true });
}

async function safeDeleteDirectory(directoryPath) {
  await fs.rm(directoryPath, { force: true, recursive: true });
}

function runFfmpegCommand(command, errorMessage) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: 'pipe'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || errorMessage);
  }
}

function extractOcrFrame(videoPath, timestamp, outputPath, ffmpegBin, ocrFrameWidth) {
  const command = [
    resolveFfmpegBin(ffmpegBin),
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(timestamp),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    buildScaleFilter(ocrFrameWidth),
    outputPath
  ];

  runFfmpegCommand(command, 'ffmpeg OCR frame extraction failed.');
}

// Extract N frames within a window of a center timestamp. Returns the
// list of timestamps (seconds) for the extracted frames.
// Used for batch snapshots that are valid for multi-frame merge — all
// frames show the same position list state since they're within seconds
// of each other.
function extractBatchOcrFrames(videoPath, centerTimestamp, windowSeconds, count, ocrFrameDirectory, ffmpegBin, ocrFrameWidth, baseStem) {
  const ffmpegBinResolved = resolveFfmpegBin(ffmpegBin);
  const halfWindow = windowSeconds / 2;
  // Spread count frames evenly across [center - halfWindow, center + halfWindow]
  const timestamps = [];
  for (let i = 0; i < count; i++) {
    const t = centerTimestamp - halfWindow + (i * windowSeconds) / Math.max(1, count - 1);
    timestamps.push(t);
  }
  const extracted = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = path.join(ocrFrameDirectory, `${baseStem}_batch_t${ts.toFixed(2)}_i${i}.png`);
    const command = [
      ffmpegBinResolved, '-hide_banner', '-loglevel', 'error',
      '-ss', ts.toFixed(3),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', buildScaleFilter(ocrFrameWidth),
      outPath
    ];
    runFfmpegCommand(command, `ffmpeg batch frame extraction at t=${ts} failed.`);
    extracted.push({ timestamp: ts, framePath: outPath });
  }
  return extracted;
}

async function preflightOutputExtraction(videoPath, outputKind, logsDirectory, probeKey, ffmpegBin) {
  const extension = '.png';
  const preflightOutputPath = path.join(logsDirectory, `${probeKey}_preflight${extension}`);

  try {
    extractFinalFrame(videoPath, 0, preflightOutputPath, ffmpegBin);
  } catch (error) {
    throw new Error(`Final output preflight failed before OCR started: ${error.message}`);
  } finally {
    await safeDeleteFile(preflightOutputPath);
  }
}

function extractFinalFrame(videoPath, timestamp, outputPath, ffmpegBin) {
  const targetExtension = path.extname(outputPath).toLowerCase();
  const outputFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const command = [
    resolveFfmpegBin(ffmpegBin),
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(timestamp),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    outputFilter
  ];

  if (targetExtension === '.jpg' || targetExtension === '.jpeg') {
    command.push(
      '-pix_fmt',
      'yuvj420p',
      '-strict',
      'unofficial',
      '-q:v',
      '2'
    );
  }

  command.push(outputPath);

  runFfmpegCommand(command, 'ffmpeg final frame extraction failed.');
}

async function prefilterFrames({ fps, framePaths, outputKind, prefilterProfile, progressInterval, temporalDecay }) {
  const prefilterRows = [];
  let bestRow = null;
  const startedAt = Date.now();

  for (let index = 0; index < framePaths.length; index += 1) {
    const framePath = framePaths[index];
    const stats = await analyzeFrameBeforeOcr(framePath);
    const timestamp = buildFrameTimestamp(index, fps);
    // Attach timestamp onto stats so scoreFramePrefilter temporal boost
    // (which historically read stats.timestamp) cannot produce NaN.
    stats.timestamp = timestamp;
    const row = {
      frameIndex: index,
      framePath,
      prefilterScore: scoreFramePrefilter(stats, outputKind, prefilterProfile, temporalDecay, timestamp),
      stats,
      timestamp
    };
    prefilterRows.push(row);

    if (!bestRow || row.prefilterScore > bestRow.prefilterScore) {
      bestRow = row;
    }

    const processedCount = index + 1;
    if (processedCount === 1 || processedCount === framePaths.length || processedCount % progressInterval === 0) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const bestSummary = bestRow
        ? `best prefilter ${bestRow.prefilterScore.toFixed(2)} at ${formatDuration(bestRow.timestamp)}`
        : 'no prefilter candidate yet';
      console.log(
        `[scan:${outputKind}] prefilter ${processedCount}/${framePaths.length} frames after ${formatDuration(elapsedSeconds)}; ${bestSummary}`
      );
    }
  }

  return {
    bestRow,
    prefilterRows
  };
}

/**
 * Run chart-stream OCR at a specific scale and return the parsed result.
 * Returns { ocr, chartStream, tickerCount, ocrText }
 *
 * When ocrEngine === 'easyocr', uses the EasyOCR Python wrapper instead of
 * Tesseract. EasyOCR reads QMG position lists much more accurately (2026-09-29
 * test on 20220606: Tesseract 25% recall, EasyOCR ~95% recall) at the cost of
 * ~60s per frame vs ~1-2s for Tesseract. The crop+preprocessing is still
 * applied (we run Tesseract's sharp pipeline first, then feed EasyOCR the
 * cropped PNG) so the OCR input is the same as the Tesseract path.
 */
async function runChartStreamOcr(framePath, phashRegionFraction, scale, ocrEngine = 'tesseract', easyOcrOptions = {}) {
  // For EasyOCR we optionally crop from the ORIGINAL video (videoPath +
  // timestamp) instead of the 1280px-wide OCR-resolution frame. Cropping
  // from the downscaled frame loses detail — verified 2026-09-29 that
  // ffmpeg-crop from the original 1920px video produces clean EasyOCR
  // output (75% recall on 20220606) while cropping from the OCR-resolution
  // frame produces garbage (0% recall, captured text like "CD WEJ GNS").
  let ocr;
  if (ocrEngine === 'easyocr') {
    // EasyOCR works much better with ffmpeg's crop+scale than with sharp's
    // extract+resize+lanczos3 (verified 2026-09-29: 0% recall with sharp
    // vs 75% recall with ffmpeg on the same frame). Always use scale=5
    // (not the dual-scale 3/4 used for Tesseract) — EasyOCR is much slower
    // (~60s/frame) so we don't need to run it twice; the bigger image
    // produces cleaner OCR.
    const EASYOCR_SCALE = 5;
    const { x, y, w, h } = phashRegionFraction;
    const cropFilter = `crop=in_w*${w}:in_h*${h}:in_w*${x}:in_h*${y},scale=${Math.round(w * 1920 * EASYOCR_SCALE)}:-1`;
    const tmpPath = path.join(
      os.tmpdir(),
      `qmg_easyocr_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    );
    // Prefer cropping from the original 1920px video (much better OCR); fall
    // back to the OCR-resolution frame only if videoPath isn't threaded
    // through (e.g., legacy callers, unit tests).
    const { videoPath: srcVideo, timestamp: srcTs } = easyOcrOptions;
    const ffmpegArgs = srcVideo && Number.isFinite(srcTs)
      ? ['-ss', String(srcTs), '-i', srcVideo]
      : ['-i', framePath];
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(resolveFfmpegBin(null), [
        ...ffmpegArgs,
        '-frames:v', '1',
        '-vf', cropFilter,
        '-y', tmpPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg crop exit ${code}`)));
    });
    let easyResult;
    try {
      easyResult = await runEasyOcr(tmpPath);
    } finally {
      try { await fs.unlink(tmpPath); } catch (_) { /* ignore */ }
    }
    ocr = adaptToParserSchema(easyResult);
  } else {
    ocr = await ocrImage(framePath, {
      chartStream: true,
      overlayRegion: phashRegionFraction,
      overlayScale: scale,
    });
  }
  const chartStream = parseChartStreamPositionList({ ocr });
  const tickerCount = (chartStream && chartStream.position_list && chartStream.position_list.length)
    ? chartStream.position_list.length
    : 0;
  return { ocr, chartStream, tickerCount };
}

async function buildSnapshotCandidate(framePath, frameIndex, dateKey, fps, stats, prefilterScore, options = {}) {
  // Optional override timestamp (used for batch snapshots where frameIndex
  // doesn't correspond to the original sample-frame index).
  const explicitTimestamp = Number.isFinite(options.timestamp) ? options.timestamp : null;
  const {
    chartStreamParser = false,
    phashRegion = null,
    phashRegionFraction = null,
    ocrEngine = 'tesseract',
    videoPath = null,
  } = options;

  let ocr, chartStream, tickerSource;
  if (chartStreamParser) {
    // Dual-scale: run both 3x and 4x, pick the one with more tickers.
    // Tested 5x+6x on 2026-09-29 (more readable text) — produced different
    // captured frames and worse recall on 20220606 (12.5% vs 25%). The
    // OCR's frame selection is sensitive to scale; sticking with 3x+4x
    // until we understand the scoring interaction.
    const easyOcrOpts = { videoPath, timestamp: explicitTimestamp != null ? explicitTimestamp : stats.timestamp };
    // For EasyOCR: the OCR branch hardcodes scale=5 internally (EasyOCR is
    // slow enough that running it twice is wasteful). For Tesseract: dual-
    // scale 3x+4x and pick the one with more tickers (legacy behavior).
    let pick;
    if (ocrEngine === 'easyocr') {
      pick = await runChartStreamOcr(framePath, phashRegionFraction, 3, ocrEngine, easyOcrOpts);
    } else {
      const [r3, r4] = await Promise.all([
        runChartStreamOcr(framePath, phashRegionFraction, 3, ocrEngine, easyOcrOpts),
        runChartStreamOcr(framePath, phashRegionFraction, 4, ocrEngine, easyOcrOpts),
      ]);
      // Prefer by ticker count; tie-break by OCR confidence
      pick = r4.tickerCount > r3.tickerCount ? r4
        : r3.tickerCount > r4.tickerCount ? r3
        : (r4.ocr.confidence || 0) > (r3.ocr.confidence || 0) ? r4 : r3;
    }
    ocr = pick.ocr;
    chartStream = pick.chartStream;
    tickerSource = chartStream && chartStream.position_list ? chartStream.position_list : [];
  } else {
    ocr = await ocrImage(framePath);
    chartStream = null;
    tickerSource = [];
  }

  const parsed = chartStreamParser
    ? null
    : parseScreenshot({
      metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
      ocr
    });

  const [phash, phashOverlay, tickers] = await Promise.all([
    computePerceptualHash(framePath).catch(() => null),
    chartStreamParser ? computeRegionHash(framePath, phashRegion, phashRegionFraction) : Promise.resolve(null),
    Promise.resolve(
      chartStreamParser && tickerSource.length
        ? tickerSource
        : extractTickersFromOcrText(ocr.text)
    )
  ]);

  return {
    chartStream,
    frameIndex,
    framePath,
    isIntroCard: detectIntroCard(ocr.text),
    lowResFramePath: null,
    ocrConfidence: Number(parsed ? parsed.ocr_confidence : ocr.confidence || 0),
    ocrProfile: ocr.profileName,
    ocrText: ocr.text || '',
    ocrTextSnippet: extractOcrTextSnippet(ocr.text),
    parsed,
    parsedRows: null,
    phash,
    phashOverlay,
    phashRegion: phashOverlay ? phashRegion || phashRegionFraction || null : null,
    prefilterProfile: options.prefilterProfile,
    prefilterScore,
    score: parsed ? scoreSnapshotCandidate(parsed) : scoreChartStreamCandidate(chartStream, ocr.confidence),
    screenLayout: detectScreenLayout(ocr.text, ocr.lines),
    stats,
    tickers,
    timestamp: explicitTimestamp != null ? explicitTimestamp : buildFrameTimestamp(frameIndex, fps)
  };
}

// Resolve the region hash input into one hex string. Accepts either a
// pixel-region ({x,y,width,height}) or a fractional-region
// ({xFraction,yFraction,wFraction,hFraction}). Pixel regions go straight to
// computePerceptualHashOfRegion; fractional regions call the
// resolution-aware variant. Returns `null` when no region is configured or
// when sharp fails (mirrors computePerceptualHash's `.catch(() => null)`).
async function computeRegionHash(framePath, phashRegion, phashRegionFraction) {
  if (phashRegion && typeof phashRegion.x === 'number') {
    try {
      return await computePerceptualHashOfRegion(framePath, phashRegion);
    } catch (error) {
      console.log(`[scan] region pHash failed (${error.message}); skipping overlay hash`);
      return null;
    }
  }
  if (phashRegionFraction) {
    try {
      return await computePerceptualHashOfFractionalRegion(framePath, phashRegionFraction);
    } catch (error) {
      console.log(`[scan] region pHash failed (${error.message}); skipping overlay hash`);
      return null;
    }
  }
  return null;
}

// Score for the chart-stream parser. Mirrors scoreSnapshotCandidate's shape
// (parse_status + ticker list + price action + ocr_confidence bonus) but
// without the GRO/TURBO holdings fields. The signal is the size of the
// position list + the parse confidence + the OCR confidence bonus.
function scoreChartStreamCandidate(chartStream, ocrConfidence) {
  if (!chartStream) {
    return 0;
  }
  let score = Number(chartStream.confidence || 0) * 12;
  score += Array.isArray(chartStream.position_list) ? chartStream.position_list.length * 1.5 : 0;
  if (chartStream.price_action) {
    score += 2;
  }
  if (chartStream.parse_status === 'ok') {
    score += 4;
  }
  score -= Number(chartStream.tickers_rejected || 0) * 0.25;
  score += Number(ocrConfidence || 0) / 20;
  return Number(score.toFixed(2));
}

async function buildWhiteboardCandidate(framePath, frameIndex, dateKey, fps, stats, prefilterScore, options = {}) {
  const { prefilterProfile = PREFILTER_PROFILE_DEFAULT, phashRegion = null, phashRegionFraction = null } = options;
  const ocr = await ocrImage(framePath);
  const parsedRows = parseWhiteboardScreenshot({
    metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
    ocr
  });
  const scoring = scoreWhiteboardCandidateBreakdown(
    parsedRows,
    ocr.confidence,
    { ...ocr, stats },
    { prefilterProfile }
  );
  const [phash, phashOverlay, tickers] = await Promise.all([
    computePerceptualHash(framePath).catch(() => null),
    computeRegionHash(framePath, phashRegion, phashRegionFraction),
    Promise.resolve(extractTickersFromOcrText(ocr.text))
  ]);

  return {
    frameIndex,
    framePath,
    isIntroCard: detectIntroCard(ocr.text),
    lowResFramePath: null,
    observedDate: extractObservedDate(ocr.text),
    ocrConfidence: Number(ocr.confidence || 0),
    ocrProfile: ocr.profileName,
    ocrText: ocr.text || '',
    ocrTextSnippet: extractOcrTextSnippet(ocr.text),
    parsedRows,
    phash,
    phashOverlay,
    phashRegion: phashOverlay ? phashRegion || phashRegionFraction || null : null,
    prefilterScore,
    prefilterProfile,
    score: scoring.total,
    scoreBreakdown: scoring.components,
    screenLayout: detectScreenLayout(ocr.text, ocr.lines),
    stats,
    tickers,
    timestamp: explicitTimestamp != null ? explicitTimestamp : buildFrameTimestamp(frameIndex, fps)
  };
}

async function scanFrames({
  chartStreamParser = false,
  dateKey,
  ffmpegBin,
  fps,
  frameRows,
  keepFrames,
  ocrEngine = 'tesseract',
  ocrFrameDirectory,
  ocrFrameWidth,
  outputKind,
  phashRegion,
  phashRegionFraction,
  prefilterProfile,
  progressInterval,
  strongThreshold,
  topCandidates,
  videoPath
}) {
  const candidates = [];
  const frameErrors = [];
  let bestCandidate = null;
  const startedAt = Date.now();
  const buildCandidate = outputKind === 'snapshot' ? buildSnapshotCandidate : buildWhiteboardCandidate;
  const candidateOptions = {
    chartStreamParser,
    ocrEngine,
    phashRegion,
    phashRegionFraction,
    prefilterProfile,
    videoPath
  };

  // Skip OCR entirely for low-resolution source videos (360p/480p) — the
  // position-list overlay text is unreadable at those resolutions.
  const ffprobeBin = resolveFfprobeBin(null);
  if (ffprobeBin) {
    const ffprobeResult = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=height',
      '-of', 'csv=p=0',
      videoPath
    ], { encoding: 'utf8' });
    const sourceHeight = parseInt((ffprobeResult.stdout || '').trim(), 10);
    // Skip when ffprobe fails (NaN) or when height is below minimum.
    // When ffprobe succeeds and height < 720: warn and skip.
    // When ffprobe returns NaN: warn and skip (could not verify resolution).
    if (!Number.isNaN(sourceHeight) && sourceHeight < 720) {
      console.warn(`[scan:${outputKind}] Skipping ${videoPath}: source resolution ${sourceHeight}p < 720p minimum`);
      return { bestCandidate: null, candidates: [], frameErrors: [], topCandidates: [] };
    } else if (Number.isNaN(sourceHeight)) {
      console.warn(`[scan:${outputKind}] Skipping ${videoPath}: could not determine source resolution (ffprobe returned NaN)`);
      return { bestCandidate: null, candidates: [], frameErrors: [], topCandidates: [] };
    }
  }

  for (let index = 0; index < frameRows.length; index += 1) {
    const frameRow = frameRows[index];
    const ocrFramePath = path.join(
      ocrFrameDirectory,
      `ocr_${String(frameRow.frameIndex + 1).padStart(6, '0')}.png`
    );
    try {
      extractOcrFrame(videoPath, frameRow.timestamp, ocrFramePath, ffmpegBin, ocrFrameWidth);
      const candidate = await buildCandidate(
        ocrFramePath,
        frameRow.frameIndex,
        dateKey,
        fps,
        frameRow.stats,
        frameRow.prefilterScore,
        { ...candidateOptions, timestamp: frameRow.timestamp }
      );
      candidates.push(candidate);
      if (candidate.score >= strongThreshold) {
        if (!bestCandidate) {
          bestCandidate = candidate;
        } else {
          const existingIsBetter = bestCandidate.score > candidate.score
            || (bestCandidate.score === candidate.score && bestCandidate.ocrConfidence >= candidate.ocrConfidence);
          if (!existingIsBetter) {
            bestCandidate = candidate;
          }
        }
      } else if (!bestCandidate) {
        bestCandidate = candidate;
      }

      if (!keepFrames) {
        await safeDeleteFile(ocrFramePath);
      }
    } catch (error) {
      frameErrors.push({
        frame_index: frameRow.frameIndex,
        frame_path: ocrFramePath,
        message: error.message
      });
      console.log(`[scan:${outputKind}] frame ${index + 1}/${frameRows.length} failed: ${error.message}`);
      if (!keepFrames) {
        await safeDeleteFile(ocrFramePath);
      }
    }

    const processedCount = index + 1;
    if (processedCount === 1 || processedCount === frameRows.length || processedCount % progressInterval === 0) {
      logProgress({
        bestCandidate,
        outputKind,
        processedCount,
        startedAt,
        totalFrames: frameRows.length
      });
    }
  }

  if (!candidates.length && frameErrors.length) {
    throw new Error(`All OCR frame evaluations failed. First error: ${frameErrors[0].message}`);
  }

  return {
    bestCandidate,
    candidates,
    frameErrors,
    topCandidates: summarizeTopCandidates(candidates, outputKind, topCandidates)
  };
}

function parsedObservationSummary(row) {
  if (!row) {
    return null;
  }
  return {
    portfolio: row.portfolio || null,
    metrics_raw: row.metrics_raw || null,
    metric_1: row.metric_1 || null,
    metric_2: row.metric_2 || null,
    metric_scalar: Number.isFinite(row.metric_scalar) ? row.metric_scalar : null,
    action_text: row.action_text || null,
    bottom_line: row.bottom_line || null,
    parse_status: row.parse_status || 'unknown',
    issue_codes: splitIssueCodes(row.issue_codes),
    ocr_confidence: Number(row.ocr_confidence || 0),
    ocr_profile: row.ocr_profile || null
  };
}

function summarizeCandidate(candidate, outputKind, allCandidates = null, confusionRadius = 0) {
  if (!candidate) {
    return null;
  }

  const parsedRows = Array.isArray(candidate.parsedRows) ? candidate.parsedRows : [];
  const parsedObservations = parsedRows.length
    ? parsedRows.map(parsedObservationSummary)
    : candidate.parsed
      ? [parsedObservationSummary(candidate.parsed)]
      : [];
  const chartStreamSummary = candidate.chartStream
    ? {
        confidence: Number(candidate.chartStream.confidence || 0),
        parse_status: candidate.chartStream.parse_status || 'unknown',
        position_list: Array.isArray(candidate.chartStream.position_list) ? candidate.chartStream.position_list : [],
        price_action: candidate.chartStream.price_action || '',
        tickers_rejected: Number(candidate.chartStream.tickers_rejected || 0),
        // Diagnostics: surface the column-filter result and the actual rejected
        // tokens (capped at 30 to keep probe logs small). Both fields were
        // added to the parser output but require explicit propagation here.
        column_filter: candidate.chartStream.column_filter || null,
        tickers_rejected_list: Array.isArray(candidate.chartStream.tickers_rejected_list)
          ? candidate.chartStream.tickers_rejected_list
          : []
      }
    : null;

  const summary = {
    chart_stream: chartStreamSummary,
    confusion_with_nearby: allCandidates
      ? findAdjacentCandidates(allCandidates, candidate.frameIndex, confusionRadius)
      : [],
    frame_index: candidate.frameIndex,
    frame_path: candidate.framePath,
    is_intro_card: Boolean(candidate.isIntroCard),
    issue_codes: collectIssueCodes(parsedRows),
    low_res_frame_path: candidate.lowResFramePath || null,
    nearest_ffmpeg_keyframe_ts: Number.isFinite(candidate.nearestFfmpegKeyframeTs) ? candidate.nearestFfmpegKeyframeTs : null,
    observed_date: candidate.observedDate || null,
    ocr_confidence: candidate.ocrConfidence,
    ocr_profile: candidate.ocrProfile || '',
    ocr_text: candidate.ocrText || '',
    ocr_text_snippet: candidate.ocrTextSnippet || '',
    output_kind: outputKind,
    parsed_observations: parsedObservations,
    parsed_row_count: parsedRows.length || (candidate.parsed ? 1 : 0),
    phash: candidate.phash || null,
    phash_overlay: candidate.phashOverlay || null,
    phash_region: candidate.phashRegion || null,
    prefilter_profile: candidate.prefilterProfile || null,
    prefilter_score: candidate.prefilterScore == null ? null : Number(candidate.prefilterScore.toFixed(2)),
    prefilter_stats: candidate.stats || null,
    score: candidate.score,
    score_breakdown: candidate.scoreBreakdown || null,
    screen_layout: candidate.screenLayout || 'unknown',
    tickers: Array.isArray(candidate.tickers) ? candidate.tickers : [],
    timestamp: candidate.timestamp,
    timestamp_hms: formatDuration(candidate.timestamp)
  };

  return summary;
}

function summarizeCapture(candidate, outputKind, outputPath, allCandidates = null, confusionRadius = 0) {
  const summary = summarizeCandidate(candidate, outputKind, allCandidates, confusionRadius);
  if (!summary) {
    return null;
  }
  return { ...summary, output_path: outputPath };
}

// Group contiguous same-screen-layout captures into sessions so reviewers
// can answer "did video #3 have 1 DMI slide + 1 ToTT slide + 1 intro card?"
// without re-scanning the timeline. Two captures belong to the same segment
// when their frame indices are within 2× the deduplication window and they
// share a screen_layout. Segments that consist entirely of intro cards are
// flagged so downstream consumers can filter them out.
function buildWhiteboardSegments(captures) {
  if (!Array.isArray(captures) || !captures.length) {
    return [];
  }

  const sorted = captures
    .slice()
    .sort((left, right) => left.frame_index - right.frame_index);

  const contiguousWindow = CAPTURE_MIN_FRAME_GAP * 2;
  const segments = [];
  let current = null;

  for (const capture of sorted) {
    const layout = capture.screen_layout || 'unknown';
    if (!current || current.layout !== layout || (capture.frame_index - current.endFrameIndex) > contiguousWindow) {
      if (current) {
        segments.push(finalizeSegment(current));
      }
      current = {
        captureCount: 1,
        endFrameIndex: capture.frame_index,
        endTs: capture.timestamp,
        frameIndices: [capture.frame_index],
        introFlags: [Boolean(capture.is_intro_card)],
        layout,
        peakCapture: capture,
        peakScore: capture.score,
        scores: [capture.score],
        startFrameIndex: capture.frame_index,
        startTs: capture.timestamp
      };
      continue;
    }

    current.captureCount += 1;
    current.endFrameIndex = capture.frame_index;
    current.endTs = capture.timestamp;
    current.frameIndices.push(capture.frame_index);
    current.introFlags.push(Boolean(capture.is_intro_card));
    current.scores.push(capture.score);
    if (capture.score > current.peakScore) {
      current.peakScore = capture.score;
      current.peakCapture = capture;
    }
  }

  if (current) {
    segments.push(finalizeSegment(current));
  }

  return segments;
}

function finalizeSegment(segment) {
  return {
    capture_count: segment.captureCount,
    end_ts: segment.endTs,
    end_hms: formatDuration(segment.endTs),
    is_intro_card: segment.introFlags.every(Boolean),
    layout: segment.layout,
    peak_frame_index: segment.peakCapture.frame_index,
    peak_score: Number(segment.peakScore.toFixed(2)),
    start_hms: formatDuration(segment.startTs),
    start_ts: segment.startTs
  };
}

async function saveCapture({ basename = 'revere', candidate, outputRoot, outputKind, dateKey, videoPath, ffmpegBin, suffix }) {
  const explicitSuffix = Number.isFinite(suffix) ? suffix : null;
  const outputPath = allocateOutputPath(outputRoot, outputKind, dateKey, explicitSuffix, basename);
  extractFinalFrame(videoPath, candidate.timestamp, outputPath, ffmpegBin);
  return outputPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const videoPath = options.videoPath;
  const dateKey = inferDateKey(videoPath, options.dateKey);
  const baseOutputRoot = path.resolve(options.outputRoot);
  const outputRoot = options.runTag
    ? path.join(baseOutputRoot, options.runTag)
    : baseOutputRoot;
  const probeRoot = path.join(outputRoot, 'ocr_probe');
  const probeKey = createProbeKey(videoPath, dateKey, options.outputKind);
  const frameRoot = path.join(probeRoot, 'frames', probeKey);
  const frameDirectory = path.join(frameRoot, 'sample');
  const ocrFrameDirectory = path.join(frameRoot, 'ocr');
  const logsDirectory = path.join(probeRoot, 'logs');

  await safeDeleteDirectory(frameRoot);
  await ensureDirectoryExists(frameDirectory);
  await ensureDirectoryExists(ocrFrameDirectory);
  await ensureDirectoryExists(logsDirectory);

  const resultBase = {
    basename: options.basename,
    channel: options.basename === 'revere' ? 'revere' : options.basename,
    chart_stream_parser: Boolean(options.chartStreamParser),
    date_key: dateKey,
    output_kind: options.outputKind,
    phash_region: options.phashRegion || null,
    phash_region_fraction: options.phashRegionFraction || null,
    prefilter_profile: options.prefilterProfile,
    temporal_decay: options.temporalDecay,
    video_path: videoPath
  };

  const ocrEngineMetadata = computeOcrEngineMetadata();
  let keyframePtsList = [];
  let keyframeLookupSkipped = Boolean(options.skipKeyframes);
  if (!keyframeLookupSkipped) {
    const ffprobeBin = resolveFfprobeBin(null);
    if (ffprobeBin) {
      const { ptsList, skipped } = collectKeyframeTimestamps(videoPath, ffprobeBin);
      keyframePtsList = ptsList;
      keyframeLookupSkipped = skipped;
      if (!skipped) {
        console.log(`[scan:${options.outputKind}] ffprobe found ${ptsList.length} keyframe(s) for nearest-keyframe lookup`);
      }
    } else {
      keyframeLookupSkipped = true;
      console.log(`[scan:${options.outputKind}] skipping keyframe lookup (no ffprobe)`);
    }
  } else {
    console.log(`[scan:${options.outputKind}] skipping keyframe lookup (--skip-keyframes)`);
  }

  try {
    console.log(`[scan:${options.outputKind}] preflighting final ${options.outputKind} output extraction`);
    await preflightOutputExtraction(videoPath, options.outputKind, logsDirectory, probeKey, options.ffmpegBin);
    console.log(`[scan:${options.outputKind}] extracting sample frames from ${videoPath}`);
    extractSampleFrames(videoPath, frameDirectory, options.ffmpegBin, options.fps, options.sampleWidth);
    const framePaths = await listFramePaths(frameDirectory);
    if (!framePaths.length) {
      throw new Error('No sample frames were generated from the video.');
    }

    console.log(
      `[scan:${options.outputKind}] extracted ${framePaths.length} frame(s) at ${options.fps} fps with width ${options.sampleWidth}; starting prefilter`
    );

    const prefilterResult = await prefilterFrames({
      fps: options.fps,
      framePaths,
      outputKind: options.outputKind,
      prefilterProfile: options.prefilterProfile,
      progressInterval: options.progressInterval,
      temporalDecay: options.temporalDecay
    });
    const selectedFrameRows = selectFramesForOcr(prefilterResult.prefilterRows, {
      maxFrames: options.prefilterMaxFrames,
      minFrames: options.prefilterMinFrames,
      minScore: options.prefilterThreshold,
      neighborRadius: options.prefilterNeighbors
    });
    const bestPrefilter = prefilterResult.bestRow;

    // Batch snapshot mode: pick the best-scoring frame and extract N
    // additional frames within a window of that timestamp. All frames
    // show the same position list state since they're seconds apart,
    // making multi-frame merge valid.
    //
    // --batch-time overrides the center timestamp. This is needed when
    // the prefilter's best-scoring frame is not where the position list
    // is actually visible (e.g. user navigated away from the chart
    // platform — only the chart-area overlay remains).
    let batchMode = false;
    let batchCenterTs = null;
    if (options.batchSnapshots) {
      const explicitTs = Number.isFinite(options.batchTimestamp) ? options.batchTimestamp : null;
      batchCenterTs = explicitTs != null ? explicitTs : (bestPrefilter ? bestPrefilter.timestamp : null);
      if (batchCenterTs == null) {
        console.warn(`[scan:${options.outputKind}] batch mode requested but no center timestamp available (no --batch-time, no best prefilter)`);
      } else {
        batchMode = true;
        const baseStem = `${dateKey}_${path.basename(videoPath, path.extname(videoPath)).slice(0, 40)}`;
        const extracted = extractBatchOcrFrames(
          videoPath,
          batchCenterTs,
          options.batchWindowSeconds || 4,
          options.batchCount || 5,
          ocrFrameDirectory,
          options.ffmpegBin,
          options.ocrFrameWidth,
          baseStem
        );
        // Replace selectedFrameRows with batch frames. Give each its own
        // stats snapshot with the correct timestamp so the OCR pass records
        // the right capture time.
        const baseStats = bestPrefilter ? bestPrefilter.stats : { timestamp: batchCenterTs };
        selectedFrameRows.length = 0;
        for (let i = 0; i < extracted.length; i += 1) {
          const ts = extracted[i].timestamp;
          const frameStats = { ...baseStats, timestamp: ts };
          selectedFrameRows.push({
            frameIndex: i,
            framePath: extracted[i].framePath,
            prefilterScore: bestPrefilter ? bestPrefilter.prefilterScore : 18,
            stats: frameStats,
            timestamp: ts
          });
        }
        console.log(
          `[scan:${options.outputKind}] batch mode: extracted ${selectedFrameRows.length} frames within ±${(options.batchWindowSeconds || 4) / 2}s of t=${batchCenterTs.toFixed(1)}` +
            (explicitTs != null ? ' (explicit --batch-time)' : ' (best prefilter)')
        );
      }
    }

    console.log(
      `[scan:${options.outputKind}] prefilter kept ${selectedFrameRows.length}/${framePaths.length} frame(s) for OCR`
      + (bestPrefilter ? `; best prefilter ${bestPrefilter.prefilterScore.toFixed(2)} at ${formatDuration(bestPrefilter.timestamp)}` : '')
    );

    console.log(
      `[scan:${options.outputKind}] extracting OCR candidates from source video at width ${options.ocrFrameWidth}`
    );

    const scanResult = await scanFrames({
      chartStreamParser: Boolean(options.chartStreamParser),
      dateKey,
      ffmpegBin: options.ffmpegBin,
      fps: options.fps,
      frameRows: selectedFrameRows,
      keepFrames: Boolean(options.keepFrames),
      ocrEngine: options.ocrEngine || 'tesseract',
      ocrFrameDirectory,
      ocrFrameWidth: options.ocrFrameWidth,
      outputKind: options.outputKind,
      phashRegion: options.phashRegion || null,
      phashRegionFraction: options.phashRegionFraction || null,
      prefilterProfile: options.prefilterProfile,
      progressInterval: options.progressInterval,
      strongThreshold: options.strongThreshold,
      topCandidates: options.topCandidates,
      videoPath
    });

  console.log(
    `[scan:${options.outputKind}] prefilter kept ${selectedFrameRows.length}/${framePaths.length} frame(s) for OCR`
      + (bestPrefilter ? `; best prefilter ${bestPrefilter.prefilterScore.toFixed(2)} at ${formatDuration(bestPrefilter.timestamp)}` : '')
  );
    const candidates = scanResult.candidates;
    for (const candidate of candidates) {
      candidate.nearestFfmpegKeyframeTs = nearestKeyframe(keyframePtsList, candidate.timestamp);
    }

    const strongResult = pickTopDistinctCandidates(
      candidates,
      options.strongThreshold,
      options.maxCapturesPerVideo,
      CAPTURE_MIN_FRAME_GAP,
      options.phashHammingMax
    );
    const strongCandidates = strongResult.picked;
    const reviewResult = strongCandidates.length
      ? { picked: [], rejected: [] }
      : pickTopDistinctCandidates(candidates, options.reviewThreshold, options.maxCapturesPerVideo, CAPTURE_MIN_FRAME_GAP, options.phashHammingMax);
    const reviewCandidates = reviewResult.picked;
    const captures = strongCandidates.length ? strongCandidates : reviewCandidates;
    const rejectedForReport = (strongCandidates.length ? strongResult.rejected : reviewResult.rejected).slice(0, 5);

    if (!captures.length) {
      const bestCandidate = chooseBestCandidate(candidates);
      const result = {
        ...resultBase,
        captured_count: 0,
        captures: [],
        frame_count: framePaths.length,
        frame_error_count: scanResult.frameErrors.length,
        frame_errors: scanResult.frameErrors.slice(0, 5),
        nearest_ffmpeg_keyframe_lookups_skipped: keyframeLookupSkipped,
        nearest_ffmpeg_keyframe_pts_total: keyframePtsList.length,
        ocr_engine_metadata: ocrEngineMetadata,
        ocr_frame_count: selectedFrameRows.length,
        ocr_frame_width: options.ocrFrameWidth,
        prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
        sample_frame_width: options.sampleWidth,
        status: 'no_match',
        top_candidate: summarizeCandidate(bestCandidate, options.outputKind, candidates, options.confusionRadius),
        top_candidates: scanResult.topCandidates,
        top_rejected_candidates: rejectedForReport.map((candidate) => summarizeCandidate(candidate, options.outputKind)),
        whiteboard_segments: []
      };
      const logPath = await writeScanLog(logsDirectory, probeKey, result);
      result.log_path = logPath;
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const captureOutputs = [];
    for (let captureIndex = 0; captureIndex < captures.length; captureIndex += 1) {
      const candidate = captures[captureIndex];
      const explicitSuffix = captureIndex === 0 ? null : captureIndex + 1;
      const outputPath = await saveCapture({
        basename: options.basename,
        candidate,
        dateKey,
        ffmpegBin: options.ffmpegBin,
        outputKind: options.outputKind,
        outputRoot,
        suffix: explicitSuffix,
        videoPath
      });
      captureOutputs.push({ candidate, outputPath });
    }

    const status = strongCandidates.length ? 'done' : 'review';
    const captureSummaries = captureOutputs.map(({ candidate, outputPath }) => summarizeCapture(
      candidate,
      options.outputKind,
      outputPath,
      candidates,
      options.confusionRadius
    ));
    // Multi-frame RAW-OCR token voting (run once, expose both fields).
    // See src/parse/parseChartStream.js clusterRawOcrTokens for details.
    // Use top_candidates (all OCR'd frames, pre-dedup) rather than
    // captureSummaries (post-dedup) so the clusterer sees every frame
    // the OCR pass produced, not just the picked subset.
    const clusterResult = clusterRawOcrTokens(
      (scanResult.topCandidates || []).map((c) => c.ocr_text || ''),
      // Filter A: per-canonical frame count. Default 2 (was 1). Filters
      // single-frame OCR garbles (VIO→VLO, NFU→NFLX, INA→TNA, BUCO→UCO)
      // and chart-area tickers that bleed in briefly. Override via
      // --cluster-min-frequency <n> (1 disables the filter).
      { maxDistance: 1, minTokenLength: 2, minFrequency: options.clusterMinFrequency || 2 }
    );
    // Override captures' tickers with cluster's output. The b2925da
    // backfill (prior commit) only kicked in when captures were empty,
    // but in 65 saved snapshots the parser always returned SOMETHING
    // (often wrong tickers, never empty). Empirically: on the QMG
    // snapshots, clusterRecall beats CapRecall on 60+ runs (e.g. 20220607
    // cluster hits 7/7 GT, captures 4/7; 20220608 cluster 9/9, captures 7/9).
    // Always prefer the cluster when it's non-empty — captures are a per-
    // frame view, the cluster is a multi-frame consensus, and on noisy
    // EasyOCR output the consensus is the right answer.
    if (clusterResult.merged_list.length > 0) {
      for (const cap of captureSummaries) {
        cap.tickers = clusterResult.merged_list.slice();
      }
    }
    const result = {
      ...resultBase,
      captured_count: captureOutputs.length,
      captures: captureSummaries,
      frame_count: framePaths.length,
      frame_error_count: scanResult.frameErrors.length,
      frame_errors: scanResult.frameErrors.slice(0, 5),
      max_captures_per_video: options.maxCapturesPerVideo,
      nearest_ffmpeg_keyframe_lookups_skipped: keyframeLookupSkipped,
      nearest_ffmpeg_keyframe_pts_total: keyframePtsList.length,
      ocr_engine_metadata: ocrEngineMetadata,
      ocr_frame_count: selectedFrameRows.length,
      ocr_frame_width: options.ocrFrameWidth,
      output_path: captureOutputs[0].outputPath,
      prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
      review_threshold: options.reviewThreshold,
      sample_frame_width: options.sampleWidth,
      status,
      strong_threshold: options.strongThreshold,
      top_candidate: summarizeCandidate(captureOutputs[0].candidate, options.outputKind, candidates, options.confusionRadius),
      top_candidates: scanResult.topCandidates,
      top_rejected_candidates: rejectedForReport.map((candidate) => summarizeCandidate(candidate, options.outputKind)),
      whiteboard_segments: buildWhiteboardSegments(captureSummaries),
      // Multi-frame merge: union of all selected captures' position lists,
      // keeping only tickers that appear in >=2 captures. Significantly
      // improves recall for noisy QMG frames (e.g. 20220606: ALB+TNA on one
      // frame, CBIO on another — merge captures all three).
      merged_position_list: mergeMultiplePositionLists(
        captureSummaries.map((c) => c.tickers || []),
        { minOccurrences: 2 }
      ),
      // Multi-frame RAW-OCR token voting. Collects raw ticker-shape tokens
      // from each frame's OCR text (not the parser's accepted list), groups
      // tokens within edit-distance 2 of each other into clusters, picks a
      // canonical representative per cluster (preferring seed-lexicon
      // matches). Surfaces tickers that the parser rejected due to OCR
      // garbling but that appear consistently across frames. See
      // src/parse/parseChartStream.js clusterRawOcrTokens for details.
      // Expose both the canonical merged list AND the per-cluster
      // diagnostics (canonical, members, frequency). The clusterResult
      // variable is declared ABOVE this object literal so we can hoist the
      // expensive clusterRawOcrTokens() call out of the property values.
      merged_raw_token_list: clusterResult.merged_list,
      merged_raw_token_clusters: clusterResult.clusters.map((c) => ({
        canonical: c.canonical,
        members: c.members,
        frequency: c.frequency
      }))
    };
    const logPath = await writeScanLog(logsDirectory, probeKey, result);
    result.log_path = logPath;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const errorResult = {
      ...resultBase,
      message: error.message,
      nearest_ffmpeg_keyframe_lookups_skipped: keyframeLookupSkipped,
      nearest_ffmpeg_keyframe_pts_total: keyframePtsList.length,
      ocr_engine_metadata: ocrEngineMetadata,
      status: 'error'
    };
    const logPath = await writeScanLog(logsDirectory, probeKey, errorResult);
    console.error(`[scan:${options.outputKind}] failed: ${error.message}`);
    console.error(`[scan:${options.outputKind}] details saved to ${logPath}`);
    throw error;
  } finally {
    if (!options.keepFrames) {
      await safeDeleteDirectory(frameRoot);
    }

    await closeWorker();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
