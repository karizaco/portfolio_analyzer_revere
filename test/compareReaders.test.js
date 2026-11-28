'use strict';

// The two readers, separated.
//
// The corpus holds the readings of TWO readers, and `tools/evalParserReplay.js`
// pools a date's predictions as the union of its logs -- so over a corpus
// with both readers in it the number is a MIXTURE, and the table reader's
// false positives count against the chart-stream reader's score.
//
// `tools/compareReaders.js` separates them, and it answered the
// `position_table` sweep's question: "does the table reader help where
// the chart-stream reader fails?" It does not.
//
// These tests pin the MECHANISM on synthetic logs -- the real corpus is
// untracked, so a test asserting the real numbers would fail on a fresh
// clone.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readersOf, tagOf, TABLE_TAGS } = require('../tools/compareReaders');

/**
 * A capture published by the given reader.
 *
 * @param {string|null} source
 * @param {string[]} tickers
 * @returns {object}
 */
function captureFrom(source, tickers) {
  return {
    ticker_source: source,
    chart_stream: { position_list: tickers },
  };
}

test('a capture the table reader published says so', () => {
  assert.equal(readersOf({ captures: [captureFrom('position_table', ['AAPL'])] }), 'table');
});

test('a capture with no table source came from the chart-stream reader', () => {
  assert.equal(readersOf({ captures: [captureFrom(null, ['AAPL'])] }), 'chart');
  // And an OLD log -- one that predates the table reader entirely -- has
  // no `ticker_source` at all, which is the same case.
  assert.equal(readersOf({ captures: [captureFrom(undefined, ['AAPL'])] }), 'chart');
});

test('a log whose captures came from BOTH readers is a MIXTURE', () => {
  assert.equal(readersOf({
    captures: [captureFrom('position_table', ['AAPL']), captureFrom(null, ['MSFT'])],
  }), 'mixed');
});

test('a capture with an EMPTY reading does not make a reader', () => {
  // A frame the table reader found nothing in fell back to the legacy
  // reader, and that frame published nothing.
  assert.equal(readersOf({
    captures: [captureFrom('position_table', []), captureFrom(null, ['MSFT'])],
  }), 'chart');
});

test('a log with no captures at all is the chart-stream reader\'s', () => {
  assert.equal(readersOf({ captures: [] }), 'chart');
});

test('the run tag comes out of the path', () => {
  assert.equal(
    tagOf('C:/repo/data/video_scan_test/_rerun/qmg-table-weak/ocr_probe/logs/x.json'),
    'qmg-table-weak',
  );
  assert.equal(
    tagOf('C:/repo/data/video_ocr_probe/qmg-easyocr-20261106-feb/ocr_probe/logs/x.json'),
    '',
  );
});

test('the sweep\'s run tags are the table reader\'s', () => {
  // Every tag the sweep wrote is in the table set -- so the sweep's logs
  // are kept out of the chart-stream column however their
  // `ticker_source` reads.
  for (const tag of ['qmg-table', 'qmg-table-weak', 'qmg-table-20261127', 'qmg-table-fix']) {
    assert.ok(TABLE_TAGS.has(tag), `${tag} is a table tag`);
  }
  assert.ok(!TABLE_TAGS.has('qmg-easyocr-20261106-feb'), 'and a chart-stream tag is not');
});
