'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProbeKey,
  parseArgs
} = require('../src/video/ocrScanArgs');

const TEST_OUTPUT_ROOT = path.resolve(__dirname, '..', 'data', 'ocr_probe_test_root');

function silentConsoleLog() {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
}

test('parseArgs returns defaults plus resolved --video path', () => {
  const options = parseArgs(['--video', 'sample.mp4'], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.videoPath, path.resolve('sample.mp4'));
  assert.equal(options.outputKind, 'whiteboard');
  assert.equal(options.outputRoot, TEST_OUTPUT_ROOT);
  assert.equal(options.fps, 0.25);
  assert.equal(options.sampleWidth, 640);
  assert.equal(options.ocrFrameWidth, 1280);
  assert.equal(options.prefilterThreshold, 14);
  assert.equal(options.prefilterMinFrames, 12);
  assert.equal(options.prefilterMaxFrames, 60);
  assert.equal(options.prefilterNeighbors, 1);
  assert.equal(options.strongThreshold, 6);
  assert.equal(options.reviewThreshold, 4);
  assert.equal(options.maxCapturesPerVideo, 3);
  assert.equal(options.progressInterval, 10);
  assert.equal(options.topCandidates, 5);
  assert.equal(options.keepFrames, undefined);
});

test('parseArgs honours every numeric and string option', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--date', '20250908',
    '--output-kind', 'snapshot',
    '--output-root', './custom-root',
    '--ffmpeg-bin', 'C:/ffmpeg/bin/ffmpeg.exe',
    '--fps', '0.5',
    '--sample-width', '480',
    '--ocr-frame-width', '960',
    '--prefilter-threshold', '10',
    '--prefilter-min-frames', '6',
    '--prefilter-max-frames', '24',
    '--prefilter-neighbors', '2',
    '--strong-threshold', '15',
    '--review-threshold', '8',
    '--max-captures', '5',
    '--progress-interval', '4',
    '--top-candidates', '7',
    '--keep-frames'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.dateKey, '20250908');
  assert.equal(options.outputKind, 'snapshot');
  assert.equal(options.outputRoot, path.resolve('./custom-root'));
  assert.equal(options.ffmpegBin, 'C:/ffmpeg/bin/ffmpeg.exe');
  assert.equal(options.fps, 0.5);
  assert.equal(options.sampleWidth, 480);
  assert.equal(options.ocrFrameWidth, 960);
  assert.equal(options.prefilterThreshold, 10);
  assert.equal(options.prefilterMinFrames, 6);
  assert.equal(options.prefilterMaxFrames, 24);
  assert.equal(options.prefilterNeighbors, 2);
  assert.equal(options.strongThreshold, 15);
  assert.equal(options.reviewThreshold, 8);
  assert.equal(options.maxCapturesPerVideo, 5);
  assert.equal(options.progressInterval, 4);
  assert.equal(options.topCandidates, 7);
  assert.equal(options.keepFrames, true);
});

test('parseArgs captures --run-tag as a free-form string (defaults to null)', () => {
  const defaultOptions = parseArgs(['--video', 'a.mp4'], { defaultOutputRoot: TEST_OUTPUT_ROOT });
  assert.equal(defaultOptions.runTag, undefined);

  const taggedOptions = parseArgs(
    ['--video', 'a.mp4', '--run-tag', 'run-2'],
    { defaultOutputRoot: TEST_OUTPUT_ROOT }
  );
  assert.equal(taggedOptions.runTag, 'run-2');
});

test('parseArgs prints help and returns null for --help', () => {
  const restore = silentConsoleLog();
  try {
    const result = parseArgs(['--help'], { defaultOutputRoot: TEST_OUTPUT_ROOT });
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('parseArgs throws when --video is missing', () => {
  assert.throws(
    () => parseArgs([], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /Missing required argument: --video/
  );
});

test('parseArgs rejects an unsupported output kind', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--output-kind', 'weird'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /Unsupported output kind: weird/
  );
});

test('parseArgs synthesizes videoPath from --video-dir + --file', () => {
  const options = parseArgs([
    '--video-dir', '/tmp/videos',
    '--file', 'clip.mp4'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.videoPath, path.resolve('/tmp/videos', 'clip.mp4'));
  assert.equal(options.videoDirectory, path.resolve('/tmp/videos'));
  assert.equal(options.fileName, 'clip.mp4');
});

test('parseArgs rejects non-positive --fps', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--fps', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--fps` must be a positive number/
  );

  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--fps', 'abc'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--fps` must be a positive number/
  );
});

test('parseArgs rejects non-positive --sample-width and --ocr-frame-width', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--sample-width', '-1'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--sample-width` must be a positive number/
  );

  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--ocr-frame-width', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--ocr-frame-width` must be a positive number/
  );
});

test('parseArgs rejects negative --prefilter-neighbors', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--prefilter-neighbors', '-1'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--prefilter-neighbors` must be zero or a positive number/
  );
});

test('parseArgs rejects non-positive --top-candidates and --progress-interval', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--top-candidates', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--top-candidates` must be a positive number/
  );

  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--progress-interval', '-3'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--progress-interval` must be a positive number/
  );
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--no-such-flag'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /Unknown argument: --no-such-flag/
  );
});

test('parseArgs rejects non-positive --prefilter-threshold', () => {
  // 0 would collapse selectFramesForOcr's dynamic-threshold floor to 0 and
  // cause the entire video to be OCR'd, blowing the OCR budget. There is no
  // semantic for "disable prefilter" in this tool, so reject 0 and negatives.
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--prefilter-threshold', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--prefilter-threshold` must be a positive number/
  );

  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--prefilter-threshold', '-3'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--prefilter-threshold` must be a positive number/
  );
});

test('parseArgs rejects non-positive --max-captures', () => {
  assert.throws(
    () => parseArgs(['--video', 'a.mp4', '--max-captures', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--max-captures` must be a positive number/
  );
});

test('createProbeKey is stable for the same absolute path', () => {
  const left = createProbeKey('/abs/path/clip.mp4', '20250908', 'whiteboard');
  const right = createProbeKey('/abs/path/clip.mp4', '20250908', 'whiteboard');
  assert.equal(left, right);
});

test('createProbeKey produces different keys for different paths or kinds', () => {
  const whiteboard = createProbeKey('/abs/path/clip.mp4', '20250908', 'whiteboard');
  const snapshot = createProbeKey('/abs/path/clip.mp4', '20250908', 'snapshot');
  const other = createProbeKey('/abs/path/other.mp4', '20250908', 'whiteboard');
  const laterDate = createProbeKey('/abs/path/clip.mp4', '20250909', 'whiteboard');

  assert.notEqual(whiteboard, snapshot);
  assert.notEqual(whiteboard, other);
  assert.notEqual(whiteboard, laterDate);
});

test('createProbeKey sanitizes special characters and falls back when empty', () => {
  const sanitized = createProbeKey('/path/with spaces & punctuation!.mp4', '20250908', 'whiteboard');
  assert.match(sanitized, /^20250908_[a-z0-9._-]+_[0-9a-f]{8}_whiteboard$/);
  assert.ok(!/\s/.test(sanitized));

  const fallback = createProbeKey('/path/!!!@@@', '20250908', 'whiteboard');
  assert.match(fallback, /^20250908_video_[0-9a-f]{8}_whiteboard$/);
});

test('chart_stream profile lowers the prefilter threshold and captures 2 frames by default', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'chart_stream'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.prefilterThreshold, 8);
  assert.equal(options.maxCapturesPerVideo, 2);
  assert.equal(options.chartStreamParser, true);
});

test('chart_stream profile honours explicit --prefilter-threshold and --max-captures', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'chart_stream',
    '--prefilter-threshold', '12',
    '--max-captures', '1'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.prefilterThreshold, 12);
  assert.equal(options.maxCapturesPerVideo, 1);
});

test('non chart_stream profiles keep the global defaults', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'whiteboard'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.prefilterThreshold, 14);
  assert.equal(options.maxCapturesPerVideo, 3);
});

// ---------------------------------------------------------------------------
// The positions-TABLE profile
// ---------------------------------------------------------------------------

test('the position_table profile sets up the table reader', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'position_table',
    '--output-kind', 'snapshot'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.positionTableParser, true);
  assert.equal(options.chartStreamParser, true, 'the table result is published in the chart_stream shape');
  assert.equal(options.nativeOcrFrame, true, 'the table glyphs are ~6.8 source px tall');
  assert.equal(options.ocrEngine, 'easyocr');
  assert.equal(options.prefilterMaxFrames, 3);
  assert.equal(options.maxCapturesPerVideo, 2);
  assert.equal(options.tableFrameBudgetMs, 900000);
});

test('the legacy reader is given the chart-stream crop, not the table region', () => {
  // The table profile's pHash region is a capture-dedup rectangle over the
  // whole right-hand strip. The LEGACY reader is the chart-stream reader,
  // so it must read the chart-stream crop — and the crop it gets must not
  // be null, because `runChartStreamOcr` destructures it.
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'position_table',
    '--output-kind', 'snapshot'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.deepEqual(options.chartStreamCropFraction, { x: 0.86, y: 0.62, w: 0.14, h: 0.22 });
  assert.notDeepEqual(options.chartStreamCropFraction, options.phashRegionFraction);
});

test('a pixel --phash-region still leaves the legacy reader a crop', () => {
  // `--phash-region` is a PIXEL region, so it leaves the fractional one
  // unset. The legacy crop used to be read from the fractional one, which
  // made the fail-safe path crash with a TypeError.
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'position_table',
    '--output-kind', 'snapshot',
    '--phash-region', '1600,300,120,420'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.phashRegionFraction, null);
  assert.deepEqual(options.chartStreamCropFraction, { x: 0.86, y: 0.62, w: 0.14, h: 0.22 });
});

test('the position_table profile refuses a non-snapshot output kind', () => {
  assert.throws(
    () => parseArgs([
      '--video', '/tmp/a.mp4',
      '--prefilter-profile', 'position_table'
    ], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /requires `--output-kind snapshot`/
  );
});

test('--table-frame-budget-ms overrides the frame budget', () => {
  const options = parseArgs([
    '--video', '/tmp/a.mp4',
    '--prefilter-profile', 'position_table',
    '--output-kind', 'snapshot',
    '--table-frame-budget-ms', '600000'
  ], { defaultOutputRoot: TEST_OUTPUT_ROOT });

  assert.equal(options.tableFrameBudgetMs, 600000);
});

test('parseArgs rejects a non-positive --table-frame-budget-ms', () => {
  assert.throws(
    () => parseArgs(['--video', '/tmp/a.mp4', '--table-frame-budget-ms', '0'], { defaultOutputRoot: TEST_OUTPUT_ROOT }),
    /`--table-frame-budget-ms` must be a positive number/
  );
});
