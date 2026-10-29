'use strict';

// The Revere score is quoted in CLAUDE.md, so its METHODOLOGY has to be
// pinned, not just its output.
//
// These tests use a synthetic ground truth and synthetic probe logs: the real
// corpus under data/video_ocr_probe/ and data/video_scan_test/_rerun/ is
// untracked, so a test that asserted the real numbers would fail on a fresh
// clone. What is pinned here is the behaviour — and every one of these
// behaviours was a defect.
//
//   1. The ground truth is read with its OWN reader. The Qullamaggie reader
//      (src/qmg/qmgGroundTruth.js) filters frame ids with /^\d+$/, which
//      matches NONE of the Revere frame ids (`tWfLqBqt3RI_001136`), so
//      copying it would score an empty ground truth.
//   2. A key that is not a date is REPORTED, not silently skipped: `_meta`
//      is documentation, and `20260922 (batch t=1020s)` is an annotated
//      duplicate of a real date that would double-count it.
//   3. Two runs that captured the same frame are CONSENSED — a holding
//      counts as found only when EVERY run that captured the frame read it.
//      Taking the union would let one good run paper over one bad one.
//   4. A frame whose capture carries NO per-portfolio reading cannot be
//      MEASURED. Its ground truth must not enter the denominator — with no
//      prediction to compare against, counting it would measure the
//      corpus's replayability rather than the parser.
//   5. A capture further than the tolerance from the frame is a different
//      moment in the video, and matching it anyway would turn the score into
//      a guess.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listGroundTruthDateKeys,
  listGroundTruthFrames,
  parseFrameId,
  readCaptureReadings,
  scoreGroundTruth,
} = require('../tools/evalRevere');

const GROUND_TRUTH = {
  _meta: { note: 'not a date' },
  20260101: {
    videoAAA_000100: { gro: ['AAA', 'BBB'], turbo: ['CCC'] },
    videoAAA_000100_B: { gro: ['AAA', 'BBB'], turbo: ['CCC', 'DDD'] },
  },
  20260102: {
    videoBBB_000200: { gro: ['EEE'], turbo: [] },
  },
};

function log(dateKey, videoId, captures, file) {
  return {
    file: file || `/tmp/${dateKey}_${videoId}_x_snapshot.json`,
    dateKey,
    videoId,
    channel: 'revere',
    captures,
  };
}

function capture(timestamp, readings) {
  return {
    timestamp,
    parsed_observations: Object.entries(readings).map(([portfolio, tickers]) => ({
      portfolio,
      tickers_from_bbox: tickers,
    })),
  };
}

test('the ground-truth reader lists the dates and reports everything else', () => {
  const { dates, ignored } = listGroundTruthDateKeys(GROUND_TRUTH);
  assert.deepEqual(dates, ['20260101', '20260102']);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].key, '_meta');
  assert.equal(ignored[0].reason, 'metadata key');

  // An annotated duplicate of a real date is NOT a date of its own.
  const withDuplicate = Object.assign({}, GROUND_TRUTH, { '20260101 (batch t=1020s)': { videoAAA_000100: { gro: ['AAA'] } } });
  const listed = listGroundTruthDateKeys(withDuplicate);
  assert.deepEqual(listed.dates, ['20260101', '20260102']);
  assert.equal(listed.ignored.length, 2);
  assert.equal(listed.ignored[1].reason, 'not a date key');
});

test('a frame id is <video>_<HHMMSS>', () => {
  const parsed = parseFrameId('videoAAA_000100');
  assert.equal(parsed.videoId, 'videoAAA');
  assert.equal(parsed.timestampSeconds, 60);
  assert.equal(parsed.timestampHms, '00:01:00');
  assert.equal(parsed.variant, '');

  const variant = parseFrameId('videoAAA_000100_B');
  assert.equal(variant.variant, 'B');
  assert.equal(variant.timestampSeconds, 60);

  assert.equal(parseFrameId('not a frame id'), null);
});

test('a frame keeps both portfolios, and an empty list is a statement', () => {
  const frames = listGroundTruthFrames(GROUND_TRUTH);
  assert.equal(frames.length, 3);
  const empty = frames.find((frame) => frame.frameId === 'videoBBB_000200');
  assert.deepEqual(empty.holdings.GRO, ['EEE']);
  assert.deepEqual(empty.holdings.TURBO, [], 'an empty TURBO list is kept, not dropped');
  assert.equal(empty.timestampSeconds, 120);
});

test('a capture with no row for a portfolio is NO reading, not an empty one', () => {
  const readings = readCaptureReadings(capture(60, { GRO: ['AAA'] }));
  assert.deepEqual(readings.GRO, ['AAA']);
  assert.equal(readings.TURBO, null, 'no row at all is null');

  const empty = readCaptureReadings(capture(60, { GRO: [], TURBO: [] }));
  assert.deepEqual(empty.GRO, [], 'a row with no tickers is an empty list');
  assert.deepEqual(empty.TURBO, []);
});

test('two runs are CONSENSED: a holding counts only when every run read it', () => {
  const logs = [
    log('20260101', 'videoaaa', [
      capture(60, { GRO: ['AAA', 'BBB'], TURBO: ['CCC'] }),
    ]),
    log('20260101', 'videoaaa', [
      capture(60, { GRO: ['AAA', 'ZZZ'], TURBO: ['CCC'] }),
    ]),
  ];
  const report = scoreGroundTruth({ gt: GROUND_TRUTH, logs });

  const frame = report.perFrame.find((row) => row.frameId === 'videoAAA_000100');
  const gro = frame.holdings.GRO;
  assert.equal(gro.scored, true);
  assert.equal(gro.runsPooled, 2);
  assert.equal(gro.distinctReadings, 2);
  // BBB was read by one run only, so it is not a finding.
  assert.deepEqual([...gro.predicted].sort(), ['AAA']);
  assert.deepEqual(gro.missed, ['BBB']);
  // ZZZ was read by one run only, so it is not a false positive either.
  assert.deepEqual(gro.fp, []);
  assert.ok(frame.disagreement.includes('GRO:BBB'));
  assert.ok(frame.disagreement.includes('GRO:ZZZ'));
});

test('a frame with no per-portfolio reading is LOST, not scored', () => {
  // The capture exists and is exactly on the frame, but it carries no
  // portfolio reading (a snapshot run records the whole panel). Its ground
  // truth must not enter the denominator.
  const logs = [
    log('20260101', 'videoaaa', [capture(60, {})]),
  ];
  const report = scoreGroundTruth({ gt: GROUND_TRUTH, logs });

  const frame = report.perFrame.find((row) => row.frameId === 'videoAAA_000100');
  assert.equal(frame.holdings.GRO.scored, false);
  assert.equal(frame.holdings.GRO.reason, 'NO_PORTFOLIO_READING');
  // Both frames of 20260101 match that capture, and neither portfolio of
  // either frame was read.
  assert.equal(report.census.readingsLostToMissingPortfolioReading, 4);
  assert.equal(report.totals.gt, 0, 'an unmeasurable reading adds no denominator');
  assert.equal(report.totals.hit, 0);
  assert.equal(report.census.readingsScored, 0);
});

test('a capture beyond the tolerance is a different moment, not a measurement', () => {
  const logs = [
    log('20260101', 'videoaaa', [
      capture(60 + 500, { GRO: ['AAA', 'BBB'], TURBO: ['CCC'] }),
    ]),
  ];
  const report = scoreGroundTruth({ gt: GROUND_TRUTH, logs, toleranceSeconds: 120 });

  const frame = report.perFrame.find((row) => row.frameId === 'videoAAA_000100');
  assert.equal(frame.holdings.GRO.scored, false);
  assert.equal(frame.holdings.GRO.reason, 'NO_CAPTURE');
  assert.equal(report.census.framesNeverFound, 3);
  // 20260101 has a log (its capture is simply too far away); 20260102 has
  // none at all.
  assert.deepEqual(report.census.datesNeverSeen, ['20260102']);
});

test("a capture of the frame's own video wins over another video's capture", () => {
  const logs = [
    log('20260101', 'videozzz', [
      capture(60, { GRO: ['XXX'], TURBO: [] }),
    ]),
    log('20260101', 'videoaaa', [
      capture(60, { GRO: ['AAA', 'BBB'], TURBO: ['CCC'] }),
    ]),
  ];
  const report = scoreGroundTruth({ gt: GROUND_TRUTH, logs });

  const frame = report.perFrame.find((row) => row.frameId === 'videoAAA_000100');
  assert.deepEqual([...frame.holdings.GRO.predicted].sort(), ['AAA', 'BBB']);
  assert.equal(frame.videoIdMatched, true);
});

test('the census reports what the corpus could not reach', () => {
  const logs = [
    log('20260101', 'videoaaa', [
      capture(60, { GRO: ['AAA', 'BBB'], TURBO: ['CCC'] }),
    ]),
    log('20260102', 'videobbb', [
      capture(120, { GRO: ['EEE'], TURBO: [] }),
    ]),
    log('20260301', 'videoccc', [
      capture(60, { GRO: ['AAA'], TURBO: [] }),
    ]),
  ];
  const report = scoreGroundTruth({ gt: GROUND_TRUTH, logs });

  assert.equal(report.census.groundTruthDates, 2);
  assert.equal(report.census.groundTruthFrames, 3);
  assert.equal(report.census.groundTruthReadings, 6);
  assert.equal(report.census.logs, 3);
  assert.equal(report.census.logsWithDateKey, 3);
  assert.equal(report.census.logsOutsideGroundTruth, 1, 'a log for an unknown date is out of scope');
  assert.equal(report.census.datesWithALog, 2);
  assert.equal(report.census.readingsScored, 6, 'every frame of every date with a log is scored');
  // The variant frame's TURBO list is {CCC, DDD} and the capture only read
  // CCC, so DDD is a miss.
  assert.equal(report.totals.hit, 7);
  assert.equal(report.totals.gt, 8);
  assert.equal(report.totals.pred, 7);
});

test('the shipped ground truth is readable and every frame id parses', () => {
  const { readRevereGroundTruth } = require('../tools/evalRevere');
  const gt = readRevereGroundTruth();
  const { dates, ignored } = listGroundTruthDateKeys(gt);
  assert.ok(dates.length > 0, 'the shipped ground truth has dates');
  for (const key of ignored) {
    assert.ok(key.key.startsWith('_'), `only metadata keys are ignored, not ${key.key}`);
  }
  const frames = listGroundTruthFrames(gt);
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.parseError, null, `${frame.frameId} parses`);
    assert.ok(frame.timestampSeconds >= 0);
    assert.ok(frame.holdings.GRO.length > 0 || frame.holdings.TURBO.length > 0);
  }
});

// ---------------------------------------------------------------------------
// THE REPLAY
// ---------------------------------------------------------------------------
//
// The replay re-extracts, re-OCRs and re-parses the ground-truth frames, so a
// parser fix is measurable in seconds instead of after an 8-13 minute re-scan.
// Two things about it have to be pinned:
//
//   6. The video is found by the DOWNLOADER'S OWN NAME, in every spelling it
//      has taken. A September 2026 download run prepended an underscore to
//      the id, and some Qullamaggie ids start with one themselves — so
//      `_Vn-EBl95hes.mp4` is the video `Vn-EBl95hes` and
//      `__2urSPdZVec.mp4` is the video `_2urSPdZVec`. Matching one spelling
//      only would find no media for 37 of 40 files.
//   7. A capture whose video is NOT on disk is not a replay target. It cannot
//      be replayed, and pretending otherwise would put a capture in the
//      denominator with no prediction behind it.

test('a video is found under every spelling its file name has taken', () => {
  const { videoFileForms } = require('../tools/evalRevere');

  assert.deepEqual(
    videoFileForms('tWfLqBqt3RI', '20260922'),
    ['20260922_twflqbqt3ri', 'twflqbqt3ri', '_twflqbqt3ri'],
    'the dated name, the bare name, and the underscore-prefixed name',
  );

  // An id that already starts with an underscore must not get a second one.
  assert.deepEqual(
    videoFileForms('_2urSPdZVec', '20260922'),
    ['20260922__2urspdzvec', '_2urspdzvec'],
  );

  assert.deepEqual(videoFileForms('', '20260922'), [], 'no id, no forms');
});

test('the media index is keyed in lower case, because the ids are', () => {
  const { buildMediaIndex, findVideoOnDisk } = require('../tools/evalRevere');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalrevere-media-'));
  const media = path.join(dir, 'downloads_hires');
  fs.mkdirSync(media);
  try {
    fs.writeFileSync(path.join(media, '20260922_tWfLqBqt3RI.mp4'), 'x');
    fs.writeFileSync(path.join(media, '_Vn-EBl95hes.mp4'), 'x');
    const index = buildMediaIndex({ root: dir, dirs: ['downloads_hires'] });

    assert.equal(
      findVideoOnDisk(index, 'twflqbqt3ri', '20260922'),
      path.join(media, '20260922_tWfLqBqt3RI.mp4'),
      'the file keeps its case; the id does not',
    );
    assert.equal(
      findVideoOnDisk(index, 'vn-ebl95hes', '20260922'),
      path.join(media, '_Vn-EBl95hes.mp4'),
      'the prepended underscore is tried',
    );
    assert.equal(findVideoOnDisk(index, 'nosuchvideo', '20260922'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only a capture whose video is on disk is a replay target', () => {
  const { collectReplayTargets } = require('../tools/evalRevere');
  const index = new Map([['20260101_videoaaa', '/media/20260101_videoAAA.mp4']]);
  const logs = [
    log('20260101', 'videoaaa', [capture(100, { GRO: ['AAA'] })], '/tmp/one.json'),
    log('20260101', 'videobbb', [capture(100, { GRO: ['EEE'] })], '/tmp/two.json'),
  ];
  const targets = collectReplayTargets({
    gt: GROUND_TRUTH,
    logs,
    toleranceSeconds: 120,
    index,
  });

  assert.equal(targets.length, 1, 'the capture whose video is missing is not a target');
  assert.equal(targets[0].videoId, 'videoaaa');
  assert.equal(targets[0].timestamp, 100);
  assert.ok(targets[0].videoPath.endsWith('20260101_videoAAA.mp4'));
});

test('a capture beyond the tolerance is not a replay target either', () => {
  const { collectReplayTargets } = require('../tools/evalRevere');
  const index = new Map([['20260101_videoaaa', '/media/20260101_videoAAA.mp4']]);
  const logs = [log('20260101', 'videoaaa', [capture(100 + 500, { GRO: ['AAA'] })], '/tmp/one.json')];
  const targets = collectReplayTargets({
    gt: GROUND_TRUTH,
    logs,
    toleranceSeconds: 120,
    index,
  });
  assert.equal(targets.length, 0, 'a different moment in the video is not the frame');
});

test('the OCR cache round-trips, and a missing cache is an empty one', () => {
  const { loadOcrCache, writeOcrCache } = require('../tools/evalRevere');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalrevere-cache-'));
  try {
    const file = path.join(dir, 'cache.json');
    assert.equal(loadOcrCache(file).size, 0, 'a cache that is not there yet is empty, not an error');

    const cache = new Map([['videoaaa@100', { text: 'hello', words: [{ text: 'hello', left: 1, top: 2, width: 3, height: 4, line: 0 }] }]]);
    writeOcrCache(file, cache);
    const loaded = loadOcrCache(file);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.get('videoaaa@100').text, 'hello');
    assert.equal(loaded.get('videoaaa@100').words.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
