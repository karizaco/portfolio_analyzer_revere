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
    '  --phash-region <x,y,w,h>  Region in pixels for the overlay pHash (optional)',
    '  --phash-hamming-max <n>    Max Hamming distance for overlay pHash dedup, default 6',
    '  --phash-region-fraction <xf,yf,wf,hf> Fractional overlay region (0..1); chart_stream default "0.87,0.58,0.13,0.40"',
    '  --temporal-decay <secs>    Seconds over which early-frame boost decays to zero, default 1800',
    '  --chart-stream-parser      Replace the GRO/TURBO whiteboard parser with parseChartStream',
    '  --help                     Show this help text',
    ''
  ].join('\n'));
}

// Default fractional overlay region for chart-stream OCR. Qullamaggie's
// position-list overlay sits in the bottom-right corner of a streamed chart frame.
// At 1080p (1920x1080):
//   - Position list table spans x=[1766-1911], y=[~653-1023] (145x370 px).
//   - The OLD default 0.87,0.58,0.13,0.40 was 250x434 px — captured chart
//     y-axis labels (26.00, Arith) on the left and "Items in Watchlist"
//     footer at the bottom. The position-list-aware filter rejected those
//     but they still confused Tesseract.
//   - The NEW default 0.91,0.58,0.09,0.40 is 173x432 px — narrower (just
//     the table area, no chart y-axis) but still tall enough to capture the
//     full position list. Tested across 5 GT videos:
//       0.87,0.13 (250px wide): 50% recall, 6 FPs
//       0.91,0.09 (173px wide): 58% recall, 4 FPs
//   - Even narrower (0.92,0.08 = 154px) was tested but Tesseract produces
//     MORE garbled text in narrow crops — Tesseract needs context on the
//     left side of text to read correctly.
// The position-list-aware filter in src/parse/parseChartStream.js
// (identifyPositionListColumn) is the second line of defense — it uses
// per-word OCR positions to identify the dominant ticker column and
// rejects chart-area tokens that survived the crop narrowing.
const CHART_STREAM_REGION_FRACTION_DEFAULT = '0.91,0.58,0.09,0.40';

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
  return { x: xFraction, y: yFraction, w: wFraction, h: hFraction };
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
    phashHammingMax: 6,
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
    temporalDecay: 1800,
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
      case '--temporal-decay':
        options.temporalDecay = Number(nextValue);
        index += 1;
        break;
      case '--phash-hamming-max':
        options.phashHammingMax = Number(nextValue);
        index += 1;
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

  if (!Number.isFinite(options.temporalDecay) || options.temporalDecay <= 0) {
    throw new Error('`--temporal-decay` must be a positive number of seconds.');
  }

  if (!Number.isFinite(options.phashHammingMax) || options.phashHammingMax < 0 || options.phashHammingMax > 64) {
    throw new Error('`--phash-hamming-max` must be an integer between 0 and 64.');
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

  // chart_stream prefilter + chart-stream parser must be used together: the prefilter
  // finds dark candlestick-chart frames and the parser extracts position lists from them.
  // Auto-enable so the user only needs --prefilter-profile chart_stream.
  if (options.prefilterProfile === 'chart_stream') {
    options.chartStreamParser = true;
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
