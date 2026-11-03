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
  scoreMergedLists,
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

// ---------------------------------------------------------------------------
// The VIDEO-level reading
// ---------------------------------------------------------------------------
//
// The capture-level score says what ONE frame showed. The artifact the
// production consumers read is `merged_position_list` -- the multi-frame
// clusterer's consensus -- and the two have disagreed three times on record:
// `REGN` on 20230609, `U` on 20230523 and `AAPL` on 20230605, each of which
// a capture-level metric could not see.
//
// These tests use a LOCAL ground truth, because the shared one is asserted
// elsewhere (groundTruthDates === 3) and adding a date to it would change
// that.

const MERGED_GROUND_TRUTH = {
  '20220110': { 0: ['AAA'] },
  '20220111': { 0: ['BBB'] },
  '20220112': { 0: ['AAPL'] },
  '20220113': { 0: ['AAPL'] },
};

test('the video-level arm sees a holding no capture read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-fp-'));
  try {
    // The frame read AAA. The CONSENSUS published AAA and GHOST -- a ticker
    // no frame of the video ever showed. This is the `AAPL` shape: the
    // clusterer invented a holding out of the merge.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220110',
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
      merged_position_list: ['AAA', 'GHOST'],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));

    const captureLevel = scoreLogs({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });
    assert.equal(captureLevel.totals.hit, 1);
    assert.equal(captureLevel.totals.pred, 1);
    assert.deepEqual(captureLevel.perDate[0].fp, [], 'the capture saw no false positive');

    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });
    const recorded = merged.arms.recorded;
    assert.equal(recorded.totals.hit, 1);
    assert.equal(recorded.totals.pred, 2);
    assert.deepEqual(recorded.perDate[0].fp, ['GHOST'],
      'the video-level arm sees the invented holding the capture level cannot');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log with no merged list is LOST in that arm, not scored as zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-lost-'));
  try {
    // No `merged_position_list` and no `cluster_input`: the log cannot
    // support the `recorded` or the `rebuilt` reading. Those arms must
    // report the date as unmeasured -- and its ground truth must not enter
    // their denominator. A zero would be a claim that the video held
    // nothing.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220111',
      captures: [{ ocr_words: [{ text: 'BBB' }] }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });

    for (const arm of ['recorded', 'rebuilt']) {
      assert.equal(merged.arms[arm].census.datesScored, 0, `${arm} scored an unreadable date`);
      assert.equal(merged.arms[arm].census.datesLostToMissingReading, 1);
      assert.equal(merged.arms[arm].totals.gt, 0, `${arm} put an unmeasured date in the denominator`);
      assert.equal(merged.arms[arm].totals.hit, 0);
      assert.equal(merged.arms[arm].totals.pred, 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rebuilt arm repairs a garble across frames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-repair-'));
  try {
    // Two frames both read the panel's AAPL row as AAPQ. The clusterer
    // repairs it across frames, which is the merged reading's whole reason
    // to exist: no single frame says AAPL.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220112',
      captures: [
        { ocr_words: [{ text: 'AAPQ' }] },
        { ocr_words: [{ text: 'AAPQ' }] },
      ],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });

    const rebuilt = merged.arms.rebuilt_current;
    assert.equal(rebuilt.census.datesScored, 1);
    assert.equal(rebuilt.totals.hit, 1, 'the garble was repaired into AAPL');
    assert.equal(rebuilt.totals.gt, 1);
    assert.equal(rebuilt.totals.pred, 1);
    assert.deepEqual(rebuilt.perDate[0].missed, []);
    assert.deepEqual(rebuilt.perDate[0].fp, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rebuilt arm uses the log\'s recorded cluster input and threshold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-input-'));
  try {
    // The log records the clusterer's per-frame input verbatim and the
    // Filter A threshold it ran with. The rebuilt arm must use BOTH.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220113',
      captures: [],
      cluster_input: ['AAPQ', 'AAPQ'],
      cluster_min_frequency: 2,
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });

    const rebuilt = merged.arms.rebuilt;
    assert.equal(rebuilt.census.datesScored, 1);
    assert.equal(rebuilt.totals.hit, 1);
    assert.equal(rebuilt.totals.pred, 1);
    assert.deepEqual(rebuilt.perDate[0].fp, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rebuilt arm honours the recorded Filter A threshold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-threshold-'));
  try {
    // Two frames, and a threshold of 3. Filter A counts DISTINCT FRAMES, so
    // the cluster cannot reach three and is dropped -- and the reading is
    // empty, so the date is LOST rather than scored as "held nothing".
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220114',
      captures: [],
      cluster_input: ['AAPQ', 'AAPQ'],
      cluster_min_frequency: 3,
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: { '20220114': { 0: ['AAPL'] } },
      files,
      parseCapture: fakeParser,
    });

    const rebuilt = merged.arms.rebuilt;
    assert.equal(rebuilt.census.datesScored, 0);
    assert.equal(rebuilt.census.datesLostToMissingReading, 1);
    assert.equal(rebuilt.totals.gt, 0);
    assert.equal(rebuilt.totals.pred, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rebuilt arm falls back to the log\'s recorded per-frame readings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-fallback-'));
  try {
    // `cluster_input` post-dates every captured log, so without a fallback
    // the arm would be empty on the whole corpus. The log keeps each
    // capture's `chart_stream.position_list` -- the very array the clusterer
    // clustered -- so the merge can still be reproduced.
    //
    // Two frames read the panel's AAPL row as AAPQ. The clusterer repairs it
    // across frames; no single frame says AAPL.
    //
    // The date is 20220112 because that is the ground-truth entry whose
    // holding is AAPL -- 20220110's is AAA, and a reading of AAPL there
    // would be a false positive, not a hit.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220112',
      captures: [
        { chart_stream: { position_list: ['AAPQ'] } },
        { chart_stream: { position_list: ['AAPQ'] } },
      ],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });

    const rebuilt = merged.arms.rebuilt;
    assert.equal(rebuilt.census.datesScored, 1);
    assert.equal(rebuilt.totals.hit, 1, 'the garble was repaired into AAPL');
    assert.equal(rebuilt.totals.pred, 1);
    assert.deepEqual(rebuilt.perDate[0].fp, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rebuilt arm stays empty when the log has no per-frame readings either', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-merged-nofallback-'));
  try {
    // No `cluster_input`, and no capture carries a `chart_stream.position_list`.
    // There is nothing to cluster, so the date is LOST in that arm -- not
    // scored as zero, which would claim the video held nothing.
    writeLog(dir, 'a_snapshot.json', {
      date_key: '20220110',
      captures: [{ ocr_words: [{ text: 'AAA' }] }],
    });

    const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
    const merged = scoreMergedLists({
      gt: MERGED_GROUND_TRUTH,
      files,
      parseCapture: fakeParser,
    });

    const rebuilt = merged.arms.rebuilt;
    assert.equal(rebuilt.census.datesScored, 0);
    assert.equal(rebuilt.census.datesLostToMissingReading, 1);
    assert.equal(rebuilt.totals.gt, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
