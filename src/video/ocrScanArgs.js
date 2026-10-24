'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const { PREFILTER_PROFILE_DEFAULT } = require('../config/schema');
const {
  PIPELINE_PROFILE_DEFAULT,
  getPipelineProfileNames
} = require('../config/pipelineProfiles');

const SUPPORTED_PIPELINE_PROFILES = Object.freeze(getPipelineProfileNames());

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
    `  --pipeline-profile <name>  End-to-end pipeline profile, default ${PIPELINE_PROFILE_DEFAULT} (run node tools/runOcrProfiles.js --list for catalog)`,
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
    '  --table-frame-budget-ms <n>  Wall-clock budget for one frame of the positions-TABLE reader, default 900000 (15 min). The per-image OCR timeout is derived from it.',
    '  --review-threshold <n>     Review score threshold, default 4',
    '  --max-captures <n>         Maximum screenshots to save per video, default 3',
    '  --cluster-min-frequency <n> Minimum per-canonical frame count for multi-frame OCR token voting, default 1 (set to 2 to filter single-frame garbles)',
    '  --position-merge-min-occurrences <n>  Min capture count for position merge, default 1 (set to 2 for intersection mode)',
    '  --progress-interval <n>    Report OCR progress every N frames, default 10',
    '  --batch-snapshots          Extract a batch of N frames within ±W seconds of the best-scoring frame. All frames show the same position list state, so multi-frame merge is valid. Use with --batch-count and --batch-window.',
    '  --batch-count <n>          Number of frames in the batch (default 5)',
    '  --batch-window <seconds>   Window around the center timestamp (default 4)',
    '  --batch-time <seconds>     Override the center timestamp for batch snapshots (skips the best-scoring frame search). Use when you know the exact timestamp where the position list is visible.',
    '  --ocr-engine <name>        OCR engine: tesseract (default) | easyocr. EasyOCR reads QMG position lists much more accurately (~95% recall vs ~25%) at the cost of ~60s/frame vs ~1-2s. Only applies to chart-stream parser mode.',
    '  --top-candidates <n>       Include the top N candidate timestamps in the result, default 5',
    '  --keep-frames              Keep sampled intermediate frames',
    '  --keep-ocr-crops           Keep the cropped position-list panel PNGs that get fed to the OCR engine (under ocr_probe/crops/). Lets OCR settings be re-benchmarked without a full re-scan.',
    '  --skip-keyframes           Do not invoke ffprobe to locate the nearest keyframe per capture',
    '  --confusion-radius <n>     Adjacent-frame lookup window for confusion_with_nearby, default 1',
    '  --prefilter-profile <p>    whiteboard | chart_stream | tale_of_the_tape | position_table (drives prefilter score table + keyword guard)',
    '  --basename <name>          Snapshot PNG prefix + screenshot discovery stem, default "revere"',
    '  --phash-region <x,y,w,h>  Region in pixels for the overlay pHash (optional)',
    '  --phash-hamming-max <n>    Max Hamming distance for overlay pHash dedup, default 6',
    '  --phash-region-fraction <xf,yf,wf,hf> Fractional overlay region (0..1); chart_stream default "0.86,0.62,0.14,0.22"',
    '  --temporal-decay <secs>    Seconds over which early-frame boost decays to zero, default 1800',
    '  --chart-stream-parser      Replace the GRO/TURBO whiteboard parser with parseChartStream',
    '  --help                     Show this help text',
    ''
  ].join('\n'));
}

// Default fractional overlay region for chart-stream OCR. Qullamaggie's
// position-list overlay sits in the bottom-right corner of a streamed chart frame.
const CHART_STREAM_REGION_FRACTION_DEFAULT = '0.86,0.62,0.14,0.22';
// Tale-of-the-Tape position list sits center-right in the frame (x≈50-95%, y≈55-98%)
const TALE_OF_THE_TAPE_CROP_FRACTION = '0.50,0.55,0.45,0.43';
// The positions-TABLE reader does not use a fixed crop at all — it LOCATES
// the table in the frame. This region is only the overlay pHash, used to
// tell one capture from another, so it covers the whole right-hand strip
// where the table can be in either the 2022 or the 2023 layout.
const POSITION_TABLE_REGION_FRACTION = '0.78,0.28,0.22,0.72';
// Wall-clock budget for ONE frame of the positions-TABLE reader. The reader
// spends two OCR batches per frame (a title probe over every candidate
// column, then a ticker read over the winner), so the per-image timeout has
// to be derived from the number of images rather than fixed — a fixed
// timeout would let a frame with many candidate columns run for an hour.
//
// The value is duplicated from DEFAULT_FRAME_BUDGET_MS in
// src/video/positionTableScan.js on purpose: the args module stays free of
// the OCR stack (sharp + the EasyOCR adapter), so requiring it here would
// pull a subprocess-spawning module into every CLI parse.
const TABLE_FRAME_BUDGET_MS_DEFAULT = 900000;

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
    batchCount: 5,
    batchSnapshots: false,
    batchTimestamp: null,
    batchWindowSeconds: 4,
    chartStreamParser: false,
    clusterMinFrequency: 2,
    confusionRadius: 1,
    ffmpegBin: 'ffmpeg',
    fps: 0.25,
    keepOcrCrops: false,
    maxCapturesPerVideo: 3,
    ocrEngine: 'tesseract',
    nativeOcrFrame: false,
    positionMergeMinOccurrences: 1,
    positionTableParser: false,
    ocrFrameWidth: 1280,
    outputKind: 'whiteboard',
    outputRoot: defaultOutputRoot,
    pipelineProfile: PIPELINE_PROFILE_DEFAULT,
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
    tableFrameBudgetMs: null,
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
      case '--pipeline-profile':
        options.pipelineProfile = String(nextValue);
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
      case '--table-frame-budget-ms':
        options.tableFrameBudgetMs = Number(nextValue);
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
      case '--cluster-min-frequency':
        options.clusterMinFrequency = Number(nextValue);
        index += 1;
        break;
      case '--position-merge-min-occurrences':
        options.positionMergeMinOccurrences = Number(nextValue);
        index += 1;
        break;
      case '--batch-snapshots':
        options.batchSnapshots = true;
        break;
      case '--batch-count':
        options.batchCount = Number(nextValue);
        index += 1;
        break;
      case '--batch-window':
        options.batchWindowSeconds = Number(nextValue);
        index += 1;
        break;
      case '--batch-time':
        options.batchTimestamp = Number(nextValue);
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
      case '--ocr-engine':
        options.ocrEngine = String(nextValue);
        index += 1;
        break;
      case '--keep-frames':
        options.keepFrames = true;
        break;
      case '--keep-ocr-crops':
        options.keepOcrCrops = true;
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

  if (!Number.isFinite(options.prefilterThreshold) || options.prefilterThreshold <= 0) {
    throw new Error('`--prefilter-threshold` must be a positive number.');
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

  if (!Number.isFinite(options.clusterMinFrequency) || !Number.isInteger(options.clusterMinFrequency) || options.clusterMinFrequency < 1) {
    throw new Error('`--cluster-min-frequency` must be an integer >= 1.');
  }

  if (!Number.isFinite(options.positionMergeMinOccurrences) || !Number.isInteger(options.positionMergeMinOccurrences) || options.positionMergeMinOccurrences < 1) {
    throw new Error('`--position-merge-min-occurrences` must be an integer >= 1.');
  }

  if (!Number.isFinite(options.confusionRadius) || options.confusionRadius < 0) {
    throw new Error('`--confusion-radius` must be zero or a positive number.');
  }

  if (options.tableFrameBudgetMs !== null
    && (!Number.isFinite(options.tableFrameBudgetMs) || options.tableFrameBudgetMs <= 0)) {
    throw new Error('`--table-frame-budget-ms` must be a positive number.');
  }

  if (!['tesseract', 'easyocr'].includes(options.ocrEngine)) {
    throw new Error(`Unsupported OCR engine: ${options.ocrEngine}. Use 'tesseract' or 'easyocr'.`);
  }

  if (!Number.isFinite(options.temporalDecay) || options.temporalDecay < 0) {
    throw new Error('`--temporal-decay` must be a non-negative number of seconds (0 to disable the boost).');
  }

  if (!Number.isFinite(options.phashHammingMax) || options.phashHammingMax < 0 || options.phashHammingMax > 64) {
    throw new Error('`--phash-hamming-max` must be an integer between 0 and 64.');
  }

  if (!['whiteboard', 'chart_stream', 'tale_of_the_tape', 'position_table'].includes(options.prefilterProfile)) {
    throw new Error(`Unsupported prefilter profile: ${options.prefilterProfile}`);
  }

  if (!SUPPORTED_PIPELINE_PROFILES.includes(options.pipelineProfile)) {
    throw new Error(
      `Unsupported pipeline profile: ${options.pipelineProfile}. `
      + `Use one of: ${SUPPORTED_PIPELINE_PROFILES.join(', ')}`
    );
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

  // tale_of_the_tape uses the center-right crop for the Positions table.
  if (options.prefilterProfile === 'tale_of_the_tape' && !options.phashRegion && !options.phashRegionFraction) {
    options.phashRegionFraction = parseFractionalRegion(TALE_OF_THE_TAPE_CROP_FRACTION);
  }

  // The positions-TABLE reader locates the table itself, so it needs no
  // fixed crop — but it does need a pHash region to tell captures apart.
  if (options.prefilterProfile === 'position_table' && !options.phashRegion && !options.phashRegionFraction) {
    options.phashRegionFraction = parseFractionalRegion(POSITION_TABLE_REGION_FRACTION);
  }

  // The crop the LEGACY chart-stream reader OCRs.
  //
  // In every profile except position_table this is the pHash region, which
  // is what the legacy reader has always been given. In table mode it is
  // NOT: the table profile's region is a capture-dedup rectangle covering
  // the whole right-hand strip, five times the area of the chart_stream
  // crop and in the wrong place for the legacy column filter. The legacy
  // reader is the chart-stream reader, so it gets the chart-stream crop.
  //
  // It also cannot be null: `runChartStreamOcr` destructures it, and in
  // table mode `--phash-region` (a PIXEL region) leaves the fractional one
  // unset — which used to crash the fail-safe path with a TypeError.
  options.chartStreamCropFraction = options.prefilterProfile === 'position_table'
    ? parseFractionalRegion(CHART_STREAM_REGION_FRACTION_DEFAULT)
    : options.phashRegionFraction;

  // chart_stream and tale_of_the_tape prefilters use the chart-stream parser.
  if (options.prefilterProfile === 'chart_stream' || options.prefilterProfile === 'tale_of_the_tape') {
    options.chartStreamParser = true;
  }

  // The positions-TABLE reader has its own pipeline, but it publishes its
  // result in the chart_stream shape, so the aggregator needs to be told.
  if (options.prefilterProfile === 'position_table') {
    options.chartStreamParser = true;
    options.positionTableParser = true;
    // The table's glyphs are ~6.8 SOURCE px tall. A 1280-wide OCR frame
    // makes them ~4.5 px and the panel reads as "US / D / WCU / W / KOCO"
    // instead of "UPST / DVN / NRGU / MOS / TQQQ" — so the table reader
    // needs the source pixels. This is not a preference: at 1280 the table
    // is not readable at all.
    //
    // So an explicit --ocr-frame-width is REFUSED rather than honoured:
    // in table mode the flag can only downscale the reader's input, never
    // improve on it, and honouring it would produce a silent, empty
    // result.
    if (argv.includes('--ocr-frame-width')) {
      throw new Error(
        '`--prefilter-profile position_table` cannot be combined with `--ocr-frame-width`: '
        + 'the table reader needs the source pixels, and a downscaled frame is not readable.'
      );
    }
    options.nativeOcrFrame = true;
    // The table reader is EasyOCR-only: it reads a narrow, upscaled strip
    // of the source frame, which is precisely what Tesseract's
    // document-trained model is worst at. Asking for Tesseract here would
    // silently run EasyOCR anyway, so it is refused instead.
    if (argv.includes('--ocr-engine') && options.ocrEngine !== 'easyocr') {
      throw new Error(
        '`--prefilter-profile position_table` requires the easyocr engine: the table '
        + 'reader reads an upscaled strip of the source frame, which tesseract cannot read.'
      );
    }
    options.ocrEngine = 'easyocr';
    // The table reader lives in the snapshot branch of the scan. With any
    // other output kind it would be silently ignored, which is worse than
    // being told the combination does not work.
    if (options.outputKind !== 'snapshot') {
      throw new Error(
        '`--prefilter-profile position_table` requires `--output-kind snapshot`: '
        + 'the table reader is part of the snapshot path.'
      );
    }
  }

  // chart_stream profile frames score 8-12 on valid dark position-list frames.
  // Lower the prefilter threshold to match the profile's own floor so frames
  // scoring 8-9 are not excluded before OCR. This is safe because the OCR frame
  // budget is capped separately (prefilterMaxFrames below) — a lower threshold
  // widens the candidate pool, and selectFramesForOcr still takes only the
  // highest-scoring N, so wall-clock cost does not grow.
  //
  // The guard must check whether the user PASSED the flag, not whether the key
  // exists in `options` — buildDefaultOptions always populates both keys, so an
  // `'x' in options` test is always true and the override would never fire.
  if (options.prefilterProfile === 'chart_stream' && !argv.includes('--prefilter-threshold')) {
    options.prefilterThreshold = 8;
  }

  // chart_stream mode benefits from multi-frame consensus — capture 2 frames so the
  // clusterer has enough data to filter single-frame OCR garbles.
  if (options.prefilterProfile === 'chart_stream' && !argv.includes('--max-captures')) {
    options.maxCapturesPerVideo = 2;
  }

  // Cap the OCR frame budget for chart_stream. EasyOCR runs ~60s/frame, so the
  // default 60-frame budget would mean a ~60 min/video scan. selectFramesForOcr
  // picks the highest-scoring frames, so 12 gives the same capture quality as
  // 60 at 1/5 the wall cost. Callers can still raise it via --prefilter-max-frames.
  if (options.prefilterProfile === 'chart_stream' && !argv.includes('--prefilter-max-frames')) {
    options.prefilterMaxFrames = 12;
  }

  // The positions-TABLE reader costs two OCR batches per frame (a title
  // probe over every candidate column, then a ticker read over the winner),
  // so the frame budget is much smaller than chart_stream's 12. Three
  // frames is enough for the multi-frame merge to have something to agree
  // on; the table itself does not change between them.
  if (options.prefilterProfile === 'position_table' && !argv.includes('--prefilter-threshold')) {
    options.prefilterThreshold = 8;
  }
  if (options.prefilterProfile === 'position_table' && !argv.includes('--prefilter-max-frames')) {
    options.prefilterMaxFrames = 3;
  }
  if (options.prefilterProfile === 'position_table' && !argv.includes('--max-captures')) {
    options.maxCapturesPerVideo = 2;
  }

  // The table reader's per-frame wall-clock budget. It is what bounds the
  // per-image OCR timeout, so it is the knob that keeps a frame with many
  // candidate columns from running for an hour.
  if (options.prefilterProfile === 'position_table' && !argv.includes('--table-frame-budget-ms')) {
    options.tableFrameBudgetMs = TABLE_FRAME_BUDGET_MS_DEFAULT;
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
  PIPELINE_PROFILE_DEFAULT,
  POSITION_TABLE_REGION_FRACTION,
  SUPPORTED_PIPELINE_PROFILES,
  TABLE_FRAME_BUDGET_MS_DEFAULT,
  TALE_OF_THE_TAPE_CROP_FRACTION,
  createProbeKey,
  parseArgs,
  parseFractionalRegion,
  parsePixelRegion,
  printHelp
};
