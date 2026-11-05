'use strict';

// Replay every captured EasyOCR/Tesseract snapshot log through the CURRENT
// parser and score it against data/qmg_ground_truth.json.
//
// This is the offline counterpart to a full re-scan: the logs already contain
// the raw `ocr_text` + `ocr_words` + `ocr_engine`, so parser changes can be
// measured in seconds instead of ~12 min/video of EasyOCR time.
//
// Usage:
//   node tools/evalParserReplay.js [globRoot...]
//   node tools/evalParserReplay.js data/video_ocr_probe/qmg-easyocr-20261018
//   node tools/evalParserReplay.js --json
//   node tools/evalParserReplay.js --drop-aliases A,AL
//   node tools/evalParserReplay.js --confusion-csv path/to/other.csv
//
// Exit code is 0 on a completed run and 2 on a usage error — this is a
// report, not a gate.
//
// The last two flags select the curated alias table by PATH. A before/after
// measurement of that table used to mean editing
// config/ticker_ocr_confusions.csv in place, which is shared: two
// measurements in one tree raced each other, the table flipped between its
// 20-line and 29-line forms mid-measurement twice, and a wrong "before"
// column was reported once as a result.
//
// ---------------------------------------------------------------------------
// WHAT THIS NUMBER IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
//
// The probe logs only carry per-word geometry (`ocr_words`) from commit
// 02e481f (2026-10-18) onwards. Every log written before that date has no
// `ocr_words` at all, and a log without them cannot be replayed through the
// current parser: the parser's column gate, panel gate, Filter B and its
// in-column repair pass all need word positions. Replaying such a log on
// `ocr_text` alone measures a DIFFERENT and much weaker parser (precision
// falls from ~93% to ~12%), so it is not done here.
//
// The consequence is that this tool measures a SURVIVING SAMPLE, and the
// sample is not random: it is the post-2026-10-18 crop profile. The census
// this tool prints says so explicitly, so the headline number cannot be
// mistaken for a corpus-wide figure.
//
// Scores are per DATE. A date's ground truth is counted ONCE, however many
// logs cover it, and the predictions of every log for that date are pooled.
// Counting the ground truth once per log file inflated the denominator by
// 2.17x and made "dates scored" a count of log rows rather than of dates.
//
// The score above is a CAPTURE-level one — what ONE frame showed. The
// artifact the production consumers read is the VIDEO-level consensus
// (`merged_position_list`), and the two have disagreed three times on
// record, so both are measured. See 'The VIDEO-level reading' below.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseChartStreamPositionList,
  clusterVideoLevelReadings,
  setOcrConfusionCsvPath,
} = require('../src/parse/parseChartStream');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');
const { layoutAliasEraForDate } = require('../src/video/chartStreamCrop');

// Whether the parse applies the LAYOUT-SCOPED alias rows
// (config/ticker_ocr_confusions_right_sidebar.csv). On by default, because
// the scan tool applies them; `--no-layout-aliases` turns them off, so the
// rows' worth is a measured difference rather than an argument.
let useLayoutAliases = true;
function setUseLayoutAliases(value) {
  const previous = useLayoutAliases;
  useLayoutAliases = Boolean(value);
  return previous;
}
const { listGroundTruthCaptures } = require('../src/qmg/qmgGroundTruth');

const GT_PATH = path.resolve(__dirname, '..', 'data', 'qmg_ground_truth.json');
const DEFAULT_ROOTS = [
  'data/video_ocr_probe/qmg-easyocr-20261018',
  'data/video_ocr_probe/qmg-easyocr-20261017',
  'data/video_ocr_probe/qmg-1080p-batch1',
  'data/video_ocr_probe/qmg-1080p-batch2',
  'data/video_ocr_probe/qmg-1080p-test',
  'data/video_ocr_probe/batch15-v2',
  'data/video_ocr_probe/easyocr-test2',
  'data/video_ocr_probe/fix-verify-2022',
];

// The crop width the scan recorded, so the parser sees the same coordinate
// space it saw live. `ocr_frame_width` is the width of the frame the OCR ran
// on; the crop is that frame's region, upscaled. Note that the parser's
// column detector takes `cropWidth` and never reads it, so this value does
// not currently affect the score -- it is kept correct so it cannot become a
// trap the day somebody reintroduces an x-threshold gate.
const OCR_UPSCALE = 5;

function collectLogFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('_snapshot.json')) out.push(full);
    }
  };
  walk(root);
  return out;
}

// The ground truth file stores two shapes per date: an array of tickers, or
// an object `{tickers, crop}` per capture. `src/qmg/qmgGroundTruth.js` reads
// both; a local reimplementation of it silently dropped the four dates in the
// object form (20220323, 20220427, 20220428, 20220510).
//
// For a date-level score the union of that date's captures is the target: a
// position list is stable within a video, and the GT file records per-capture
// variants of it.
function groundTruthForDate(gt, dateKey) {
  const captures = listGroundTruthCaptures(gt, { dates: [dateKey] });
  const all = new Set();
  for (const capture of captures) {
    for (const ticker of capture.tickers || []) all.add(String(ticker).toUpperCase());
  }
  return all.size ? all : null;
}

function cropWidthFor(log) {
  const region = log.phash_region_fraction;
  const frameWidth = Number(log.ocr_frame_width);
  if (!region || !Number.isFinite(frameWidth) || frameWidth <= 0) return null;
  return Math.round(region.w * frameWidth * OCR_UPSCALE);
}

// Score a set of probe logs against the ground truth.
//
// Returns the per-date rows plus a census of how much of the corpus was
// reachable at all. The census is not decoration: without it the headline
// recall reads as a corpus-wide figure when it is a survival-weighted one.
function scoreLogs({ gt, files, parseCapture = defaultParse }) {
  const census = {
    files: 0,
    logs: 0,
    logsWithoutDateKey: 0,
    logsOutsideGroundTruth: 0,
    logsWithWords: 0,
    // Captures of the logs that reached the ground truth. A log with no
    // date_key, or with a date the ground truth does not know, is out of
    // scope entirely and its captures are not counted here.
    capturesInGtDateLogs: 0,
    capturesWithWords: 0,
  };

  const byDate = new Map();

  for (const file of files) {
    census.files += 1;
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    census.logs += 1;

    const dateKey = log.date_key;
    if (!dateKey) {
      census.logsWithoutDateKey += 1;
      continue;
    }
    const expected = groundTruthForDate(gt, dateKey);
    if (!expected) {
      census.logsOutsideGroundTruth += 1;
      continue;
    }

    const captures = Array.isArray(log.captures) ? log.captures : [];
    let row = byDate.get(dateKey);
    if (!row) {
      row = { date: dateKey, expected, predicted: new Set(), logs: 0, sources: [] };
      byDate.set(dateKey, row);
    }
    row.logs += 1;
    row.sources.push(file);

    let wordsInThisLog = 0;
    for (const capture of captures) {
      census.capturesInGtDateLogs += 1;
      const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
      if (!words.length) continue;
      census.capturesWithWords += 1;
      wordsInThisLog += 1;

      const result = parseCapture(capture, log);
      for (const ticker of result) row.predicted.add(String(ticker).toUpperCase());
    }
    if (wordsInThisLog) census.logsWithWords += 1;
  }

  const perDate = [];
  let totalHit = 0;
  let totalGt = 0;
  let totalPred = 0;

  for (const row of byDate.values()) {
    const hit = [...row.predicted].filter((ticker) => row.expected.has(ticker)).length;
    // A date whose every log lacked `ocr_words` could not be MEASURED. Its
    // ground truth must not enter the score's denominator: with no
    // prediction to compare against, including it would measure the
    // corpus's replayability rather than the parser. It is reported in the
    // census instead, which is where the survivorship belongs.
    const scored = row.predicted.size > 0;
    if (scored) {
      totalHit += hit;
      totalGt += row.expected.size;
      totalPred += row.predicted.size;
    }
    perDate.push({
      date: row.date,
      hit,
      gt: row.expected.size,
      pred: row.predicted.size,
      logs: row.logs,
      scored,
      missed: [...row.expected].filter((ticker) => !row.predicted.has(ticker)).sort(),
      fp: [...row.predicted].filter((ticker) => !row.expected.has(ticker)).sort(),
    });
  }

  // The ground-truth file also carries two annotated duplicate dates
  // ("20220323 (batch t=1020s)" and "20220428 (batch t=1300s)"). They are
  // not dates of their own -- they are the same captures of the same video,
  // under a label -- so they are excluded from the date census.
  const gtDates = new Set(
    listGroundTruthCaptures(gt, {})
      .map((capture) => capture.dateKey)
      .filter((dateKey) => /^\d{8}$/.test(dateKey)),
  );

  return {
    perDate,
    census: {
      ...census,
      groundTruthDates: gtDates.size,
      datesWithALog: byDate.size,
      datesScored: perDate.filter((row) => row.scored).length,
      datesLostToMissingWords: perDate.filter((row) => !row.scored).length,
      groundTruthDatesNeverSeen: [...gtDates].filter(
        (dateKey) => !byDate.has(dateKey),
      ),
    },
    totals: { hit: totalHit, gt: totalGt, pred: totalPred },
  };
}

function defaultParse(capture, log) {
  const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
  const result = parseChartStreamPositionList({
    layoutEra: useLayoutAliases ? layoutAliasEraForDate(log && log.date_key) : null,
    ocr: {
      text: capture.ocr_text || '',
      words,
      _cropWidth: cropWidthFor(log),
      _engine: (log.ocr_engine_metadata || {}).engine,
    },
  });
  return result.position_list || [];
}

// ---------------------------------------------------------------------------
// The VIDEO-level reading — the number production actually publishes
// ---------------------------------------------------------------------------
//
// The capture-level score says what ONE frame showed. The artifact the
// production consumers read is `merged_position_list` — the multi-frame
// clusterer's consensus — and the two have disagreed three times on record:
//
//   * `REGN` on 20230609. A capture read the panel's `RGTI` row as `Rgn`,
//     and the distance-1 repair pass turned that into `REGN`, a SEED
//     ticker. The selected capture was clean; the CONSENSUS was not.
//   * `U` on 20230523. A capture read the collapsed `LI` cell as `U`, and
//     the consensus published it as a holding.
//   * `AAPL` on 20230605. `AAPL` is in NO capture's reading at all: the
//     clusterer renamed a garbage read (`ARCO`) to a seed ticker and
//     published a holding no frame of the video ever showed.
//
// A capture-level metric cannot see any of the three — CLAUDE.md records the
// same conclusion twice — so it cannot be the only number. Three readings
// are measured here, and each is EXACT about something different:
//
//   recorded          the log's own `merged_position_list`, verbatim: what
//                     production published, from the parser of the day.
//   rebuilt           the CURRENT clusterer over the log's recorded
//                     per-frame input (`cluster_input`): the clusterer's own
//                     behaviour, with the per-frame readings as recorded.
//   rebuilt_current   the CURRENT parser end to end, over the captures the
//                     log kept: the per-frame parser's behaviour at the
//                     video level.
//
// The third is the one a per-frame parser change moves, and it is the least
// faithful: the production clusterer saw EVERY OCR'd frame, while a log
// keeps only the SELECTED captures. That gap is stated in the output rather
// than hidden, and each arm carries its own denominator — a date that could
// not be measured in one arm is reported as lost there, and does not enter
// that arm's totals.

// The scan tool's clusterer recipe.
//
// It is NOT reimplemented here: `clusterVideoLevelReadings` in
// src/parse/parseChartStream.js is the single implementation, and the scan
// tool (production) calls it too. A replay that clustered differently from
// production would be measuring a parser that does not exist.
//
// The snapshot branch's rule: the clusterer is fed the per-frame
// `position_list` readings, repairs against the DECODE lexicon (seed +
// observed), and relaxes Filter A to 1 when only one frame contributes.
const CLUSTER_MAX_DISTANCE = 1;
const CLUSTER_MIN_TOKEN_LENGTH = 2;
const CLUSTER_DEFAULT_MIN_FREQUENCY = 2;

// The clusterer's canonical-selection rules.
//
//   shipped              the rule the scan tool runs: a member that IS a
//                        lexicon ticker wins; otherwise the cluster is
//                        corrected to the closest lexicon ticker of the
//                        FIRST member that yields a correction, and the tie
//                        inside that member is broken by "prefer the longer
//                        ticker".
//   corroborated         the same, PLUS the rule that a CORRECTED canonical
//                        must be within edit distance 1 of at least one
//                        cluster member. A cluster that fails it is DISCARDED.
//   supported            the canonical is the correction the VIDEO actually
//                        read, breaking ties between equally-close
//                        candidates. Distance still comes first.
//   supported+corroborated both.
//   video-supported      the video's support DOMINATES the distance, so a
//                        candidate the video demonstrably held beats a closer
//                        candidate it never read.
//   video-supported+corroborated both.
//
// The second exists because the first can publish a holding no frame of the
// video showed: on 20230605 the cluster {AACO, ARCO} was published as
// `AAPL`, which is in no capture's reading of that video.
//
// The third exists because the second throws the cluster away, and the
// cluster's OTHER member had the right answer. **Every candidate for that
// cluster is TWO edits away** -- AACO is 2 from AAPL and 2 from AAL, and
// ARCO is 2 from ARQQ and 2 from ARKG -- so "closest" cannot discriminate
// between them at all, and a rule that picks the closest correction picks a
// tie and keeps the shipped answer. What discriminates is the video's own
// reading: ARQQ was read in six frames of that video and AAPL in none.
//
// The `supported` rule uses that signal only to break a tie, which is the
// conservative ordering. The `video-supported` rule lets it dominate the
// distance, which can move a cluster off a correct one-glyph correction. The
// corpus is what says which one is worth shipping.
//
// The current production default is `corroborated`; the flag below is how
// the named alternatives are measured over the recorded logs, with no OCR and
// no change to any shared config file.
// The cluster rules, each as the switches it turns on.
//
// `shipped` is the rule as it was BEFORE 2026-11-03 -- the corroboration
// gate off. The scan tool now runs `corroborated` by default, so `shipped`
// is what reproduces the old behaviour, and the batch runner's
// `--cluster-rule shipped` passes `--no-cluster-corroboration` to match.
//
// Every rule here is a fully-SPECIFIED set of switches, so it does not
// depend on any default.
const CLUSTER_RULES = {
  shipped: { requireDistanceOneCorroboration: false, preferSupportedCorrection: false, preferVideoSupport: false },
  corroborated: { requireDistanceOneCorroboration: true, preferSupportedCorrection: false, preferVideoSupport: false },
  'corroborated-strict': { requireDistanceOneCorroboration: true, corroborationAllowsVideoSupport: false, preferSupportedCorrection: false, preferVideoSupport: false },
  supported: { requireDistanceOneCorroboration: false, preferSupportedCorrection: true, preferVideoSupport: false },
  'supported+corroborated': { requireDistanceOneCorroboration: true, preferSupportedCorrection: true, preferVideoSupport: false },
  'video-supported': { requireDistanceOneCorroboration: false, preferSupportedCorrection: false, preferVideoSupport: true },
  'video-supported+corroborated': { requireDistanceOneCorroboration: true, preferSupportedCorrection: false, preferVideoSupport: true },
  swallowed: { publishSwallowedHoldings: true, requireDistanceOneCorroboration: false },
  'corroborated+swallowed': { publishSwallowedHoldings: true, requireDistanceOneCorroboration: true },
};

// What each rule does, in one line, for the report.
const CLUSTER_RULE_DESCRIPTIONS = {
  shipped: 'the rule as it was before 2026-11-03: a corrected canonical is published even when nothing corroborates it',
  corroborated: 'a corrected canonical must be within edit distance 1 of a cluster member, or the cluster is DISCARDED',
  'corroborated-strict': 'the same, and the video\'s own reading of the ticker does NOT count as corroboration',
  supported: 'the canonical is the correction the VIDEO actually read, breaking TIES between equally-close candidates',
  'supported+corroborated': 'the same, and the canonical must also be within edit distance 1',
  'video-supported': 'the canonical is the correction the VIDEO actually read, whatever its distance',
  'video-supported+corroborated': 'the same, and the canonical must also be within edit distance 1',
  swallowed: 'a cluster\'s OTHER lexicon tickers are published too, when the video read them in >= 4 frames of their own',
  'corroborated+swallowed': 'the same, and the canonical must also be within edit distance 1',
};

// The name of a cluster rule. ONE implementation, in
// src/parse/parseChartStream.js, used by the scan tool too -- the replay
// compares a log's recorded rule against the rule it is applying, so the two
// have to name the same combination the same way. They have drifted twice.
const { clusterRuleName } = require('../src/parse/parseChartStream');

function recordedClusterRuleOf(log) {
  return clusterRuleName({
    requireDistanceOneCorroboration: log && log.cluster_corroboration === true,
    preferSupportedCorrection: log && log.cluster_supported === true,
    preferVideoSupport: log && log.cluster_video_supported === true,
    corroborationAllowsVideoSupport: log && log.cluster_strict_corroboration !== true,
    publishSwallowedHoldings: log && log.cluster_swallowed_holdings === true,
  });
}

function clusterMerged(input, minFrequency, lexicon, clusterOptions = {}) {
  if (!Array.isArray(input) || !input.length) return null;
  const result = clusterVideoLevelReadings(input, {
    maxDistance: CLUSTER_MAX_DISTANCE,
    minTokenLength: CLUSTER_MIN_TOKEN_LENGTH,
    defaultMinFrequency: CLUSTER_DEFAULT_MIN_FREQUENCY,
    minFrequency: Number.isFinite(minFrequency) ? minFrequency : undefined,
    lexicon,
    requireDistanceOneCorroboration: clusterOptions.requireDistanceOneCorroboration === true,
    corroborationAllowsVideoSupport: clusterOptions.corroborationAllowsVideoSupport !== false,
    preferSupportedCorrection: clusterOptions.preferSupportedCorrection === true,
    preferVideoSupport: clusterOptions.preferVideoSupport === true,
    publishSwallowedHoldings: clusterOptions.publishSwallowedHoldings === true,
    swallowedHoldingMinFrames: clusterOptions.swallowedHoldingMinFrames,
    explainDropped: clusterOptions.explainDropped === true
  });
  return Array.isArray(result.merged_list) ? result.merged_list : [];
}

// The log's own per-frame readings -- the arrays the clusterer clustered.
//
// The scan tool built its clusterer input from every OCR'd CANDIDATE frame's
// `chart_stream.position_list`. A probe log keeps the SELECTED captures, each
// with that same array, so a log that predates `cluster_input` still carries
// the readings the clusterer ran on -- for the frames it kept.
//
// This is the input the CLUSTER rule is measured over: the per-frame readings
// are the parser's, so a difference between two cluster rules is a difference
// between the rules and nothing else.
function recordedFrameReadings(log) {
  const captures = Array.isArray(log.captures) ? log.captures : [];
  const frames = [];
  for (const capture of captures) {
    const list = capture && capture.chart_stream && capture.chart_stream.position_list;
    if (!Array.isArray(list) || !list.length) continue;
    frames.push(list.map((ticker) => String(ticker).toUpperCase()).join(' '));
  }
  return frames;
}

// The three ways to read a log at the video level. Each returns null when
// the log cannot support that reading — and a null is not a zero: the date
// is reported as unmeasured in that arm, and does not enter its totals.
function mergedReaders(parseCapture, lexicon, clusterOptions = {}) {
  return {
    recorded(log) {
      if (!Array.isArray(log.merged_position_list)) return null;
      return log.merged_position_list;
    },
    rebuilt(log) {
      // The exact frames and threshold the clusterer ran with, when the log
      // recorded them.
      if (Array.isArray(log.cluster_input) && log.cluster_input.length) {
        return clusterMerged(log.cluster_input, log.cluster_min_frequency, lexicon, clusterOptions);
      }
      // Otherwise the log's own per-frame readings. This is what makes the
      // arm measurable at all on the corpus that exists: `cluster_input`
      // post-dates every captured log, so without this fallback the arm
      // would be empty everywhere.
      const frames = recordedFrameReadings(log);
      if (!frames.length) return null;
      return clusterMerged(frames, log.cluster_min_frequency, lexicon, clusterOptions);
    },
    rebuilt_current(log) {
      const captures = Array.isArray(log.captures) ? log.captures : [];
      const input = [];
      for (const capture of captures) {
        const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
        if (!words.length) continue;
        const reading = parseCapture(capture, log) || [];
        if (reading.length) input.push(reading.map((t) => String(t).toUpperCase()).join(' '));
      }
      if (!input.length) return null;
      return clusterMerged(input, null, lexicon, clusterOptions);
    },
  };
}

// Score the VIDEO-level readings of a set of probe logs.
//
// The ground truth is counted once per date, exactly as in scoreLogs: a date
// whose readings could not be produced contributes to no arm's denominator.
function scoreMergedLists({ gt, files, parseCapture = defaultParse, clusterOptions = {} }) {
  const lexicon = loadDecodeLexiconSync();
  const readers = mergedReaders(parseCapture, lexicon, clusterOptions);
  const armNames = Object.keys(readers);

  const byDate = new Map();
  const census = {
    files: 0,
    logs: 0,
    logsWithoutDateKey: 0,
    logsOutsideGroundTruth: 0,
    // How many of the logs RECORD their own cluster rule, and how many of
    // those disagree with the rule this run is applying. The flag governs
    // the rebuilt arms -- that is the whole point of measuring a rule over
    // a corpus -- but a reader has to know when a log's own merged list was
    // made under a different rule than the one being applied to it.
    logsWithRecordedClusterRule: 0,
    logsWithDifferentRecordedClusterRule: 0,
    // Where the `rebuilt` arm's clusterer input came from: the log's own
    // `cluster_input`, the log's recorded per-frame readings, or neither.
    logsWithRecordedClusterInput: 0,
    logsWithFrameReadingFallback: 0,
    logsWithNoClusterInput: 0,
  };
  const ruleUnderTest = clusterRuleName(clusterOptions);

  for (const file of files) {
    census.files += 1;
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    census.logs += 1;

    const dateKey = log.date_key;
    if (!dateKey) {
      census.logsWithoutDateKey += 1;
      continue;
    }
    const expected = groundTruthForDate(gt, dateKey);
    if (!expected) {
      census.logsOutsideGroundTruth += 1;
      continue;
    }

    let row = byDate.get(dateKey);
    if (!row) {
      row = { date: dateKey, expected, logs: 0, arms: {} };
      for (const name of armNames) row.arms[name] = new Set();
      byDate.set(dateKey, row);
    }
    row.logs += 1;

    if (typeof log.cluster_corroboration === 'boolean'
        || typeof log.cluster_supported === 'boolean'
        || typeof log.cluster_video_supported === 'boolean') {
      census.logsWithRecordedClusterRule += 1;
      if (recordedClusterRuleOf(log) !== ruleUnderTest) {
        census.logsWithDifferentRecordedClusterRule += 1;
      }
    }

    if (Array.isArray(log.cluster_input) && log.cluster_input.length) {
      census.logsWithRecordedClusterInput += 1;
    } else if (recordedFrameReadings(log).length) {
      census.logsWithFrameReadingFallback += 1;
    } else {
      census.logsWithNoClusterInput += 1;
    }

    for (const name of armNames) {
      let reading = null;
      try {
        reading = readers[name](log, parseCapture);
      } catch {
        reading = null;
      }
      if (!Array.isArray(reading) || !reading.length) continue;
      for (const ticker of reading) row.arms[name].add(String(ticker).toUpperCase());
    }
  }

  const arms = {};
  for (const name of armNames) {
    const perDate = [];
    let totalHit = 0;
    let totalGt = 0;
    let totalPred = 0;

    for (const row of byDate.values()) {
      const predicted = row.arms[name];
      const hit = [...predicted].filter((ticker) => row.expected.has(ticker)).length;
      // Same rule as the capture-level score: a date with no reading at all
      // could not be MEASURED, so its ground truth must not enter the
      // denominator. It is reported in the census instead.
      const scored = predicted.size > 0;
      if (scored) {
        totalHit += hit;
        totalGt += row.expected.size;
        totalPred += predicted.size;
      }
      perDate.push({
        date: row.date,
        hit,
        gt: row.expected.size,
        pred: predicted.size,
        logs: row.logs,
        scored,
        missed: [...row.expected].filter((ticker) => !predicted.has(ticker)).sort(),
        fp: [...predicted].filter((ticker) => !row.expected.has(ticker)).sort(),
      });
    }

    arms[name] = {
      perDate,
      census: {
        datesWithALog: byDate.size,
        datesScored: perDate.filter((entry) => entry.scored).length,
        datesLostToMissingReading: perDate.filter((entry) => !entry.scored).length,
      },
      totals: { hit: totalHit, gt: totalGt, pred: totalPred },
    };
  }

  return {
    arms,
    census: {
      ...census,
      groundTruthDates: new Set(
        listGroundTruthCaptures(gt, {})
          .map((capture) => capture.dateKey)
          .filter((dateKey) => /^\d{8}$/.test(dateKey)),
      ).size,
    },
  };
}

function percent(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) : '0.0';
}

// ---------------------------------------------------------------------------
// The curated alias table override
// ---------------------------------------------------------------------------
//
// `--confusion-csv PATH` parses under a DIFFERENT alias table, and
// `--drop-aliases A,B` parses with those rows removed.
//
// Both exist because a before/after measurement of the alias table used to
// mean editing config/ticker_ocr_confusions.csv in place. The map is cached
// at module level and the file is shared, so two measurements in one tree
// raced each other: the table flipped between its 20-line and 29-line forms
// mid-measurement, twice, and a wrong "before" column was reported once as
// a result. The table is now selected by PATH and the cache is keyed by the
// resolved path, so both columns can be produced in one process, in either
// order, with nothing on disk changed.

const ALIAS_CSV = path.resolve(__dirname, '..', 'config', 'ticker_ocr_confusions.csv');

function splitAliasList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function countAliasRows(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function parseFlags(argv) {
  const flags = {
    json: false,
    roots: [],
    confusionCsv: '',
    dropAliases: [],
    groundTruth: '',
    layoutAliases: true,
    // The default matches what the SCAN TOOL now does, so the `rebuilt` arm
    // measures the pipeline that actually runs. `--cluster-rule shipped`
    // measures the pre-2026-11-03 behaviour instead.
    clusterRule: 'corroborated+swallowed'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--ground-truth') {
      flags.groundTruth = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--ground-truth=')) {
      flags.groundTruth = arg.slice('--ground-truth='.length);
    } else if (arg === '--confusion-csv') {
      flags.confusionCsv = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--confusion-csv=')) {
      flags.confusionCsv = arg.slice('--confusion-csv='.length);
    } else if (arg === '--drop-aliases') {
      flags.dropAliases = splitAliasList(argv[i + 1] || '');
      i += 1;
    } else if (arg.startsWith('--drop-aliases=')) {
      flags.dropAliases = splitAliasList(arg.slice('--drop-aliases='.length));
    } else if (arg === '--no-layout-aliases') {
      flags.layoutAliases = false;
    } else if (arg === '--cluster-rule') {
      flags.clusterRule = argv[i + 1] || '';
      i += 1;
    } else if (arg.startsWith('--cluster-rule=')) {
      flags.clusterRule = arg.slice('--cluster-rule='.length);
    } else if (arg.startsWith('--')) {
      const error = new Error(`unknown flag: ${arg}`);
      error.usage = true;
      throw error;
    } else {
      flags.roots.push(arg);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(CLUSTER_RULES, flags.clusterRule)) {
    const error = new Error(
      `unknown --cluster-rule: ${flags.clusterRule} (expected one of: ${Object.keys(CLUSTER_RULES).join(', ')})`
    );
    error.usage = true;
    throw error;
  }
  return flags;
}

function applyAliasTableOverride(flags) {
  const drop = flags.dropAliases;
  const baseCsv = flags.confusionCsv ? path.resolve(flags.confusionCsv) : ALIAS_CSV;
  const previous = setOcrConfusionCsvPath(baseCsv);
  let tempDir = null;
  let effective = baseCsv;

  if (drop.length) {
    const lines = fs.readFileSync(baseCsv, 'utf8').split(/\r?\n/);
    const kept = lines.filter((line, index) => {
      if (index === 0) return true;
      const garbled = String(line.split(',')[0] || '').trim().toUpperCase();
      if (!garbled) return true;
      return !drop.includes(garbled);
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-alias-'));
    effective = path.join(tempDir, 'ticker_ocr_confusions.csv');
    fs.writeFileSync(effective, kept.join('\n'));
    setOcrConfusionCsvPath(effective);
  }

  return {
    describe() {
      return {
        source: baseCsv,
        dropped: drop,
        rows: countAliasRows(effective),
      };
    },
    restore() {
      setOcrConfusionCsvPath(previous);
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // A leftover temp directory is harmless; never fail a report over it.
        }
      }
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const asJson = flags.json;
  const effectiveRoots = flags.roots.length ? flags.roots : DEFAULT_ROOTS;

  const aliasOverride = applyAliasTableOverride(flags);
  setUseLayoutAliases(flags.layoutAliases);

  const gtPath = flags.groundTruth ? path.resolve(flags.groundTruth) : GT_PATH;
  const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
  const files = effectiveRoots.flatMap((root) => collectLogFiles(path.resolve(root)));
  const report = scoreLogs({ gt, files });
  const clusterOptions = CLUSTER_RULES[flags.clusterRule];
  const mergedReport = scoreMergedLists({ gt, files, clusterOptions });

  if (asJson) {
    console.log(JSON.stringify({
      roots: effectiveRoots,
      ground_truth: gtPath,
      alias_table: aliasOverride.describe(),
      cluster_rule: flags.clusterRule,
      census: report.census,
      merged_census: mergedReport.census,
      totals: report.totals,
      micro_recall: Number(percent(report.totals.hit, report.totals.gt)),
      micro_precision: Number(percent(report.totals.hit, report.totals.pred)),
      per_date: report.perDate.map((row) => ({
        date: row.date,
        hit: row.hit,
        gt: row.gt,
        pred: row.pred,
        logs: row.logs,
        scored: row.scored,
        missed: row.missed,
        fp: row.fp,
      })),
      merged: Object.fromEntries(
        Object.entries(mergedReport.arms).map(([name, arm]) => [
          name,
          {
            census: arm.census,
            totals: arm.totals,
            micro_recall: Number(percent(arm.totals.hit, arm.totals.gt)),
            micro_precision: Number(percent(arm.totals.hit, arm.totals.pred)),
            per_date: arm.perDate.map((row) => ({
              date: row.date,
              hit: row.hit,
              gt: row.gt,
              pred: row.pred,
              logs: row.logs,
              scored: row.scored,
              missed: row.missed,
              fp: row.fp,
            })),
          },
        ]),
      ),
    }, null, 2));
    aliasOverride.restore();
    return 0;
  }

  const perDate = [...report.perDate].sort(
    (a, b) => (b.hit / b.gt) - (a.hit / a.gt) || a.date.localeCompare(b.date),
  );
  for (const row of perDate.filter((entry) => entry.scored)) {
    console.log(
      `${row.date}  ${String(row.hit).padStart(2)}/${String(row.gt).padEnd(2)}`
      + `  pred=${String(row.pred).padStart(2)}`
      + `  logs=${String(row.logs).padStart(2)}`
      + `  recall=${((row.hit / row.gt) * 100).toFixed(0).padStart(3)}%`
      + `  precision=${((row.hit / Math.max(row.pred, 1)) * 100).toFixed(0).padStart(3)}%`
      + `  missed=[${row.missed.join(' ')}]  fp=[${row.fp.join(' ')}]`
    );
  }

  const unmeasurable = perDate.filter((entry) => !entry.scored);
  if (unmeasurable.length) {
    console.log('');
    console.log('--- dates that could NOT be measured (every log predates `ocr_words`) ---');
    for (const row of unmeasurable) {
      console.log(
        `${row.date}  gt=${String(row.gt).padEnd(2)}  logs=${String(row.logs).padStart(2)}`
        + `  -- not scored, not counted in the totals`,
      );
    }
  }

  // The VIDEO-level readings: the artifact the production consumers read.
  //
  // The capture-level number above says what ONE frame showed. These say
  // what the multi-frame consensus said, and the two have disagreed three
  // times on record (REGN, U, AAPL) — a defect only the consensus shows is
  // invisible to a capture-level metric.
  console.log('');
  console.log('--- the VIDEO-level reading (what production publishes) ---');
  console.log(`cluster rule       : ${flags.clusterRule}`
    + `   (${CLUSTER_RULE_DESCRIPTIONS[flags.clusterRule] || 'unknown rule'})`);
  const mergedArms = mergedReport.arms;
  const mergedDates = new Set();
  for (const arm of Object.values(mergedArms)) {
    for (const row of arm.perDate) mergedDates.add(row.date);
  }
  for (const date of [...mergedDates].sort()) {
    const cells = ['recorded', 'rebuilt', 'rebuilt_current'].map((name) => {
      const row = mergedArms[name].perDate.find((entry) => entry.date === date);
      if (!row || !row.scored) return '--';
      return `${String(row.hit).padStart(2)}/${String(row.gt).padEnd(2)}`;
    });
    console.log(`${date}  recorded=${cells[0]}  rebuilt=${cells[1]}  rebuilt_current=${cells[2]}`);
  }
  console.log('');
  console.log('  recorded        : the log\'s own merged list — what production published');
  console.log('                    (unaffected by the cluster rule: it is what the rule of the day produced)');
  console.log('  rebuilt         : the current clusterer over the log\'s recorded per-frame readings');
  console.log('                    (the frames production clustered, so this arm is where the CLUSTER');
  console.log('                     rule is measured on its own — the per-frame parser is held fixed)');
  console.log('  rebuilt_current : the current parser end to end, over the captures the log kept');
  console.log('                    (the production clusterer saw EVERY ocr\'d frame; a log keeps');
  console.log('                     only the selected captures, so this arm is the least faithful)');
  if (mergedReport.census.logsWithRecordedClusterRule) {
    console.log(`  logs recording their own cluster rule: ${mergedReport.census.logsWithRecordedClusterRule}`
      + ` (${mergedReport.census.logsWithDifferentRecordedClusterRule} disagree with the rule under test)`);
  }
  for (const [name, arm] of Object.entries(mergedArms)) {
    console.log(
      `${name.padEnd(18)}: dates scored ${String(arm.census.datesScored).padStart(2)}`
      + `  recall ${percent(arm.totals.hit, arm.totals.gt)}%  (${arm.totals.hit}/${arm.totals.gt})`
      + `  precision ${percent(arm.totals.hit, arm.totals.pred)}%  (${arm.totals.hit}/${arm.totals.pred})`
      + `  lost ${arm.census.datesLostToMissingReading}`,
    );
  }

  const { census, totals } = report;
  console.log('');
  console.log('--- the corpus this number is drawn from ---');
  console.log(`files walked              : ${census.files}`);
  console.log(`logs parsed               : ${census.logs}`);
  console.log(`logs with no date_key     : ${census.logsWithoutDateKey}`);
  console.log(`logs outside the ground truth: ${census.logsOutsideGroundTruth}`);
  console.log(`logs WITH ocr_words       : ${census.logsWithWords}`
    + '   (the rest predate commit 02e481f and cannot be replayed)');
  console.log(`captures with ocr_words    : ${census.capturesWithWords}/${census.capturesInGtDateLogs}`);
  console.log(`ground-truth dates        : ${census.groundTruthDates}`);
  console.log(`  seen in the corpus      : ${census.datesWithALog}`);
  console.log(`  never seen at all       : ${census.groundTruthDatesNeverSeen.length}`
    + (census.groundTruthDatesNeverSeen.length
      ? `  [${census.groundTruthDatesNeverSeen.join(' ')}]`
      : ''));
  console.log(`  scored                  : ${census.datesScored}`);
  console.log(`  lost to missing words   : ${census.datesLostToMissingWords}`);
  console.log('');
  console.log('The score is a SURVIVING SAMPLE, not a corpus-wide figure:');
  console.log('a log without per-word geometry exercises a different, weaker');
  console.log('parser, so it is excluded rather than scored on ocr_text alone.');
  console.log('');
  console.log(`dates scored     : ${census.datesScored}`);
  console.log(`micro recall     : ${percent(totals.hit, totals.gt)}%  (${totals.hit}/${totals.gt})`);
  console.log(`micro precision  : ${percent(totals.hit, totals.pred)}%  (${totals.hit}/${totals.pred})`);
  const alias = aliasOverride.describe();
  console.log('');
  console.log(`ground truth     : ${gtPath}`);
  console.log(`alias table      : ${alias.rows} rows from ${alias.source}`
    + (alias.dropped.length ? `  (dropped: ${alias.dropped.join(' ')})` : ''));
  console.log(`layout aliases   : ${flags.layoutAliases ? 'ON (right_sidebar rows, dates 20230518-20231215)' : 'OFF (--no-layout-aliases)'}`);
  aliasOverride.restore();
  return 0;
}

module.exports = {
  DEFAULT_ROOTS,
  GT_PATH,
  collectLogFiles,
  cropWidthFor,
  groundTruthForDate,
  scoreLogs,
  scoreMergedLists,
  mergedReaders,
  clusterMerged,
  CLUSTER_RULES,
  clusterRuleName,
  recordedClusterRuleOf,
  parseFlags,
  applyAliasTableOverride,
  setUseLayoutAliases,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error && error.usage) {
      console.error(`evalParserReplay: ${error.message}`);
      console.error('usage: node tools/evalParserReplay.js [--json] [--confusion-csv PATH]'
        + ' [--drop-aliases A,B] [--no-layout-aliases]'
        + ' [--cluster-rule shipped|corroborated|corroborated-strict'
        + '|supported|supported+corroborated'
        + '|video-supported|video-supported+corroborated'
        + '|swallowed|corroborated+swallowed]'
        + ' [--ground-truth PATH] [root ...]');
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
