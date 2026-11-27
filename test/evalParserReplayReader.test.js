'use strict';

// The replay splits the corpus BY READER.
//
// The corpus holds logs from two readers -- the chart-stream crop reader
// and the positions-TABLE reader -- and a date's predictions are pooled
// as the union of its logs. So a date read by both readers had TWO
// readings, and pooling them made the table reader's false positives
// count against the chart-stream reader's score.
//
// Measured over `data/video_scan_test/_rerun` on 2026-11-28:
//
//   the chart-stream reader alone : 431/460 hits, 78.9 % precision
//   the table reader alone         :  60/64  hits, 84.5 % precision
//   the two pooled                 : 432/460 hits, 76.3 % precision
//
// So the pooled precision is materially worse than either reader's own,
// and it is worse because of the mixing.
//
// These tests pin the MECHANISM on synthetic logs -- the real corpus is
// untracked, so a test asserting the real numbers would fail on a fresh
// clone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readerOfLog,
  scoreMergedLists,
} = require('../tools/evalParserReplay');

/**
 * A capture published by the given reader.
 *
 * @param {string|null} source  'position_table', 'chart_stream' or null
 * @param {string[]} tickers
 * @returns {object}
 */
function captureFrom(source, tickers) {
  return {
    ticker_source: source,
    chart_stream: { position_list: tickers },
  };
}

/**
 * A log with the given captures.
 *
 * @param {object[]} captures
 * @returns {object}
 */
function logWith(captures) {
  return {
    date_key: '20220101',
    captures,
    merged_position_list: captures.flatMap(
      (capture) => (capture.chart_stream && capture.chart_stream.position_list) || [],
    ),
  };
}

/**
 * Write the logs to a scratch directory and score them.
 *
 * The scorer reads from disk, so the test writes real files -- a
 * synthetic log object passed in would not be read.
 *
 * @param {object[]} logs
 * @returns {object} the scorer's report
 */
function scoreSynthetic(logs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-replay-'));
  try {
    const files = logs.map((log, index) => {
      const file = path.join(dir, `log_${index}.json`);
      fs.writeFileSync(file, JSON.stringify(log), 'utf8');
      return file;
    });
    const gt = { '20220101': { '0': ['AAPL', 'MSFT'] } };
    return scoreMergedLists({ gt, files });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a log with no capture published nothing, and it is not a reading', () => {
  assert.equal(readerOfLog(logWith([])), 'none');
});

test('a capture with no table source came from the chart-stream reader', () => {
  assert.equal(readerOfLog(logWith([captureFrom(null, ['AAPL'])])), 'chart_stream');
  // And an OLD log -- one that predates the table reader entirely -- has
  // no `ticker_source` at all, which is the same case.
  assert.equal(readerOfLog(logWith([captureFrom(undefined, ['AAPL'])])), 'chart_stream');
});

test('a capture the table reader published says so', () => {
  assert.equal(
    readerOfLog(logWith([captureFrom('position_table', ['AAPL'])])),
    'position_table',
  );
});

test('a log whose captures came from BOTH readers is a MIXTURE', () => {
  // The scan tool's merge takes a table capture's own holdings and a
  // legacy capture's cluster consensus, so a mixed log's merged list is
  // a mixture too.
  assert.equal(
    readerOfLog(logWith([
      captureFrom('position_table', ['AAPL']),
      captureFrom(null, ['MSFT']),
    ])),
    'mixed',
  );
});

test('a capture with an EMPTY reading does not make a reader', () => {
  // A frame the table reader found nothing in fell back to the legacy
  // reader, and that frame published nothing.
  const log = logWith([
    captureFrom('position_table', []),
    captureFrom(null, ['MSFT']),
  ]);
  assert.equal(readerOfLog(log), 'chart_stream');
});

test('the two readers are scored SEPARATELY, each with its own denominator', () => {
  // A chart-stream log and a table log for the SAME date, with the
  // table log carrying a false positive.
  const report = scoreSynthetic([
    logWith([captureFrom(null, ['AAPL', 'MSFT'])]),
    logWith([captureFrom('position_table', ['AAPL', 'ZZZZ'])]),
  ]);

  const arm = report.arms.recorded;
  // The chart-stream reader: 2 of 2, no false positive.
  assert.equal(arm.byReader.chart_stream.hit, 2);
  assert.equal(arm.byReader.chart_stream.gt, 2);
  assert.equal(arm.byReader.chart_stream.pred, 2);
  // The table reader: 1 of 2, and its own false positive.
  assert.equal(arm.byReader.position_table.hit, 1);
  assert.equal(arm.byReader.position_table.gt, 2);
  assert.equal(arm.byReader.position_table.pred, 2);
  // And the POOLED totals count the ground truth ONCE per date.
  assert.equal(arm.totals.gt, 2);
  assert.equal(arm.totals.hit, 2);
  assert.equal(arm.totals.pred, 3);
  // So the pooled precision is WORSE than either reader's own, and the
  // difference is the false positive that belongs to one of them.
  assert.equal(
    Number((arm.totals.hit / arm.totals.pred * 100).toFixed(1)),
    66.7,
  );
  assert.equal(
    Number((arm.byReader.chart_stream.hit / arm.byReader.chart_stream.pred * 100).toFixed(1)),
    100,
  );
});

test('a date read by ONE reader is counted once, and its own numbers are its own', () => {
  const report = scoreSynthetic([
    logWith([captureFrom(null, ['AAPL', 'MSFT'])]),
  ]);
  const arm = report.arms.recorded;
  assert.equal(arm.byReader.chart_stream.dates, 1);
  assert.equal(arm.byReader.chart_stream.hit, 2);
  assert.equal(arm.totals.hit, 2);
  assert.equal(arm.totals.gt, 2);
  assert.equal(arm.census.datesScored, 1);
});
