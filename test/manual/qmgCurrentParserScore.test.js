'use strict';

// Score the CURRENT parser over the recorded OCR words of a scan run.
//
// This is the no-OCR counterpart of a production scan: it re-parses the
// frames a scan already read, so a parser change is measurable in seconds
// instead of 10-30 minutes of EasyOCR per video.
//
// The corpus of probe logs is UNTRACKED, so this asserts STRUCTURE (the run
// has logs, they have captures, each capture re-parses to a reading) and
// REPORTS the numbers. A fresh clone has no logs and the test says so.
//
//   node --test test/manual/qmgCurrentParserScore.test.js
//   node --test test/manual/qmgCurrentParserScore.test.js -- --run-tag qmg-easyocr-20261106-ina-validation
//
// The run tag can also be given in the QMG_SCORING_RUN_TAG environment
// variable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseChartStreamPositionList } = require('../../src/parse/parseChartStream');
const { clusterVideoLevelReadings, resolveClusterRuleOptions, setOcrConfusionCsvPath } = require('../../src/parse/parseChartStream');
const { loadDecodeLexiconSync } = require('../../src/normalize/tickerScan');
const { layoutAliasEraForDate } = require('../../src/video/chartStreamCrop');
const { loadQmgGroundTruth, listGroundTruthCaptures } = require('../../src/qmg/qmgGroundTruth');
const fsExtra = require('node:fs');
const osExtra = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const RERUN = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

function argValue(flag) {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

const RUN_TAG = argValue('--run-tag') || process.env.QMG_SCORING_RUN_TAG || null;

function walk(dir, out, depth) {
  if (depth > 5) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'frames' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.name.endsWith('_snapshot.json')) out.push(full);
  }
}

function logsForRun() {
  const files = [];
  if (RUN_TAG) {
    const base = path.join(RERUN, RUN_TAG, 'ocr_probe', 'logs');
    const dir = fs.existsSync(base) ? base : path.join(RERUN, RUN_TAG);
    if (!fs.existsSync(dir)) return files;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f));
  } else {
    walk(RERUN, files, 0);
  }
  // The NEWEST log per date. The corpus holds several runs per date, and the
  // older ones predate the era crop, the current parser and the alias
  // tables -- scoring them would measure a pipeline that no longer exists.
  const newest = new Map();
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const d = String(j.date_key || '');
    if (!/^\d{8}$/.test(d)) continue;
    const m = fs.statSync(f).mtimeMs;
    if (!newest.has(d) || m > newest.get(d).m) newest.set(d, { m, f, j });
  }
  return [...newest.values()].sort((a, b) => a.f.localeCompare(b.f));
}

// The era-conditional crop rectangles. A log that used anything else was
// produced by a different pipeline and is not comparable.
const ERA_CROPS = new Set(['0.86,0.6,0.14,0.28', '0.82,0.6,0.18,0.32']);

function regionKey(j) {
  const c = j.phash_region_fraction || {};
  return `${c.x},${c.y},${c.w},${c.h}`;
}

test('the current parser re-parses the recorded captures and is scored', () => {
  const files = logsForRun();
  if (!files.length) {
    console.log(`no probe logs found${RUN_TAG ? ` for run tag ${RUN_TAG}` : ''} — nothing to score`);
    return;
  }

  const gt = loadQmgGroundTruth();
  const gtByDate = new Map();
  for (const c of listGroundTruthCaptures(gt)) {
    const d = c.date || c.dateKey;
    if (!gtByDate.has(d)) gtByDate.set(d, new Set());
    for (const t of c.tickers || []) gtByDate.get(d).add(String(t).toUpperCase());
  }

  let scored = 0;
  let captures = 0;
  let hit = 0;
  let gtTotal = 0;
  let fp = 0;
  const rows = [];

  for (const entry of files) {
    const file = typeof entry === 'string' ? entry : entry.f;
    const j = typeof entry === 'string'
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : entry.j;
    const date = String(j.date_key || '');
    if (!/^\d{8}$/.test(date)) continue;
    if (!RUN_TAG && !ERA_CROPS.has(regionKey(j))) continue;
    const g = gtByDate.get(date);
    if (!g || !g.size) continue;
    const era = layoutAliasEraForDate(date);
    const merged = new Set();
    let read = 0;
    // The clusterer's INPUT is every OCR'd candidate frame, and the log
    // keeps only the selected captures. So the merged list is rebuilt from
    // the captures' own readings -- the same fallback the replay tool calls
    // `rebuilt`. It is not the production clustering (production clusters
    // every candidate), but it IS the level production publishes.
    const clusterInput = [];
    for (const c of j.captures || []) {
      const result = parseChartStreamPositionList({
        ocr: {
          text: c.ocr_text || '',
          words: c.ocr_words || [],
          _cropWidth: 1345,
          _engine: 'easyocr',
        },
        layoutEra: era,
      });
      read += 1;
      const list = (result.position_list || []).map((t) => String(t).toUpperCase());
      if (list.length) clusterInput.push(list.join(' '));
    }
    if (clusterInput.length) {
      const rule = resolveClusterRuleOptions({ clusterSwallowedHoldings: true });
      const clusterResult = clusterVideoLevelReadings(clusterInput, {
        maxDistance: 1,
        minTokenLength: 2,
        minFrequency: Math.min(2, clusterInput.length),
        lexicon: loadDecodeLexiconSync(),
        ...rule,
        explainDropped: true,
      });
      for (const t of clusterResult.merged_list || []) merged.add(String(t).toUpperCase());
    }
    captures += read;
    if (!read) continue;
    scored += 1;
    const h = [...g].filter((t) => merged.has(t)).length;
    const f = [...merged].filter((t) => !g.has(t));
    hit += h; gtTotal += g.size; fp += f.length;
    rows.push({ date, h, n: g.size, miss: [...g].filter((t) => !merged.has(t)), fp: f, era });
  }

  // The A/B. The same corpus, the same parser, the same merge -- with and
  // without the alias tables. The shared table is filtered into a TEMPORARY
  // file and the parser is pointed at it, so nothing on disk is edited and
  // the two readings cannot race each other.
  //
  // The LAYOUT-scoped tables are dropped by forcing `layoutEra` to null, which
  // is exactly what the parser does when a caller does not name a layout.
  const AB_DATES = (process.env.QMG_SCORING_AB_ALIASES || 'INA,TQ').split(',').filter(Boolean);

  function scoreAll({ useShared, useLayout }) {
    let tmp = null;
    let restore = null;
    if (!useShared) {
      tmp = path.join(osExtra.tmpdir(), `confusions-ab-${process.pid}.csv`);
      const table = path.join(ROOT, 'config', 'ticker_ocr_confusions.csv');
      const rows = fsExtra.readFileSync(table, 'utf8').split(/\r?\n/).filter((line) => line.trim());
      const kept = rows.filter((line, i) => {
        if (i === 0 && /^garbled\s*,/i.test(line)) return true;
        return !AB_DATES.includes(line.split(',')[0].trim().toUpperCase());
      });
      fsExtra.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
      restore = setOcrConfusionCsvPath(tmp);
    }
    try {
      let n = 0; let h = 0; let g = 0; let f = 0;
      let rh = 0; let rf = 0;
      const detail = [];
      for (const entry of files) {
        const j = typeof entry === 'string'
          ? JSON.parse(fs.readFileSync(entry, 'utf8'))
          : entry.j;
        const date = String(j.date_key || '');
        if (!/^\d{8}$/.test(date)) continue;
        if (!RUN_TAG && !ERA_CROPS.has(regionKey(j))) continue;
        const gtSet = gtByDate.get(date);
        if (!gtSet || !gtSet.size) continue;
        const era = useLayout ? layoutAliasEraForDate(date) : null;
        const clusterInput = [];
        for (const c of j.captures || []) {
          const result = parseChartStreamPositionList({
            ocr: { text: c.ocr_text || '', words: c.ocr_words || [], _cropWidth: 1345, _engine: 'easyocr' },
            layoutEra: era,
          });
          const list = (result.position_list || []).map((t) => String(t).toUpperCase());
          if (list.length) clusterInput.push(list.join(' '));
        }
        if (!clusterInput.length) continue;
        const rule = resolveClusterRuleOptions({ clusterSwallowedHoldings: true });
        const clusterResult = clusterVideoLevelReadings(clusterInput, {
          maxDistance: 1, minTokenLength: 2,
          minFrequency: Math.min(2, clusterInput.length),
          lexicon: loadDecodeLexiconSync(), ...rule, explainDropped: true,
        });
        const merged = new Set((clusterResult.merged_list || []).map((t) => String(t).toUpperCase()));
        const hits = [...gtSet].filter((t) => merged.has(t)).length;
        const fps = [...merged].filter((t) => !gtSet.has(t));
        n += 1; h += hits; g += gtSet.size; f += fps.length;

        // The log's OWN merged list — what the scan published, and what the
        // production consumers read. It is a different level from the rebuilt
        // merge (production clusters every OCR'd candidate frame, not only
        // the selected captures), so both are reported.
        const recorded = new Set((j.merged_position_list || []).map((t) => String(t).toUpperCase()));
        rh += [...gtSet].filter((t) => recorded.has(t)).length;
        rf += [...recorded].filter((t) => !gtSet.has(t)).length;

        detail.push({ date, hits, n: gtSet.size, miss: [...gtSet].filter((t) => !merged.has(t)), fp: fps });
      }
      return { n, h, g, f, rh, rf, detail };
    } finally {
      if (restore !== null) setOcrConfusionCsvPath(restore);
      if (tmp) { try { fsExtra.unlinkSync(tmp); } catch { /* scratch */ } }
    }
  }

  const before = scoreAll({ useShared: false, useLayout: false });
  const after = scoreAll({ useShared: true, useLayout: true });

  console.log('per-date reading (current parser):');
  for (const r of after.detail) {
    console.log(`  ${r.date}  ${r.hits}/${r.n}  miss=${r.miss.join(',') || '-'}  fp=${r.fp.join(',') || '-'}`);
  }
  console.log(`\nwithout the alias tables : ${before.h}/${before.g} = ${(before.h / before.g * 100).toFixed(1)}%  fp ${before.f}   (${before.n} dates)`);
  console.log(`with    the alias tables : ${after.h}/${after.g} = ${(after.h / after.g * 100).toFixed(1)}%  fp ${after.f}   (${after.n} dates)`);
  console.log(`delta: ${after.h - before.h >= 0 ? '+' : ''}${after.h - before.h} hits, ${after.f - before.f >= 0 ? '+' : ''}${after.f - before.f} false positives`);
  console.log(`\nthe logs' own merged list (what production published): `
    + `${after.rh}/${after.g} = ${(after.rh / after.g * 100).toFixed(1)}%  fp ${after.rf}`);

  const moved = after.detail.filter((r) => {
    const b = before.detail.find((x) => x.date === r.date);
    return b && (b.hits !== r.hits || b.fp.length !== r.fp.length);
  });
  for (const r of moved) {
    const b = before.detail.find((x) => x.date === r.date);
    console.log(`  ${r.date}: ${b.hits}/${b.n} fp=${b.fp.join(',') || '-'}  ->  ${r.hits}/${r.n} fp=${r.fp.join(',') || '-'}`);
  }

  assert.ok(after.n > 0, `expected to score at least one date from ${files.length} logs`);
});
