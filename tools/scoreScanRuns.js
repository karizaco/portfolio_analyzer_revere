#!/usr/bin/env node
/**
 * Score finished chart-stream scan runs against the pixel-verified ground truth.
 *
 * Usage:
 *   node tools/scoreScanRuns.js <run-dir> [<run-dir> ...]
 *   node tools/scoreScanRuns.js --json <run-dir> [<run-dir> ...]
 *
 * A run directory is any directory that holds an `ocr_probe/logs/` tree -- the
 * layout `tools/scanVideoWithOcr.js` writes (the "flat" layout, one of the three
 * `src/video/probeLogDirs.js` knows).
 *
 * WHAT IS SCORED
 * --------------
 * `merged_position_list` -- the VIDEO-level consensus, which is what the
 * production consumers read (`tools/runQmgOcrBatch.js` and
 * `tools/aggregateScanResults.js`). It is NOT the capture-level
 * `capture.chart_stream.position_list`: the two have disagreed on record (see
 * CLAUDE.md, "The video-level reading -- merged_position_list"), and a
 * capture-level metric cannot see either disagreement.
 *
 * THE GROUND TRUTH'S DENOMINATOR
 * ------------------------------
 * A date's ground truth is the UNION over its captures, and the union is what
 * the replay tool scores against too. A date whose ground truth is the object
 * form (`{ "0": [...], "1": [...] }`) contributes every capture's tickers; the
 * `crop` key of the capture-object form is a crop rectangle and is never a
 * ticker.
 *
 * The ground truth is pixel-verified -- run
 * `node tools/checkGroundTruthConsistency.js` before quoting a number.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GT_PATH = path.join(ROOT, 'data', 'qmg_ground_truth.json');

function loadGroundTruth() {
  return JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
}

/** A date's ground truth, as a SET: the union over every capture. */
function groundTruthTickers(entry) {
  const out = [];
  if (Array.isArray(entry)) {
    out.push(...entry);
  } else if (entry && typeof entry === 'object') {
    for (const capture of Object.values(entry)) {
      if (Array.isArray(capture)) out.push(...capture);
      else if (capture && Array.isArray(capture.tickers)) out.push(...capture.tickers);
    }
  }
  return [...new Set(out)];
}

/** Every probe-log directory under a run directory. */
function logDirsOf(runDir) {
  const found = [];
  const candidates = [
    path.join(runDir, 'ocr_probe', 'logs'),
    path.join(runDir, 'ocr_probe', 'logs'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) { found.push(dir); break; }
  }
  if (found.length) return found;

  // Doubled layout: <date>/<tag>/<tag>/ocr_probe/logs -- walk for any.
  const stack = [runDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (e.name === 'logs' && path.basename(path.dirname(sub)) === 'ocr_probe') {
        found.push(sub);
      } else {
        stack.push(sub);
      }
    }
  }
  return found;
}

function dateOfLog(log, file) {
  if (log && typeof log.date === 'string' && /^\d{8}$/.test(log.date)) return log.date;
  if (log && typeof log.date_key === 'string' && /^\d{8}$/.test(log.date_key)) return log.date_key;
  const m = String(file).match(/^(\d{8})_/);
  return m ? m[1] : null;
}

function scoreRun(runDir, gt) {
  const rows = [];
  for (const logsDir of logDirsOf(runDir)) {
    let files;
    try { files = fs.readdirSync(logsDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let log;
      try { log = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8')); } catch { continue; }
      const date = dateOfLog(log, file);
      if (!date) continue;

      const gtTickers = groundTruthTickers(gt[date]);
      if (!gtTickers.length) {
        rows.push({ date, status: 'no_ground_truth', log_path: path.join(logsDir, file) });
        continue;
      }
      const gtSet = new Set(gtTickers);
      const merged = [...new Set(log.merged_position_list || [])];
      const predSet = new Set(merged);
      const hit = merged.filter(t => gtSet.has(t));
      const miss = [...gtSet].filter(t => !predSet.has(t));
      const fp = merged.filter(t => !gtSet.has(t));
      rows.push({
        date,
        status: 'scored',
        hit: hit.length,
        gt: gtSet.size,
        predicted: merged.length,
        recallPct: Math.round((100 * hit.length) / gtSet.size),
        precisionPct: merged.length ? Math.round((100 * hit.length) / merged.length) : 0,
        hitTickers: hit,
        missTickers: miss,
        fpTickers: fp,
        log_path: path.join(logsDir, file),
      });
    }
  }
  return rows;
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const dirs = args.filter(a => a !== '--json');
  if (!dirs.length) {
    console.error('usage: node tools/scoreScanRuns.js [--json] <run-dir> [<run-dir> ...]');
    process.exit(2);
  }

  const gt = loadGroundTruth();
  const all = [];
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) {
      console.error(`no such directory: ${abs}`);
      process.exit(2);
    }
    all.push(...scoreRun(abs, gt));
  }
  all.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (json) {
    const scored = all.filter(r => r.status === 'scored');
    const totalHit = scored.reduce((n, r) => n + r.hit, 0);
    const totalGt = scored.reduce((n, r) => n + r.gt, 0);
    const totalFp = scored.reduce((n, r) => n + r.fpTickers.length, 0);
    const totalPred = scored.reduce((n, r) => n + r.predicted, 0);
    console.log(JSON.stringify({
      dates: all,
      totals: {
        datesScored: scored.length,
        hit: totalHit,
        gt: totalGt,
        predicted: totalPred,
        fp: totalFp,
        recallPct: totalGt ? Math.round((100 * totalHit) / totalGt) : 0,
        precisionPct: totalPred ? Math.round((100 * totalHit) / totalPred) : 0,
      },
    }, null, 2));
    return;
  }

  for (const r of all) {
    if (r.status !== 'scored') {
      console.log(`${r.date}  ${r.status}`);
      continue;
    }
    console.log(
      `${r.date}  ${r.hit}/${r.gt} hits (${r.recallPct}%)  pred=${r.predicted}  FP=[${r.fpTickers.join(', ') || 'none'}]  miss=[${r.missTickers.join(', ') || 'none'}]`
    );
  }
  const scored = all.filter(r => r.status === 'scored');
  const totalHit = scored.reduce((n, r) => n + r.hit, 0);
  const totalGt = scored.reduce((n, r) => n + r.gt, 0);
  const totalFp = scored.reduce((n, r) => n + r.fpTickers.length, 0);
  const totalPred = scored.reduce((n, r) => n + r.predicted, 0);
  console.log(`\nTotal: ${totalHit}/${totalGt} hits (${totalGt ? Math.round((100 * totalHit) / totalGt) : 0}% recall), ` +
    `${totalFp} FP of ${totalPred} predictions (${totalPred ? Math.round((100 * totalHit) / totalPred) : 0}% precision) over ${scored.length} dates`);
}

if (require.main === module) main(process.argv);
module.exports = { scoreRun, groundTruthTickers, loadGroundTruth };
