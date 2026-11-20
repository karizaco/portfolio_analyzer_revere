'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  selectFramesForOcr,
  scoreFramePrefilter,
} = require('../src/video/ocrScanLogic');
const {
  PROFILE_ID,
  QMG_PRODUCTION_OCR_PROFILE,
  productionScanFlags,
  productionBatchCommand,
} = require('../src/video/qmgProductionOcrProfile');
const {
  ensureOcrScanOutcomesTable,
  writeOcrScanOutcome,
  listSuccessfulOutcomeDates,
  listSuccessfulOutcomeVideoIds,
} = require('../src/video/ocrScanOutcomeStore');
const { flagsForDate, parseArgs, BASE_FLAGS, DEFAULT_MAX_CAPTURES } = require('../tools/runQmgOcrBatch');

test('selectFramesForOcr returns no frames when every score is invalid', () => {
  const selected = selectFramesForOcr([
    { frameIndex: 0, prefilterScore: undefined },
    { frameIndex: 1, prefilterScore: NaN },
    { frameIndex: 2, prefilterScore: 'abc' },
  ], {
    maxFrames: 1,
    minFrames: 1,
    minScore: 14,
    uniformSampleCount: 0,
  });
  assert.deepEqual(selected, []);
});

test('chart_stream prefilter rewards chart-like geometry', () => {
  const chartLike = {
    brightRatio: 0.04,
    darkRatio: 0.55,
    edgeRatio: 0.10,
    stdDev: 55,
    meanLuma: 70,
    horizontalEdgeRatio: 0.10,
    verticalEdgeRatio: 0.20,
    rowDensity: 150,
    multiColStripeCount: 3,
    midToneRatioTicker: 0.50,
  };
  const neutral = {
    ...chartLike,
    verticalEdgeRatio: 0.01,
  };

  const chartScore = scoreFramePrefilter(chartLike, 'snapshot', 'chart_stream', Infinity);
  const neutralScore = scoreFramePrefilter(neutral, 'snapshot', 'chart_stream', Infinity);

  assert.ok(
    chartScore > neutralScore,
    `expected chart-like frame ${chartScore} to score above neutral frame ${neutralScore}`,
  );
});

test('production OCR profile locks engine, captures and cluster rule', () => {
  assert.equal(PROFILE_ID, 'qmg-production-v1');
  assert.equal(QMG_PRODUCTION_OCR_PROFILE.engine, 'easyocr');
  assert.equal(QMG_PRODUCTION_OCR_PROFILE.maxCaptures, 2);
  assert.equal(QMG_PRODUCTION_OCR_PROFILE.clusterRule, 'corroborated+swallowed');
  assert.equal(QMG_PRODUCTION_OCR_PROFILE.lowCpu, true);

  const flags = productionScanFlags();
  assert.ok(flags.includes('easyocr'));
  assert.ok(flags.includes('chart_stream'));
  const maxIdx = flags.indexOf('--max-captures');
  assert.equal(flags[maxIdx + 1], '2');
  assert.deepEqual(BASE_FLAGS.slice(0, 4), flags.slice(0, 4));
  assert.equal(DEFAULT_MAX_CAPTURES, 2);

  const cmd = productionBatchCommand(['20220606', '20230609']);
  assert.match(cmd, /runQmgOcrBatch\.js/);
  assert.match(cmd, /--low-cpu/);
  assert.match(cmd, /20220606,20230609/);
});

test('batch runner defaults to production profile flags and low-cpu', () => {
  const args = parseArgs([]);
  assert.equal(args.lowCpu, true);
  assert.equal(args.clusterRule, 'corroborated+swallowed');

  const flags = flagsForDate('20220606');
  const maxIdx = flags.indexOf('--max-captures');
  assert.equal(flags[maxIdx + 1], '2');
  assert.ok(flags.includes('easyocr'));

  const noLow = parseArgs(['--no-low-cpu']);
  assert.equal(noLow.lowCpu, false);

  const overridden = flagsForDate('20230609', 'corroborated+swallowed', { maxCaptures: 1, maxFrames: 6 });
  assert.equal(overridden[overridden.indexOf('--max-captures') + 1], '1');
  assert.equal(overridden[overridden.indexOf('--prefilter-max-frames') + 1], '6');
});

test('ocr_scan_outcomes store writes and lists successful production rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-outcomes-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    ensureOcrScanOutcomesTable(db);
    writeOcrScanOutcome({
      videoId: 'abcdefghijk',
      uploadDate: '20220606',
      runTag: 'qmg-easyocr-test',
      profileId: PROFILE_ID,
      engine: 'easyocr',
      clusterRule: 'corroborated+swallowed',
      maxCaptures: 2,
      status: 'ok',
      tickers: ['AAPL', 'NVDA'],
      logPath: 'data/example.json',
      elapsedMs: 1234,
    }, { db });

    writeOcrScanOutcome({
      videoId: 'failvideo12',
      uploadDate: '20220607',
      runTag: 'qmg-easyocr-test',
      profileId: PROFILE_ID,
      engine: 'easyocr',
      status: 'timeout',
      tickers: [],
    }, { db });

    const dates = listSuccessfulOutcomeDates({ db, profileId: PROFILE_ID });
    const vids = listSuccessfulOutcomeVideoIds({ db, profileId: PROFILE_ID });
    assert.ok(dates.has('20220606'));
    assert.equal(dates.has('20220607'), false);
    assert.ok(vids.has('abcdefghijk'));
    assert.equal(vids.has('failvideo12'), false);

    // Upsert same video+run_tag
    writeOcrScanOutcome({
      videoId: 'abcdefghijk',
      uploadDate: '20220606',
      runTag: 'qmg-easyocr-test',
      profileId: PROFILE_ID,
      engine: 'easyocr',
      status: 'ok',
      tickers: ['AAPL', 'NVDA', 'TSLA'],
    }, { db });
    const row = db.prepare(
      'SELECT ticker_count, status FROM ocr_scan_outcomes WHERE video_id=? AND run_tag=?',
    ).get('abcdefghijk', 'qmg-easyocr-test');
    assert.equal(row.status, 'ok');
    assert.equal(row.ticker_count, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
