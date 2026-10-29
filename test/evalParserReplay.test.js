'use strict';

// The replay tool's headline number is quoted in CLAUDE.md, so its
// METHODOLOGY has to be pinned, not just its output.
//
// These tests use synthetic ground truth and synthetic probe logs in a
// temporary directory: the real corpus under data/video_ocr_probe/ and
// data/video_scan_test/_rerun/ is untracked, so a test that asserted the
// real numbers would fail on a fresh clone. What is pinned here is the
// behaviour -- and every one of these behaviours was a defect.
//
//   1. The ground truth is read with the CANONICAL reader
//      (src/qmg/qmgGroundTruth.js). A local reimplementation silently
//      dropped the four dates whose GT is in the object form
//      {tickers, crop}: 20220323, 20220427, 20220428, 20220510.
//   2. The ground truth is counted ONCE PER DATE, not once per log file.
//      Counting it per log inflated the denominator by 2.17x, and a date
//      with five bad logs contributed its tickers five times.
//   3. A date whose every log predates `ocr_words` could not be MEASURED.
//      Its ground truth must not enter the score's denominator, and it must
//      be reported as lost rather than silently dropped.
//   4. The corpus census is reported, so the surviving-sample nature of the
//      number is impossible to miss.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  groundTruthForDate,
  scoreLogs,
} = require('../tools/evalParserReplay');

function writeLog(dir, name, log) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(log));
}

// A parser stand-in: it reads the words the way the real one would, so a
// capture with no `ocr_words` produces no prediction.
function fakeParser(capture) {
  const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
  return words.map((word) => String(word.text || '').toUpperCase());
}

const GROUND_TRUTH = {
  _meta: { note: 'not a date' },
  // The common form: a map of capture index -> ticker array.
  '20220101': { 0: ['AAA', 'BBB'], 1: ['BBB', 'CCC'] },
  // The object form: a map of capture index -> {tickers, crop}. The old
  // local reader dropped every date in this shape.
  '20220102': { 0: { tickers: ['XXX'], crop: [1766, 705, 1911, 906] } },
  // The top-level array form.
  '20220103': ['ZZZ'],
  // An annotated duplicate of a real date. Not a date of its own.
  '20220101 (batch t=10s)': { 0: ['AAA', 'BBB'] },
};

test('the ground truth reader understands both GT shapes', () => {
  const arrayForm = groundTruthForDate(GROUND_TRUTH, '20220101');
  assert.deepEqual([...arrayForm].sort(), ['AAA', 'BBB', 'CCC']);

  // This is the date the old reader returned null for.
  const objectForm = groundTruthForDate(GROUND_TRUTH, '20220102');
  assert.deepEqual([...objectForm], ['XXX']);

  const topLevelArray = groundTruthForDate(GROUND_TRUTH, '20220103');
  assert.deepEqual([...topLevelArray], ['ZZZ']);

  assert.equal(groundTruthForDate(GROUND_TRUTH, '20221231'), null);
  assert.equal(groundTruthForDate(GROUND_TRUTH, '_meta'), null);
});

test('the ground truth is counted once per date, not once per log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-dedup-'));
  try {
    // Two logs for the SAME date, each finding one ticker. The date's
    // ground truth is {AAA, BBB, CCC}: it must be counted once (3), not
    // twice (6), even though two logs covered it.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220101',
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
    });
    writeLog(dir, 'b_snapshot.json', {
      date_key: '20220101',
      captures: [{ ocr_words: [{ text: 'CCC' }] }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const report = scoreLogs({ gt: GROUND_TRUTH, files, parseCapture: fakeParser });

    assert.equal(report.totals.gt, 3, 'the date ground truth is counted once');
    assert.equal(report.totals.hit, 2);
    assert.equal(report.totals.pred, 2);
    assert.equal(report.census.datesScored, 1);
    assert.equal(report.census.datesWithALog, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a date whose logs have no words is lost, not scored and not counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-nowords-'));
  try {
    // 20220102's only log has no per-word geometry, so the parser cannot be
    // run on it. Its ground truth must not enter the denominator -- with a
    // prediction to compare against, counting it would measure the
    // corpus's replayability rather than the parser.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220102',
      captures: [{ ocr_text: 'XXX' }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const report = scoreLogs({ gt: GROUND_TRUTH, files, parseCapture: fakeParser });

    assert.equal(report.totals.gt, 0, 'an unmeasurable date adds no denominator');
    assert.equal(report.totals.hit, 0);
    assert.equal(report.census.datesScored, 0);
    assert.equal(report.census.datesLostToMissingWords, 1);
    assert.equal(report.census.datesWithALog, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the census reports what the corpus could not reach', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-census-'));
  try {
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220101',
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
    });
    writeLog(dir, 'b_snapshot.json', {
      date_key: '20220102',
      captures: [{ ocr_words: [{ text: 'XXX' }] }],
    });
    writeLog(dir, 'c_snapshot.json', {
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
    });
    writeLog(dir, 'd_snapshot.json', {
      date_key: '20221231',
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const report = scoreLogs({ gt: GROUND_TRUTH, files, parseCapture: fakeParser });
    const { census } = report;

    assert.equal(census.files, 4);
    assert.equal(census.logs, 4);
    assert.equal(census.logsWithoutDateKey, 1);
    assert.equal(census.logsOutsideGroundTruth, 1);
    assert.equal(census.logsWithWords, 2);
    assert.equal(census.capturesWithWords, 2);
    // Captures are counted for the logs that reached the ground truth. The
    // log with no date_key and the log for an unknown date are out of scope
    // entirely, so their captures are not counted.
    assert.equal(census.capturesInGtDateLogs, 2);

    // Three real dates (20220101, 20220102, 20220103). The annotated
    // duplicate and the `_meta` key are not dates.
    assert.equal(census.groundTruthDates, 3);
    assert.deepEqual(census.groundTruthDatesNeverSeen, ['20220103']);
    assert.equal(census.datesScored, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log that fails to parse as JSON does not sink the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-badjson-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken_snapshot.json'), '{ not json');
    writeLog(dir, 'good_snapshot.json', {
      date_key: '20220103',
      captures: [{ ocr_words: [{ text: 'ZZZ' }] }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const report = scoreLogs({ gt: GROUND_TRUTH, files, parseCapture: fakeParser });

    assert.equal(report.totals.hit, 1);
    assert.equal(report.totals.gt, 1);
    assert.equal(report.census.files, 2);
    assert.equal(report.census.logs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
