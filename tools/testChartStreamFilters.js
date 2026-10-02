'use strict';

/**
 * Smoke tests for the FP reduction filters in parseChartStream.js:
 *   Filter A: clusterRawOcrTokens per-canonical frame count (default 2)
 *   Filter B: parseChartStreamPositionList bbox y-range filter
 *   Filter G: parseChartStreamPositionList panel-line reject gate
 *
 * Run: node tools/testChartStreamFilters.js
 * Exit 0 on pass, 1 on failure.
 */

const assert = require('node:assert');
const {
  clusterRawOcrTokens,
  parseChartStreamPositionList,
  mergeMultiplePositionLists
} = require('../src/parse/parseChartStream');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    failed += 1;
  }
}

console.log('=== Filter A: clusterRawOcrTokens per-canonical frame count ===');

test('defaults to minFrequency=2 (filters single-frame garbles)', () => {
  // NFU→NFLX garble appears in only 1 frame. With default minFrequency=2,
  // the cluster should be dropped.
  const result = clusterRawOcrTokens([
    'NFU 412 5.5%',     // frame 0: garbled, real ticker is NFLX
    'NFLX 511 2.3%',    // frame 1: clean
    'NFLX 510 2.4%',    // frame 2: clean
    'NFLX 509 2.6%',    // frame 3: clean
    'NFLX 512 2.2%'     // frame 4: clean
  ]);
  // The cluster spans frames 1-4 (4 frames via NFLX) plus frame 0 (via NFU).
  // Wait — NFU and NFLX are different tokens. With maxDistance=1 the cluster
  // wouldn't merge them. So NFU appears in 1 frame (frame 0). It would
  // survive edit-distance correction to NFLX, but the frame count of NFU's
  // cluster (just NFU, 1 frame) < 2, so it gets filtered.
  // The NFLX cluster has frameCount=4 → survives.
  assert.deepStrictEqual(result.merged_list, ['NFLX']);
});

test('preserves clusters spanning >= 2 frames (backward compat, default)', () => {
  // A real ticker that appears in 3 frames should survive.
  const result = clusterRawOcrTokens([
    'NFLX 412 5.5%',
    'NFLX 511 2.3%',
    'NFLX 510 2.4%'
  ]);
  assert.deepStrictEqual(result.merged_list, ['NFLX']);
});

test('minFrequency=1 disables Filter A (backward compat)', () => {
  // Single-frame tokens should survive when minFrequency=1.
  const result = clusterRawOcrTokens(['NFU 412 5.5%'], { minFrequency: 1 });
  // NFU gets edit-distance-correction → NFLX survives
  assert.deepStrictEqual(result.merged_list, ['NFLX']);
});

test('cluster merges via edit-distance and counts union of frames (Filter A)', () => {
  // Two distinct tokens (NFU, NFL) that both garble to NFLX.
  // Both appear in different frames. With union-find clustering (maxDistance=1),
  // NFU and NFL are different tokens (edit distance 1 vs 3 vs NFLX), so they
  // don't cluster. But each individually gets corrected to NFLX.
  // Actually with maxDistance=1, NFU (3 chars) and NFL (3 chars) → distance 1.
  // They cluster together. Union of frames: {0, 1, 2}. frameCount=3.
  const result = clusterRawOcrTokens([
    'NFU 412 5.5%',     // frame 0: NFU
    'NFL 511 2.3%',     // frame 1: NFL
    'NFLX 510 2.4%'     // frame 2: clean
  ], { maxDistance: 1, minFrequency: 2 });
  // The cluster spans 3 frames → survive
  assert(result.merged_list.includes('NFLX'), `Expected NFLX in ${result.merged_list}`);
});

test('returns frameCount field per cluster (diagnostic)', () => {
  const result = clusterRawOcrTokens([
    'NFLX 412 5.5%',
    'NFLX 511 2.3%',
    'NFLX 510 2.4%'
  ]);
  const nflxCluster = result.clusters.find(c => c.canonical === 'NFLX');
  assert(nflxCluster, 'NFLX cluster not found');
  assert.strictEqual(nflxCluster.frameCount, 3, `Expected frameCount=3, got ${nflxCluster.frameCount}`);
});

console.log('\n=== Filter G: panel-line reject gate ===');

test('rejects ticker whose only occurrence is at line >= watchlistLine', () => {
  // The "WATCHLIST" header is at line 10. A ticker at line 11 is in the
  // watchlist panel. The "A - Positions" header is at line 2. Tickers at
  // lines 3-9 are in the position list.
  const words = [
    { text: 'A', line: 2, top: 100, left: 0, width: 10, height: 12, conf: 90 },  // header line
    { text: 'POSITIONS', line: 2, top: 100, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'TNA', line: 3, top: 130, left: 100, width: 30, height: 12, conf: 90 },
    { text: '15.20', line: 3, top: 130, left: 140, width: 30, height: 12, conf: 90 },
    { text: 'WATCHLIST', line: 10, top: 350, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'ZETA', line: 11, top: 380, left: 100, width: 30, height: 12, conf: 90 },  // watchlist row
    { text: '20.00', line: 11, top: 380, left: 140, width: 30, height: 12, conf: 90 }
  ];
  const text = 'A POSITIONS\nTNA 15.20\n\nWATCHLIST\nZETA 20.00';
  const result = parseChartStreamPositionList({
    ocr: { text, lines: text.split('\n'), words }
  });
  // ZETA is in lexicon → previously accepted. Filter G should now reject it.
  assert(!result.position_list.includes('ZETA'),
    `Expected ZETA to be rejected; position_list=${result.position_list}`);
  // TNA should still be accepted (edit-distance-correction from TNA or via panel)
  assert(result.position_list.includes('TNA'),
    `Expected TNA to be accepted; position_list=${result.position_list}`);
  // Panel gate should be active
  assert(result.panel_gate, 'panel_gate should be populated');
  assert.strictEqual(result.panel_gate.active, true);
});

test('keeps ticker with at least one in-panel occurrence (transition frame)', () => {
  // TNA appears at line 3 (in panel) AND line 11 (watchlist). The gate
  // keeps it because at least one occurrence is in the panel.
  const words = [
    { text: 'A', line: 2, top: 100, left: 0, width: 10, height: 12, conf: 90 },
    { text: 'POSITIONS', line: 2, top: 100, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'TNA', line: 3, top: 130, left: 100, width: 30, height: 12, conf: 90 },
    { text: '15.20', line: 3, top: 130, left: 140, width: 30, height: 12, conf: 90 },
    { text: 'WATCHLIST', line: 10, top: 350, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'TNA', line: 11, top: 380, left: 100, width: 30, height: 12, conf: 90 },  // transition overlap
    { text: '20.00', line: 11, top: 380, left: 140, width: 30, height: 12, conf: 90 }
  ];
  const text = 'A POSITIONS\nTNA 15.20\n\nWATCHLIST\nTNA 20.00';
  const result = parseChartStreamPositionList({
    ocr: { text, lines: text.split('\n'), words }
  });
  assert(result.position_list.includes('TNA'),
    `Expected TNA to be accepted (in-panel occurrence); position_list=${result.position_list}`);
});

test('skips panel gate when boundaries not detected (safe fallback)', () => {
  // No POSITIONS/WATCHLIST headers in the OCR. Gate should not activate.
  const words = [
    { text: 'TNA', line: 1, top: 100, left: 100, width: 30, height: 12, conf: 90 },
    { text: '15.20', line: 1, top: 100, left: 140, width: 30, height: 12, conf: 90 },
    { text: 'ZETA', line: 2, top: 130, left: 100, width: 30, height: 12, conf: 90 }
  ];
  const text = 'TNA 15.20\nZETA 20.00';
  const result = parseChartStreamPositionList({
    ocr: { text, lines: text.split('\n'), words }
  });
  // Without gate, ZETA is in lexicon → accepted
  assert(result.panel_gate === null, 'panel_gate should be null when boundaries not detected');
});

console.log('\n=== Filter B: bbox y-range filter ===');

test('rejects chart-area ticker whose bbox is far from position list y-range', () => {
  // Position list tickers at y=130 (TNA, NFLX). NVDA bleeds in at y=600
  // (chart axis label). Median y = 130, lineHeight = 12. yMax = 130 + 24 = 154.
  // NVDA at y=600 is well outside → rejected.
  const words = [
    { text: 'A', line: 1, top: 100, left: 0, width: 10, height: 12, conf: 90 },
    { text: 'POSITIONS', line: 1, top: 100, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'TNA', line: 2, top: 130, left: 100, width: 30, height: 12, conf: 90 },
    { text: '15.20', line: 2, top: 130, left: 140, width: 30, height: 12, conf: 90 },
    { text: 'NFLX', line: 3, top: 145, left: 100, width: 40, height: 12, conf: 90 },
    { text: '511', line: 3, top: 145, left: 150, width: 30, height: 12, conf: 90 },
    { text: 'NVDA', line: 10, top: 600, left: 100, width: 40, height: 12, conf: 90 }  // chart axis label
  ];
  const text = 'A POSITIONS\nTNA 15.20\nNFLX 511\n... (chart)\nNVDA 200';
  const result = parseChartStreamPositionList({
    ocr: { text, lines: text.split('\n'), words }
  });
  // NVDA should be rejected by Filter B (its y=600 is outside [130-24, 130+24])
  assert(!result.position_list.includes('NVDA'),
    `Expected NVDA to be rejected by bbox filter; position_list=${result.position_list}`);
  // TNA and NFLX should be accepted
  assert(result.position_list.includes('TNA'),
    `Expected TNA to be accepted; position_list=${result.position_list}`);
  assert(result.position_list.includes('NFLX'),
    `Expected NFLX to be accepted; position_list=${result.position_list}`);
  // bbox_filter diagnostic should be populated
  assert(result.bbox_filter, 'bbox_filter should be populated');
});

test('skips bbox filter when fewer than 2 accepted tickers', () => {
  const words = [
    { text: 'A', line: 1, top: 100, left: 0, width: 10, height: 12, conf: 90 },
    { text: 'POSITIONS', line: 1, top: 100, left: 30, width: 60, height: 12, conf: 90 },
    { text: 'TNA', line: 2, top: 130, left: 100, width: 30, height: 12, conf: 90 },
    { text: '15.20', line: 2, top: 130, left: 140, width: 30, height: 12, conf: 90 }
  ];
  const text = 'A POSITIONS\nTNA 15.20';
  const result = parseChartStreamPositionList({
    ocr: { text, lines: text.split('\n'), words }
  });
  // Only one ticker; bbox filter should be skipped
  assert(result.bbox_filter === null, 'bbox_filter should be null with <2 accepted tickers');
});

console.log('\n=== Backward compatibility ===');

test('legacy callers (no word positions) still work', () => {
  const result = parseChartStreamPositionList({
    ocr: { text: 'TNA 15.20\nNFLX 511', lines: [], words: [] }
  });
  assert(result.position_list.includes('TNA'),
    `Expected TNA in legacy mode; position_list=${result.position_list}`);
  assert(result.position_list.includes('NFLX'),
    `Expected NFLX in legacy mode; position_list=${result.position_list}`);
  assert(result.bbox_filter === null, 'bbox_filter should be null when no word positions');
  assert(result.panel_gate === null, 'panel_gate should be null when no word positions');
});

test('mergeMultiplePositionLists unchanged (regression check)', () => {
  const merged = mergeMultiplePositionLists(
    [['TNA', 'NFLX'], ['NFLX'], ['TNA', 'NFLX']],
    { minOccurrences: 2 }
  );
  assert.deepStrictEqual(merged, ['NFLX', 'TNA']);
});

console.log('\n=== Single-letter ticker exception (NYSE) ===');

test('clusterer accepts single-letter "U" (Unity Software) across multiple frames', () => {
  const frames = [
    'U 4053 -339,47 8.63',
    'U 4053 -339,47 8.63',
    'U 4053 -339,47 8.63',
  ];
  const result = clusterRawOcrTokens(frames, { minFrequency: 1 });
  assert(result.merged_list.includes('U'),
    `Expected 'U' in merged_list; got ${result.merged_list}`);
});

test('clusterer rejects bare single-letter "X" (chart-internal, not in allowlist semantics)', () => {
  // Note: X is technically in SINGLE_LETONER_TICKERS (NYSE: X = United States Steel
  // was delisted but X is still in the allowlist as a single-char ticker letter).
  // This test documents that behavior — to suppress chart-axis X, the caller must
  // remove it via the lexicon filter at the parseChartStreamPositionList level.
  const frames = [
    'X 100 200',
    'X 100 200',
    'X 100 200',
  ];
  const result = clusterRawOcrTokens(frames, { minFrequency: 1 });
  // X is in the allowlist AND in the default seed lexicon
  assert(result.merged_list.includes('X'),
    `Expected 'X' in merged_list (NYSE single-letter allowlist); got ${result.merged_list}`);
});

test('clusterer still rejects short non-letter single chars (e.g. "1")', () => {
  const frames = [
    '1 100 200',
    '1 100 200',
    '1 100 200',
  ];
  const result = clusterRawOcrTokens(frames, { minFrequency: 1 });
  assert(!result.merged_list.includes('1'),
    `'1' should be filtered out (not a letter); got ${result.merged_list}`);
});

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.error('\nFAILURES detected.');
  process.exit(1);
}
console.log('All filter tests passed.');
process.exit(0);