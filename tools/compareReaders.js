'use strict';

// THE READERS, SIDE BY SIDE.
//
// The corpus holds the readings of TWO readers: the chart-stream crop
// reader and the positions-TABLE reader. `tools/evalParserReplay.js`
// pools a date's predictions as the union of its logs, so over a corpus
// with both readers in it the number is a MIXTURE -- and the table
// reader's false positives count against the chart-stream reader's
// score.
//
// This instrument separates them, and it is the instrument that
// answered the `position_table` sweep's question: "does the table
// reader help where the chart-stream reader fails?"
//
// THREE RULES, and each one is a measurement artefact that has to be
// handled:
//
//   * A LOG'S READER IS ITS CAPTURES' `ticker_source`. 'position_table'
//     for a frame the table reader published, 'chart_stream' for a frame
//     the legacy crop reader published, and a log whose captures came
//     from BOTH is a MIXTURE -- the scan tool's merge takes a table
//     capture's own holdings and a legacy capture's cluster consensus.
//
//   * THE SWEEP'S OWN LOGS ARE THE TABLE READER'S, so they are kept out
//     of the chart-stream column by their RUN TAG. Without that the
//     "most recent log" for a swept date is the sweep's own log -- which
//     is newer than the chart-stream production log and is not the
//     chart-stream reader's reading at all.
//
//   * EACH COLUMN IS THE READER'S MOST RECENT PURE LOG for the date,
//     because the corpus holds months of runs and a reader's OLD reading
//     is not its current one.
//
// Usage:
//
//   node tools/compareReaders.js
//   node tools/compareReaders.js --swept          # the swept dates only
//   node tools/compareReaders.js --json

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GT_PATH = path.join(ROOT, 'data', 'qmg_ground_truth.json');

// The run tags the `position_table` sweep wrote. They are the TABLE
// reader's logs, whatever `ticker_source` says.
const TABLE_TAGS = new Set([
  'qmg-table',
  'qmg-table-weak',
  'qmg-table-20261127',
  'qmg-table-fix',
]);

// The roots the probe logs live in.
const ROOTS = [
  path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  path.join(ROOT, 'data', 'video_ocr_probe'),
];

// The dates the sweep covered, and the ones it was AIMED at: the
// chart-stream reader's weakest.
const SWEPT_DATES = [
  '20220218', '20220222', '20220323', '20220606', '20220607', '20221104', '20230608', '20230609',
  '20220126', '20220131', '20220228', '20220405', '20220406', '20221117', '20231215',
];

function collectLogFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'logs') {
          for (const f of fs.readdirSync(full)) {
            if (f.endsWith('.json')) out.push(path.join(full, f));
          }
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  walk(path.resolve(root));
  return out;
}

/** The run tag a log came from. */
function tagOf(file) {
  const parts = file.split(/[\\/]/);
  const index = parts.lastIndexOf('_rerun');
  if (index >= 0 && parts[index + 1]) return parts[index + 1];
  return '';
}

/** 'table', 'chart' or 'mixed'. */
function readersOf(log) {
  const sources = new Set();
  for (const capture of log.captures || []) {
    const list = capture.chart_stream && capture.chart_stream.position_list;
    if (!Array.isArray(list) || !list.length) continue;
    if (capture.ticker_source === 'position_table') sources.add('table');
    else sources.add('chart');
  }
  if (sources.has('table') && sources.has('chart')) return 'mixed';
  if (sources.has('table')) return 'table';
  return 'chart';
}

function loadGroundTruth() {
  const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
  const truthFor = (dateKey) => {
    const set = new Set();
    for (const value of Object.values(gt[dateKey] || {})) {
      for (const t of (Array.isArray(value) ? value : (value.tickers || []))) set.add(String(t).toUpperCase());
    }
    return set;
  };
  return { truthFor, dates: Object.keys(gt).filter((k) => /^\d{8}$/.test(k)) };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const onlySwept = args.includes('--swept');
  const { truthFor, dates } = loadGroundTruth();

  const files = [...new Set(ROOTS.flatMap(collectLogFiles))];
  const best = new Map();

  for (const file of files) {
    let log;
    try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const dateKey = String(log.date_key || '');
    if (!dateKey || !truthFor(dateKey).size) continue;
    const read = new Set((log.merged_position_list || []).map((t) => String(t).toUpperCase()));
    if (!read.size) continue;
    let stamp = 0;
    try { stamp = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
    // A log from the sweep's tag is the TABLE reader's, whatever it says.
    const bucket = TABLE_TAGS.has(tagOf(file)) ? 'table' : readersOf(log);
    if (bucket === 'mixed') continue;
    const key = `${dateKey}|${bucket}`;
    const current = best.get(key);
    if (!current || stamp > current.stamp) best.set(key, { stamp, read, file });
  }

  const wanted = onlySwept ? SWEPT_DATES : dates;
  const rows = [];
  for (const dateKey of wanted.sort()) {
    const truth = truthFor(dateKey);
    if (!truth.size) continue;
    const cs = best.get(`${dateKey}|chart`);
    const tb = best.get(`${dateKey}|table`);
    if (!cs && !tb) continue;
    const score = (entry) => {
      if (!entry) return null;
      const hits = [...entry.read].filter((t) => truth.has(t));
      const fp = [...entry.read].filter((t) => !truth.has(t));
      return { hits: hits.length, gt: truth.size, fp: fp.length, names: fp.sort() };
    };
    rows.push({ date: dateKey, chart_stream: score(cs), position_table: score(tb) });
  }

  const totals = { chart_stream: { hits: 0, gt: 0, fp: 0 }, position_table: { hits: 0, gt: 0, fp: 0 } };
  for (const row of rows) {
    for (const key of ['chart_stream', 'position_table']) {
      const s = row[key];
      if (!s) continue;
      totals[key].hits += s.hits;
      totals[key].gt += s.gt;
      totals[key].fp += s.fp;
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ rows, totals }, null, 2));
    return 0;
  }

  console.log('date        the truth   the chart-stream reader        the table reader');
  console.log('                        hits/n  fp                     hits/n  fp');
  for (const row of rows) {
    const cell = (s) => (s ? `${String(s.hits).padStart(2)}/${String(s.gt).padEnd(3)} ${String(s.fp).padStart(2)}  ${s.names.join(' ').slice(0, 22).padEnd(22)}` : '     -            -                    -');
    console.log(`  ${row.date}  ${String(row.chart_stream ? row.chart_stream.gt : row.position_table.gt).padStart(3)}       ${cell(row.chart_stream)}  ${cell(row.position_table)}`);
  }
  console.log('');
  for (const [key, label] of [['chart_stream', 'the chart-stream reader'], ['position_table', 'the table reader']]) {
    const t = totals[key];
    const recall = t.gt ? ((t.hits / t.gt) * 100).toFixed(1) : '0.0';
    const precision = t.hits + t.fp ? ((t.hits / (t.hits + t.fp)) * 100).toFixed(1) : '0.0';
    console.log(`  ${label}: ${t.hits}/${t.gt} hits (${recall} % recall), ${t.fp} false positives (${precision} % precision)`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`compareReaders: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}

module.exports = { TABLE_TAGS, SWEPT_DATES, readersOf, tagOf };
