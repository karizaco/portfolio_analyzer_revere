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
//
// Exit code is always 0 — this is a report, not a gate.
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

const fs = require('node:fs');
const path = require('node:path');

const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
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
    ocr: {
      text: capture.ocr_text || '',
      words,
      _cropWidth: cropWidthFor(log),
      _engine: (log.ocr_engine_metadata || {}).engine,
    },
  });
  return result.position_list || [];
}

function percent(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) : '0.0';
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const roots = argv.filter((arg) => arg !== '--json');
  const effectiveRoots = roots.length ? roots : DEFAULT_ROOTS;

  const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
  const files = effectiveRoots.flatMap((root) => collectLogFiles(path.resolve(root)));
  const report = scoreLogs({ gt, files });

  if (asJson) {
    console.log(JSON.stringify({
      roots: effectiveRoots,
      census: report.census,
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
    }, null, 2));
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
  return 0;
}

module.exports = {
  DEFAULT_ROOTS,
  GT_PATH,
  collectLogFiles,
  cropWidthFor,
  groundTruthForDate,
  scoreLogs,
};

if (require.main === module) {
  main();
}
