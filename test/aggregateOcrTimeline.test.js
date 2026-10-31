const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Offline tests for tools/aggregateOcrTimeline.js. The tool is a CLI script, so
// each test writes synthetic probe logs into a temp workspace, runs the script
// with that workspace as cwd, and reads back timeline.json.

const SCRIPT = path.resolve(__dirname, '..', 'tools', 'aggregateOcrTimeline.js');
const DATE_TAG = '20261031';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-timeline-'));
}

function writeLog(root, tag, filename, payload) {
  const dir = path.join(root, 'data', `video_scan_${DATE_TAG}`, tag, 'ocr_probe', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}

function runTimeline(root, tagArg) {
  execFileSync(process.execPath, [SCRIPT, '--date-tag', DATE_TAG, tagArg], { cwd: root, stdio: 'pipe' });
  const firstTag = tagArg.split(',')[0];
  return JSON.parse(fs.readFileSync(path.join(root, 'data', `video_scan_${DATE_TAG}`, firstTag, 'timeline.json'), 'utf8'));
}

function whiteboardCapture(extra) {
  return { score: 80, screen_layout: 'whiteboard', tickers: [], parsed_observations: [], ...extra };
}

test('aggregateOcrTimeline counts whiteboard bbox tickers (capture-level and per-observation)', () => {
  const root = makeWorkspace();
  writeLog(root, 'ocr-test', '20261031_20261030_vidBBOX0001_1a2b3c4d_whiteboard.json', {
    status: 'done',
    channel: 'revere',
    captures: [
      whiteboardCapture({
        tickers: ['GARBAGEX'],
        parsed_observations: [
          { portfolio: 'GRO', tickers_from_bbox: ['NVDA', 'PLTR'] },
          { portfolio: 'TURBO', tickers_from_bbox: ['TSLA'] }
        ]
      }),
      whiteboardCapture({ screen_layout: 'structured_whiteboard', tickers_from_bbox: ['AMD', 'NVDA'] })
    ]
  });
  const timeline = runTimeline(root, 'ocr-test');
  assert.equal(timeline.per_video.length, 1);
  assert.deepEqual(timeline.per_video[0].ticker_union, ['AMD', 'NVDA', 'PLTR', 'TSLA']);
  assert.deepEqual(timeline.per_day[0].ticker_union, ['AMD', 'NVDA', 'PLTR', 'TSLA']);
  assert.equal(timeline.totals.unique_tickers, 4);
  const freq = Object.fromEntries(timeline.totals.top_tickers.map(({ ticker, count }) => [ticker, count]));
  assert.equal(freq.NVDA, 2, 'NVDA appears in both captures');
  assert.equal(freq.GARBAGEX, undefined, 'raw clusterer tickers are not used when bbox tickers exist');
});

test('aggregateOcrTimeline keeps raw tickers for legacy whiteboard logs without any bbox field, and for non-whiteboard layouts', () => {
  const root = makeWorkspace();
  writeLog(root, 'ocr-test', '20261031_20261030_vidLEGACY01_1a2b3c4d_whiteboard.json', {
    status: 'done',
    captures: [{ score: 70, screen_layout: 'whiteboard', tickers: ['AAPL'], parsed_observations: [{ portfolio: 'GRO' }] }]
  });
  writeLog(root, 'ocr-test', '20261031_20261030_vidSNAP0001_5e6f7a8b_snapshot.json', {
    status: 'done',
    captures: [{ score: 60, screen_layout: 'chart_stream', tickers: ['MSFT'], chart_stream: { position_list: ['MSFT'] } }]
  });
  const timeline = runTimeline(root, 'ocr-test');
  const byId = Object.fromEntries(timeline.per_video.map((row) => [row.video_id, row]));
  assert.deepEqual(byId.vidLEGACY01.ticker_union, ['AAPL']);
  assert.deepEqual(byId.vidSNAP0001.ticker_union, ['MSFT']);
  assert.deepEqual(byId.vidSNAP0001.chart_stream_tickers, ['MSFT']);
});

test('aggregateOcrTimeline counts a video once when a retry run-tag re-scans it (last tag wins)', () => {
  const root = makeWorkspace();
  writeLog(root, 'ocr-test', '20261031_20261030_vidRETRY001_1a2b3c4d_whiteboard.json', {
    status: 'done',
    captures: [whiteboardCapture({ score: 40, tickers_from_bbox: ['OLDT'] })]
  });
  writeLog(root, 'ocr-test-p4', '20261031_20261030_vidRETRY001_9f8e7d6c_whiteboard.json', {
    status: 'done',
    captures: [
      whiteboardCapture({ score: 90, tickers_from_bbox: ['NEWT'] }),
      whiteboardCapture({ score: 70, tickers_from_bbox: ['NEWT'] })
    ]
  });
  const timeline = runTimeline(root, 'ocr-test,ocr-test-p4');
  assert.equal(timeline.totals.videos, 1);
  assert.equal(timeline.totals.videos_with_captures, 1);
  assert.equal(timeline.totals.captures, 2);
  assert.equal(timeline.per_video.length, 1);
  assert.equal(timeline.per_video[0].max_score, 90);
  assert.deepEqual(timeline.per_video[0].ticker_union, ['NEWT']);
  assert.equal(timeline.per_day.length, 1);
  assert.equal(timeline.per_day[0].videos, 1);
  assert.equal(timeline.per_day[0].captures, 2);
  assert.deepEqual(timeline.per_day[0].ticker_union, ['NEWT']);
  assert.deepEqual(timeline.totals.video_type_counts, { untagged: 1 });
  assert.equal(timeline.totals.superseded_attempts, 1);
});

test('aggregateOcrTimeline keeps the later scan-date log when one run-tag holds two attempts for a video', () => {
  const root = makeWorkspace();
  writeLog(root, 'ocr-test', '20261031_20261030_vidRETRY002_1a2b3c4d_whiteboard.json', {
    status: 'done',
    captures: [whiteboardCapture({ tickers_from_bbox: ['NEWT'] })]
  });
  writeLog(root, 'ocr-test', '20261030_20261030_vidRETRY002_1a2b3c4d_whiteboard.json', {
    status: 'done',
    captures: [whiteboardCapture({ tickers_from_bbox: ['OLDT'] }), whiteboardCapture({ tickers_from_bbox: ['OLDT'] })]
  });
  const timeline = runTimeline(root, 'ocr-test');
  assert.equal(timeline.totals.videos, 1);
  assert.equal(timeline.totals.captures, 1);
  assert.deepEqual(timeline.per_video[0].ticker_union, ['NEWT']);
});

test('aggregateOcrTimeline: a failed retry does not replace a done attempt; whiteboard and snapshot outputs stay separate', () => {
  const root = makeWorkspace();
  writeLog(root, 'ocr-test', '20261031_20261030_vidRETRY003_1a2b3c4d_whiteboard.json', {
    status: 'done',
    captures: [{ score: 50, screen_layout: 'whiteboard', tickers: ['KEEP'] }]
  });
  writeLog(root, 'ocr-test', '20261031_20261030_vidRETRY003_1a2b3c4d_snapshot.json', {
    status: 'done',
    captures: [{ score: 50, screen_layout: 'chart_stream', tickers: ['SNAP'] }]
  });
  writeLog(root, 'ocr-test-p4', '20261031_20261030_vidRETRY003_9f8e7d6c_whiteboard.json', {
    status: 'error',
    captures: []
  });
  const timeline = runTimeline(root, 'ocr-test,ocr-test-p4');
  assert.equal(timeline.totals.videos, 2);
  const unions = timeline.per_video.map((row) => row.ticker_union.join(',')).sort();
  assert.deepEqual(unions, ['KEEP', 'SNAP']);
});
