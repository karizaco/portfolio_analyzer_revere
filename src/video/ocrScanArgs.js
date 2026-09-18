'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const { PREFILTER_PROFILE_DEFAULT } = require('../config/schema');

const DEFAULT_OUTPUT_ROOT = path.join(
  path.resolve(__dirname, '..', '..'),
  'data',
  'video_ocr_probe'
);

function printHelp() {
  console.log([
    'Usage: node tools/scanVideoWithOcr.js --video <path> [options]',
    '',
    'Options:',
    '  --video <path>             Local video file to scan',
    '  --date <YYYYMMDD>          Optional date key override for output naming',
    '  --output-kind <kind>       whiteboard | snapshot',
    '  --output-root <path>       Root directory for extracted outputs',
    '  --run-tag <name>           Optional subdirectory appended to output-root so same-day reruns do not overwrite previous results',
    '  --ffmpeg-bin <path>        Optional ffmpeg executable path',
    '  --fps <number>             Frame sampling rate, default 0.25',
    '  --sample-width <pixels>    Width for cheap prefilter frame extraction, default 640',
    '  --ocr-frame-width <pixels> Width for OCR candidate frame extraction, default 1280',
    '  --prefilter-threshold <n>  Cheap image filter threshold, default 14',
    '  --prefilter-min-frames <n> Minimum frames to keep for OCR, default 12',
    '  --prefilter-max-frames <n> Maximum frames to OCR, default 60',
    '  --prefilter-neighbors <n>  Neighbor frames kept around strong prefilter hits, default 1',
    '  --strong-threshold <n>     Autosave score threshold, default 6',
    '  --review-threshold <n>     Review score threshold, default 4',
    '  --max-captures <n>         Maximum screenshots to save per video, default 3',
    '  --progress-interval <n>    Report OCR progress every N frames, default 10',
    '  --top-candidates <n>       Include the top N candidate timestamps in the result, default 5',
    '  --keep-frames              Keep sampled intermediate frames',
    '  --skip-keyframes           Do not invoke ffprobe to locate the nearest keyframe per capture',
    '  --confusion-radius <n>     Adjacent-frame lookup window for confusion_with_nearby, default 1',
    '  --prefilter-profile <p>    whiteboard | chart_stream (drives prefilter score table + keyword guard)',
    '  --basename <name>          Snapshot PNG prefix + screenshot discovery stem, default "revere"',
    '  --phash-region <x,y,w,h>   Region in pixels for the overlay pHash (optional)',
    '  --phash-region-fraction <xf,yf,wf,hf> Fractional overlay region (0..1); chart_stream default "0.70,0.84,0.28,0.14"',
    '  --chart-stream-parser      Replace the GRO/TURBO whiteboard parser with parseChartStream',
    '  --help                     Show this help text',
    ''
  ].join('\n'));
}

// Default fractional overlay region for chart-stream runs. Qullamaggie's
// position-list overlay sits in the bottom-right corner of a streamed chart
// frame; the values here cover ~28% width × 14% height starting at 70% / 84%
// of the frame. These numbers were eyeballed from the YouTube layout and are
// good enough for the prefilter — the OCR engine tolerates a couple of pixels
// of slack on every edge.
const CHART_STREAM_REGION_FRACTION_DEFAULT = '0.70,0.84,0.28,0.14';

function parseFractionalRegion(raw) {
  if (!raw) return null;
  const tokens = String(raw).split(',').map((value) => Number(value.trim()));
  if (tokens.length !== 4 || tokens.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`Expected fractional region as four 0..1 numbers, got "${raw}"`);
  }
  const [xFraction, yFraction, wFraction, hFraction] = tokens;
  if (xFraction + wFraction > 1.001 || yFraction + hFraction > 1.001) {
    throw new Error(`Fractional region overflows frame bounds: ${raw}`);
  }
  return { xFraction, yFraction, wFraction, hFraction };
}

function parsePixelRegion(raw) {
  if (!raw) return null;
  const tokens = String(raw).split(',').map((value) => Number(value.trim()));
  if (tokens.length !== 4 || tokens.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Expected pixel region as four non-negative numbers, got "${raw}"`);
  }
  const [x, y, width, height] = tokens;
  return { x, y, width, height };
}

function buildDefaultOptions(defaultOutputRoot) {
  return {
    basename: 'revere',
    chartStreamParser: false,
    confusionRadius: 1,
    ffmpegBin: 'ffmpeg',
    fps: 0.25,
    maxCapturesPerVideo: 3,
    ocrFrameWidth: 1280,
    outputKind: 'whiteboard',
    outputRoot: defaultOutputRoot,
    phashRegion: null,
    phashRegionFraction: null,
    prefilterMaxFrames: 60,
    prefilterMinFrames: 12,
    prefilterNeighbors: 1,
    prefilterProfile: PREFILTER_PROFILE_DEFAULT,
    prefilterThreshold: 14,
    progressInterval: 10,
    reviewThreshold: 4,
    sampleWidth: 640,
    skipKeyframes: false,
    strongThreshold: 6,
    topCandidates: 5
  };
}

function parseArgs(argv, overrides = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return null;
  }

  const defaultOutputRoot = overrides.defaultOutputRoot || DEFAULT_OUTPUT_ROOT;
  const options = buildDefaultOptions(defaultOutputRoot);

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
      case '--run-tag':
        options.runTag = nextValue;
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
      case '--max-captures':
        options.maxCapturesPerVideo = Number(nextValue);
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
      case '--skip-keyframes':
        options.skipKeyframes = true;
        break;
      case '--confusion-radius':
        options.confusionRadius = Number(nextValue);
        index += 1;
        break;
      case '--prefilter-profile':
        options.prefilterProfile = String(nextValue);
        index += 1;
        break;
      case '--basename':
        options.basename = String(nextValue);
        index += 1;
        break;
      case '--phash-region':
        options.phashRegion = parsePixelRegion(nextValue);
        index += 1;
        break;
      case '--phash-region-fraction':
        options.phashRegionFraction = parseFractionalRegion(nextValue);
        index += 1;
        break;
      case '--chart-stream-parser':
        options.chartStreamParser = true;
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

  if (!Number.isFinite(options.maxCapturesPerVideo) || options.maxCapturesPerVideo <= 0) {
    throw new Error('`--max-captures` must be a positive number.');
  }

  if (!Number.isFinite(options.confusionRadius) || options.confusionRadius < 0) {
    throw new Error('`--confusion-radius` must be zero or a positive number.');
  }

  if (!['whiteboard', 'chart_stream'].includes(options.prefilterProfile)) {
    throw new Error(`Unsupported prefilter profile: ${options.prefilterProfile}`);
  }

  const sanitizedBasename = String(options.basename || 'revere').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  if (!sanitizedBasename) {
    throw new Error('`--basename` must contain at least one alphanumeric character.');
  }
  options.basename = sanitizedBasename;

  if (options.phashRegion && options.phashRegionFraction) {
    throw new Error('Pass either `--phash-region` or `--phash-region-fraction`, not both.');
  }

  if (options.prefilterProfile === 'chart_stream' && !options.phashRegion && !options.phashRegionFraction) {
    options.phashRegionFraction = parseFractionalRegion(CHART_STREAM_REGION_FRACTION_DEFAULT);
  }

  if (options.chartStreamParser && options.outputKind !== 'snapshot') {
    // The chart-stream parser produces a single observation row per capture;
    // it's only meaningful in snapshot mode where one slide = one capture.
    // For whiteboard runs the parser is a no-op anyway because no structured
    // GRO/TURBO rows exist.
    throw new Error('`--chart-stream-parser` is only supported with `--output-kind snapshot`.');
  }

  return options;
}

function createProbeKey(videoPath, dateKey, outputKind) {
  const baseName = path.basename(videoPath, path.extname(videoPath))
    .replace(/[^a-z0-9._-]+/gi, '_')
    .toLowerCase();
  const shortenedName = baseName.slice(0, 36).replace(/_+$/g, '') || 'video';
  const digest = crypto.createHash('sha1').update(videoPath).digest('hex').slice(0, 8);
  return `${dateKey}_${shortenedName}_${digest}_${outputKind}`;
}

module.exports = {
  CHART_STREAM_REGION_FRACTION_DEFAULT,
  DEFAULT_OUTPUT_ROOT,
  createProbeKey,
  parseArgs,
  parseFractionalRegion,
  parsePixelRegion,
  printHelp
};
