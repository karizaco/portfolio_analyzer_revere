'use strict';

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

const CURATED_CASES = Object.freeze([
  { dateKey: '20220218', captureIndex: 1, mode: 'trade_ideas' },
  { dateKey: '20221104', captureIndex: 2, mode: 'sparse' },
  { dateKey: '20220606', captureIndex: 1, mode: 'normal_2022' },
  { dateKey: '20230609', captureIndex: 2, mode: 'dense_2023' },
]);

const CHART_STREAM_REGION = parseFractionalRegion(CHART_STREAM_REGION_FRACTION_DEFAULT);

function parseArgs(argv) {
  const options = {
    engine: 'tesseract',
    outputDir: path.resolve('artifacts', 'qmg_ocr_remote'),
    snapshotRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot-root') {
      options.snapshotRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--engine') {
      options.engine = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function snapshotFileName(dateKey, captureIndex) {
  const suffix = captureIndex === 0 ? '' : `_${captureIndex + 1}`;
  return `qmg_${dateKey}${suffix}.png`;
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function renderReport(summary) {
  const lines = [
    `snapshot_root: ${summary.snapshotRoot}`,
    `engine: ${summary.engine}`,
    `node: ${summary.nodeVersion}`,
    `overall_mean_recall: ${formatPct(summary.overallMeanRecall)}`,
    '',
    'Per-case results:',
  ];

  for (const result of summary.results) {
    lines.push(
      `${result.mode} ${result.dateKey}[${result.captureIndex}] `
      + `recall=${formatPct(result.recall)} `
      + `hits=${result.hit.length}/${result.gtTickers.length} `
      + `fp=${result.fp.length} `
      + `found=[${result.found.join(',')}] `
      + `miss=[${result.miss.join(',')}]`
    );
  }

  return `${lines.join('\n')}\n`;
}

function printHelp() {
  console.log(
    'Usage: node tools/runQmgCuratedBenchmark.js --snapshot-root <dir> '
    + '[--output-dir <dir>] [--engine tesseract]'
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.snapshotRoot) {
    throw new Error('Missing required --snapshot-root <dir> argument.');
  }

  const snapshotRoot = path.resolve(options.snapshotRoot);
  if (!fs.existsSync(snapshotRoot)) {
    throw new Error(`Snapshot root does not exist: ${snapshotRoot}`);
  }

  ensureDir(options.outputDir);

  const gt = loadQmgGroundTruth();
  const results = [];
  const missingSnapshots = [];

  for (const testCase of CURATED_CASES) {
    const fileName = snapshotFileName(testCase.dateKey, testCase.captureIndex);
    const snapshotPath = path.join(snapshotRoot, fileName);
    if (!fs.existsSync(snapshotPath)) {
      missingSnapshots.push(snapshotPath);
      continue;
    }

    const gtCapture = getGroundTruthForCapture(gt, testCase.dateKey, testCase.captureIndex);
    const gtTickers = gtCapture.tickers;
    const ocrResult = await ocrImage(snapshotPath, {
      chartStream: true,
      ocrEngine: options.engine,
      overlayRegion: CHART_STREAM_REGION,
    });
    const parsed = parseChartStreamPositionList({ ocr: ocrResult });
    const found = Array.isArray(parsed.position_list) ? parsed.position_list : [];
    const hit = gtTickers.filter((ticker) => found.includes(ticker));
    const miss = gtTickers.filter((ticker) => !found.includes(ticker));
    const fp = found.filter((ticker) => !gtTickers.includes(ticker));
    const caseRecall = recall(found, gtTickers);

    console.log(
      `${testCase.mode.padEnd(11)} ${testCase.dateKey}[${testCase.captureIndex}] `
      + `${formatPct(caseRecall).padStart(6)} hits=${hit.length}/${gtTickers.length} `
      + `fp=${fp.length} found=[${found.join(',')}] miss=[${miss.join(',')}]`
    );

    results.push({
      captureIndex: testCase.captureIndex,
      dateKey: testCase.dateKey,
      found,
      fp,
      gtTickers,
      hit,
      miss,
      mode: testCase.mode,
      recall: caseRecall,
      snapshotPath,
      variant: ocrResult.chartStreamVariant || null,
    });
  }

  if (missingSnapshots.length) {
    throw new Error(
      `Missing curated snapshots under ${snapshotRoot}:\n${missingSnapshots.join('\n')}`
    );
  }

  const summary = {
    engine: options.engine,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    overallMeanRecall: mean(results.map((result) => result.recall)),
    results,
    snapshotRoot,
  };

  fs.writeFileSync(
    path.join(options.outputDir, 'benchmark_results.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  fs.writeFileSync(path.join(options.outputDir, 'REPORT.txt'), renderReport(summary));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
