const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

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
  selectFramesForOcr,
  summarizeLumaBuffer
} = require('../src/video/ocrScanLogic');

test('scoreSnapshotCandidate ranks holdings-style frames strongly', () => {
  const score = scoreSnapshotCandidate({
    bottom_line: 'Breadth still healthy',
    gro_holdings: ['AAPL', 'MSFT', 'NVDA'],
    gro_metrics_raw: 'GRO RVAB: (1.45/1.51)',
    issue_codes: '',
    layout_type: 'gro_turbo',
    ocr_confidence: '84',
    parse_status: 'ok',
    turbo_holdings: ['TQQQ', 'SOXL'],
    turbo_metrics_raw: 'TURBO RVAB: (0.90/0.95)'
  });

  assert.ok(score >= 20);
});

test('scoreWhiteboardCandidate ranks dual-portfolio whiteboards strongly', () => {
  const score = scoreWhiteboardCandidate([
    {
      action_text: 'ADD TO LEADERS',
      bottom_line: 'Leaders intact',
      issue_codes: '',
      metric_1: '1.45',
      metric_2: '1.51',
      metric_scalar: '',
      metrics_raw: 'GRO RVAB: (1.45/1.51)',
      portfolio: 'GRO'
    },
    {
      action_text: 'TRIM SMALL CAPS',
      bottom_line: 'Leaders intact',
      issue_codes: '',
      metric_1: '0.90',
      metric_2: '0.95',
      metric_scalar: '',
      metrics_raw: 'TURBO RVAB: (0.90/0.95)',
      portfolio: 'TURBO'
    }
  ], 82);

  assert.ok(score >= 20);
});

test('summarizeLumaBuffer and scoreFramePrefilter favor bright text-heavy frames', () => {
  const whiteboardPixels = Buffer.alloc(160 * 90, 235);
  for (let rowIndex = 20; rowIndex < 70; rowIndex += 8) {
    for (let columnIndex = 10; columnIndex < 150; columnIndex += 3) {
      whiteboardPixels[(rowIndex * 160) + columnIndex] = 20;
    }
  }

  const darkScenePixels = Buffer.alloc(160 * 90, 60);
  const whiteboardStats = summarizeLumaBuffer(whiteboardPixels, 160, 90);
  const darkSceneStats = summarizeLumaBuffer(darkScenePixels, 160, 90);

  assert.ok(scoreFramePrefilter(whiteboardStats, 'whiteboard') > scoreFramePrefilter(darkSceneStats, 'whiteboard'));
});

test('selectFramesForOcr keeps strong candidates and nearby neighbors while capping volume', () => {
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: 3, timestamp: 0 },
    { frameIndex: 1, prefilterScore: 16, timestamp: 4 },
    { frameIndex: 2, prefilterScore: 15, timestamp: 8 },
    { frameIndex: 3, prefilterScore: 2, timestamp: 12 },
    { frameIndex: 4, prefilterScore: 17, timestamp: 16 },
    { frameIndex: 5, prefilterScore: 1, timestamp: 20 },
    { frameIndex: 6, prefilterScore: 14, timestamp: 24 }
  ], {
    maxFrames: 5,
    minFrames: 2,
    minScore: 14,
    neighborRadius: 1
  });

  assert.deepEqual(selected.map((row) => row.frameIndex), [1, 2, 3, 4, 5]);
});

test('analyzeFrameBeforeOcr can score a generated bright frame', async () => {
  const sharp = require('sharp');
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-prefilter-'));
  const filePath = path.join(tempDirectory, 'frame.png');
  const width = 160;
  const height = 90;
  const pixels = Buffer.alloc(width * height * 3, 240);

  for (let rowIndex = 15; rowIndex < 75; rowIndex += 10) {
    for (let columnIndex = 10; columnIndex < 150; columnIndex += 2) {
      const pixelIndex = ((rowIndex * width) + columnIndex) * 3;
      pixels[pixelIndex] = 10;
      pixels[pixelIndex + 1] = 10;
      pixels[pixelIndex + 2] = 10;
    }
  }

  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
  const stats = await analyzeFrameBeforeOcr(filePath);

  assert.ok(stats.brightRatio > 0.5);
  assert.ok(scoreFramePrefilter(stats, 'whiteboard') > 10);
});

test('groupContiguousCandidates and chooseBestWindow prefer longer later windows', () => {
  const windows = groupContiguousCandidates([
    { frameIndex: 1, score: 12, timestamp: 1 },
    { frameIndex: 2, score: 13, timestamp: 2 },
    { frameIndex: 6, score: 14, timestamp: 6 },
    { frameIndex: 7, score: 14, timestamp: 7 },
    { frameIndex: 8, score: 14, timestamp: 8 }
  ]);

  assert.equal(windows.length, 2);
  assert.deepEqual(chooseBestWindow(windows).map((row) => row.frameIndex), [6, 7, 8]);
});

test('chooseBestCandidate prefers score then confidence then later timestamp', () => {
  const selected = chooseBestCandidate([
    { ocrConfidence: 81, score: 14, timestamp: 20 },
    { ocrConfidence: 83, score: 14, timestamp: 18 },
    { ocrConfidence: 79, score: 15, timestamp: 12 }
  ]);

  assert.equal(selected.timestamp, 12);
});

test('inferDateKey prefers explicit date, then filename date, then mtime', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-scan-logic-'));
  const datedFile = path.join(tempDirectory, 'video_20250908_sample.mp4');
  fs.writeFileSync(datedFile, 'sample');

  assert.equal(inferDateKey(datedFile, '20250102'), '20250102');
  assert.equal(inferDateKey(datedFile), '20250908');
});

test('allocateOutputPath chooses whiteboard and snapshot collision-safe names', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-scan-output-'));
  const whiteboardFirst = allocateOutputPath(tempDirectory, 'whiteboard', '20250908');
  fs.writeFileSync(whiteboardFirst, 'sample');
  const whiteboardSecond = allocateOutputPath(tempDirectory, 'whiteboard', '20250908');

  const snapshotFirst = allocateOutputPath(tempDirectory, 'snapshot', '20250908');
  fs.writeFileSync(snapshotFirst, 'sample');
  const snapshotSecond = allocateOutputPath(tempDirectory, 'snapshot', '20250908');

  assert.match(whiteboardFirst, /20250908_ps\.png$/);
  assert.match(whiteboardSecond, /20250908_ps_2\.png$/);
  assert.match(snapshotFirst, /revere_20250908\.png$/);
  assert.match(snapshotSecond, /revere_20250908_2\.png$/);
});