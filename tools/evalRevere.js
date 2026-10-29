'use strict';

// Score the Revere whiteboard OCR path against data/revere_ground_truth.json.
//
// The Revere ground truth had ZERO consumers until this tool: nothing in the
// repository read data/revere_ground_truth.json, so the number quoted for the
// whiteboard path could not be recomputed and a regression (a date dropping
// from 90% to 42%) was invisible. This is the Revere counterpart of
// tools/evalParserReplay.js.
//
// Usage:
//   node tools/evalRevere.js                       # the whole tracked corpus
//   node tools/evalRevere.js data/video_ocr_probe  # one or more probe roots
//   node tools/evalRevere.js --tolerance 60        # seconds a capture may be
//                                                   # away from a ground-truth frame
//   node tools/evalRevere.js --json
//
// Exit code is always 0 — this is a report, not a gate.
//
// ---------------------------------------------------------------------------
// WHAT THIS NUMBER IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
//
// The ground truth is keyed by DATE -> FRAME -> {gro, turbo}. A frame is a
// single whiteboard screenshot, and the two portfolios are read separately, so
// the unit of measurement is (frame, portfolio) — the ground truth holds 144
// such readings across 6 frames.
//
// A ground-truth frame names its own video and its own wall-clock position
// (`tWfLqBqt3RI_001136` = video tWfLqBqt3RI at 00:11:36). The tool pairs a
// frame with the probe-log capture that shows the same screen: the capture of
// the SAME VIDEO whose timestamp is closest to the frame's, within a
// tolerance. When the closest capture is not the exact frame, the offset is
// printed with the frame — a reading taken four seconds away is the same
// screen, a reading taken two minutes away is a guess, and the reader must be
// able to tell the two apart.
//
// WHEN TWO RUNS READ THE SAME FRAME DIFFERENTLY, the tool takes the
// CONSENSUS: a holding counts as found only when every run that captured
// the frame read it. The alternative — taking the union — would let one good
// run paper over one bad one, and a recall figure that hides a bad run is
// exactly the regression this tool exists to expose. The tickers the runs
// disagree about are printed with the frame, because a disagreement is a
// finding in its own right.
//
// THE MEASURED QUANTITY IS THE PIPELINE'S RECORDED OUTPUT, NOT A RE-PARSE.
// Unlike the Qullamaggie replay tool, this one does not re-run the parser
// over the logs' OCR text: the Revere whiteboard is a two-column screen whose
// OCR text interleaves the chart panel with the whiteboard, so the text-only
// parser cannot recover the two holdings lists at all (the GRO HOLDINGS line
// is swallowed into the preceding line). The only per-portfolio reading that
// exists is the one the positional parser (parseWhiteboardScreenshotWithBoxes)
// wrote into the log, and that is what is scored.
//
// Two consequences, both reported by the census rather than hidden:
//   * A frame whose capture carries no per-portfolio reading cannot be
//     MEASURED. Its ground truth must not enter the denominator — with no
//     prediction to compare against, counting it would measure the corpus's
//     replayability rather than the pipeline. It is reported as lost.
//   * A frame the corpus never captured at all is reported as never found.
//
// So the headline number is a SURVIVING SAMPLE, and the census says exactly
// how much of the ground truth it covers.

const fs = require('node:fs');
const path = require('node:path');

const { buildLogsDirectories } = require('../src/video/probeLogDirs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_GT_PATH = path.join(PROJECT_ROOT, 'data', 'revere_ground_truth.json');

// The two portfolios the Revere whiteboard carries.
const PORTFOLIOS = Object.freeze(['GRO', 'TURBO']);

// How far a probe-log capture may sit from a ground-truth frame and still be
// taken as showing the same screen. The whiteboard stays up for minutes, so a
// small offset is the same frame; a large one is a different moment in the
// video and would silently turn the score into a guess.
const DEFAULT_TOLERANCE_SECONDS = 120;

// The roots searched when none are given. `data/video_ocr_probe` holds the
// Revere runs; `data/video_scan_*` holds the scan directories. Every log
// directory is found through src/video/probeLogDirs.js, so this tool cannot
// drift from the aggregators the way tools/aggregateOcrTimeline.js did.
const DEFAULT_STATIC_ROOTS = Object.freeze([
  'data/video_ocr_probe',
  'data/video_pipeline_samples',
]);

const DATE_KEY_RE = /^\d{8}$/;
const FRAME_ID_RE = /^(.+)_(\d{2})(\d{2})(\d{2})(?:_([A-Za-z0-9]+))?$/;

// ---------------------------------------------------------------------------
// THE CANONICAL GROUND-TRUTH READER
// ---------------------------------------------------------------------------
//
// data/revere_ground_truth.json is a DIFFERENT shape from the Qullamaggie
// ground truth: its frame keys are not capture indexes but frame identifiers
// (`tWfLqBqt3RI_001136`), and each frame holds two ticker lists rather than
// one. src/qmg/qmgGroundTruth.js therefore cannot read it — and worse, its
// capture-index filter (`/^\d+$/`) matches NONE of the Revere frame ids, so
// copying that reader's filter would silently drop every Revere frame and
// score an empty ground truth.
//
// This reader is the single place the Revere ground truth is interpreted.
// The tool and the test both go through it, so there is no second
// reimplementation that could disagree with this one — the defect that cost
// the Qullamaggie tool four of its ground-truth dates.

/**
 * Read and parse the Revere ground-truth file.
 *
 * @param {string} [gtPath] - path to the JSON file
 * @returns {object} the parsed ground truth
 */
function readRevereGroundTruth(gtPath = DEFAULT_GT_PATH) {
  return JSON.parse(fs.readFileSync(gtPath, 'utf8'));
}

/**
 * List the date keys the ground truth holds, and the keys it does not.
 *
 * The keys that are not dates are REPORTED, not silently skipped: `_meta` and
 * `_source` are documentation, but a key like `20260922 (batch t=1020s)` is an
 * annotated duplicate of a real date and would double-count that date if it
 * were mistaken for one.
 *
 * @param {object} gt
 * @returns {{dates: string[], ignored: Array<{key: string, reason: string}>}}
 */
function listGroundTruthDateKeys(gt) {
  const dates = [];
  const ignored = [];
  for (const key of Object.keys(gt || {})) {
    if (key.startsWith('_')) {
      ignored.push({ key, reason: 'metadata key' });
      continue;
    }
    if (!DATE_KEY_RE.test(key)) {
      ignored.push({ key, reason: 'not a date key' });
      continue;
    }
    dates.push(key);
  }
  dates.sort();
  return { dates, ignored };
}

/**
 * Split a ground-truth frame id into its video id, its position in the video
 * and its variant suffix.
 *
 * `tWfLqBqt3RI_001136`      -> video tWfLqBqt3RI at 00:11:36
 * `tWfLqBqt3RI_001332_B`    -> the same, variant B
 *
 * @param {string} frameId
 * @returns {{videoId: string, timestampSeconds: number, timestampHms: string, variant: string}|null}
 */
function parseFrameId(frameId) {
  const match = FRAME_ID_RE.exec(String(frameId || ''));
  if (!match) return null;
  const [, videoId, hh, mm, ss, variant] = match;
  const timestampSeconds = (Number(hh) * 3600) + (Number(mm) * 60) + Number(ss);
  if (!Number.isFinite(timestampSeconds)) return null;
  return {
    videoId,
    timestampSeconds,
    timestampHms: `${hh}:${mm}:${ss}`,
    variant: variant || '',
  };
}

/**
 * List the ground-truth frames, with their per-portfolio holdings.
 *
 * A frame is KEPT even when one of its two holdings lists is empty: an empty
 * list is a statement about the screen, and dropping the frame would hide it.
 *
 * @param {object} gt
 * @returns {Array<object>} one row per frame
 */
function listGroundTruthFrames(gt) {
  const { dates } = listGroundTruthDateKeys(gt);
  const frames = [];
  for (const dateKey of dates) {
    const entry = gt[dateKey];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const frameId of Object.keys(entry)) {
      const raw = entry[frameId];
      const holdings = { GRO: [], TURBO: [] };
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const portfolio of PORTFOLIOS) {
          const list = raw[portfolio] || raw[portfolio.toLowerCase()];
          holdings[portfolio] = Array.isArray(list)
            ? list.map((ticker) => String(ticker).toUpperCase())
            : [];
        }
      }
      const parsedId = parseFrameId(frameId);
      frames.push({
        dateKey,
        frameId,
        note: raw && typeof raw === 'object' ? (raw.note || '') : '',
        videoId: parsedId ? parsedId.videoId : '',
        timestampSeconds: parsedId ? parsedId.timestampSeconds : null,
        timestampHms: parsedId ? parsedId.timestampHms : '',
        variant: parsedId ? parsedId.variant : '',
        parseError: parsedId ? null : 'frame id is not <video>_<HHMMSS>',
        holdings,
      });
    }
  }
  return frames;
}

/**
 * Flatten the ground truth into one row per (frame, portfolio).
 *
 * @param {object} gt
 * @returns {Array<object>}
 */
function listGroundTruthReadings(gt) {
  const readings = [];
  for (const frame of listGroundTruthFrames(gt)) {
    for (const portfolio of PORTFOLIOS) {
      readings.push({
        dateKey: frame.dateKey,
        frameId: frame.frameId,
        portfolio,
        tickers: frame.holdings[portfolio],
      });
    }
  }
  return readings;
}

// ---------------------------------------------------------------------------
// FINDING THE PROBE LOGS
// ---------------------------------------------------------------------------

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(target) {
  try {
    return fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Every log directory under a root, found through the SHARED layout list.
 *
 * src/video/probeLogDirs.js knows three layouts — flat, doubled and legacy
 * root — and the aggregators use it so they cannot drift apart. This tool
 * uses the same list, but it collects from ALL of the candidates that exist
 * rather than the first one: "first wins" can hide a doubled-layout log
 * directory when a flat one happens to exist for the same run tag, and a
 * hidden log is a silently missing measurement.
 *
 * @param {string} root
 * @returns {string[]} existing log directories
 */
function discoverLogDirectories(root) {
  const abs = path.resolve(root);
  const found = [];
  if (!isDirectory(abs)) return found;

  // The root may itself be a logs directory.
  try {
    if (fs.readdirSync(abs).some((name) => name.endsWith('.json'))) found.push(abs);
  } catch {
    /* unreadable root */
  }

  for (const runTag of listDirectories(abs)) {
    for (const candidate of buildLogsDirectories(abs, runTag)) {
      if (isDirectory(candidate)) found.push(candidate);
    }
  }

  // The legacy-root layout of the root itself, for a root whose run tag list
  // is empty.
  for (const candidate of buildLogsDirectories(abs, '')) {
    if (isDirectory(candidate)) found.push(candidate);
  }

  return [...new Set(found.map((dir) => path.resolve(dir)))];
}

/**
 * Every probe-log JSON file under a directory.
 *
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function collectLogFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The roots searched when the caller names none.
 *
 * @returns {string[]} absolute root paths
 */
function defaultRoots() {
  const roots = DEFAULT_STATIC_ROOTS.map((root) => path.resolve(PROJECT_ROOT, root));
  let entries = [];
  try {
    entries = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('video_scan_')) {
      roots.push(path.resolve(PROJECT_ROOT, 'data', entry.name));
    }
  }
  return roots;
}

/**
 * The video id a probe log belongs to.
 *
 * Taken from the log's own `video_path` (`<upload_date>_<video_id>.mp4`),
 * because a log FILE name is `<date>_<title slug>_<video id>_<hash>_<kind>.json`
 * and the title slug may itself contain underscores.
 *
 * @param {object} log
 * @returns {string} the video id, lower-cased, or '' when it cannot be read
 */
function videoIdFromLog(log) {
  const videoPath = String(log.video_path || '');
  if (videoPath) {
    const file = path.basename(videoPath).replace(/\.[A-Za-z0-9]+$/, '');
    const match = /^\d{8}_(.+)$/.exec(file);
    if (match) return match[1].toLowerCase();
    if (file) return file.toLowerCase();
  }
  const file = path.basename(String(log.file || '')).replace(/\.json$/i, '');
  const parts = file.split('_');
  if (parts.length >= 3) return parts[parts.length - 3].toLowerCase();
  return '';
}

/**
 * Read one probe log.
 *
 * @param {string} file
 * @returns {{file: string, dateKey: string, videoId: string, channel: string, captures: Array<object>}|null}
 */
function readProbeLog(file) {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!log || typeof log !== 'object') return null;
  return {
    file,
    dateKey: String(log.date_key || ''),
    videoId: videoIdFromLog(log),
    channel: String(log.channel || log.basename || ''),
    captures: Array.isArray(log.captures) ? log.captures : [],
  };
}

/**
 * Read every probe log under a set of roots.
 *
 * @param {string[]} roots
 * @returns {{logs: Array<object>, files: string[], directories: string[]}}
 */
function readProbeLogs(roots) {
  const directories = [];
  const files = [];
  for (const root of roots) {
    for (const dir of discoverLogDirectories(root)) {
      directories.push(dir);
      for (const file of collectLogFiles(dir)) files.push(file);
    }
  }
  const uniqueFiles = [...new Set(files)];
  const logs = [];
  for (const file of uniqueFiles) {
    const log = readProbeLog(file);
    if (log) logs.push(log);
  }
  return { logs, files: uniqueFiles, directories };
}

// ---------------------------------------------------------------------------
// READING A CAPTURE
// ---------------------------------------------------------------------------

/**
 * The per-portfolio holdings a capture recorded.
 *
 * `parsed_observations` is the only place the whiteboard path writes its two
 * holdings lists: `parseWhiteboardScreenshotWithBoxes` produces one row per
 * portfolio and `tools/scanVideoWithOcr.js` copies each row's
 * `tickers_from_bbox` into the log. A portfolio with NO row is reported as
 * `null` (no reading at all); a portfolio with an empty list is reported as
 * `[]` (the parser looked and found nothing), and the two are not the same.
 *
 * @param {object} capture
 * @returns {{GRO: string[]|null, TURBO: string[]|null}}
 */
function readCaptureReadings(capture) {
  const readings = { GRO: null, TURBO: null };
  const rows = Array.isArray(capture && capture.parsed_observations)
    ? capture.parsed_observations
    : null;
  if (!rows) return readings;
  for (const row of rows) {
    const portfolio = String((row && row.portfolio) || '').toUpperCase();
    if (!PORTFOLIOS.includes(portfolio)) continue;
    if (!row || !Array.isArray(row.tickers_from_bbox)) continue;
    readings[portfolio] = row.tickers_from_bbox.map((ticker) => String(ticker).toUpperCase());
  }
  return readings;
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

function emptyBucket() {
  return { hit: 0, gt: 0, pred: 0, readings: 0 };
}

function mergeBucket(target, source) {
  target.hit += source.hit;
  target.gt += source.gt;
  target.pred += source.pred;
  target.readings += source.readings;
}

/**
 * Score the ground truth against a set of probe logs.
 *
 * @param {object} options
 * @param {object} options.gt - the parsed ground truth
 * @param {Array<object>} options.logs - probe logs (see readProbeLog)
 * @param {number} [options.toleranceSeconds] - how far a capture may be from a frame
 * @param {(capture: object, log: object) => object} [options.readCapture] - reading hook
 * @returns {object} the report: perFrame, perDate, census, totals
 */
function scoreGroundTruth({
  gt,
  logs,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  readCapture = readCaptureReadings,
}) {
  const { dates: gtDates, ignored: ignoredKeys } = listGroundTruthDateKeys(gt);
  const gtDateSet = new Set(gtDates);
  const frames = listGroundTruthFrames(gt);

  const census = {
    groundTruthDates: gtDates.length,
    groundTruthFrames: frames.length,
    groundTruthReadings: frames.length * PORTFOLIOS.length,
    ignoredGroundTruthKeys: ignoredKeys,
    logs: logs.length,
    logsWithDateKey: 0,
    logsOutsideGroundTruth: 0,
    logsForGroundTruthDates: 0,
    capturesInGroundTruthLogs: 0,
    capturesWithinTolerance: 0,
    readingsScored: 0,
    readingsLostToMissingCapture: 0,
    readingsLostToMissingPortfolioReading: 0,
    datesWithALog: 0,
    datesNeverSeen: [],
    framesNeverFound: 0,
    framesNeverFoundList: [],
    framesWithAnExactTimestampCapture: 0,
    framesWhoseExactCaptureHadNoPortfolioReading: 0,
    framesMatchedExactlyWithAReading: 0,
    framesMatchedToANearbyCapture: 0,
    framesMatchedWithoutAVideoIdMatch: 0,
    framesWithDisagreeingRuns: 0,
    readingsPooledFromMoreThanOneRun: 0,
  };

  // Index the corpus by date so a frame only looks at its own day.
  const logsByDate = new Map();
  for (const log of logs) {
    if (!log.dateKey) continue;
    census.logsWithDateKey += 1;
    if (!gtDateSet.has(log.dateKey)) {
      census.logsOutsideGroundTruth += 1;
      continue;
    }
    census.logsForGroundTruthDates += 1;
    if (!logsByDate.has(log.dateKey)) logsByDate.set(log.dateKey, []);
    logsByDate.get(log.dateKey).push(log);
  }
  census.datesWithALog = logsByDate.size;
  census.datesNeverSeen = gtDates.filter((dateKey) => !logsByDate.has(dateKey));

  const perFrame = [];
  const perDate = [];
  const totals = emptyBucket();

  for (const frame of frames) {
    const dateLogs = logsByDate.get(frame.dateKey) || [];

    // Every capture of this date whose timestamp is close enough to the
    // frame. The video id is a preference, not a filter: a date can hold
    // several videos, and a frame that names one of them should find its
    // own capture even if the log's video id could not be read.
    const candidates = [];
    for (const log of dateLogs) {
      for (const capture of log.captures) {
        census.capturesInGroundTruthLogs += 1;
        const timestamp = Number(capture && capture.timestamp);
        if (!Number.isFinite(timestamp)) continue;
        if (frame.timestampSeconds === null) continue;
        const offset = timestamp - frame.timestampSeconds;
        if (Math.abs(offset) > toleranceSeconds) continue;
        census.capturesWithinTolerance += 1;
        candidates.push({
          capture,
          log,
          offset,
          videoMatched: Boolean(frame.videoId) && log.videoId === frame.videoId.toLowerCase(),
          readings: readCapture(capture, log),
        });
      }
    }

    const frameRow = {
      date: frame.dateKey,
      frameId: frame.frameId,
      note: frame.note,
      videoId: frame.videoId,
      timestampHms: frame.timestampHms,
      variant: frame.variant,
      offsetSeconds: null,
      sourceLog: null,
      videoIdMatched: false,
      matchedExactly: false,
      matchedNearby: false,
      disagreement: [],
      holdings: {},
    };

    if (!candidates.length) {
      census.framesNeverFound += 1;
      census.framesNeverFoundList.push({
        date: frame.dateKey,
        frameId: frame.frameId,
        reason: frame.parseError
          ? `frame id could not be parsed (${frame.parseError})`
          : 'no capture of this date within the tolerance',
      });
      for (const portfolio of PORTFOLIOS) {
        frameRow.holdings[portfolio] = {
          portfolio,
          scored: false,
          reason: 'NO_CAPTURE',
          hit: 0,
          gt: frame.holdings[portfolio].length,
          pred: 0,
          missed: frame.holdings[portfolio].slice().sort(),
          fp: [],
        };
        census.readingsLostToMissingCapture += 1;
      }
      perFrame.push(frameRow);
      continue;
    }

    const videoMatched = candidates.filter((candidate) => candidate.videoMatched);
    const pool = videoMatched.length ? videoMatched : candidates;
    if (!videoMatched.length) census.framesMatchedWithoutAVideoIdMatch += 1;

    // Did the corpus capture this frame EXACTLY? A capture at offset 0 is
    // the ground-truth frame itself; the corpus does have one for every
    // Revere frame, but the runs that took them (snapshot runs) recorded only
    // the whole panel, not the two portfolios. That is a survivorship fact
    // about the corpus, so it is counted rather than hidden.
    const exact = pool.filter((candidate) => candidate.offset === 0);
    if (exact.length) {
      census.framesWithAnExactTimestampCapture += 1;
      const exactHasReading = PORTFOLIOS.some(
        (portfolio) => exact.some((candidate) => Array.isArray(candidate.readings[portfolio])),
      );
      if (!exactHasReading) census.framesWhoseExactCaptureHadNoPortfolioReading += 1;
    }

    // The capture nearest the frame, then the nearest one that carries a
    // reading for the portfolio in question. A capture with no reading at all
    // (a snapshot run, which records the whole panel but not the two
    // portfolios) is not a measurement, so the tool looks past it.
    const pick = (portfolio) => {
      const withReading = pool.filter(
        (candidate) => Array.isArray(candidate.readings[portfolio]),
      );
      if (!withReading.length) return { group: [], hasReading: false };
      const nearest = Math.min(...withReading.map((candidate) => Math.abs(candidate.offset)));
      const group = withReading.filter((candidate) => Math.abs(candidate.offset) === nearest);
      return { group, hasReading: true, nearest };
    };

    const dateBucket = perDate.find((row) => row.date === frame.dateKey);
    if (!dateBucket) {
      perDate.push({
        date: frame.dateKey,
        hit: 0,
        gt: 0,
        pred: 0,
        readings: 0,
        frames: 0,
        framesScored: 0,
        missed: [],
        fp: [],
      });
    }
    const bucket = perDate.find((row) => row.date === frame.dateKey);
    bucket.frames += 1;

    for (const portfolio of PORTFOLIOS) {
      const { group, hasReading } = pick(portfolio);
      const expected = frame.holdings[portfolio];
      const expectedSet = new Set(expected);

      if (!hasReading) {
        census.readingsLostToMissingPortfolioReading += 1;
        frameRow.holdings[portfolio] = {
          portfolio,
          scored: false,
          reason: 'NO_PORTFOLIO_READING',
          hit: 0,
          gt: expected.length,
          pred: 0,
          missed: expected.slice().sort(),
          fp: [],
        };
        continue;
      }

      // Two runs can capture the same second and read it differently. The
      // CONSENSUS is taken — a holding counts as found only when every run
      // that captured the frame read it — so one good run cannot paper over
      // one bad one. The tickers the runs disagree about are reported.
      const readingSets = group.map((candidate) => new Set(candidate.readings[portfolio]));
      const union = new Set();
      for (const set of readingSets) for (const ticker of set) union.add(ticker);
      const consensus = [...union].filter((ticker) => readingSets.every((set) => set.has(ticker)));
      const disagreement = [...union].filter((ticker) => !consensus.includes(ticker)).sort();

      const distinctReadings = new Set(
        readingSets.map((set) => [...set].sort().join(',')),
      ).size;
      if (group.length > 1) census.readingsPooledFromMoreThanOneRun += 1;
      if (distinctReadings > 1) census.framesWithDisagreeingRuns += 1;

      const predicted = consensus;
      const predictedSet = new Set(predicted);
      const hit = predicted.filter((ticker) => expectedSet.has(ticker)).length;
      const missed = expected.filter((ticker) => !predictedSet.has(ticker)).sort();
      const fp = predicted.filter((ticker) => !expectedSet.has(ticker)).sort();

      census.readingsScored += 1;
      frameRow.holdings[portfolio] = {
        portfolio,
        scored: true,
        hit,
        gt: expected.length,
        pred: predicted.length,
        predicted,
        missed,
        fp,
        offsetSeconds: group[0].offset,
        sourceLog: group[0].log.file,
        runsPooled: group.length,
        distinctReadings,
        disagreement,
      };
      frameRow.offsetSeconds = frameRow.offsetSeconds === null
        ? group[0].offset
        : frameRow.offsetSeconds;
      frameRow.sourceLog = frameRow.sourceLog || group[0].log.file;
      frameRow.videoIdMatched = frameRow.videoIdMatched || group[0].videoMatched;
      if (group[0].offset === 0) frameRow.matchedExactly = true;
      else frameRow.matchedNearby = true;
      if (distinctReadings > 1) {
        frameRow.disagreement = frameRow.disagreement || [];
        frameRow.disagreement.push(...disagreement.map((ticker) => `${portfolio}:${ticker}`));
      }

      bucket.hit += hit;
      bucket.gt += expected.length;
      bucket.pred += predicted.length;
      bucket.readings += 1;
      bucket.framesScored += 1;
      bucket.missed.push(...missed);
      bucket.fp.push(...fp);

      mergeBucket(totals, { hit, gt: expected.length, pred: predicted.length, readings: 1 });
    }

    if (frameRow.matchedExactly) census.framesMatchedExactlyWithAReading += 1;
    if (frameRow.matchedNearby) census.framesMatchedToANearbyCapture += 1;

    perFrame.push(frameRow);
  }

  return {
    perFrame,
    perDate: perDate.map((row) => ({
      ...row,
      missed: [...new Set(row.missed)].sort(),
      fp: [...new Set(row.fp)].sort(),
    })),
    census,
    totals,
  };
}

// ---------------------------------------------------------------------------
// REPORTING
// ---------------------------------------------------------------------------

function percent(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) : '0.0';
}

function printFrameRows(perFrame) {
  for (const frame of perFrame) {
    const parts = PORTFOLIOS.map((portfolio) => {
      const reading = frame.holdings[portfolio];
      if (!reading || !reading.scored) {
        return `${portfolio}: not scored (${reading ? reading.reason : 'no reading'})`;
      }
      return `${portfolio}: ${reading.hit}/${reading.gt}`
        + (reading.runsPooled > 1 ? ` (${reading.runsPooled} runs pooled)` : '')
        + (reading.fp.length ? ` fp=[${reading.fp.join(' ')}]` : '');
    });
    console.log(
      `${frame.date} ${frame.frameId}`
      + `  ${frame.timestampHms}`
      + `  offset=${frame.offsetSeconds === null ? 'n/a' : `${frame.offsetSeconds}s`}`
      + `  video=${frame.videoIdMatched ? 'yes' : 'no'}`
    );
    for (const part of parts) console.log(`      ${part}`);
    if (frame.disagreement && frame.disagreement.length) {
      console.log(`      runs disagree on: ${frame.disagreement.join(' ')}`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const roots = [];
  let toleranceSeconds = DEFAULT_TOLERANCE_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (arg === '--tolerance') {
      toleranceSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    roots.push(path.resolve(PROJECT_ROOT, arg));
  }
  const effectiveRoots = roots.length ? roots : defaultRoots();
  const tolerance = Number.isFinite(toleranceSeconds) && toleranceSeconds >= 0
    ? toleranceSeconds
    : DEFAULT_TOLERANCE_SECONDS;

  const gt = readRevereGroundTruth();
  const { logs, files, directories } = readProbeLogs(effectiveRoots);
  const report = scoreGroundTruth({ gt, logs, toleranceSeconds: tolerance });
  const { census, totals } = report;

  if (asJson) {
    console.log(JSON.stringify({
      roots: effectiveRoots,
      tolerance_seconds: tolerance,
      log_directories: directories.length,
      log_files: files.length,
      census,
      totals,
      micro_recall: Number(percent(totals.hit, totals.gt)),
      micro_precision: Number(percent(totals.hit, totals.pred)),
      per_date: report.perDate,
      per_frame: report.perFrame,
    }, null, 2));
    return 0;
  }

  console.log('--- per frame ---');
  printFrameRows(report.perFrame);

  console.log('');
  console.log('--- per date ---');
  for (const row of [...report.perDate].sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(
      `${row.date}  ${String(row.hit).padStart(2)}/${String(row.gt).padEnd(2)}`
      + `  pred=${String(row.pred).padStart(2)}`
      + `  frames=${row.frames} scored=${row.framesScored}`
      + `  recall=${((row.hit / Math.max(row.gt, 1)) * 100).toFixed(1).padStart(5)}%`
      + `  precision=${((row.hit / Math.max(row.pred, 1)) * 100).toFixed(1).padStart(5)}%`
      + (row.missed.length ? `  missed=[${row.missed.join(' ')}]` : '')
      + (row.fp.length ? `  fp=[${row.fp.join(' ')}]` : '')
    );
  }

  console.log('');
  console.log('--- the corpus this number is drawn from ---');
  console.log(`root directories          : ${effectiveRoots.length}`);
  console.log(`log directories found     : ${directories.length}`);
  console.log(`log files read            : ${census.logs}`);
  console.log(`logs with no date_key     : ${census.logs - census.logsWithDateKey}`);
  console.log(`logs outside the ground truth: ${census.logsOutsideGroundTruth}`);
  console.log(`logs for ground-truth dates: ${census.logsForGroundTruthDates}`);
  console.log(`captures in those logs    : ${census.capturesInGroundTruthLogs}`);
  console.log(`  within +/-${tolerance}s of a frame: ${census.capturesWithinTolerance}`);
  console.log(`ground-truth dates        : ${census.groundTruthDates}`);
  console.log(`  seen in the corpus      : ${census.datesWithALog}`);
  console.log(`  never seen at all       : ${census.datesNeverSeen.length}`
    + (census.datesNeverSeen.length ? `  [${census.datesNeverSeen.join(' ')}]` : ''));
  console.log(`ground-truth frames       : ${census.groundTruthFrames}`);
  console.log(`  never found             : ${census.framesNeverFound}`
    + (census.framesNeverFoundList.length
      ? `  [${census.framesNeverFoundList.map((entry) => `${entry.date}/${entry.frameId}`).join(' ')}]`
      : ''));
  console.log(`  captured at the exact ts: ${census.framesWithAnExactTimestampCapture}`
    + `  (of which the capture carried no portfolio reading: ${census.framesWhoseExactCaptureHadNoPortfolioReading})`);
  console.log(`  scored at the exact ts  : ${census.framesMatchedExactlyWithAReading}`);
  console.log(`  scored at a nearby ts   : ${census.framesMatchedToANearbyCapture}`);
  console.log(`  matched without a video id match: ${census.framesMatchedWithoutAVideoIdMatch}`);
  console.log(`  runs disagreed on a frame: ${census.framesWithDisagreeingRuns}`
    + `  (readings pooled from >1 run: ${census.readingsPooledFromMoreThanOneRun})`);
  console.log(`ground-truth readings     : ${census.groundTruthReadings} (${census.groundTruthFrames} frames x ${PORTFOLIOS.length} portfolios)`);
  console.log(`  scored                  : ${census.readingsScored}`);
  console.log(`  lost: no capture        : ${census.readingsLostToMissingCapture}`);
  console.log(`  lost: no portfolio reading: ${census.readingsLostToMissingPortfolioReading}`);
  if (census.ignoredGroundTruthKeys.length) {
    console.log(`ignored ground-truth keys : ${census.ignoredGroundTruthKeys.length}`
      + `  [${census.ignoredGroundTruthKeys.map((entry) => entry.key).join(' ')}]`);
  }
  console.log('');
  console.log('The score is a SURVIVING SAMPLE, not a corpus-wide figure:');
  console.log('a ground-truth frame the corpus never captured, or captured');
  console.log('without a per-portfolio reading, is reported above rather than');
  console.log('scored on a guess.');
  console.log('');
  console.log(`readings scored   : ${census.readingsScored}/${census.groundTruthReadings}`);
  console.log(`micro recall      : ${percent(totals.hit, totals.gt)}%  (${totals.hit}/${totals.gt})`);
  console.log(`micro precision   : ${percent(totals.hit, totals.pred)}%  (${totals.hit}/${totals.pred})`);
  return 0;
}

module.exports = {
  DEFAULT_GT_PATH,
  DEFAULT_TOLERANCE_SECONDS,
  PORTFOLIOS,
  collectLogFiles,
  defaultRoots,
  discoverLogDirectories,
  listGroundTruthDateKeys,
  listGroundTruthFrames,
  listGroundTruthReadings,
  parseFrameId,
  readCaptureReadings,
  readProbeLog,
  readProbeLogs,
  readRevereGroundTruth,
  scoreGroundTruth,
};

if (require.main === module) {
  main();
}
