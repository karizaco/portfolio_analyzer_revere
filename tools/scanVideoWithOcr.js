const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { closeWorker, ocrImage } = require('../src/ocr/ocrImage');
const { parseScreenshot } = require('../src/parse/parseScreenshot');
const { parseWhiteboardScreenshot } = require('../src/parse/parseWhiteboardScreenshot');
const {
  analyzeFrameBeforeOcr,
  allocateOutputPath,
  chooseBestCandidate,
  chooseBestWindow,
  groupContiguousCandidates,
  inferDateKey,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreWhiteboardCandidate,
  selectFramesForOcr
} = require('../src/video/ocrScanLogic');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'data', 'video_ocr_probe');

function printHelp() {
  console.log([
    'Usage: node tools/scanVideoWithOcr.js --video <path> [options]',
    '',
    'Options:',
    '  --video <path>             Local video file to scan',
    '  --date <YYYYMMDD>          Optional date key override for output naming',
    '  --output-kind <kind>       whiteboard | snapshot',
    '  --output-root <path>       Root directory for extracted outputs',
    '  --ffmpeg-bin <path>        Optional ffmpeg executable path',
    '  --fps <number>             Frame sampling rate, default 0.25',
    '  --sample-width <pixels>    Width for cheap prefilter frame extraction, default 640',
    '  --ocr-frame-width <pixels> Width for OCR candidate frame extraction, default 1280',
    '  --prefilter-threshold <n>  Cheap image filter threshold, default 14',
    '  --prefilter-min-frames <n> Minimum frames to keep for OCR, default 12',
    '  --prefilter-max-frames <n> Maximum frames to OCR, default 60',
    '  --prefilter-neighbors <n>  Neighbor frames kept around strong prefilter hits, default 1',
    '  --strong-threshold <n>     Autosave score threshold, default 14',
    '  --review-threshold <n>     Review score threshold, default 10',
    '  --progress-interval <n>    Report OCR progress every N frames, default 10',
    '  --top-candidates <n>       Include the top N candidate timestamps in the result, default 5',
    '  --keep-frames              Keep sampled intermediate frames',
    '  --help                     Show this help text',
    ''
  ].join('\n'));
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return null;
  }

  const options = {
    ffmpegBin: 'ffmpeg',
    fps: 0.25,
    ocrFrameWidth: 1280,
    outputKind: 'whiteboard',
    outputRoot: DEFAULT_OUTPUT_ROOT,
    prefilterMaxFrames: 60,
    prefilterMinFrames: 12,
    prefilterNeighbors: 1,
    prefilterThreshold: 14,
    progressInterval: 10,
    reviewThreshold: 10,
    sampleWidth: 640,
    strongThreshold: 14,
    topCandidates: 5
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case '--video':
        options.videoPath = path.resolve(nextValue);
        index += 1;
        break;
      case '--video-dir':
        options.videoDirectory = path.resolve(nextValue);
        index += 1;
        break;
      case '--file':
        options.fileName = nextValue;
        index += 1;
        break;
      case '--date':
        options.dateKey = nextValue;
        index += 1;
        break;
      case '--output-root':
        options.outputRoot = path.resolve(nextValue);
        index += 1;
        break;
      case '--output-kind':
        options.outputKind = nextValue;
        index += 1;
        break;
      case '--ffmpeg-bin':
        options.ffmpegBin = nextValue;
        index += 1;
        break;
      case '--fps':
        options.fps = Number(nextValue);
        index += 1;
        break;
      case '--sample-width':
        options.sampleWidth = Number(nextValue);
        index += 1;
        break;
      case '--ocr-frame-width':
        options.ocrFrameWidth = Number(nextValue);
        index += 1;
        break;
      case '--prefilter-threshold':
        options.prefilterThreshold = Number(nextValue);
        index += 1;
        break;
      case '--prefilter-min-frames':
        options.prefilterMinFrames = Number(nextValue);
        index += 1;
        break;
      case '--prefilter-max-frames':
        options.prefilterMaxFrames = Number(nextValue);
        index += 1;
        break;
      case '--prefilter-neighbors':
        options.prefilterNeighbors = Number(nextValue);
        index += 1;
        break;
      case '--strong-threshold':
        options.strongThreshold = Number(nextValue);
        index += 1;
        break;
      case '--review-threshold':
        options.reviewThreshold = Number(nextValue);
        index += 1;
        break;
      case '--progress-interval':
        options.progressInterval = Number(nextValue);
        index += 1;
        break;
      case '--top-candidates':
        options.topCandidates = Number(nextValue);
        index += 1;
        break;
      case '--keep-frames':
        options.keepFrames = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.videoPath && options.videoDirectory && options.fileName) {
    options.videoPath = path.resolve(options.videoDirectory, options.fileName);
  }

  if (!options.videoPath) {
    throw new Error('Missing required argument: --video');
  }

  if (!['whiteboard', 'snapshot'].includes(options.outputKind)) {
    throw new Error(`Unsupported output kind: ${options.outputKind}`);
  }

  if (!Number.isFinite(options.fps) || options.fps <= 0) {
    throw new Error('`--fps` must be a positive number.');
  }

  if (!Number.isFinite(options.sampleWidth) || options.sampleWidth <= 0) {
    throw new Error('`--sample-width` must be a positive number.');
  }

  if (!Number.isFinite(options.ocrFrameWidth) || options.ocrFrameWidth <= 0) {
    throw new Error('`--ocr-frame-width` must be a positive number.');
  }

  if (!Number.isFinite(options.progressInterval) || options.progressInterval <= 0) {
    throw new Error('`--progress-interval` must be a positive number.');
  }

  if (!Number.isFinite(options.prefilterThreshold)) {
    throw new Error('`--prefilter-threshold` must be numeric.');
  }

  if (!Number.isFinite(options.prefilterMinFrames) || options.prefilterMinFrames <= 0) {
    throw new Error('`--prefilter-min-frames` must be a positive number.');
  }

  if (!Number.isFinite(options.prefilterMaxFrames) || options.prefilterMaxFrames <= 0) {
    throw new Error('`--prefilter-max-frames` must be a positive number.');
  }

  if (!Number.isFinite(options.prefilterNeighbors) || options.prefilterNeighbors < 0) {
    throw new Error('`--prefilter-neighbors` must be zero or a positive number.');
  }

  if (!Number.isFinite(options.topCandidates) || options.topCandidates <= 0) {
    throw new Error('`--top-candidates` must be a positive number.');
  }

  return options;
}

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

function isBetterCandidate(candidate, currentBest) {
  if (!currentBest) {
    return true;
  }

  if (candidate.score !== currentBest.score) {
    return candidate.score > currentBest.score;
  }

  if (candidate.ocrConfidence !== currentBest.ocrConfidence) {
    return candidate.ocrConfidence > currentBest.ocrConfidence;
  }

  return candidate.timestamp > currentBest.timestamp;
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

function createProbeKey(videoPath, dateKey, outputKind) {
  const baseName = path.basename(videoPath, path.extname(videoPath))
    .replace(/[^a-z0-9._-]+/gi, '_')
    .toLowerCase();
  const shortenedName = baseName.slice(0, 36).replace(/_+$/g, '') || 'video';
  const digest = crypto.createHash('sha1').update(videoPath).digest('hex').slice(0, 8);
  return `${dateKey}_${shortenedName}_${digest}_${outputKind}`;
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

function buildWindowCandidates(candidates, threshold) {
  return groupContiguousCandidates(candidates.filter((candidate) => candidate.score >= threshold));
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

async function buildSnapshotCandidate(framePath, frameIndex, dateKey, fps) {
  const ocr = await ocrImage(framePath);
  const parsed = parseScreenshot({
    metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
    ocr
  });

  return {
    frameIndex,
    framePath,
    ocrConfidence: Number(parsed.ocr_confidence || ocr.confidence || 0),
    parsed,
    score: scoreSnapshotCandidate(parsed),
    timestamp: buildFrameTimestamp(frameIndex, fps)
  };
}

async function buildWhiteboardCandidate(framePath, frameIndex, dateKey, fps) {
  const ocr = await ocrImage(framePath);
  const parsedRows = parseWhiteboardScreenshot({
    metadata: buildFrameMetadata(framePath, dateKey, frameIndex),
    ocr
  });

  return {
    frameIndex,
    framePath,
    ocrConfidence: Number(ocr.confidence || 0),
    parsedRows,
    score: scoreWhiteboardCandidate(parsedRows, ocr.confidence),
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
      const candidate = await buildCandidate(ocrFramePath, frameRow.frameIndex, dateKey, fps);
      candidates.push(candidate);
      if (candidate.score >= strongThreshold && isBetterCandidate(candidate, bestCandidate)) {
        bestCandidate = candidate;
      } else if (!bestCandidate && isBetterCandidate(candidate, bestCandidate)) {
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

  return {
    frame_index: candidate.frameIndex,
    frame_path: candidate.framePath,
    ocr_confidence: candidate.ocrConfidence,
    output_kind: outputKind,
    score: candidate.score,
    timestamp: candidate.timestamp
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const videoPath = options.videoPath;
  const dateKey = inferDateKey(videoPath, options.dateKey);
  const outputRoot = path.resolve(options.outputRoot);
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

  let outputPath = '';
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

    const strongWindows = buildWindowCandidates(candidates, options.strongThreshold);
    const bestWindow = chooseBestWindow(strongWindows);
    const reviewCandidate = chooseBestCandidate(candidates.filter((candidate) => candidate.score >= options.reviewThreshold));
    const strongCandidate = chooseBestCandidate(bestWindow);

    let selectedCandidate = strongCandidate;
    let status = 'done';
    if (!selectedCandidate && reviewCandidate) {
      selectedCandidate = reviewCandidate;
      status = 'review';
    }

    if (!selectedCandidate) {
      const bestCandidate = chooseBestCandidate(candidates);
      const result = {
        ...resultBase,
        frame_count: framePaths.length,
        frame_error_count: scanResult.frameErrors.length,
        frame_errors: scanResult.frameErrors.slice(0, 5),
        ocr_frame_width: options.ocrFrameWidth,
        ocr_frame_count: selectedFrameRows.length,
        prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
        sample_frame_width: options.sampleWidth,
        status: 'no_match',
        top_candidates: scanResult.topCandidates,
        top_candidate: summarizeCandidate(bestCandidate, options.outputKind),
        window_end: bestWindow.length ? bestWindow[bestWindow.length - 1].timestamp : null,
        window_length: bestWindow.length,
        window_start: bestWindow.length ? bestWindow[0].timestamp : null
      };
      const logPath = await writeScanLog(logsDirectory, probeKey, result);
      result.log_path = logPath;
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    outputPath = allocateOutputPath(outputRoot, options.outputKind, dateKey);
    extractFinalFrame(videoPath, selectedCandidate.timestamp, outputPath, options.ffmpegBin);

    const result = {
      ...resultBase,
      frame_count: framePaths.length,
      frame_error_count: scanResult.frameErrors.length,
      frame_errors: scanResult.frameErrors.slice(0, 5),
      ocr_frame_count: selectedFrameRows.length,
      ocr_frame_width: options.ocrFrameWidth,
      output_path: outputPath,
      prefilter_best_score: bestPrefilter ? bestPrefilter.prefilterScore : null,
      sample_frame_width: options.sampleWidth,
      status,
      top_candidates: scanResult.topCandidates,
      top_candidate: summarizeCandidate(selectedCandidate, options.outputKind),
      window_end: bestWindow.length ? bestWindow[bestWindow.length - 1].timestamp : null,
      window_length: bestWindow.length,
      window_start: bestWindow.length ? bestWindow[0].timestamp : null
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