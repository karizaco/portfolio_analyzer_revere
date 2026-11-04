'use strict';

// `tools/scoreScanRuns.js` produces the number this session's 2022-era
// production scans are judged by, so its METHODOLOGY is pinned here -- not its
// output. The real corpus under `data/video_scan_test/_rerun/` is untracked,
// so a test asserting the real numbers would fail on a fresh clone.
//
// What is pinned, and why each one was a possible defect:
//
//   1. The scored reading is `merged_position_list` -- the VIDEO-level
//      consensus -- and NOT `capture.chart_stream.position_list`. The two have
//      disagreed on record three times (CLAUDE.md, "The video-level reading --
//      merged_position_list"): 20230609 published `REGN` in the merged list and
//      `RGTI` in the capture, 20230523 lost `LI` to `AI` at the cluster step,
//      and 20230605 published `AAPL`, which no capture of the video ever read.
//      A capture-level metric sees none of those.
//   2. The denominator is the date's ground truth as the UNION over its
//      captures. The position list changes during a session, so the union is
//      what a video-level reading has to be scored against.
//   3. The ground truth has three shapes -- a top-level array, a capture map of
//      arrays, and a capture map of `{tickers, crop}` objects -- and the `crop`
//      key is a RECTANGLE, never a ticker.
//   4. A date with no ground truth is reported, not scored. It must not enter
//      the denominator: a missing ground truth is an absence, not a failure,
//      and a date that reports zero would look like a total failure.
//   5. Both probe-log layouts are found: the flat one
//      (`<run>/ocr_probe/logs`) and the doubled one
//      (`<run>/<date>/<tag>/<tag>/ocr_probe/logs`).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scoreRun,
  groundTruthTickers,
} = require('../tools/scoreScanRuns');

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `scoreScanRuns-${tag}-`));
}

function writeLog(dir, name, log) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(log));
}

const GROUND_TRUTH = {
  // The common form: a capture map of arrays. Two captures, one shared ticker.
  '20220101': { 0: ['AAA', 'BBB'], 1: ['BBB', 'CCC'] },
  // The object form: a capture map of {tickers, crop}. The crop is a
  // rectangle and is NEVER a ticker.
  '20220102': { 0: { tickers: ['XXX'], crop: [1766, 705, 1911, 906] } },
  // The top-level array form.
  '20220103': ['ZZZ'],
};

test('the ground truth reader understands all three shapes', () => {
  // The union over captures, with the shared ticker counted once.
  assert.deepEqual([...groundTruthTickers(GROUND_TRUTH['20220101'])].sort(), ['AAA', 'BBB', 'CCC']);
  // The object form -- and the crop rectangle is not a ticker.
  assert.deepEqual(groundTruthTickers(GROUND_TRUTH['20220102']), ['XXX']);
  // The top-level array form.
  assert.deepEqual(groundTruthTickers(GROUND_TRUTH['20220103']), ['ZZZ']);
  // A missing date is empty, not a throw.
  assert.deepEqual(groundTruthTickers(GROUND_TRUTH['20990101']), []);
});

test('the scored reading is the merged list, not the capture list', () => {
  const run = tmpDir('merged');
  const logs = path.join(run, 'ocr_probe', 'logs');
  writeLog(logs, '20220101_20220101_abc_snapshot.json', {
    date: '20220101',
    // The video-level consensus: two hits and one false positive.
    merged_position_list: ['AAA', 'BBB', 'ZZZ'],
    // The capture-level reading, which DISAGREES with it -- the exact shape
    // of the 20230609 `REGN`/`RGTI` disagreement. If the tool scored the
    // capture list, this row would score differently.
    captures: [
      { chart_stream: { position_list: ['AAA', 'BBB'] } },
    ],
  });

  const rows = scoreRun(run, GROUND_TRUTH);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'scored');
  assert.equal(row.hit, 2);
  assert.equal(row.gt, 3);
  assert.equal(row.predicted, 3);
  assert.deepEqual(row.missTickers, ['CCC']);
  assert.deepEqual(row.fpTickers, ['ZZZ']);
});

test('a date with no ground truth is reported, not scored', () => {
  const run = tmpDir('nogrt');
  const logs = path.join(run, 'ocr_probe', 'logs');
  writeLog(logs, '20220199_20220199_abc_snapshot.json', {
    date: '20220199',
    merged_position_list: ['AAA'],
  });

  const rows = scoreRun(run, GROUND_TRUTH);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'no_ground_truth');
  // It must not be reported as a zero-hit failure.
  assert.equal(rows[0].hit, undefined);
});

test('the date comes from the file name when the log carries none', () => {
  const run = tmpDir('namedate');
  const logs = path.join(run, 'ocr_probe', 'logs');
  writeLog(logs, '20220103_20220103_xyz_snapshot.json', {
    merged_position_list: ['ZZZ'],
  });

  const rows = scoreRun(run, GROUND_TRUTH);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '20220103');
  assert.equal(rows[0].hit, 1);
});

test('the doubled probe-log layout is found as well as the flat one', () => {
  const run = tmpDir('doubled');
  // <run>/<date>/<tag>/<tag>/ocr_probe/logs
  const logs = path.join(run, '20220103', 'tag', 'tag', 'ocr_probe', 'logs');
  writeLog(logs, '20220103_20220103_xyz_snapshot.json', {
    date: '20220103',
    merged_position_list: ['ZZZ'],
  });

  const rows = scoreRun(run, GROUND_TRUTH);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '20220103');
  assert.equal(rows[0].hit, 1);
  assert.equal(rows[0].gt, 1);
});

test('a prediction repeated in the merged list is counted once', () => {
  const run = tmpDir('dedup');
  const logs = path.join(run, 'ocr_probe', 'logs');
  writeLog(logs, '20220103_20220103_xyz_snapshot.json', {
    date: '20220103',
    merged_position_list: ['ZZZ', 'ZZZ'],
  });

  const rows = scoreRun(run, GROUND_TRUTH);
  assert.equal(rows[0].predicted, 1);
  assert.equal(rows[0].hit, 1);
});
