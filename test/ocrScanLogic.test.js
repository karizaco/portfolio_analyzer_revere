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
  detectIntroCard,
  extractObservedDate,
  formatDuration,
  groupContiguousCandidates,
  inferDateKey,
  scoreFramePrefilter,
  scoreSnapshotCandidate,
  scoreWhiteboardCandidate,
  scoreWhiteboardCandidateBreakdown,
  selectFramesForOcr,
  summarizeLumaBuffer
} = require('../src/video/ocrScanLogic');
const {
  computePerceptualHashFromPixels,
  hammingDistance,
  SOURCE_SIZE
} = require('../src/video/imageHash');
const { extractTickersFromOcrText } = require('../src/normalize/tickerScan');

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

test('scoreWhiteboardCandidate penalizes frames with no whiteboard keywords (browser chrome + chart)', () => {
  // Browser chrome + stock chart label OCR — high line/char density but zero
  // whiteboard-specific keywords. Must score well below the strong threshold.
  const browserChromeText = [
    'Safari File Edit View History Bookmarks Window Help',
    'Roundhill Magnificent Seven ETF',
    '$69.15 +0.11%',
    'Vol 3,260,889',
    'MAGS (-$0.37) -0.53%',
    '52-Wk High 3% to Pivot',
    'Updated: 04:00 PM ET'
  ].join('\n');

  const withChrome = scoreWhiteboardCandidate(
    [],
    33,
    {
      text: browserChromeText,
      lines: browserChromeText.split('\n')
    }
  );

  const dmiText = [
    'DAILY MARKET INSIGHT',
    'MARKET STATE: UPTREND',
    'WHAT HAPPENED TODAY?',
    'GRO -0.46% TURBO -0.53%',
    'BOTTOM LINE HEALTHY'
  ].join('\n');

  const withDmi = scoreWhiteboardCandidate(
    [],
    33,
    {
      text: dmiText,
      lines: dmiText.split('\n')
    }
  );

  assert.ok(withChrome < 6, `browser-chrome score ${withChrome} should be < strongThreshold (6)`);
  assert.ok(withDmi > 20, `DMI score ${withDmi} should clear strongThreshold`);
  assert.ok(withDmi > withChrome + 20, `DMI ${withDmi} must beat browser-chrome ${withChrome} by > 20 points`);
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

  // maxFrames=5 with uniformSampleCount=12 reserves floor(5*0.25)=1 slot
  // for the timeline-wide uniform sample. With 7 frames the uniform sample
  // picks frame 0. The remaining 4 budget goes to top-scoring seeds and
  // their neighbors (frames 1, 2, 3, 4 — the neighbor radius pulls in
  // frame 3 next to seed 2). Frame 5 loses out because the budget is full.
  assert.deepEqual(selected.map((row) => row.frameIndex), [0, 1, 2, 3, 4]);
});

test('selectFramesForOcr relaxes dynamic threshold when best score is below minScore', () => {
  // Simulates a video whose brightest frame is a low-contrast dense-text slide
  // (best prefilter = 10.6). The default minScore=14 would filter out the
  // trade-line window entirely; with relaxation, mid-range frames survive.
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: 10.6, timestamp: 0 },
    { frameIndex: 1, prefilterScore: 12.4, timestamp: 4 },
    { frameIndex: 2, prefilterScore: 11.8, timestamp: 8 },
    { frameIndex: 3, prefilterScore: 11.2, timestamp: 12 },
    { frameIndex: 4, prefilterScore: 9.8, timestamp: 16 },
    { frameIndex: 5, prefilterScore: 10.1, timestamp: 20 },
    { frameIndex: 6, prefilterScore: 11.9, timestamp: 24 }
  ], {
    maxFrames: 6,
    minFrames: 4,
    minScore: 14,
    neighborRadius: 0,
    uniformSampleCount: 0
  });

  // Every mid-range frame must survive — the relaxation floor (14 * 0.6 = 8.4)
  // lets dynamicThreshold = max(8.4, 10.6 - 3) = 8.4 capture them all.
  assert.deepEqual(selected.map((row) => row.frameIndex), [0, 1, 2, 3, 5, 6]);
});

test('selectFramesForOcr still rejects very low scores even after relaxation', () => {
  // Floor guard: a fully-black frame (score 0.5) must NOT pass even when the
  // best score is low, otherwise OCR would run on garbage.
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: 10.6, timestamp: 0 },
    { frameIndex: 1, prefilterScore: 12.4, timestamp: 4 },
    { frameIndex: 2, prefilterScore: 0.5, timestamp: 8 },
    { frameIndex: 3, prefilterScore: -2.1, timestamp: 12 }
  ], {
    maxFrames: 10,
    minFrames: 1,
    minScore: 14,
    neighborRadius: 0,
    uniformSampleCount: 0
  });

  // Only the two bright frames survive; the 0.5 and -2.1 frames are filtered
  // by the relaxed floor (max(8.4, 10.6-3) = 8.4).
  assert.deepEqual(selected.map((row) => row.frameIndex).sort((a, b) => a - b), [0, 1]);
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

test('extractObservedDate parses the long-form "WEEKDAY, MONTH DAY, YEAR" pattern', () => {
  // DAILY MARKET INSIGHT intro / agenda line — canonical 2026-09 corpus form
  assert.equal(extractObservedDate('THURSDAY, SEPTEMBER 11, 2026 — AGENDA'), '20260911');
  assert.equal(extractObservedDate('TUESDAY, SEPTEMBER 8, 2026'), '20260908');
  // Tolerant of missing commas and the OCR-dropped weekday suffix
  assert.equal(extractObservedDate('Mon March 4 2024'), '20240304');
});

test('extractObservedDate parses the short-form "WEEKDAY, M/D/YY" pattern', () => {
  // TALE OF THE TAPE header — historical videos in the corpus
  assert.equal(extractObservedDate('>> TALE OF THE TAPE — TUE, 11/15/22 <<'), '20221115');
  assert.equal(extractObservedDate('AGENDA — THURS, 9/8/26 <<'), '20260908');
  // Two-digit year >= 70 → 1900s
  assert.equal(extractObservedDate('SUN, 7/4/76'), '19760704');
});

test('extractObservedDate returns null for ambiguous or absent dates', () => {
  assert.equal(extractObservedDate(''), null);
  assert.equal(extractObservedDate('SPX +0.87% QQQ +1.38% MID +1.57%'), null);
  assert.equal(extractObservedDate('GROTECTION GAUGE'), null);
});

test('detectIntroCard flags WHAT\'S THE MARKET TREND? intro card', () => {
  const introText = [
    "WHAT'S THE MARKET TREND?",
    '"THE GROTECTION GAUGE"',
    'REVERE ASSET MANAGEMENT',
    'DAILY MARKET INSIGHT VIDEO',
    'AGENDA — TUE, 11/15/22',
    'SPX +0.87% QQQ +1.38% GRO +0.37%',
    'TALE OF THE TAPE',
    'CHARTS: OF INTEREST'
  ].join('\n');

  assert.equal(detectIntroCard(introText), true);
  // Tolerant of OCR-dropped apostrophe
  assert.equal(detectIntroCard(introText.replace("WHAT'S", 'WHATS')), true);
});

test('detectIntroCard rejects real Daily Market Insight / Tale of the Tape slides', () => {
  const dmiText = [
    '>> TALE OF THE TAPE — TUE, 11/15/22 <<',
    'MARKET STATE: BEAR MARKET RALLY > R',
    'HEADWINDS: USD, INFLATION, FED TAPER',
    'TECHNICAL: INDEXES & G-6',
    'BULL CASE: INITIATE RALLY & RECLAIM 21EMA',
    'BEAR CASE: RALLY FAIL, BREAK 21EMA',
    'NEWS: PPI LESS THAN EXP',
    'LEVELS: SPX vs 3800',
    'PORTFOLIO/RVAB: (0.70/0.63) ADD 5% UWM',
    'BOTTOM LINE: BOUNCE',
    'S&P500 KEY LEVELS'
  ].join('\n');

  assert.equal(detectIntroCard(dmiText), false);
  // Even with the intro headline forced in, real slide negatives win
  const forced = "WHAT'S THE MARKET TREND?\n" + dmiText;
  assert.equal(detectIntroCard(forced), false);
});

test('scoreWhiteboardCandidateBreakdown exposes additive components and matches the wrapper total', () => {
  const rows = [
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
  ];

  const ocrResult = {
    lines: rows.map(() => ''),
    text: 'DAILY MARKET INSIGHT\nMARKET STATE: UPTREND\nGRO RVAB TURBO RVAB\nBOTTOM LINE HEALTHY\n'
  };

  const breakdown = scoreWhiteboardCandidateBreakdown(rows, 80, ocrResult);
  assert.equal(typeof breakdown.total, 'number');
  assert.equal(breakdown.total, scoreWhiteboardCandidate(rows, 80, ocrResult));
  // Component buckets must sum (approximately) to the total — allow small float drift.
  const componentSum = Object.values(breakdown.components).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(componentSum - breakdown.total) < 0.05,
    `components ${componentSum} should match total ${breakdown.total}`);
  // Each row contributes: metrics_raw (+6) + metric_1 (+2) + metric_2 (+2) +
  // action_text (+1) + bottom_line (+2) = +13. metric_scalar is the empty
  // string so the `if (row.metric_scalar)` guard skips it. Two rows ⇒ 26.
  assert.equal(breakdown.components.per_row_metrics, 26);
  assert.equal(breakdown.components.pair_bonus, 4);
  assert.equal(breakdown.components.keyword_guard, 0);
  // ocrConfidence 80 / 20 = 4
  assert.equal(breakdown.components.ocr_confidence_bonus, 4);
});

test('extractTickersFromOcrText returns the seed-lexicon tickers present in OCR text', () => {
  const text = [
    '>> TALE OF THE TAPE — TUE, 11/15/22 <<',
    'GRO HOLDINGS: TQQQ UPRO SPYM',
    'TURBO HOLDINGS: TQQQ SSO',
    'ADD 5% GEV TRIM 3% PLTR'
  ].join('\n');

  const tickers = extractTickersFromOcrText(text);
  // All four are seed-lexicon members; PLTR is in the seed but we don't assert
  // its presence here because the strict-shape check on the noisy OCR variant
  // could prune it.
  assert.ok(tickers.includes('TQQQ'), `expected TQQQ in ${JSON.stringify(tickers)}`);
  assert.ok(tickers.includes('UPRO'), `expected UPRO in ${JSON.stringify(tickers)}`);
  assert.ok(tickers.includes('SPYM'), `expected SPYM in ${JSON.stringify(tickers)}`);
  assert.ok(tickers.includes('SSO'), `expected SSO in ${JSON.stringify(tickers)}`);
  // Dedup: TQQQ appears twice in source but only once in output.
  assert.equal(tickers.filter((t) => t === 'TQQQ').length, 1);
  // Non-seed tickers (NVDA, TSLA) and OCR fragments (TALE, TUE) must not
  // be reported — fuzzy correction is intentionally disabled.
  assert.ok(!tickers.includes('TALE'), `TALE leaked through fuzzy correction: ${tickers}`);
  assert.ok(!tickers.includes('TUE'), `TUE leaked through fuzzy correction: ${tickers}`);
});

test('extractTickersFromOcrText returns an empty array for OCR text without tickers', () => {
  assert.deepEqual(extractTickersFromOcrText(''), []);
  assert.deepEqual(extractTickersFromOcrText('Tale of the Tape — Tue, 11/15/22 — header only'), []);
});

test('computePerceptualHashFromPixels is deterministic for identical input', () => {
  const pixels = new Uint8Array(SOURCE_SIZE * SOURCE_SIZE);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 7) % 256;
  }
  const hashA = computePerceptualHashFromPixels(pixels);
  const hashB = computePerceptualHashFromPixels(pixels);
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 16); // 64 bits -> 16 hex chars
});

test('computePerceptualHashFromPixels produces different hashes for different inputs', () => {
  const uniformLight = new Uint8Array(SOURCE_SIZE * SOURCE_SIZE).fill(240);
  const checkerboard = new Uint8Array(SOURCE_SIZE * SOURCE_SIZE);
  for (let rowIndex = 0; rowIndex < SOURCE_SIZE; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < SOURCE_SIZE; columnIndex += 1) {
      checkerboard[(rowIndex * SOURCE_SIZE) + columnIndex] = (rowIndex + columnIndex) % 2 === 0 ? 240 : 10;
    }
  }
  const distance = hammingDistance(
    computePerceptualHashFromPixels(uniformLight),
    computePerceptualHashFromPixels(checkerboard)
  );
  // Different content should flip many bits. We don't pin an exact threshold
  // (the 64-bit DCT can collapse some patterns) but the distance MUST exceed
  // a strict share of bits to count as "different content".
  assert.ok(distance > 10, `expected hash distance > 10, got ${distance}`);
});

test('hammingDistance computes the maximum value for opposite hex strings', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('aaaaaaaaaaaaaaaa', '5555555555555555'), 64);
});

test('formatDuration formats seconds into zero-padded HH:MM:SS', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(7), '00:00:07');
  assert.equal(formatDuration(65), '00:01:05');
  assert.equal(formatDuration(3600 + 90), '01:01:30');
  // Defensive: negative / non-finite inputs fall back to zero rather than NaN.
  assert.equal(formatDuration(-5), '00:00:00');
  assert.equal(formatDuration(NaN), '00:00:00');
});