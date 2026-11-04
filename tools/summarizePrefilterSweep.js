'use strict';

/**
 * Summarise a prefilter-resolution sweep JSON.
 *
 * `tools/sweepPrefilterResolution.js` prints its roll-up at the end of a run,
 * but the run is expensive (minutes per date, hours per era) and the JSON is
 * written after EVERY date — so the useful thing is to be able to re-read the
 * JSON later and get the tables again without paying for the sweep twice.
 *
 * It also prints the CENSUS the roll-up hides: how many labelled frames each
 * date's pool holds, and how many of them read NOTHING. That number is the
 * measurement's power, and it is the one that decides how much the verdicts
 * are worth — a date whose pool contains no zero-holding frame cannot
 * distinguish "the prefilter ranks well" from "the prefilter never had a
 * junk frame to rank".
 *
 * Usage:
 *   node tools/summarizePrefilterSweep.js data/prefilter_resolution_sweep_2022.json
 *   node tools/summarizePrefilterSweep.js <file> --per-date
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { file: null, perDate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--per-date') args.perDate = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (!args.file) args.file = a;
  }
  return args;
}

// The result key is `region@resolution@decay` — THREE segments. A two-segment
// split is what produced the `padEnd of undefined` crash, so it is done once,
// here, and nowhere else.
function parseResultKey(key) {
  const [region, resolution, decay] = String(key).split('@');
  return { region, resolution, decay };
}

function load(file) {
  const resolved = path.resolve(file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function printCensus(result) {
  console.log('=== the label census (the measurement\'s power) ===\n');
  console.log('date       era  labels  pool  holding  zero  <=1  conflicts   verdict@160x90/era/production');
  console.log('-'.repeat(108));
  let totals = { labels: 0, pool: 0, holding: 0, zero: 0, nearJunk: 0, datesWithZero: 0, datesWithNearJunk: 0 };
  for (const date of result.dates || []) {
    const first = date.results && date.results['fallback@160x90@production'];
    const pool = first ? first.labelled_frames : 0;
    const holding = first ? first.holding_frames : 0;
    const zero = first ? first.zero_frames : 0;
    // A frame that read exactly ONE ticker is nearly as useless as one that
    // read none, and the verdict's ">0 is a holding" rule is generous to the
    // prefilter. This count is the census's harder half.
    const nearJunk = first
      ? (first.labelled || []).filter((l) => l.holdings <= 1).length
      : 0;
    totals.labels += (date.labels || []).length;
    totals.pool += pool;
    totals.holding += holding;
    totals.zero += zero;
    totals.nearJunk += nearJunk;
    if (zero > 0) totals.datesWithZero += 1;
    if (nearJunk > 0) totals.datesWithNearJunk += 1;
    console.log(
      String(date.date).padEnd(11)
      + String(date.era).padEnd(4)
      + String((date.labels || []).length).padStart(7)
      + String(pool).padStart(5)
      + String(holding).padStart(8)
      + String(zero).padStart(5)
      + String(nearJunk).padStart(5)
      + String(first ? first.label_conflicts : '-').padStart(11)
      + `   ${first ? first.verdict : '-'}`
    );
  }
  console.log('-'.repeat(108));
  console.log(
    `  totals: ${totals.labels} label(s), ${totals.pool} pool frame(s), `
    + `${totals.holding} holding, ${totals.zero} reading NOTHING, ${totals.nearJunk} reading at most ONE`
  );
  console.log(
    `  dates whose pool contains a zero-holding frame: ${totals.datesWithZero}`
    + `/${(result.dates || []).length}`
  );
  console.log(
    `  dates whose pool contains a <=1-holding frame:    ${totals.datesWithNearJunk}`
    + `/${(result.dates || []).length}`
  );
  console.log(
    '\n  A date with NO zero-holding frame cannot say anything about the'
    + ' prefilter picking a junk frame:\n  the pool the prefilter KEPT is, by'
    + ' construction, mostly frames that read holdings.\n  Its verdict is'
    + ' NO_ZERO_FRAME and its Spearman still measures the ORDERING.'
  );
  console.log(
    '\n  The conflict column is a LOWER BOUND on the zero count: when two runs'
    + ' read the same\n  frame differently the larger reading wins ("the frame'
    + ' DID hold positions"), so a frame\n  read as zero by one run and as'
    + ' holding by another is counted as holding.'
  );
}

function printRollup(result) {
  console.log('\n=== per era, per resolution, per region ===\n');
  console.log(
    'era    resolution  region     decay      dates  OK  PART  INV  no-zero  mean spearman  mean best-labelled'
  );
  console.log('-'.repeat(112));
  const rows = Object.values(result.summary || {});
  rows.sort((a, b) => a.era.localeCompare(b.era)
    || a.result_key.localeCompare(b.result_key));
  for (const row of rows) {
    const { region, resolution, decay } = parseResultKey(row.result_key);
    const v = row.verdicts || {};
    console.log(
      String(row.era).padEnd(6)
      + String(resolution).padEnd(12)
      + String(region).padEnd(11)
      + String(decay).padEnd(11)
      + String(row.dates).padStart(5)
      + String(v.OK || 0).padStart(4)
      + String(v.PARTIAL || 0).padStart(6)
      + String(v.INVERTED || 0).padStart(5)
      + String(v.NO_ZERO_FRAME || 0).padStart(9)
      + String(row.mean_spearman === null ? '-' : row.mean_spearman).padStart(15)
      + String(row.mean_best_labelled === null ? '-' : row.mean_best_labelled).padStart(22)
    );
  }
  console.log('\n  A NEGATIVE mean spearman is GOOD: a low rank should carry a high holding count.');
  console.log('  INVERTED means the best zero-holding frame outranks EVERY holding frame.');
  console.log('  PARTIAL means it outranks some of them.');
}

function printPerDate(result) {
  console.log('\n=== per date, per resolution, per region (production decay) ===\n');
  for (const date of result.dates || []) {
    console.log(
      `--- ${date.date} (${date.era}-era) — ${date.video || '?'}`
      + `  [${date.frames_extracted} extracted, ${date.frames_scored} scored]`
    );
    for (const key of Object.keys(date.results || {})) {
      const entry = date.results[key];
      const { resolution, region, decay } = parseResultKey(key);
      if (decay !== 'production') continue;
      const best = entry.best_labelled;
      console.log(
        `    ${resolution.padEnd(8)} ${region.padEnd(9)} ${String(entry.verdict).padEnd(15)}`
        + ` best-labelled=${best ? best.holdings : '-'}`
        + ` (rank ${best ? best.rank : '-'}/${entry.scored_frames})`
        + `  zero-outranks=${entry.zero_outranks}/${entry.holding_frames}`
        + `  spearman=${entry.spearman_rank_holdings === null ? '-' : entry.spearman_rank_holdings.toFixed(3)}`
      );
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: node tools/summarizePrefilterSweep.js <sweep.json> [--per-date]');
    process.exit(2);
  }
  const result = load(args.file);
  console.log(`\n=== ${path.basename(args.file)} ===`);
  console.log(
    `  dates: ${(result.dates || []).length}`
    + `   stride: ${result.stride}`
    + `   fps: ${result.sample_fps}`
    + `   sample width: ${result.sample_width}`
    + `   sources: ${(result.sources || []).join(',')}`
  );
  console.log(`  resolutions: ${(result.resolutions || []).join(',')}`);
  printCensus(result);
  printRollup(result);
  if (args.perDate) printPerDate(result);
}

if (require.main === module) main();

module.exports = { parseResultKey, load, printCensus, printRollup, printPerDate };
