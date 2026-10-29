'use strict';

// Regression tests for the capture -> tickers routing in
// src/video/captureTickers.js.
//
// The routing used to live inline in tools/aggregateScanResults.js, and for a
// non-chart_stream capture it read `capture.tickers_from_bbox`. That field is
// never written at CAPTURE level — the writers
// (src/parse/parseWhiteboardScreenshotWithBoxes.js and
// tools/scanVideoWithOcr.js) write it per OBSERVATION, as
// `capture.parsed_observations[].tickers_from_bbox`. So every whiteboard
// capture resolved to an empty list and the Revere half of
// `data/analysis.json` was silently empty.
//
// The correct field for a non-chart_stream capture is `capture.tickers`.
//
// The data-driven test at the bottom reads the probe logs that are TRACKED in
// git, so it runs on a fresh clone. It asserts the two facts the fix rests
// on, so the field cannot silently move again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getCaptureTickers } = require('../src/video/captureTickers');

const ROOT = path.resolve(__dirname, '..');

test('a chart_stream capture reads its column-filtered position list', () => {
  const capture = {
    screen_layout: 'chart_stream',
    chart_stream: { position_list: ['GOVX', 'NFLX', 'TNA'] },
    tickers: ['GOVX', 'NFLX', 'TNA', 'SPY'],
  };
  assert.deepEqual(getCaptureTickers(capture), ['GOVX', 'NFLX', 'TNA']);
});

test('a chart_stream capture with no position list yields nothing', () => {
  assert.deepEqual(getCaptureTickers({ screen_layout: 'chart_stream' }), []);
  assert.deepEqual(getCaptureTickers({ screen_layout: 'chart_stream', chart_stream: {} }), []);
  assert.deepEqual(getCaptureTickers({ screen_layout: 'chart_stream', chart_stream: { position_list: 'nope' } }), []);
});

test('a whiteboard capture reads capture.tickers', () => {
  const capture = {
    screen_layout: 'structured_whiteboard',
    tickers: ['AAPL', 'MSFT'],
    parsed_observations: [{ tickers_from_bbox: ['AAPL'] }],
  };
  assert.deepEqual(getCaptureTickers(capture), ['AAPL', 'MSFT']);
});

test('the routing does NOT read tickers_from_bbox', () => {
  // The field the old code read. It exists only per observation, so a capture
  // carrying it at the top level is a shape no writer produces. If somebody
  // re-adds a `tickers_from_bbox` branch, this fails.
  const capture = {
    screen_layout: 'structured_whiteboard',
    tickers_from_bbox: ['AAPL', 'MSFT'],
  };
  assert.deepEqual(getCaptureTickers(capture), []);
});

test('the routing does NOT read the per-observation tickers_from_bbox either', () => {
  // `capture.tickers` is a strict superset of the observation set (measured
  // below), so the observations are never needed. Reading them would be a
  // second source of truth for the same numbers.
  const capture = {
    screen_layout: 'structured_whiteboard',
    parsed_observations: [
      { tickers_from_bbox: ['AAPL'] },
      { tickers_from_bbox: ['MSFT'] },
    ],
  };
  assert.deepEqual(getCaptureTickers(capture), []);
});

test('missing, malformed and empty captures yield an empty list', () => {
  assert.deepEqual(getCaptureTickers(null), []);
  assert.deepEqual(getCaptureTickers(undefined), []);
  assert.deepEqual(getCaptureTickers('not a capture'), []);
  assert.deepEqual(getCaptureTickers({}), []);
  assert.deepEqual(getCaptureTickers({ screen_layout: 'structured_whiteboard' }), []);
  assert.deepEqual(getCaptureTickers({ screen_layout: 'structured_whiteboard', tickers: 'nope' }), []);
});

// ---------------------------------------------------------------------------
// The data-driven check, over the probe logs that are tracked in git.
// ---------------------------------------------------------------------------

function trackedProbeLogs() {
  const out = execFileSync('git', ['ls-files', 'data/video_scan_*/**/ocr_probe/logs/*.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('the tracked probe logs corroborate the routing', (t) => {
  const files = trackedProbeLogs();
  if (!files.length) {
    t.skip('no tracked probe logs in this checkout');
    return;
  }

  let captures = 0;
  let topLevelBbox = 0;
  let nonChart = 0;
  let nonChartWithTickers = 0;
  let observationsOnly = 0;
  let chartStream = 0;
  let chartStreamWithList = 0;

  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch {
      continue;
    }
    for (const capture of log.captures || []) {
      captures += 1;
      if ('tickers_from_bbox' in capture) topLevelBbox += 1;
      if (capture.screen_layout === 'chart_stream') {
        chartStream += 1;
        if ((capture.chart_stream?.position_list || []).length) chartStreamWithList += 1;
        continue;
      }
      nonChart += 1;
      const tickers = Array.isArray(capture.tickers) ? capture.tickers : [];
      if (tickers.length) nonChartWithTickers += 1;
      const observed = (capture.parsed_observations || [])
        .flatMap((o) => (Array.isArray(o.tickers_from_bbox) ? o.tickers_from_bbox : []));
      if (observed.length && !tickers.length) observationsOnly += 1;
    }
  }

  assert.ok(captures > 0, 'expected the tracked probe logs to contain captures');

  // The premise of the whole fix: no capture carries `tickers_from_bbox` at
  // the top level, so the old routing could only ever return [].
  assert.equal(topLevelBbox, 0,
    'a capture now carries a top-level tickers_from_bbox — the routing may need revisiting');

  // `capture.tickers` is a strict superset of the per-observation set: there is
  // no capture whose holdings live only in the observations.
  assert.equal(observationsOnly, 0,
    'a capture has observation tickers but no capture.tickers — the routing would drop it');

  assert.ok(nonChartWithTickers > 0, 'expected some non-chart captures to carry tickers');
  assert.ok(chartStreamWithList > 0, 'expected some chart_stream captures to carry a position list');
});

test('getCaptureTickers never drops a holding that a capture shows', () => {
  const files = trackedProbeLogs();
  if (!files.length) return;

  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch {
      continue;
    }
    for (const capture of log.captures || []) {
      const expected = capture.screen_layout === 'chart_stream'
        ? (capture.chart_stream?.position_list || [])
        : (capture.tickers || []);
      const actual = getCaptureTickers(capture);
      assert.deepEqual(actual, expected, `routing disagrees in ${file}`);
    }
  }
});
