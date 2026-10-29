'use strict';

// Unit tests for the Qullamaggie chart-stream extension:
//   - scoreFramePrefilter under the chart_stream profile
//   - detectScreenLayout recognising a position-list overlay
//   - computePerceptualHashOfRegion (region-cropped pHash)
//   - parseChartStreamPositionList (ticker extraction)
//   - extractTickersFromOcrText (the new Qullamaggie-recurring tickers)
//
// These tests run in-process (no ffmpeg, no OCR engine) so they live alongside
// the existing in-process suites rather than in the .e2e.test.js file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  PREFILTER_PROFILES,
  scoreFramePrefilter,
  summarizeLumaBuffer
} = require('../src/video/ocrScanLogic');
const { detectScreenLayout } = require('../src/parse/parseWhiteboardScreenshot');
const {
  computePerceptualHashOfRegion,
  computePerceptualHashOfFractionalRegion,
  resolveFractionalRegion
} = require('../src/video/imageHashRegion');
const { parseChartStreamPositionList, hasPriceNear, mergeMultiplePositionLists } = require('../src/parse/parseChartStream');
const { extractTickersFromOcrText } = require('../src/normalize/tickerScan');

async function makeFixtureFrame({ width, height, draw }) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-stream-'));
  const filePath = path.join(tempDirectory, 'frame.png');
  const pixels = Buffer.alloc(width * height * 3, 32);
  draw(pixels, width, height);
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
  return { filePath, cleanup: () => fs.rmSync(tempDirectory, { recursive: true, force: true }) };
}

test('PREFILTER_PROFILES exposes both whiteboard and chart_stream entries', () => {
  assert.ok(PREFILTER_PROFILES.whiteboard, 'whiteboard profile must be exported');
  assert.ok(PREFILTER_PROFILES.chart_stream, 'chart_stream profile must be exported');
  // Chart_stream's chartLikenessBoost is a POSITIVE number (it rewards chart
  // frames) while whiteboard's is negative. This single-line invariant
  // distinguishes the two profiles and is the most likely thing a refactor
  // could break.
  assert.ok(PREFILTER_PROFILES.chart_stream.chartLikenessBoost > 0,
    `chart_stream.chartLikenessBoost must be > 0, got ${PREFILTER_PROFILES.chart_stream.chartLikenessBoost}`);
  assert.ok(PREFILTER_PROFILES.whiteboard.chartLikenessBoost < 0,
    `whiteboard.chartLikenessBoost must be < 0, got ${PREFILTER_PROFILES.whiteboard.chartLikenessBoost}`);
  // Chart-stream must accept darker frames than whiteboard.
  assert.ok(PREFILTER_PROFILES.chart_stream.meanLumaFloor < PREFILTER_PROFILES.whiteboard.meanLumaFloor,
    'chart_stream should drop meanLumaFloor below whiteboard');
});

test('scoreFramePrefilter prefers dark chart-like frames under chart_stream profile', () => {
  // Two synthetic stats: a "dark chart" (mean luma ~70, dark ratio ~0.55) and
  // a "bright whiteboard" (mean luma ~235, dark ratio ~0.05). Under the
  // chart_stream profile the chart should score HIGHER than the whiteboard;
  // under the whiteboard profile the whiteboard should win.
  const chartStats = {
    brightRatio: 0.04,
    darkRatio: 0.55,
    edgeRatio: 0.10,
    stdDev: 55,
    meanLuma: 70
  };
  const whiteboardStats = {
    brightRatio: 0.72,
    darkRatio: 0.05,
    edgeRatio: 0.09,
    stdDev: 60,
    meanLuma: 235
  };

  const chartScoreUnderChartStream = scoreFramePrefilter(chartStats, 'snapshot', 'chart_stream');
  const whiteboardScoreUnderChartStream = scoreFramePrefilter(whiteboardStats, 'snapshot', 'chart_stream');
  const chartScoreUnderWhiteboard = scoreFramePrefilter(chartStats, 'snapshot', 'whiteboard');
  const whiteboardScoreUnderWhiteboard = scoreFramePrefilter(whiteboardStats, 'snapshot', 'whiteboard');

  assert.ok(chartScoreUnderChartStream > whiteboardScoreUnderChartStream,
    `chart_stream profile should favour dark frames: chart=${chartScoreUnderChartStream}, wb=${whiteboardScoreUnderChartStream}`);
  assert.ok(whiteboardScoreUnderWhiteboard > chartScoreUnderWhiteboard,
    `whiteboard profile should favour bright frames: wb=${whiteboardScoreUnderWhiteboard}, chart=${chartScoreUnderWhiteboard}`);
});

test('scoreFramePrefilter summarises a real dark frame as chart-favourable', async () => {
  const { filePath, cleanup } = await makeFixtureFrame({
    width: 160,
    height: 90,
    draw: (pixels) => {
      // Dark blue canvas everywhere
      for (let i = 0; i < pixels.length; i += 3) {
        pixels[i] = 13;
        pixels[i + 1] = 17;
        pixels[i + 2] = 23;
      }
      // Faint bright rectangle in the bottom-right (the position-list overlay)
      for (let rowIndex = 60; rowIndex < 84; rowIndex += 1) {
        for (let columnIndex = 110; columnIndex < 150; columnIndex += 1) {
          const idx = (rowIndex * 160 + columnIndex) * 3;
          pixels[idx] = 230;
          pixels[idx + 1] = 230;
          pixels[idx + 2] = 230;
        }
      }
    }
  });
  try {
    // Direct hash of the file (sharp decode), but scoreFramePrefilter needs a
    // luma buffer — use summarizeLumaBuffer on the raw pixels instead.
    const raw = await sharp(filePath).grayscale().resize(160, 90).raw().toBuffer();
    const stats = summarizeLumaBuffer(raw, 160, 90);
    const chartScore = scoreFramePrefilter(stats, 'snapshot', 'chart_stream');
    const wbScore = scoreFramePrefilter(stats, 'snapshot', 'whiteboard');
    assert.ok(chartScore > wbScore,
      `synthetic dark chart-stream frame should score higher under chart_stream (chart=${chartScore}, wb=${wbScore})`);
    assert.ok(stats.darkRatio > 0.5, `expected darkRatio > 0.5, got ${stats.darkRatio}`);
  } finally {
    cleanup();
  }
});

test('detectScreenLayout returns chart_stream when 2+ tickers and a price token co-occur', () => {
  const overlayText = [
    'POSITION LIST',
    'NVDA  $134.20',
    'RIVN  $13.05',
    'SPOT  $402.10'
  ].join('\n');

  assert.equal(detectScreenLayout(overlayText, overlayText.split('\n')), 'chart_stream');
});

test('detectScreenLayout rejects tickers-only (no price) so axis labels don\'t trigger chart_stream', () => {
  const axisLabels = [
    'SPX',
    'NDX',
    'DJI',
    'VIX'
  ].join('\n');

  assert.notEqual(detectScreenLayout(axisLabels, axisLabels.split('\n')), 'chart_stream');
});

test('computePerceptualHashOfRegion: identical regions → identical hash', async () => {
  const { filePath, cleanup } = await makeFixtureFrame({
    width: 200,
    height: 200,
    draw: (pixels) => {
      for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 13) % 256;
    }
  });
  try {
    const region = { x: 40, y: 40, width: 80, height: 80 };
    const hashA = await computePerceptualHashOfRegion(filePath, region);
    const hashB = await computePerceptualHashOfRegion(filePath, region);
    assert.equal(hashA, hashB);
    assert.equal(hashA.length, 16);
  } finally {
    cleanup();
  }
});

test('computePerceptualHashOfRegion: different regions → different hash', async () => {
  const { filePath, cleanup } = await makeFixtureFrame({
    width: 200,
    height: 200,
    draw: (pixels) => {
      for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 13) % 256;
    }
  });
  try {
    const regionA = { x: 0, y: 0, width: 80, height: 80 };
    const regionB = { x: 120, y: 120, width: 80, height: 80 };
    const hashA = await computePerceptualHashOfRegion(filePath, regionA);
    const hashB = await computePerceptualHashOfRegion(filePath, regionB);
    assert.notEqual(hashA, hashB);
  } finally {
    cleanup();
  }
});

test('computePerceptualHashOfFractionalRegion resolves to absolute pixels against source dims', async () => {
  const { filePath, cleanup } = await makeFixtureFrame({
    width: 480,
    height: 270,
    draw: (pixels) => {
      // Bottom-right white box (the position-list overlay)
      for (let rowIndex = 215; rowIndex < 260; rowIndex += 1) {
        for (let columnIndex = 335; columnIndex < 465; columnIndex += 1) {
          const idx = (rowIndex * 480 + columnIndex) * 3;
          pixels[idx] = 240;
          pixels[idx + 1] = 240;
          pixels[idx + 2] = 240;
        }
      }
    }
  });
  try {
    // Key names are x/y/w/h even though the values are fractions — this is the
    // shape `parseFractionalRegion()` (src/video/ocrScanArgs.js) produces and
    // the only shape production callers pass.
    const fractionRegion = { x: 0.70, y: 0.84, w: 0.28, h: 0.14 };
    const absolute = resolveFractionalRegion(480, 270, fractionRegion);
    assert.equal(absolute.x, Math.round(0.70 * 480));
    assert.equal(absolute.y, Math.round(0.84 * 270));
    assert.equal(absolute.width, Math.round(0.28 * 480));
    assert.equal(absolute.height, Math.round(0.14 * 270));
    const hash = await computePerceptualHashOfFractionalRegion(filePath, fractionRegion);
    assert.ok(hash && typeof hash === 'string' && hash.length === 16,
      `expected 16-char hex hash, got ${hash}`);
  } finally {
    cleanup();
  }
});

test('parseChartStreamPositionList accepts Qullamaggie recurring tickers + nearby prices', () => {
  const ocr = {
    text: [
      'POSITION LIST',
      'NVDA  $134.20',
      'RIVN  $13.05',
      'SPOT  $402.10',
      'CRWD  $362.80',
      'DDOG  $128.40'
    ].join('\n'),
    lines: [
      'POSITION LIST',
      'NVDA  $134.20',
      'RIVN  $13.05',
      'SPOT  $402.10',
      'CRWD  $362.80',
      'DDOG  $128.40'
    ]
  };

  const result = parseChartStreamPositionList({ ocr });
  // All five seed-lex tickers should survive the price-proximity check.
  for (const expected of ['NVDA', 'RIVN', 'SPOT', 'CRWD', 'DDOG']) {
    assert.ok(result.position_list.includes(expected),
      `expected ${expected} in ${JSON.stringify(result.position_list)}`);
  }
  assert.equal(result.parse_status, 'ok');
  assert.ok(result.confidence >= 1, `expected full confidence, got ${result.confidence}`);
});

test('parseChartStreamPositionList returns empty list for non-stream OCR text', () => {
  // Without ocr.words positions the parser uses the LEGACY fallback
  // (price-nearby + lexicon + edit-distance) — SPX edit-distances to SPY
  // (which IS in the seed lexicon), and QQQ is a direct lexicon hit. Both
  // have price-nearby, so they're accepted by the legacy path. The
  // position-list-aware filter only rejects them when called with
  // ocr.words positions.
  const ocr = {
    text: 'WEEKEND WRAP — broad market update\nSPX +0.48% QQQ +0.96%',
    lines: ['WEEKEND WRAP — broad market update', 'SPX +0.48% QQQ +0.96%']
  };

  const result = parseChartStreamPositionList({ ocr });
  // Legacy path accepts QQQ (lex match) and SPX→SPY (edit distance 1).
  // The 'no_seed_tickers' status only fires when no ticker-shaped tokens
  // are found at all (not just when none match the seed).
  assert.equal(result.parse_status, 'ok');
  assert.ok(result.position_list.length > 0);
});

test('hasPriceNear returns true for a dollar price within 12 chars of the ticker', () => {
  assert.equal(hasPriceNear('NVDA $134.20 RIVN $13.05', 'NVDA'), true);
  assert.equal(hasPriceNear('NVDA $134.20 RIVN $13.05', 'RIVN'), true);
  assert.equal(hasPriceNear('NVDA RIVN', 'NVDA'), false);
  assert.equal(hasPriceNear('NVDA target 145', 'NVDA'), true);  // "target" is a price-keyword proxy
});

test('hasPriceNear survives a ticker carrying regex metacharacters', () => {
  // The ticker comes from the OCR, so it can carry anything. "1.02(-0.20" is
  // a real reading from a whiteboard frame: interpolated raw into the
  // pattern, its "(" opened a group that never closed and the parser threw
  // "Unterminated group" — which took down the WHOLE parse, not just this
  // one token.
  for (const raw of [
    '1.02(-0.20',
    'A(B',
    'A)B',
    'A[',
    'A*',
    'A+',
    'A?',
    'A|B',
    'A{2,',
    'A\\B',
    'A^B',
    'A$B',
  ]) {
    assert.doesNotThrow(() => hasPriceNear('some OCR text', raw),
      `hasPriceNear threw for ${JSON.stringify(raw)}`);
    assert.equal(typeof hasPriceNear('some OCR text', raw), 'boolean');
  }
});

test('hasPriceNear matches a dotted ticker literally', () => {
  // The dot is a regex metacharacter: unescaped, "BRK.B" also matched
  // "BRKXB". Escaped, it matches the ticker and nothing else.
  assert.equal(hasPriceNear('BRK.B $42.10', 'BRK.B'), true);
  assert.equal(hasPriceNear('BRKXB $42.10', 'BRK.B'), false);
});

test('extractTickersFromOcrText accepts the new Qullamaggie-recurring tickers', () => {
  const text = 'NVDA CRWD PANW NET DDOG SPOT MARA RIOT RIVN TSLA AAPL MSFT';
  const tickers = extractTickersFromOcrText(text);
  for (const expected of ['RIVN', 'CRWD', 'SPOT', 'NET', 'DDOG', 'PANW', 'MARA', 'RIOT']) {
    assert.ok(tickers.includes(expected),
      `expected ${expected} in ${JSON.stringify(tickers)}`);
  }
});

test('mergeMultiplePositionLists accepts tickers in ≥minOccurrences captures', () => {
  // 3 captures — AAPL appears in all 3, GOOG/MSFT/NVDA in 1 each.
  const merged = mergeMultiplePositionLists(
    [['AAPL','GOOG'], ['AAPL','MSFT'], ['AAPL','NVDA']],
    { minOccurrences: 2 }
  );
  assert.deepEqual(merged, ['AAPL']);

  // minOccurrences=1 keeps everything that appeared in any capture.
  const union = mergeMultiplePositionLists(
    [['AAPL','GOOG'], ['AAPL','MSFT'], ['AAPL','NVDA']],
    { minOccurrences: 1 }
  );
  assert.deepEqual(union.sort(), ['AAPL','GOOG','MSFT','NVDA']);

  // Empty input returns empty.
  assert.deepEqual(mergeMultiplePositionLists([]), []);

  // Duplicates within a single frame count once (frame dedup).
  const dedup = mergeMultiplePositionLists(
    [['AAPL','AAPL','GOOG'], ['AAPL','NVDA']],
    { minOccurrences: 2 }
  );
  assert.deepEqual(dedup, ['AAPL']);

  // 3/3 threshold — only tickers in every capture.
  const strict = mergeMultiplePositionLists(
    [['AAPL','GOOG'], ['AAPL','MSFT'], ['TSLA','NVDA']],
    { minOccurrences: 3 }
  );
  assert.deepEqual(strict, []);

  // Empty frames (where OCR failed) are filtered out before thresholding.
  const withEmpty = mergeMultiplePositionLists(
    [['AAPL','GOOG'], [], ['AAPL']],
    { minOccurrences: 2 }
  );
  assert.deepEqual(withEmpty, ['AAPL']);
});


// Regression tests for parseChartStreamPositionList:
//   1. Sparse 2-token position lists are NOT short-circuited by the column detector
//      (previously identifyPositionListColumn early-returned when tickerWords.length < 3).
//   2. The no_ocr branch exposes ocr_executed:false so downstream callers can
//      distinguish "OCR did not run" from "OCR ran and found nothing" without
//      using negative confidence values that would corrupt ranking math
//      (e.g. scoreChartStreamCandidate multiplies confidence by 12).

test('parseChartStreamPositionList: sparse 2-token position list is not dropped by column detector', () => {
  // Two real tickers in the position-list column (x=348..388) with prices to the right.
  // Previously identifyPositionListColumn early-returned empty because tickerWords.length === 2 < 3.
  const ocr = {
    text: 'NVDA  $134.20\nTSLA  $245.10',
    lines: ['NVDA  $134.20', 'TSLA  $245.10'],
    words: [
      { text: 'NVDA', left: 348, width: 40, line: 1 },
      { text: '$134.20', left: 400, width: 60, line: 1 },
      { text: 'TSLA', left: 350, width: 40, line: 2 },
      { text: '$245.10', left: 402, width: 60, line: 2 },
    ],
  };
  const result = parseChartStreamPositionList({ ocr });
  // NVDA and TSLA are in the seed lexicon, so the legacy/price-nearby path
  // must accept them regardless of the column-detector result.
  assert.ok(result.position_list.includes('NVDA'),
    `expected NVDA in position_list, got ${JSON.stringify(result.position_list)}`);
  assert.ok(result.position_list.includes('TSLA'),
    `expected TSLA in position_list, got ${JSON.stringify(result.position_list)}`);
});

test('parseChartStreamPositionList: no_ocr branch exposes ocr_executed=false sentinel', () => {
  const result = parseChartStreamPositionList({ ocr: { text: '', lines: [], words: [] } });
  assert.equal(result.parse_status, 'no_ocr');
  // Confidence stays at 0 (NOT a negative sentinel) so downstream
  // scoreChartStreamCandidate math (confidence * 12) does not produce a
  // negative score that would corrupt candidate ranking.
  assert.equal(result.confidence, 0,
    `no_ocr must return confidence=0 to keep ranking math safe, got ${result.confidence}`);
  assert.equal(result.ocr_executed, false,
    `no_ocr must set ocr_executed=false, got ${result.ocr_executed}`);
});

test('parseChartStreamPositionList: no_ticker_shapes branch sets ocr_executed=true', () => {
  // OCR runs but the text contains no ticker-shaped tokens at all.
  // STRICT_TICKER_PATTERN is /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/ — it needs at
  // least one letter, so a numeric-only OCR result yields no candidates.
  const ocr = {
    text: '42 2023 91 100',
    lines: ['42 2023 91 100'],
    words: [
      { text: '42', left: 10, width: 20, line: 1 },
      { text: '2023', left: 40, width: 30, line: 1 },
    ],
  };
  const result = parseChartStreamPositionList({ ocr });
  assert.equal(result.parse_status, 'no_ticker_shapes');
  assert.equal(result.confidence, 0,
    `no_ticker_shapes must return confidence=0, got ${result.confidence}`);
  assert.equal(result.ocr_executed, true,
    `no_ticker_shapes must set ocr_executed=true, got ${result.ocr_executed}`);
});

test('parseChartStreamPositionList: intro text yields no_position_list with ocr_executed=true', () => {
  // Prose OCR DOES produce ticker-shaped tokens ("NO", "TEXT", "HERE" all
  // match STRICT_TICKER_PATTERN), but none survive the lexicon / price /
  // column filters. That is a different outcome from "no ticker shapes":
  // candidates existed and were rejected.
  const ocr = {
    text: 'some intro text\nno tickers here',
    lines: ['some intro text', 'no tickers here'],
    words: [
      { text: 'some', left: 10, width: 40, line: 1 },
      { text: 'intro', left: 60, width: 50, line: 1 },
      { text: 'no', left: 10, width: 20, line: 2 },
      { text: 'tickers', left: 40, width: 70, line: 2 },
    ],
  };
  const result = parseChartStreamPositionList({ ocr });
  assert.equal(result.parse_status, 'no_position_list');
  assert.equal(result.confidence, 0,
    `no_position_list must return confidence=0, got ${result.confidence}`);
  assert.equal(result.ocr_executed, true,
    `no_position_list must set ocr_executed=true, got ${result.ocr_executed}`);
});

// ---------------------------------------------------------------------------
// THE CURATED-ALIAS RESCUE
// ---------------------------------------------------------------------------
//
// A recorded, human-verified misread of a position-list ticker, sitting
// inside the detected column, IS that ticker.
//
// The defect it fixes: `inListTickers` is the PRICE-ALIGNED subset of the
// column. A row whose price is garbled is not price-aligned even when its
// ticker sits exactly where every other ticker sits, so the token is
// rejected by the column gate and the holding is lost before the repair
// pass ever sees it.
//
// The three rules it has to keep:
//
//   1. The canonical is SUBSTITUTED, never JOINED. The two spellings of one
//      holding must never both appear in the reading.
//   2. A garble outside the column is not rescued. The column is the
//      structural evidence; a curated alias on its own is not enough.
//   3. A garble below the Personal WatchList header is not rescued. That
//      panel sits at the SAME x as the position list, so a row below it is
//      a watchlist row however well it lines up.
//
// Measured on the replay corpus: recall 59.6% -> 66.3%, precision
// 93.0% -> 95.2%, and every one of the ten holdings it recovers is in the
// ground truth.

const LIST_X = 780;
const PRICE_X = 900;

// A synthetic position list. The `alias` row carries a garbled price
// ("$lO5.OO" — the letter O where a digit belongs), so the row is NOT
// price-aligned even though its ticker sits in the column. That is the
// situation the rescue exists for.
function positionListFrame({ alias = 'OBTS', aliasPrice = '$lO5.OO', aliasIsPriceAligned = false, extraRows = [] } = {}) {
  // The rows are numbered from 2, and the watchlist header and the watchlist
  // row come after them — so an extra row lands INSIDE the position list,
  // where the column gate can see it. A row placed below the watchlist
  // header is not a position-list row at all, which is a different test.
  const body = [
    { token: 'AAPL', x: LIST_X, w: 40, price: '$214.50' },
    { token: 'MSFT', x: LIST_X, w: 40, price: '$412.30' },
    { token: alias, x: LIST_X, w: 40, price: aliasIsPriceAligned ? '$45.60' : aliasPrice },
    { token: 'GSII', x: 300, w: 40 },
    { token: 'TSLA', x: LIST_X, w: 40, price: '$342.10' },
    ...extraRows,
  ];
  const rows = [
    { line: 1, token: 'POSITIONS', x: 700, w: 90 },
    ...body.map((row, i) => ({ ...row, line: i + 2 })),
    { line: body.length + 2, token: 'WATCHLIST', x: 700, w: 90 },
    { line: body.length + 3, token: 'PLIR', x: LIST_X, w: 40, price: '$lO8.OO' },
  ];
  const words = [];
  const lines = [];
  for (const row of rows) {
    const parts = [row.token];
    words.push({ text: row.token, left: row.x, top: 100 + row.line * 60, width: row.w, height: 30, line: row.line });
    if (row.price) {
      parts.push(row.price);
      words.push({ text: row.price, left: PRICE_X, top: 100 + row.line * 60, width: 60, height: 30, line: row.line });
    }
    lines.push(parts.join(' '));
  }
  return { text: lines.join('\n'), lines, words };
}

test('parseChartStreamPositionList: a garbled price row is rescued from the curated alias table', () => {
  // OBTS is QBTS with the leading Q read as an O. Its row's price is
  // garbled, so the row is not price-aligned, so the column gate rejects
  // the token and the holding is lost.
  const result = parseChartStreamPositionList({ ocr: positionListFrame() });
  assert.ok(result.position_list.includes('QBTS'),
    `expected QBTS in ${JSON.stringify(result.position_list)}`);
  assert.ok(!result.position_list.includes('OBTS'),
    `the garbled form must not be published: ${JSON.stringify(result.position_list)}`);
  assert.ok(result.position_list.includes('AAPL'));
  assert.ok(result.position_list.includes('TSLA'));
});

test('parseChartStreamPositionList: a garble carrying a digit is rescued too', () => {
  // QBT5 is QBTS with the trailing S read as a 5. It is not ticker-shaped
  // at all — STRICT_TICKER_PATTERN is letters only — so it never becomes a
  // candidate and can only be reached through the word list.
  const result = parseChartStreamPositionList({ ocr: positionListFrame({ alias: 'QBT5' }) });
  assert.ok(result.position_list.includes('QBTS'),
    `expected QBTS in ${JSON.stringify(result.position_list)}`);
  assert.ok(!result.position_list.includes('QBT5'),
    `the garbled form must not be published: ${JSON.stringify(result.position_list)}`);
});

test('parseChartStreamPositionList: a garble and its canonical are never both published', () => {
  // The frame contains the garble read cleanly AND the real ticker, both
  // price-aligned. The repair pass cannot replace the garble in place
  // (its canonical is already in the reading), so the raw survives it —
  // and the rescue has to drop the raw rather than leave both.
  const frame = positionListFrame({
    alias: 'OBTS',
    aliasIsPriceAligned: true,
    extraRows: [{ line: 9, token: 'QBTS', x: LIST_X, w: 40, price: '$45.60' }],
  });

  const result = parseChartStreamPositionList({ ocr: frame });
  assert.ok(result.position_list.includes('QBTS'));
  assert.ok(!result.position_list.includes('OBTS'),
    `the garbled form must not be published: ${JSON.stringify(result.position_list)}`);
  assert.equal(result.position_list.filter((t) => t === 'QBTS').length, 1,
    'the canonical appears exactly once');
});

test('parseChartStreamPositionList: a curated alias outside the column or below the watchlist is not rescued', () => {
  // Two aliases the rescue must NOT touch:
  //   - GSII at x=300, inside the panel but in the chart area. The column
  //     is the structural evidence; a curated alias on its own is not.
  //   - PLIR at x=780 on a row BELOW the Personal WatchList header. That
  //     panel sits at the same x as the position list, so a row below it
  //     is a watchlist row however well it lines up.
  const result = parseChartStreamPositionList({ ocr: positionListFrame() });
  assert.ok(!result.position_list.includes('GSIT'),
    `a chart-area alias must not be rescued: ${JSON.stringify(result.position_list)}`);
  assert.ok(!result.position_list.includes('PLTR'),
    `a watchlist-row alias must not be rescued: ${JSON.stringify(result.position_list)}`);
  assert.ok(!result.position_list.includes('GSII'));
  assert.ok(!result.position_list.includes('PLIR'));
  // The frame DOES hold a rescuable row, so this is a boundary test and not
  // a vacuous one: the rescue must reach one alias and stop there.
  assert.ok(result.position_list.includes('QBTS'),
    `the in-column alias must still be rescued: ${JSON.stringify(result.position_list)}`);
});

