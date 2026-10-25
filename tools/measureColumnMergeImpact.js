'use strict';

// Measure what the glyph-merge fix changed, over every snapshot on disk.
//
// WHY THIS EXISTS
//   The numbers in docs/qmg-positions-layout-findings.md, section
//   "What it changed, over the whole corpus", are the only measurement of
//   the merge fix's blast radius. A measurement nobody can re-run is a
//   measurement nobody can check, so the script that produced them lives
//   here.
//
// WHAT IT COMPARES
//   Two builds of src/video/positionColumn.js — the detector that finds the
//   candidate ticker columns. For every snapshot it runs both, takes the
//   SHORTLIST (the candidates the table reader actually works from, after
//   the region, row and pitch filters) and compares the two lists.
//
//   The frame width matters: shortlistCandidates() filters on
//   REGION_LEFT_FRACTION * frameWidth, so it must be the IMAGE width, not
//   the detected column's right edge. Passing the latter changes the
//   result.
//
// USAGE
//   node tools/measureColumnMergeImpact.js --before <positionColumn.js>
//                                        [--after <positionColumn.js>]
//                                        [--data-root <dir>]
//
//   The "before" file is usually a copy of the pre-fix detector:
//
//     git show a15f66a:src/video/positionColumn.js > C:/tmp/positionColumn_before.js
//     node tools/measureColumnMergeImpact.js --before C:/tmp/positionColumn_before.js
//
//   --after defaults to the detector in the working tree.
//
// OUTPUT
//   The frame count and the breakdown the findings doc quotes. The doc's
//   numbers are the ones printed for --before a15f66a / --after 1159ec0
//   over the 252 source-width snapshots under data/video_scan*.
//
// NOTE ON THE 4
//   "Same shortlist, different winner" counts frames whose top candidate
//   changed while the REST of the shortlist is character-for-character
//   identical. It is a SUBSET of "different TOP candidate", not a
//   separate class.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { shortlistCandidates } = require(path.join(ROOT, 'src', 'video', 'positionTableScan.js'));

// A snapshot at least this wide came from the 1920x1080 source rather
// than from the 1280x720 OCR-resolution frame. Same constant as
// tools/buildPositionCorpus.js.
const MIN_WIDTH = 1600;

function parseArgs(argv) {
  const args = {
    before: null,
    after: path.join(ROOT, 'src', 'video', 'positionColumn.js'),
    dataRoot: path.join(ROOT, 'data'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--before') args.before = path.resolve(argv[++i]);
    else if (a === '--after') args.after = path.resolve(argv[++i]);
    else if (a === '--data-root') args.dataRoot = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/measureColumnMergeImpact.js --before <positionColumn.js> [--after <positionColumn.js>] [--data-root <dir>]');
      process.exit(0);
    }
  }
  if (!args.before) {
    console.error('--before <positionColumn.js> is required (the detector to compare against)');
    process.exit(2);
  }
  return args;
}

/**
 * Every source-width snapshot under the scan trees.
 *
 * The scope is deliberately the same as tools/buildPositionCorpus.js's
 * indexSnapshots(): data/video_scan* only, files named
 * qmg_<date>[_<n>].png, PNG width >= MIN_WIDTH.
 */
function collectSnapshots(dataRoot) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['frames', 'node_modules', '.git'].includes(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!/^qmg_\d{8}(?:_\d+)?\.png$/.test(e.name)) continue;
      let width = 0;
      try { width = fs.readFileSync(full).readUInt32BE(16); } catch { continue; }
      if (width < MIN_WIDTH) continue;
      out.push({ file: full, width });
    }
  };
  let dirs = [];
  try { dirs = fs.readdirSync(dataRoot); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.startsWith('video_scan')) continue;
    walk(path.join(dataRoot, d), 0);
  }
  out.sort((a, b) => (a.file < b.file ? -1 : 1));
  return out;
}

/** The shortlist of a frame: the candidates the reader works from. */
async function shortlistOf(detector, file, width) {
  const r = await detector.findTickerColumnByInkRuns(file, {});
  // The FRAME width, not the detected column's right edge: the region
  // filter is REGION_LEFT_FRACTION * frameWidth.
  return shortlistCandidates(r.candidates, width, {}).map(
    (c) => `${c.left}:${c.rowCount}:${c.top}-${c.bottom}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const before = require(args.before);
  const after = require(args.after);
  const snapshots = collectSnapshots(args.dataRoot);
  console.log(`snapshots: ${snapshots.length}`);

  const counts = {
    unchanged: 0,
    changed: 0,
    emptyToPopulated: 0,
    populatedToEmpty: 0,
    differentTopSameRest: 0,
    differentTopDifferentRest: 0,
    sameTop: 0,
  };
  const widths = new Set();
  let i = 0;
  for (const s of snapshots) {
    i += 1;
    if (i % 50 === 0) console.log(`  ...${i}/${snapshots.length}`);
    widths.add(s.width);
    let B;
    let A;
    try {
      B = await shortlistOf(before, s.file, s.width);
      A = await shortlistOf(after, s.file, s.width);
    } catch (e) {
      console.log(`  ERROR ${path.relative(ROOT, s.file)}: ${e.message}`);
      continue;
    }
    if (JSON.stringify(B) === JSON.stringify(A)) { counts.unchanged += 1; continue; }
    counts.changed += 1;
    const tb = B[0] || null;
    const ta = A[0] || null;
    if (!B.length && A.length) { counts.emptyToPopulated += 1; continue; }
    if (B.length && !A.length) { counts.populatedToEmpty += 1; continue; }
    if (tb !== ta) {
      if (JSON.stringify(B.slice(1)) === JSON.stringify(A.slice(1))) {
        counts.differentTopSameRest += 1;
      } else {
        counts.differentTopDifferentRest += 1;
      }
    } else {
      counts.sameTop += 1;
    }
  }

  const differentTop = counts.emptyToPopulated
    + counts.differentTopSameRest
    + counts.differentTopDifferentRest;
  console.log(`widths: ${[...widths].sort((a, b) => a - b).join(', ')}`);
  console.log('');
  console.log(`| | frames |`);
  console.log(`|---|---|`);
  console.log(`| shortlist unchanged | ${counts.unchanged} |`);
  console.log(`| shortlist changed | ${counts.changed} |`);
  console.log(`| ... of those, a different TOP candidate | ${differentTop} |`);
  console.log(`| ... of those, the same shortlist with a different winner | ${counts.differentTopSameRest} |`);
  console.log(`| ... empty before, populated after | **${counts.emptyToPopulated}** |`);
  console.log(`| ... populated before, empty after | **${counts.populatedToEmpty}** |`);
  console.log('');
  console.log(`the changed frames split four ways:`);
  console.log(`  ${counts.emptyToPopulated} empty before, populated after`);
  console.log(`  ${counts.differentTopSameRest} different winner, same rest`);
  console.log(`  ${counts.differentTopDifferentRest} different winner, different rest`);
  console.log(`  ${counts.sameTop} same winner, different rest`);
  const split = counts.emptyToPopulated + counts.differentTopSameRest
    + counts.differentTopDifferentRest + counts.sameTop;
  console.log(`  (sum ${split}, changed ${counts.changed})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
