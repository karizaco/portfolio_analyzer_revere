'use strict';

// The prefilter LABEL extractor: `tools/extractPrefilterLabels.js`.
//
// The prefilter decides WHICH FRAMES GET OCR'd. `tools/measurePrefilterRegion.js`
// measures its ranking without OCR, but it needs a LABEL per frame: the number
// of holdings that frame ACTUALLY READ.
//
// Those labels are ALREADY IN THE CORPUS — every probe log records, per OCR'd
// candidate, the timestamp and the tickers that frame read. Selected captures
// alone are biased toward successful frames, so the extractor also includes
// the retained top and rejected candidate summaries by default.
//
// The three properties this test pins are the ones that make the extracted
// labels usable at all:
//
//   1. the label is the count of `chart_stream.position_list` — the field the
//      aggregator reads (src/video/captureTickers.js), NOT `tickers` and NOT
//      a capture-level `tickers_from_bbox` (which no writer emits);
//   2. a timestamp is only usable as a label if it is ON THE EXTRACTION GRID,
//      because the measurement maps it back with `Math.round(ts * fps)` — an
//      off-grid timestamp would silently describe the wrong frame;
//   3. the same date scanned by two run tags is ONE date: a duplicated label
//      would be counted twice in the ranking comparison.
//
// The corpus is untracked, so the real numbers cannot be asserted here. What
// is assertable is the extractor's BEHAVIOUR, and that is what this pins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'extractPrefilterLabels.js');

/**
 * Build a probe log on disk.
 *
 * The shape is the one the scan tool writes: a `captures` array, each capture
 * carrying a `timestamp` and a `chart_stream.position_list`.
 */
function writeLog(dir, name, { dateKey, captures, candidates = [], rejected = [], videoPath }) {
  const log = {
    basename: 'qmg',
    channel: 'qmg',
    date_key: dateKey,
    output_kind: 'snapshot',
    prefilter_profile: 'chart_stream',
    video_path: videoPath || 'C:/nowhere/20220101_AAAAAAAAAAA.mp4',
    captures: captures.map((c) => ({
      chart_stream: c.holdings === null
        ? { parse_status: 'ok', position_list: [] }
        : { parse_status: 'ok', position_list: c.holdings },
      frame_index: c.ts * 0.25,
      timestamp: c.ts
    })),
    merged_position_list: []
  };

  const summary = (c) => ({
    chart_stream: c.holdings === null
      ? { parse_status: 'ok', position_list: [] }
      : { parse_status: 'ok', position_list: c.holdings },
    frame_index: c.frameIndex === undefined ? c.ts * 0.25 : c.frameIndex,
    timestamp: c.ts
  });
  if (candidates.length) {
    log.top_candidate = summary(candidates[0]);
    log.top_candidates = candidates.map(summary);
  }
  if (rejected.length) log.top_rejected_candidates = rejected.map(summary);

  // The collector picks up files ending `_snapshot.json` — that is what the
  // scan tool writes, and a file that does not match it is not a probe log.
  const file = path.join(dir, `${name}_snapshot.json`);
  fs.writeFileSync(file, JSON.stringify(log));
  return file;
}

function runTool(roots, extra = []) {
  const out = execFileSync(
    process.execPath,
    [TOOL, '--roots', roots.join(','), '--json', ...extra],
    { cwd: ROOT, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefilter-labels-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the label is the count of the chart_stream position list', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [
        { ts: 0, holdings: ['AAPL', 'MSFT'] },
        { ts: 4, holdings: ['AAPL', 'MSFT', 'TSLA'] },
        { ts: 8, holdings: [] }
      ]
    });
    const out = runTool([root]);
    const date = out.dates.find((d) => d.date === '20220101');
    assert.ok(date, 'the date was not found');
    const byTs = new Map(date.labels.map((l) => [l.ts, l.holdings]));
    assert.equal(byTs.get(0), 2, 'the first frame read two holdings');
    assert.equal(byTs.get(4), 3, 'the second frame read three holdings');
    assert.equal(byTs.get(8), 0, 'the third frame read none');
  });
});

test('the default source set includes the candidate pool and records provenance', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [{ ts: 0, holdings: ['AAPL'] }],
      candidates: [
        { ts: 4, holdings: [] },
        { ts: 8, holdings: ['MSFT', 'TSLA'] }
      ],
      rejected: [{ ts: 12, holdings: [] }]
    });

    const out = runTool([root]);
    const date = out.dates.find((d) => d.date === '20220101');
    const byTs = new Map(date.labels.map((label) => [label.ts, label]));
    assert.equal(byTs.get(0).source, 'captures');
    assert.equal(byTs.get(4).source, 'candidates');
    assert.equal(byTs.get(4).holdings, 0, 'the candidate zero was retained');
    assert.equal(byTs.get(12).source, 'rejected');
    assert.deepEqual(out.sources, ['captures', 'candidates', 'rejected']);
  });
});

test('a source filter can reproduce the selected-captures-only label set', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [{ ts: 0, holdings: ['AAPL'] }],
      candidates: [{ ts: 4, holdings: [] }],
      rejected: [{ ts: 8, holdings: [] }]
    });

    const out = runTool([root], ['--sources', 'captures']);
    const date = out.dates.find((d) => d.date === '20220101');
    assert.deepEqual(
      date.labels.map((label) => [label.ts, label.holdings, label.source]),
      [[0, 1, 'captures']]
    );
    assert.deepEqual(out.sources, ['captures']);
  });
});

test('duplicate candidate and capture labels retain both source names', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [{ ts: 4, holdings: ['AAPL'] }],
      candidates: [{ ts: 4, holdings: ['AAPL'] }]
    });

    const out = runTool([root]);
    const label = out.dates[0].labels[0];
    assert.equal(label.source, 'captures+candidates');
    assert.deepEqual(label.sources, ['captures', 'candidates']);
  });
});

test('a frame that read nothing is still a label', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [
        { ts: 0, holdings: ['AAPL'] },
        { ts: 4, holdings: [] }
      ]
    });
    const out = runTool([root]);
    const date = out.dates.find((d) => d.date === '20220101');
    const zero = date.labels.find((l) => l.ts === 4);
    assert.ok(zero, 'the zero-holding frame was dropped from the label set');
    assert.equal(zero.holdings, 0);
    assert.equal(zero.aligned, true, 'a zero-holding frame on the grid is still usable');
  });
});

test('an off-grid timestamp is reported as misaligned and is not emitted', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [
        { ts: 4, holdings: ['AAPL'] },
        // 6.5 s at 0.25 fps is frame 1.625. The frame that CONTAINS 6.5 s is
        // frame 1 (it spans 4–8 s), but the measurement addresses
        // Math.round(1.625) = frame 2. The label is one frame out.
        { ts: 6.5, holdings: ['MSFT'] }
      ]
    });
    const out = runTool([root]);
    const date = out.dates.find((d) => d.date === '20220101');
    const aligned = date.labels.filter((l) => l.aligned);
    const misaligned = date.labels.filter((l) => !l.aligned);
    assert.equal(aligned.length, 1, 'only the grid-aligned label is usable');
    assert.equal(aligned[0].ts, 4);
    assert.equal(misaligned.length, 1, 'the misaligned label is still reported');
    assert.equal(misaligned[0].ts, 6.5);
  });
});

test('a timestamp inside the frame the measurement addresses is aligned', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', {
      dateKey: '20220101',
      captures: [
        // 5.5 s is inside the frame that spans 4–8 s, and Math.round(1.375)
        // is that same frame — so the label describes the frame the tool
        // will score, and it is usable.
        { ts: 5.5, holdings: ['AAPL'] }
      ]
    });
    const out = runTool([root]);
    const date = out.dates.find((d) => d.date === '20220101');
    assert.equal(date.labels[0].aligned, true);
  });
});

test('the same date scanned by two run tags is one date with one label set', () => {
  withTempRoot((root) => {
    const runA = path.join(root, 'runA', 'ocr_probe', 'logs');
    const runB = path.join(root, 'runB', 'ocr_probe', 'logs');
    fs.mkdirSync(runA, { recursive: true });
    fs.mkdirSync(runB, { recursive: true });
    const captures = [
      { ts: 0, holdings: ['AAPL'] },
      { ts: 4, holdings: ['MSFT'] }
    ];
    writeLog(runA, '20220101_20220101_aaaaaaaaaaa_1234abcd_snapshot', { dateKey: '20220101', captures });
    writeLog(runB, '20220101_20220101_bbbbbbbbbbb_5678efgh_snapshot', { dateKey: '20220101', captures });

    const out = runTool([root]);
    const dates = out.dates.filter((d) => d.date === '20220101');
    assert.equal(dates.length, 1, 'the two run tags produced two dates');
    assert.equal(dates[0].labels.length, 2, 'the labels were duplicated');
  });
});

test('the era follows the upload date', () => {
  withTempRoot((root) => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    writeLog(logs, 'a', { dateKey: '20220421', captures: [{ ts: 0, holdings: ['AAPL'] }] });
    writeLog(logs, 'b', { dateKey: '20230609', captures: [{ ts: 0, holdings: ['AAPL'] }] });
    const out = runTool([root]);
    const byDate = new Map(out.dates.map((d) => [d.date, d.era]));
    // The era boundary is 20230518: before it the position list was a
    // floating panel in the bottom-right corner; from it, a table docked to
    // the right edge. The two layouts do not share a column, so the wide
    // measurement has to treat them separately.
    assert.equal(byDate.get('20220421'), '2022');
    assert.equal(byDate.get('20230609'), '2023');
  });
});
