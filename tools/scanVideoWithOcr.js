'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  groupContiguousCandidates,
  inferDateKey,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreWhiteboardCandidate,
  selectFramesForOcr,
  splitIssueCodes
} = require('../src/video/ocrScanLogic');
const { createProbeKey, parseArgs, printHelp } = require('../src/video/ocrScanArgs');

const OCR_TEXT_SNIPPET_MAX_CHARS = 200;
const CAPTURE_MIN_FRAME_GAP = 10;

function formatDuration(totalSeconds) {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

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
// frame indices). This ensures we capture multiple distinct screens rather
// than 3 frames from the same 30-second whiteboard segment.
function pickTopDistinctCandidates(candidates, threshold, maxCaptures, minFrameGap = CAPTURE_MIN_FRAME_GAP) {
  const strong = sortCandidatesDescending(candidates.filter((candidate) => candidate.score >= threshold));
  const picked = [];
  for (const candidate of strong) {
    if (picked.length >= maxCaptures) {
      break;
    }

    const tooClose = picked.some((other) => Math.abs(other.frameIndex - candidate.frameIndex) < minFrameGap);
    if (!tooClose) {
      picked.push(candidate);
    }
  }
  return picked;
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

async function prefilterFrames({ fps, framePaths, outputKind, progressInterval }) {
  const prefilterRows = [];
  let bestRow = null;
  const startedAt = Date.now();

  for (let index = 0; index < framePaths.length; index += 1) {
    const framePath = framePaths[index];
    const stats = await analyzeFrameBeforeOcr(framePath);
    const row = {
      frameIndex: index,
      framePath,
      prefilterScore: scoreFramePrefilter(stats, outputKind),
      stats,
      timestamp: buildFrameTimestamp(index, fps)
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

async function buildSnapshotCandidate(framePath, frameIndex, dateKey, fps, stats, prefilterScore) {
  const ocr = await ocrImage(framePath);
  const parsed = parseScreenshot({
    metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
    ocr
  });

  return {
    frameIndex,
    framePath,
    ocrConfidence: Number(parsed.ocr_confidence || ocr.confidence || 0),
    ocrProfile: ocr.profileName,
    ocrTextSnippet: extractOcrTextSnippet(ocr.text),
    parsed,
    parsedRows: null,
    prefilterScore,
    score: scoreSnapshotCandidate(parsed),
    screenLayout: detectScreenLayout(ocr.text, ocr.lines),
    stats,
    timestamp: buildFrameTimestamp(frameIndex, fps)
  };
}

async function buildWhiteboardCandidate(framePath, frameIndex, dateKey, fps, stats, prefilterScore) {
  const ocr = await ocrImage(framePath);
  const parsedRows = parseWhiteboardScreenshot({
    metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
    ocr
  });

  return {
    frameIndex,
    framePath,
    ocrConfidence: Number(ocr.confidence || 0),
    ocrProfile: ocr.profileName,
    ocrTextSnippet: extractOcrTextSnippet(ocr.text),
    parsedRows,
    prefilterScore,
    score: scoreWhiteboardCandidate(parsedRows, ocr.confidence, { ...ocr, stats }),
    screenLayout: detectScreenLayout(ocr.text, ocr.lines),
    stats,
    timestamp: buildFrameTimestamp(frameIndex, fps)
  };
}

async function scanFrames({
  dateKey,
  ffmpegBin,
  fps,
  frameRows,
  keepFrames,
  ocrFrameDirectory,
  ocrFrameWidth,
  outputKind,
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
        frameRow.prefilterScore
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

function summarizeCandidate(candidate, outputKind) {
  if (!candidate) {
    return null;
  }

  const summary = {
    frame_index: candidate.frameIndex,
    frame_path: candidate.framePath,
    issue_codes: collectIssueCodes(candidate.parsedRows),
    ocr_confidence: candidate.ocrConfidence,
    ocr_profile: candidate.ocrProfile || '',
    ocr_text_snippet: candidate.ocrTextSnippet || '',
    output_kind: outputKind,
    parsed_row_count: Array.isArray(candidate.parsedRows) ? candidate.parsedRows.length : 0,
    prefilter_score: candidate.prefilterScore == null ? null : Number(candidate.prefilterScore.toFixed(2)),
    score: candidate.score,
    screen_layout: candidate.screenLayout || 'unknown',
    timestamp: candidate.timestamp
  };

  return summary;
}

function summarizeCapture(candidate, outputKind, outputPath) {
  const summary = summarizeCandidate(candidate, outputKind);
  if (!summary) {
    return null;
  }
  return { ...summary, output_path: outputPath };
}

async function saveCapture({ candidate, outputRoot, outputKind, dateKey, videoPath, ffmpegBin, suffix }) {
  const explicitSuffix = Number.isFinite(suffix) ? suffix : null;
  const outputPath = allocateOutputPath(outputRoot, outputKind, dateKey, explicitSuffix);
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
    date_key: dateKey,
    output_kind: options.outputKind,
    video_path: videoPath
  };

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
      progressInterval: options.progressInterval
    });
    const selectedFrameRows = selectFramesForOcr(prefilterResult.prefilterRows, {
      maxFrames: options.prefilterMaxFrames,
      minFrames: options.prefilterMinFrames,
      minScore: options.prefilterThreshold,
      neighborRadius: options.prefilterNeighbors
    });
    const bestPrefilter = prefilterResult.bestRow;

    console.log(
      `[scan:${options.outputKind}] prefilter kept ${selectedFrameRows.length}/${framePaths.length} frame(s) for OCR`
      + (bestPrefilter ? `; best prefilter ${bestPrefilter.prefilterScore.toFixed(2)} at ${formatDuration(bestPrefilter.timestamp)}` : '')
    );

    console.log(
      `[scan:${options.outputKind}] extracting OCR candidates from source video at width ${options.ocrFrameWidth}`
    );

    const scanResult = await scanFrames({
      dateKey,
      ffmpegBin: options.ffmpegBin,
      fps: options.fps,
      frameRows: selectedFrameRows,
      keepFrames: Boolean(options.keepFrames),
      ocrFrameDirectory,
      ocrFrameWidth: options.ocrFrameWidth,
      outputKind: options.outputKind,
      progressInterval: options.progressInterval,
      strongThreshold: options.strongThreshold,
      topCandidates: options.topCandidates,
      videoPath
    });
    const candidates = scanResult.candidates;

    const strongCandidates = pickTopDistinctCandidates(
      candidates,
      options.strongThreshold,
      options.maxCapturesPerVideo
    );
    const reviewCandidates = strongCandidates.length
      ? []
      : pickTopDistinctCandidates(candidates, options.reviewThreshold, options.maxCapturesPerVideo);
    const captures = strongCandidates.length ? strongCandidates : reviewCandidates;

    if (!captures.length) {
      const bestCandidate = chooseBestCandidate(candidates);
      const result = {
        ...resultBase,
        captured_count: 0,
        captures: [],
        frame_count: framePaths.length,
        frame_error_count: scanResult.frameErrors.length,
        frame_errors: scanResult.frameErrors.slice(0, 5),
        ocr_frame_count: selectedFrameRows.length,
        ocr_frame_width: options.ocrFrameWidth,
        prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
        sample_frame_width: options.sampleWidth,
        status: 'no_match',
        top_candidate: summarizeCandidate(bestCandidate, options.outputKind),
        top_candidates: scanResult.topCandidates
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
    const result = {
      ...resultBase,
      captured_count: captureOutputs.length,
      captures: captureOutputs.map(({ candidate, outputPath }) => summarizeCapture(candidate, options.outputKind, outputPath)),
      frame_count: framePaths.length,
      frame_error_count: scanResult.frameErrors.length,
      frame_errors: scanResult.frameErrors.slice(0, 5),
      max_captures_per_video: options.maxCapturesPerVideo,
      ocr_frame_count: selectedFrameRows.length,
      ocr_frame_width: options.ocrFrameWidth,
      output_path: captureOutputs[0].outputPath,
      prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
      review_threshold: options.reviewThreshold,
      sample_frame_width: options.sampleWidth,
      status,
      strong_threshold: options.strongThreshold,
      top_candidate: summarizeCandidate(captureOutputs[0].candidate, options.outputKind),
      top_candidates: scanResult.topCandidates
    };
    const logPath = await writeScanLog(logsDirectory, probeKey, result);
    result.log_path = logPath;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const errorResult = {
      ...resultBase,
      message: error.message,
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
