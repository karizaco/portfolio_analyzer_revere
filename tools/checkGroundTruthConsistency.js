#!/usr/bin/env node
'use strict';
// Check `data/qmg_ground_truth.json` against the pixels it claims to describe.
//
// WHY THIS EXISTS
// ---------------
// The ground truth is a HAND-MADE reading of a TradingView positions panel.
// Nothing compared it to the images it was read from, so three classes of
// defect survived for months:
//
//   1. A MISREAD TICKER. `data/qmg_ground_truth.json` had 20220606's third
//      capture reading `BOIL` where the panel reads `GOVX` -- while all
//      eleven sibling captures of the same video read GOVX. A substitution
//      inside an otherwise identical capture is a misread, not a changed
//      position list, and it put a phantom holding in the denominator.
//   2. A MISSING CAPTURE. 20221104 had captures 0 and 2 and no capture 1,
//      although the snapshot exists and reads the same single holding.
//   3. A WRONG ANCHOR. A capture index is RUN-RELATIVE: `qmg_<date>_2.png`
//      is a different image in every run directory. 20220406's captures are
//      anchored to two runs, and the ground truth's capture order is the
//      REVERSE of one of them.
//   4. A DUPLICATE TOP-LEVEL KEY. The ground truth shipped with 69 top-level
//      key lines for 45 distinct keys -- 24 of those keys appeared TWICE, in
//      two blocks appended in different styles.
//      `JSON.parse` keeps the last occurrence and reports no error, so every
//      reader saw one value and the other copy was invisible. The two copies
//      happened to agree; the next append need not have.
//
// The fixture set (`test/fixtures/qmg_ground_truth/`) is the evidence: a crop
// of the panel showing the ticker column AND the footer that prints the
// panel's own row count, md5-pinned in `manifest.json`. This tool checks the
// ground truth against that manifest.
//
// THE INVARIANT
// -------------
// The panel prints its own row count in its footer:
//
//     "N Items in Personal WatchList"      the whole list
//     "K of N Items in Personal WatchList"  a row is selected; K is that
//                                           row's index, NOT a scroll range
//
// N is the number of rows ON SCREEN. So for every capture:
//
//     panel_count == number of visible rows == |tickers|
//
// A capture listing more tickers than the panel counts is wrong; one listing
// fewer is missing a holding. The footer text is recorded verbatim in the
// manifest, and the count is parsed back out of it, so a typo in either
// field is caught.
//
// This catches a MISCOUNT. It does NOT catch a reading taken off the wrong
// widget -- see the note below.
//
// NOTE: the 2022-era frame carries THREE right-hand widgets, and two of them
// print "Personal WatchList" in their footers:
//
//     top     "1 - WL"        "8 Items in Personal WatchList"   <- the WATCHLIST
//     middle  "S - A Scan"    "3 Items in WatchList"            <- a screener panel
//     bottom  "A - Positions" "5 of 7 Items in Personal WatchList" <- the POSITIONS
//
// So the footer's "Personal" does NOT identify the positions table, and the
// plain "N Items in WatchList" form belongs to the middle screener panel.
// The positions table is identified by its TITLE ("A - Positions") and by
// being the bottom widget -- which is why every manifest case records the
// `panel` it was read from, and why this tool requires that to be
// "positions". The panel-count invariant catches a miscount; it cannot catch
// a reading taken off the wrong widget, because the wrong widget prints its
// own count just as faithfully.
//
// Usage:
//   node tools/checkGroundTruthConsistency.js
//   node tools/checkGroundTruthConsistency.js --json

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GT_PATH = path.join(REPO, 'data', 'qmg_ground_truth.json');
const MANIFEST_PATH = path.join(REPO, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');
const BENCHMARK_PATH = path.join(REPO, 'test', 'fixtures', 'qmg_benchmark', 'manifest.json');

// "N Items in Personal WatchList" | "1 Item in Personal WatchList"
// "K of N Items in Personal WatchList" | "1 of 1 Item in Personal WatchList"
const FOOTER_RE = /^(?:(\d+)\s+of\s+)?(\d+)\s+(?:Item|Items)\s+in\s+Personal\s+WatchList$/;

function md5File(file) {
  return require('crypto').createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The panel's own row count, read back out of the footer text.
function footerTotal(text) {
  if (typeof text !== 'string') return null;
  const m = FOOTER_RE.exec(text.trim());
  if (!m) return null;
  return { selected: m[1] === undefined ? null : Number(m[1]), total: Number(m[2]) };
}

// The tickers of one ground-truth entry, in either the array form or the
// {tickers, crop} object form.
function entryTickers(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) return entry.slice();
  if (Array.isArray(entry.tickers)) return entry.tickers.slice();
  return null;
}

function sameTickers(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const x = a.map((t) => String(t).toUpperCase()).sort();
  const y = b.map((t) => String(t).toUpperCase()).sort();
  return x.every((t, i) => t === y[i]);
}

// The top-level keys of a JSON text, read from the RAW FILE.
//
// `JSON.parse` cannot answer this question: a duplicate key is not an error,
// the LAST occurrence simply wins, and every reader of the file sees only the
// winner. The ground truth shipped with 24 of its 45 keys appearing twice --
// two blocks appended in different styles -- and the copies happened to carry
// the same values, so nothing was lost. That was luck, not design: the next
// append could have quietly overwritten half the corpus.
function topLevelKeys(text) {
  const lines = text.split(/\r?\n/);
  const keys = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}"([^"]+)":\s*[{[]/.exec(lines[i]);
    if (m) keys.push({ key: m[1], line: i + 1 });
  }
  return keys;
}

function checkGroundTruthConsistency(options = {}) {
  const repoRoot = options.repoRoot || REPO;
  const gtPath = options.gtPath || path.join(repoRoot, 'data', 'qmg_ground_truth.json');
  const manifestPath = options.manifestPath
    || path.join(repoRoot, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');
  const benchmarkPath = options.benchmarkPath
    || path.join(repoRoot, 'test', 'fixtures', 'qmg_benchmark', 'manifest.json');
  // The manifest and the crops it describes live together, but they are
  // separate inputs: a caller may check a manifest copy against the real
  // crops.
  const fixtureDir = options.fixtureDir || path.dirname(manifestPath);

  const problems = [];
  const problem = (code, message, extra = {}) => problems.push({ code, message, ...extra });

  const gtText = fs.readFileSync(gtPath, 'utf8');
  let gt = null;
  let gtParseError = null;
  try {
    gt = JSON.parse(gtText);
  } catch (err) {
    gtParseError = err;
    problem('gt-unparsable', `the ground truth is not valid JSON: ${err.message}`);
  }
  const manifest = readJson(manifestPath);

  const cases = manifest.cases || [];

  // --- 0. The ground truth must not carry a duplicate top-level key. ---
  //        JSON.parse silently keeps the last one, so a duplicate is a value
  //        that can be replaced without any reader noticing.
  {
    const seen = new Map();
    for (const { key, line } of topLevelKeys(gtText)) {
      if (seen.has(key)) {
        problem(
          'duplicate-key',
          `the ground truth names ${JSON.stringify(key)} twice (lines ${seen.get(key)} and ${line}); JSON.parse would keep only the second`,
          { date: key },
        );
      } else {
        seen.set(key, line);
      }
    }
  }

  // --- 1. No two cases may claim the same capture of the same date. ---
  const seen = new Map();
  for (const c of cases) {
    const key = `${c.date}#${c.capture_index}`;
    if (seen.has(key)) {
      problem('duplicate-case', `${key} is pinned twice in the manifest`, { date: c.date, capture_index: c.capture_index });
    }
    seen.set(key, c);
  }

  // --- 2. Every pinned capture must agree with the ground truth, with the
  //        panel's own count, and with the fixture file on disk. ---
  const perCase = [];
  for (const c of cases) {
    const key = `${c.date}#${c.capture_index}`;
    const record = { date: c.date, capture_index: c.capture_index, ok: true, checks: {} };

    // 2a. the fixture file exists and still hashes to the pinned md5
    const file = path.join(fixtureDir, c.file);
    if (!fs.existsSync(file)) {
      record.ok = false;
      problem('fixture-missing', `${key}: fixture ${c.file} is not in the tree`, record);
    } else {
      const md5 = md5File(file);
      record.checks.md5 = md5 === c.md5;
      if (md5 !== c.md5) {
        record.ok = false;
        problem('fixture-md5', `${key}: ${c.file} hashes to ${md5}, the manifest pins ${c.md5}`, record);
      }
    }

    // 2b. the panel's count is the number of tickers read from it
    record.checks.count = c.panel_count === c.tickers.length;
    if (!record.checks.count) {
      record.ok = false;
      problem(
        'panel-count',
        `${key}: the panel counts ${c.panel_count} items but ${c.tickers.length} tickers were read`,
        record,
      );
    }

    // 2b'. the reading must come from the POSITIONS table. The 2022-era
    //       frame has three right-hand widgets and the upper watchlist
    //       prints the same footer form, so a reading taken off the wrong
    //       widget satisfies the count invariant perfectly. The widget is
    //       recorded, so it can be checked.
    record.checks.panel = c.panel === 'positions';
    if (!record.checks.panel) {
      record.ok = false;
      problem(
        'wrong-panel',
        `${key}: the reading is from the ${JSON.stringify(c.panel)} widget, not the positions table`,
        record,
      );
    }

    // 2c. the recorded footer text carries that same count
    const footer = footerTotal(c.panel_count_text);
    record.checks.footer = Boolean(footer) && footer.total === c.panel_count;
    if (!footer) {
      record.ok = false;
      problem('footer-unreadable', `${key}: cannot read a row count out of ${JSON.stringify(c.panel_count_text)}`, record);
    } else if (footer.total !== c.panel_count) {
      record.ok = false;
      problem(
        'footer-disagrees',
        `${key}: the footer says ${footer.total} items but the manifest counts ${c.panel_count}`,
        record,
      );
    }

    // 2d. the ground truth agrees with what the fixture shows
    const gtEntry = !gt || gt[c.date] === undefined ? undefined : gt[c.date][String(c.capture_index)];
    const tickers = entryTickers(gtEntry);
    if (tickers === null) {
      record.ok = false;
      record.checks.ground_truth = false;
      problem('gt-missing', `${key}: the ground truth has no such capture`, record);
    } else if (!sameTickers(tickers, c.tickers)) {
      record.ok = false;
      record.checks.ground_truth = false;
      problem(
        'gt-disagrees',
        `${key}: the ground truth reads [${tickers.join(', ')}], the fixture reads [${c.tickers.join(', ')}]`,
        record,
      );
    } else {
      record.checks.ground_truth = true;
    }

    // 2e. if the corpus is on this machine, the source snapshot must still
    //     hash to what the manifest recorded for it. The corpus is NOT in
    //     git, so this check is skipped where it is absent.
    const source = path.join(repoRoot, c.source);
    if (fs.existsSync(source)) {
      const sourceMd5 = md5File(source);
      record.checks.source = sourceMd5 === c.source_md5;
      if (sourceMd5 !== c.source_md5) {
        record.ok = false;
        problem(
          'source-changed',
          `${key}: ${c.source} hashes to ${sourceMd5}, the manifest recorded ${c.source_md5}`,
          record,
        );
      }
    }

    perCase.push(record);
  }

  // --- 3. The benchmark's four frames and the fixture set must name the
  //        same frame for the same case. Two manifests describing different
  //        images under the same name is the defect this whole exercise
  //        exists to prevent. ---
  let benchmark = null;
  if (fs.existsSync(benchmarkPath)) {
    benchmark = readJson(benchmarkPath);
    const byCase = new Map();
    for (const frame of benchmark.frames || []) byCase.set(frame.case, frame);

    for (const c of cases) {
      if (!c.benchmark_case) continue;
      const frame = byCase.get(c.benchmark_case);
      if (!frame) {
        problem('benchmark-missing', `the benchmark has no case ${c.benchmark_case}`, { date: c.date, capture_index: c.capture_index });
        continue;
      }
      if (frame.date_key !== c.date || frame.capture_index !== c.capture_index) {
        problem(
          'benchmark-mismatch',
          `benchmark case ${c.benchmark_case} is ${frame.date_key} capture ${frame.capture_index}, the fixture manifest pins ${c.date} capture ${c.capture_index}`,
          { date: c.date, capture_index: c.capture_index },
        );
      }
      if (frame.source !== c.source) {
        problem(
          'benchmark-source',
          `benchmark case ${c.benchmark_case} was cut from ${frame.source}, the fixture manifest from ${c.source}`,
          { date: c.date, capture_index: c.capture_index },
        );
      }
    }

    // Every benchmark frame must be pinned by the fixture set.
    for (const frame of benchmark.frames || []) {
      const key = `${frame.date_key}#${frame.capture_index}`;
      if (!seen.has(key)) {
        problem(
          'benchmark-unpinned',
          `benchmark case ${frame.case} (${key}) has no fixture in the ground-truth manifest`,
          { date: frame.date_key, capture_index: frame.capture_index },
        );
      }
    }
  }

  // --- 4. The census: how much of the ground truth is actually pinned. ---
  const gtDateKeys = Object.keys(gt || {}).filter((k) => !k.startsWith('_'));
  const annotated = gtDateKeys.filter((k) => !/^\d{8}$/.test(k));
  let gtCaptures = 0;
  let pinnedCaptures = 0;
  const unpinned = [];
  for (const dateKey of gtDateKeys) {
    const entry = gt[dateKey];
    const indexes = Array.isArray(entry)
      ? [0]
      : Object.keys(entry).filter((k) => /^\d+$/.test(k));
    for (const idx of indexes) {
      gtCaptures += 1;
      if (seen.has(`${dateKey}#${idx}`)) pinnedCaptures += 1;
      else unpinned.push(`${dateKey}#${idx}`);
    }
  }

  const census = {
    gt_dates: gtDateKeys.length,
    gt_captures: gtCaptures,
    pinned_dates: new Set(cases.map((c) => c.date)).size,
    pinned_captures: pinnedCaptures,
    unpinned_captures: gtCaptures - pinnedCaptures,
    unpinned_sample: unpinned.slice(0, 40),
    // The ground truth carries two annotated duplicate keys ("20220323 (batch
    // t=1020s)" and "20220428 (batch t=1300s)"). They are the same captures
    // of the same video under a label, they are not dates of their own, and
    // no probe log can ever match them.
    annotated_duplicate_keys: annotated,
  };

  return {
    ok: problems.length === 0,
    problems,
    census,
    cases: perCase,
    ground_truth: gtPath,
    manifest: manifestPath,
  };
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const result = checkGroundTruthConsistency();

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const { census } = result;
    console.log(`ground truth        : ${result.ground_truth}`);
    console.log(`fixture manifest    : ${result.manifest}`);
    console.log(`pinned captures     : ${census.pinned_captures} of ${census.gt_captures}`
      + ` (${census.pinned_dates} of ${census.gt_dates} dates)`);
    if (census.annotated_duplicate_keys.length) {
      console.log(`annotated duplicates: ${census.annotated_duplicate_keys.join(', ')}  (not dates; excluded from the date census)`);
    }
    if (result.problems.length) {
      console.error(`\n${result.problems.length} problem(s):`);
      for (const p of result.problems) console.error(`  [${p.code}] ${p.message}`);
    } else {
      console.log('\nOK: every pinned capture agrees with its fixture, its panel count and the ground truth.');
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}

module.exports = { checkGroundTruthConsistency, footerTotal, sameTickers, entryTickers, topLevelKeys, FOOTER_RE };
