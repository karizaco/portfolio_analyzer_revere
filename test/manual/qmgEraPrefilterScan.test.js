'use strict';

// A MANUAL integration test: the era-conditional crop and the era-conditional
// prefilter rectangle, run through the REAL production scanner against the
// REAL videos.
//
// It is deliberately not part of `npm test`:
//
//   * it is an EasyOCR scan — 12-18 minutes PER VIDEO, and the numbers depend
//     on the machine, so it cannot be a unit test;
//   * it lives in `test/manual/`, which the suite's glob does not reach
//     (`tools/runTests.js` reads the TOP level of `test/` only, and
//     `npm run test:all` globs `test/*.test.js`).
//
// Run it:
//
//   node --test test/manual/qmgEraPrefilterScan.test.js
//
// Configuration is read from `test/manual/qmgEraPrefilterScan.config.json`
// when that file exists, and from the environment otherwise (the environment
// wins). The keys are:
//
//   dates        comma-separated upload dates (default: the six 2023-era
//                sidebar dates)
//   runTag       the run tag (default qmg-easyocr-20261102-era-prefilter)
//   parallel     EasyOCR parallelism (default 2; --low-cpu caps it at 2)
//   noScan       do not scan; score an existing run's logs instead
//   noMeasure    skip the no-OCR prefilter measurement
//   labels       the labelled frames for the prefilter measurement
//                (default: the six candidates of the 2026-11-02 scan)
//
// WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED
//
// The assertions are STRUCTURAL: every requested date produced a probe log,
// every one of them produced a non-empty reading, and the scan process exited
// cleanly. The RECALL numbers are REPORTED, not asserted — EasyOCR is not
// deterministic, and a test that fails on a bad OCR run is a test people learn
// to ignore.
//
// It scores TWO readings per date, and the difference between them is the
// point:
//
//   merged   the video-level clusterer consensus — what
//            tools/runQmgOcrBatch.js and tools/runQmgCuratedBenchmark.js read
//   capture  the best single frame's reading — what the aggregator reads
//
// CLAUDE.md records these two disagreeing: on 20230609 the selected capture
// read the 13 ground-truth holdings exactly in BOTH the 2026-11-02 runs, while
// the merged list carried a 14th (`REGN`, a distance-1 repair of a misread
// `RGTI`) in one of them. A capture-level metric would never have caught it,
// and the two consumers of the same scan disagreed with each other — which is
// the argument for scoring the MERGED list and not only the capture.
//
// The panel's own footer count is reported too: it is an independent check on
// a reading, because the footer says how many rows are on screen.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const VIDEO_DIR_1080 = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const GT_FILE = path.join(ROOT, 'data', 'qmg_ground_truth.json');

// The 2023-era sidebar dates. 20230609 is the CONTROL: it has a MEASURED
// production result under the era crop (13/13 holdings, zero false positives,
// 2026-11-02), and the other five have never been scanned in production.
const DEFAULT_DATES = ['20230522', '20230523', '20230602', '20230605', '20230608', '20230609'];
const CONTROL_DATE = '20230609';

const DEFAULT_RUN_TAG = 'qmg-easyocr-20261102-era-prefilter';

// The six candidates of the 2026-11-02 production scan of 20230609, with the
// number of holdings each one actually read. This is what makes the no-OCR
// prefilter measurement meaningful: it tells the tool which frames are worth
// ranking highly.
const CONTROL_LABELS = '1944:13,972:12,3888:12,2916:12,0:7,3100:0';

function envList(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The configuration file, when it exists. It is a convenience for the two
 * ways this harness is used — a long background scan and a quick re-score of a
 * finished run — without needing a different command line for each.
 */
function readConfig() {
  const configPath = path.join(__dirname, 'qmgEraPrefilterScan.config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.log(`  ignoring the unreadable config file: ${error.message}`);
    return {};
  }
}

const CONFIG = readConfig();

const DATES = envList('QMG_ERA_DATES', envList(
  'dates',
  CONFIG.dates ? String(CONFIG.dates).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_DATES
));
const RUN_TAG = String(process.env.QMG_ERA_RUN_TAG || CONFIG.runTag || '').trim() || DEFAULT_RUN_TAG;
const PARALLEL = Number(process.env.QMG_ERA_PARALLEL || CONFIG.parallel || 2) || 2;
const NO_SCAN = Boolean(process.env.QMG_ERA_NO_SCAN || CONFIG.noScan);
const NO_MEASURE = Boolean(process.env.QMG_ERA_NO_MEASURE || CONFIG.noMeasure);
const LABELS = String(process.env.QMG_ERA_LABELS || CONFIG.labels || CONTROL_LABELS);

/** Run a repo tool as a child process, streaming its output live. */
function runTool(scriptRelativePath, args) {
  const scriptPath = path.join(ROOT, scriptRelativePath);
  return new Promise((resolve) => {
    console.log(`\n=== ${scriptRelativePath} ${args.join(' ')}`);
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        // The EasyOCR adapter sets these too, but the batch runner spawns the
        // scan tool, which spawns Python — set them here as well so a missing
        // one cannot reach a subprocess.
        KMP_DUPLICATE_LIB_OK: 'TRUE',
        OMP_NUM_THREADS: '1',
        MKL_NUM_THREADS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The ground-truth union for a date, as a Set. */
function groundTruthFor(gt, dateKey) {
  const entry = gt[dateKey];
  if (!entry) return null;
  const list = Array.isArray(entry) ? entry : Object.values(entry).flat();
  return new Set(list);
}

/** Compare a reading against the ground-truth set. */
function scoreList(list, gtSet) {
  const set = new Set(Array.isArray(list) ? list : []);
  const hit = [...set].filter((t) => gtSet.has(t)).sort();
  const miss = [...gtSet].filter((t) => !set.has(t)).sort();
  const fp = [...set].filter((t) => !gtSet.has(t)).sort();
  return { hit, miss, fp, size: set.size };
}

/** The probe log for a date inside a run tag, newest first. */
function findLog(logsDir, dateKey) {
  if (!fs.existsSync(logsDir)) return null;
  const files = fs
    .readdirSync(logsDir)
    .filter((name) => name.startsWith(`${dateKey}_`) && name.endsWith('.json'))
    .map((name) => {
      const full = path.join(logsDir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(files[0].full, 'utf8'));
}

test('the era-conditional crop and prefilter rectangle, in production', async (t) => {
  if (!fs.existsSync(VIDEO_DIR_1080)) {
    t.skip('no pipeline media on this machine (the media is not tracked in git)');
    return;
  }

  const gt = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));
  const logsDir = path.join(OUT_ROOT, RUN_TAG, 'ocr_probe', 'logs');

  // ---- Step 1 (no OCR): does the ERA rectangle rank the frames better? ----
  if (!NO_MEASURE) {
    const controlVideo = fs
      .readdirSync(VIDEO_DIR_1080)
      .find((name) => name.startsWith(`${CONTROL_DATE}_`) && name.endsWith('.mp4'));
    if (controlVideo) {
      await runTool('tools/measurePrefilterRegion.js', [
        '--video', path.join(VIDEO_DIR_1080, controlVideo),
        '--date', CONTROL_DATE,
        '--labels', LABELS
      ]);
    } else {
      console.log(`  no video for ${CONTROL_DATE} — skipping the prefilter measurement`);
    }
  }

  // ---- Step 2 (with OCR): the production scan of the 2023-era dates ----
  if (!NO_SCAN) {
    const result = await runTool('tools/runQmgOcrBatch.js', [
      '--dates', DATES.join(','),
      '--low-cpu',
      '--parallel', String(PARALLEL),
      '--run-tag', RUN_TAG
    ]);
    assert.equal(result.code, 0, 'the batch runner exited non-zero');
  } else {
    console.log(`\n=== scoring the existing run "${RUN_TAG}" without scanning`);
  }

  // ---- Step 3: score every date ----
  const report = [];
  const missing = [];
  const empty = [];

  for (const dateKey of DATES) {
    const gtSet = groundTruthFor(gt, dateKey);
    if (!gtSet) {
      console.log(`  ${dateKey}: no ground truth — skipped`);
      continue;
    }
    const log = findLog(logsDir, dateKey);
    if (!log) {
      missing.push(dateKey);
      continue;
    }

    const merged = scoreList(log.merged_position_list, gtSet);

    // The best single capture — the reading the aggregator consumes.
    const captures = Array.isArray(log.captures) ? log.captures : [];
    const perCapture = captures.map((capture) => {
      const list = (capture.chart_stream && Array.isArray(capture.chart_stream.position_list))
        ? capture.chart_stream.position_list
        : (Array.isArray(capture.tickers) ? capture.tickers : []);
      return { capture, list, score: scoreList(list, gtSet) };
    });
    const best = perCapture.reduce(
      (a, b) => (b.score.hit.length > a.score.hit.length ? b : a),
      perCapture[0] || { capture: null, list: [], score: { hit: [], miss: [], fp: [], size: 0 } }
    );

    // The panel's own footer count, where the parser could read it.
    const panelCounts = perCapture
      .map((entry) => entry.capture && entry.capture.chart_stream
        ? entry.capture.chart_stream.panel_count
        : null)
      .filter((value) => Number.isFinite(value));

    if (!merged.size && !best.list.length) empty.push(dateKey);

    report.push({
      dateKey,
      merged,
      best,
      panelCounts,
      captures: captures.length,
      ocrFrames: log.ocr_frame_count,
      prefilterBest: log.prefilter_best_score
    });
  }

  console.log('\n=== the readings ===');
  console.log('  date       merged (video level)        best capture          panel count   frames');
  for (const row of report) {
    const mergedText = `${row.merged.hit.length}/${row.merged.hit.length + row.merged.miss.length}`
      + (row.merged.fp.length ? `  FP: ${row.merged.fp.join(',')}` : '');
    const bestText = `${row.best.score.hit.length}/${row.best.score.hit.length + row.best.score.miss.length}`
      + (row.best.score.fp.length ? `  FP: ${row.best.score.fp.join(',')}` : '');
    const panelText = row.panelCounts.length ? row.panelCounts.join('/') : '—';
    console.log(
      `  ${row.dateKey}  ${mergedText.padEnd(24)}  ${bestText.padEnd(20)}  ${panelText.padEnd(12)}  `
      + `${row.ocrFrames ?? '?'} (${row.captures} capture(s), prefilter best ${row.prefilterBest ?? '?'})`
    );
  }

  const totals = report.reduce(
    (acc, row) => {
      acc.hit += row.merged.hit.length;
      acc.gt += row.merged.hit.length + row.merged.miss.length;
      acc.fp += row.merged.fp.length;
      return acc;
    },
    { hit: 0, gt: 0, fp: 0 }
  );
  if (totals.gt) {
    console.log(
      `\n  overall (merged): ${totals.hit}/${totals.gt} = `
      + `${Math.round((100 * totals.hit) / totals.gt)}% recall, ${totals.fp} false positive(s)`
    );
  }

  assert.deepEqual(missing, [], `no probe log was written for: ${missing.join(', ')}`);
  assert.deepEqual(empty, [], `these dates produced no reading at all: ${empty.join(', ')}`);
});
