'use strict';
/**
 * One-off measurement: what does a candidate alias row change?
 *
 * The alias table's rows are only meaningful if their effect can be MEASURED.
 * A recall number usually cannot see them (the garbled form is rare, and the
 * canonical it maps to is often already a hit), so this script reports the
 * change as a SET DIFFERENCE over the corpus: for every date, which tickers
 * the parser publishes with the shipped table and which with the candidate
 * table.
 *
 * It re-parses each log's recorded `ocr_words` with the CURRENT parser, so
 * this measures the PER-FRAME parser. The production clusterer saw every
 * OCR'd frame, while a log keeps only the selected captures -- the
 * `rebuilt_current` caveat applies.
 *
 * No arguments: every path is fixed below.
 *
 * BASELINE is the shipped table WITHOUT the row under test; CANDIDATE is the
 * shipped table WITH it. Both are real files on disk, so the two readings come
 * from the same corpus and the same command.
 */
const fs = require('fs');
const path = require('path');

const REPO = 'C:/Users/admin/Projects/portfolio_analyzer_revere';
const {
  parseChartStreamPositionList,
  setOcrConfusionCsvPath,
} = require(path.join(REPO, 'src/parse/parseChartStream'));
const { loadDecodeLexiconSync } = require(path.join(REPO, 'src/normalize/tickerScan'));

const BASELINE = 'c:/tmp/qmg_alias_nouc.csv';
const CANDIDATE = path.join(REPO, 'config/ticker_ocr_confusions.csv');

const ROOTS = [
  path.join(REPO, 'data/video_ocr_probe'),
  path.join(REPO, 'data/video_scan_test/_rerun'),
];

const GT_PATH = path.join(REPO, 'data/qmg_ground_truth.json');
const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
const lexicon = loadDecodeLexiconSync();

function gtTickers(entry) {
  const out = [];
  if (Array.isArray(entry)) out.push(...entry);
  else if (entry && typeof entry === 'object') {
    for (const capture of Object.values(entry)) {
      if (Array.isArray(capture)) out.push(...capture);
      else if (capture && Array.isArray(capture.tickers)) out.push(...capture.tickers);
    }
  }
  return [...new Set(out)];
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.json') && e.name.includes('_snapshot.json')) out.push(full);
  }
}

function cropWidthFor(l) {
  return l.ocr_frame_width || 1345;
}

function parseLog(log, csvPath) {
  setOcrConfusionCsvPath(csvPath);
  const perCapture = [];
  for (const capture of log.captures || []) {
    const words = Array.isArray(capture.ocr_words) ? capture.ocr_words : [];
    if (!words.length) { perCapture.push(null); continue; }
    const r = parseChartStreamPositionList({
      ocr: {
        text: capture.ocr_text || '',
        words,
        _cropWidth: cropWidthFor(log),
        _engine: (log.ocr_engine_metadata || {}).engine,
      },
    });
    perCapture.push(r.position_list || []);
  }
  return perCapture;
}

function dateOf(file, log) {
  if (log && typeof log.date === 'string' && /^\d{8}$/.test(log.date)) return log.date;
  const m = String(file).match(/(\d{8})/);
  return m ? m[1] : null;
}

const files = [];
for (const root of ROOTS) walk(root, files);

const rows = [];
for (const file of files) {
  let log;
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const date = dateOf(file, log);
  if (!date) continue;
  const before = parseLog(log, BASELINE);
  const after = parseLog(log, CANDIDATE);
  const bAll = new Set(before.filter(Boolean).flat());
  const aAll = new Set(after.filter(Boolean).flat());
  const removed = [...bAll].filter(t => !aAll.has(t));
  const added = [...aAll].filter(t => !bAll.has(t));
  if (!removed.length && !added.length) continue;
  const g = gtTickers(gt[date]);
  const gset = new Set(g);
  const bHit = [...bAll].filter(t => gset.has(t));
  const aHit = [...aAll].filter(t => gset.has(t));
  rows.push({
    date,
    file: path.relative(REPO, file),
    removed,
    added,
    before: [...bAll].sort(),
    after: [...aAll].sort(),
    gtCount: g.length,
    beforeHit: bHit.length,
    afterHit: aHit.length,
    beforeFp: [...bAll].filter(t => !gset.has(t)),
    afterFp: [...aAll].filter(t => !gset.has(t)),
  });
}

setOcrConfusionCsvPath(CANDIDATE);

console.log(`logs walked        : ${files.length}`);
console.log(`logs whose reading changes: ${rows.length}\n`);
for (const r of rows) {
  console.log(`${r.date}  ${r.file}`);
  console.log(`   baseline : ${JSON.stringify(r.before)}`);
  console.log(`   candidate: ${JSON.stringify(r.after)}`);
  console.log(`   removed : ${JSON.stringify(r.removed)}   added: ${JSON.stringify(r.added)}`);
  console.log(`   vs GT (${r.gtCount}): hits ${r.beforeHit} -> ${r.afterHit}, FP ${JSON.stringify(r.beforeFp)} -> ${JSON.stringify(r.afterFp)}`);
  console.log('');
}
