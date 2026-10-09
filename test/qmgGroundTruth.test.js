'use strict';

/**
 * QMG Chart-Stream Ground Truth Smoke Test
 *
 * Purpose:
 * - exercise the CURRENT best-known snapshot OCR path for chart-stream GT
 * - use the canonical GT store (data/qmg_ground_truth.json)
 * - report results by difficulty mode rather than pretending all captures
 *   should meet the same threshold
 *
 * This is intentionally a curated regression test, not the full benchmark.
 * Full sweeps should use tools/scanAllGtVideos.js, which also defaults to
 * EasyOCR for chart-stream runs.
 *
 * Run:
 *   node --test test/qmgGroundTruth.test.js
 *   node test/qmgGroundTruth.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ocrImage } = require('../src/ocr/ocrImage');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
const {
  getGroundTruthForCapture,
  loadQmgGroundTruth,
} = require('../src/qmg/qmgGroundTruth');
const {
  CHART_STREAM_REGION_FRACTION_DEFAULT,
  parseFractionalRegion,
} = require('../src/video/ocrScanArgs');

const SNAPSHOT_ROOTS = [
  path.join('data', 'video_scan_20260923', 'qmg-1080p-ocr-v2', 'qmg-1080p-ocr-v2', 'snapshots'),
  path.join('data', 'video_scan_20260917', 'qmg-ocr-20260917-v2', 'qmg-ocr-20260917-v2', 'snapshots'),
  path.join('data', 'video_scan_20260917', 'qmg-ocr-20260917-missing19', 'qmg-ocr-20260917-missing19', 'snapshots'),
  path.join('data', 'video_ocr_probe', 'qmg-1080p-batch1', 'snapshots'),
  path.join('data', 'video_ocr_probe', 'qmg-1080p-batch2', 'snapshots'),
];

const CURATED_CASES = [
  { dateKey: '20220218', captureIndex: 1, mode: 'trade_ideas' },
  { dateKey: '20221104', captureIndex: 2, mode: 'sparse' },
  { dateKey: '20220606', captureIndex: 1, mode: 'normal_2022' },
  { dateKey: '20230609', captureIndex: 2, mode: 'dense_2023' },
];

const REQUIRED_MODE_THRESHOLDS = Object.freeze({
  normal_2022: 0.30,
  sparse: 0.80,
});

const OVERALL_THRESHOLD = 0.30;
const CHART_STREAM_REGION = parseFractionalRegion(CHART_STREAM_REGION_FRACTION_DEFAULT);

function snapshotFileName(dateKey, captureIndex) {
  const suffix = captureIndex === 0 ? '' : `_${captureIndex + 1}`;
  return `qmg_${dateKey}${suffix}.png`;
}

function resolveSnapshotPath(dateKey, captureIndex) {
  const fileName = snapshotFileName(dateKey, captureIndex);
  for (const root of SNAPSHOT_ROOTS) {
    const candidate = path.resolve(root, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function recall(found, gt) {
  if (!gt.length) return 0;
  return gt.filter((ticker) => found.includes(ticker)).length / gt.length;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function runTests() {
  const gt = loadQmgGroundTruth();
  const results = [];
  const missingSnapshots = [];

  for (const testCase of CURATED_CASES) {
    const { dateKey, captureIndex, mode } = testCase;
    const snapshotPath = resolveSnapshotPath(dateKey, captureIndex);
    if (!snapshotPath) {
      missingSnapshots.push(`${dateKey}[${captureIndex}]`);
      continue;
    }

    const gtCapture = getGroundTruthForCapture(gt, dateKey, captureIndex);
    const gtTickers = gtCapture.tickers;
    let ocrResult;
    try {
      ocrResult = await ocrImage(snapshotPath, {
        chartStream: true,
        ocrEngine: 'easyocr',
        overlayRegion: CHART_STREAM_REGION,
      });
    } catch (error) {
      throw new Error(`OCR failed for ${dateKey}[${captureIndex}] at ${snapshotPath}: ${error.message}`);
    }

    const parsed = parseChartStreamPositionList({ ocr: ocrResult });
    const found = Array.isArray(parsed.position_list) ? parsed.position_list : [];
    const hit = gtTickers.filter((ticker) => found.includes(ticker));
    const miss = gtTickers.filter((ticker) => !found.includes(ticker));
    const fp = found.filter((ticker) => !gtTickers.includes(ticker));
    const captureRecall = recall(found, gtTickers);

    console.log(
      `${mode.padEnd(11)} ${dateKey}[${captureIndex}] ${formatPct(captureRecall).padStart(6)} `
      + `variant=${String(ocrResult.chartStreamVariant || 'boosted').padEnd(12)} `
      + `hits=${hit.length}/${gtTickers.length} fp=${fp.length} `
      + `found=[${found.join(',')}] miss=[${miss.join(',')}]`
    );

    results.push({
      captureIndex,
      dateKey,
      fpCount: fp.length,
      mode,
      recall: captureRecall,
      variant: ocrResult.chartStreamVariant || 'boosted',
    });
  }

  assert.equal(missingSnapshots.length, 0, `Missing curated snapshots: ${missingSnapshots.join(', ')}`);
  assert.ok(results.length > 0, 'No QMG ground-truth results were collected.');

  const modeSummaries = new Map();
  for (const result of results) {
    if (!modeSummaries.has(result.mode)) {
      modeSummaries.set(result.mode, []);
    }
    modeSummaries.get(result.mode).push(result);
  }

  console.log('\nMode summary');
  console.log('mode         captures  mean_recall  mean_fp  variants');
  console.log('-----------  --------  -----------  -------  ------------------------------');

  for (const [mode, modeResults] of [...modeSummaries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const modeRecall = mean(modeResults.map((result) => result.recall));
    const modeFp = mean(modeResults.map((result) => result.fpCount));
    const variants = [...new Set(modeResults.map((result) => result.variant))].join(',');
    console.log(
      `${mode.padEnd(11)}  ${String(modeResults.length).padStart(8)}  ${formatPct(modeRecall).padStart(11)}  `
      + `${modeFp.toFixed(2).padStart(7)}  ${variants}`
    );
    if (Object.prototype.hasOwnProperty.call(REQUIRED_MODE_THRESHOLDS, mode)) {
      assert.ok(
        modeRecall >= REQUIRED_MODE_THRESHOLDS[mode],
        `Mode ${mode} mean recall ${formatPct(modeRecall)} is below ${formatPct(REQUIRED_MODE_THRESHOLDS[mode])}`
      );
    }
  }

  const overallRecall = mean(results.map((result) => result.recall));
  console.log(`\nOverall mean recall: ${formatPct(overallRecall)} across ${results.length} curated captures`);
  assert.ok(
    overallRecall >= OVERALL_THRESHOLD,
    `Overall mean recall ${formatPct(overallRecall)} is below ${formatPct(OVERALL_THRESHOLD)}`
  );
}

const isMain = require.main === module;
if (isMain) {
  runTests().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
} else {
  module.exports = { runTests };
}
