'use strict';

/**
 * QMG Chart-Stream Ground Truth Test
 *
 * Regression test for Qullamaggie position-list OCR.
 * Runs against human-verified snapshots and asserts ticker recall thresholds.
 *
 * Run:  node --test test/qmgGroundTruth.test.js
 *        node test/qmgGroundTruth.test.js   (without --test flag, exits 0/1)
 */

const { ocrImage } = require('../src/ocr/ocrImage');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
const fs = require('fs');
const path = require('path');

// ── Ground truth ──────────────────────────────────────────────────────────────
// Human-verified ticker lists per snapshot. Each entry: [dateKey, captureIndex, gtList]
// captureIndex: 0 = base snapshot (_20220606.png), 1 = _20220606_2.png, etc.
const GROUND_TRUTH = [
  // 20220606: 3 distinct QMG videos at different timestamps
  ['20220606', 0, ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX']],
  ['20220606', 1, ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX']],
  ['20220606', 2, ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX']],
  // 20220607
  ['20220607', 0, ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM']],
  ['20220607', 1, ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM']],
  ['20220607', 2, ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM']],
  // 20220608
  ['20220608', 0, ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC']],
  ['20220608', 1, ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC']],
  ['20220608', 2, ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC']],
  // 20220614
  ['20220614', 0, ['UVXY','VLO','UCO']],
  ['20220614', 1, ['UVXY','VLO','UCO']],
  ['20220614', 2, ['UVXY','VLO','UCO']],
  // 20221117
  ['20221117', 0, ['FREY','OIH','ASML','U','SI','SOXL']],
  ['20221117', 1, ['FREY','OIH','ASML','U','SI','SOXL']],
  ['20221117', 2, ['FREY','OIH','ASML','U','SI','SOXL']],
  // 20230126
  ['20230126', 0, ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS']],
  ['20230126', 1, ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS']],
  ['20230126', 2, ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS']],
];

// Minimum recall fraction to pass (0.5 = 50%)
const PASS_THRESHOLD = 0.50;

// ── Helpers ─────────────────────────────────────────────────────────────────
const SNAPSHOT_DIR = 'data/video_ocr_probe/qmg-1080p-batch1/snapshots';
const CROP = { x: 0.70, y: 0.60, w: 0.30, h: 0.40 };
const SCALE = 3;

function snapPath(dateKey, captureIndex) {
  const suffix = captureIndex === 0 ? '' : `_${captureIndex + 1}`;
  return path.join(SNAPSHOT_DIR, `qmg_${dateKey}${suffix}.png`);
}

function recall(found, gt) {
  const gtSet = new Set(gt);
  return gt.filter(t => found.includes(t)).length / gt.length;
}

// ── Test suite ───────────────────────────────────────────────────────────────
async function runTests() {
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const [dateKey, captureIndex, gtList] of GROUND_TRUTH) {
    const snap = snapPath(dateKey, captureIndex);

    if (!fs.existsSync(snap)) {
      console.error(`FAIL  ${dateKey} [${captureIndex}]: snapshot not found: ${snap}`);
      failed++;
      continue;
    }

    let ocrResult;
    try {
      ocrResult = await ocrImage(snap, {
        chartStream: true,
        overlayRegion: CROP,
        overlayScale: SCALE,
      });
    } catch (err) {
      console.error(`FAIL  ${dateKey} [${captureIndex}]: OCR error: ${err.message}`);
      failed++;
      continue;
    }

    const parsed = parseChartStreamPositionList({ ocr: ocrResult });
    const found = parsed.position_list;
    const r = recall(found, gtList);
    const hit = gtList.filter(t => found.includes(t));
    const miss = gtList.filter(t => !found.includes(t));

    const status = r >= PASS_THRESHOLD ? 'PASS' : 'FAIL';
    if (status === 'PASS') passed++; else failed++;

    console.log(
      `${status}  ${dateKey} [${captureIndex}]: ` +
      `${hit.length}/${gtList.length} (${(r*100).toFixed(0)}%) ` +
      `found=[${found.join(',')}] ` +
      `miss=[${miss.join(',')}]`
    );

    results.push({ dateKey, captureIndex, gt: gtList, found, hit: hit.length, miss, recall: r });
  }

  // Summary
  const totalGt = results.reduce((a, r) => a + r.gt.length, 0);
  const totalHit = results.reduce((a, r) => a + r.hit, 0);
  const overallRecall = totalHit / totalGt;

  console.log(`\n─────────────────────────────────`);
  console.log(`Snapshots: ${results.length}  Passed: ${passed}  Failed: ${failed}`);
  console.log(`Overall recall: ${(overallRecall*100).toFixed(1)}% (${totalHit}/${totalGt})`);
  console.log(`Threshold: ${(PASS_THRESHOLD*100).toFixed(0)}% per-snapshot recall`);

  if (failed > 0) {
    console.log(`\nFAILED — ${failed} snapshot(s) below ${(PASS_THRESHOLD*100).toFixed(0)}% recall threshold`);
    process.exit(1);
  } else {
    console.log(`\nPASSED`);
    process.exit(0);
  }
}

// Run as module or direct script
const isMain = require.main === module;
if (isMain) {
  runTests().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
} else {
  // Export for --test runner
  module.exports = { runTests };
}
