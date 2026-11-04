'use strict';

// A MANUAL measurement: the WIDE prefilter-resolution sweep.
//
// CLAUDE.md (§ 'The prefilter's RESOLUTION — 640×360 is the first one that
// works') says shipping a higher prefilter resolution needs three things:
//
//   1. a WIDE measurement — one video, six labelled frames, is not enough,
//      and the 2022-era floating panel and the 2023-era right sidebar have
//      different geometry, so the two eras have to be measured SEPARATELY;
//   2. a re-tune of the scale-bound constants (`rowDensityTarget`,
//      `multiColStripeCountTarget`);
//   3. a decision on the stripe term itself.
//
// This harness produces (1). It needs no OCR at all: the labels it scores
// against are already in the corpus, because every probe log records the OCR'd
// candidate pool (selected captures plus the top/rejected candidates), with a
// timestamp and `chart_stream.position_list` for each frame. The default
// source set is the whole retained pool; `--sources captures` can reproduce
// the older selected-captures-only measurement. `tools/extractPrefilterLabels.js`
// extracts them.
//
// It is deliberately not part of `npm test`: it needs the real videos (the
// media is not in git) and it re-extracts every sampled frame.
//
// Run it:
//
//   node --test test/manual/prefilterResolutionSweep.test.js
//
// Configuration comes from `test/manual/prefilterResolutionSweep.config.json`
// when that file exists, and from the environment otherwise (the environment
// wins):
//
//   dates        the dates to measure (default: every measurable one)
//   era         "2022" or "2023" (default: both)
//   resolutions  "w x h,..." (default 160x90,320x180,640x360)
//   stride       score every n-th frame (default 1 — every frame)
//   minLabels    a date needs this many aligned labels (default 2)
//   sources      comma-separated captures,candidates,rejected (default: all)
//   limit        stop after n dates
//   out          where to write the JSON
//
// The assertions are STRUCTURAL: the sweep ran, every measurable date was
// measured, and every ranking carries a verdict from the known set. The
// VERDICTS are reported, not asserted — a resolution that does not help is a
// finding, not a failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const { runSweep } = require(path.join(ROOT, 'tools', 'sweepPrefilterResolution'));
const {
  collect,
  DEFAULT_ROOTS,
  normalizeSources
} = require(path.join(ROOT, 'tools', 'extractPrefilterLabels'));

const KNOWN_VERDICTS = new Set([
  'OK',
  'PARTIAL',
  'INVERTED',
  'NO_ZERO_FRAME',
  'NO_HOLDING_FRAME',
  'NO_LABELS'
]);

function readConfig() {
  const configPath = path.join(__dirname, 'prefilterResolutionSweep.config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.log(`  ignoring the unreadable config file: ${error.message}`);
    return {};
  }
}

const CONFIG = readConfig();

const DATES = String(process.env.PREFILTER_SWEEP_DATES || CONFIG.dates || '').trim();
const ERA = String(process.env.PREFILTER_SWEEP_ERA || CONFIG.era || '').trim();
const RESOLUTIONS = String(
  process.env.PREFILTER_SWEEP_RESOLUTIONS || CONFIG.resolutions || '160x90,320x180,640x360'
).trim();
const STRIDE = Number(process.env.PREFILTER_SWEEP_STRIDE || CONFIG.stride || 1) || 1;
const MIN_LABELS = Number(process.env.PREFILTER_SWEEP_MIN_LABELS || CONFIG.minLabels || 2) || 2;
const LIMIT = Number(process.env.PREFILTER_SWEEP_LIMIT || CONFIG.limit || 0) || 0;
const SOURCES = String(process.env.PREFILTER_SWEEP_SOURCES || CONFIG.sources || '').trim();
const OUT = path.resolve(
  ROOT,
  String(process.env.PREFILTER_SWEEP_OUT || CONFIG.out || 'data/prefilter_resolution_sweep.json')
);

test('the wide prefilter-resolution sweep, per era', async (t) => {
  // The corpus is untracked, so a fresh clone has neither the probe logs nor
  // the media. That is a skip, not a failure.
  const labelDates = collect({
    roots: DEFAULT_ROOTS,
    era: ERA || null,
    date: null,
    sources: SOURCES ? normalizeSources(SOURCES) : undefined
  });
  const measurable = labelDates.filter(
    (date) => date.alignedLabels.length >= MIN_LABELS && date.videos.length
  );
  if (!measurable.length) {
    t.skip('no probe logs with grid-aligned labels and media on this machine');
    return;
  }

  const argv = [
    '--resolutions', RESOLUTIONS,
    '--stride', String(STRIDE),
    '--min-labels', String(MIN_LABELS),
    '--out', OUT,
    '--print', 'detail'
  ];
  if (DATES) argv.push('--dates', DATES);
  if (ERA) argv.push('--era', ERA);
  if (SOURCES) argv.push('--sources', SOURCES);
  if (LIMIT) argv.push('--limit', String(LIMIT));

  console.log(`\n=== tools/sweepPrefilterResolution.js --resolutions ${RESOLUTIONS} --stride ${STRIDE}`);
  console.log(`  ${measurable.length} measurable date(s); output: ${path.relative(ROOT, OUT)}`);

  await runSweep(argv);

  assert.ok(fs.existsSync(OUT), 'the sweep wrote no output file');
  const result = JSON.parse(fs.readFileSync(OUT, 'utf8'));

  assert.ok(result.dates.length, 'no date was measured');
  assert.ok(result.summary && Object.keys(result.summary).length, 'the roll-up is empty');

  // Every measured date carries a verdict for every (resolution, region,
  // decay) combination, and every verdict is one of the known ones. A
  // verdict outside the set would mean the sweep changed its own
  // vocabulary, which is how a measurement starts lying.
  const expectedKeys = new Set();
  for (const date of result.dates) {
    for (const key of Object.keys(date.results || {})) expectedKeys.add(key);
  }
  assert.ok(expectedKeys.size, 'no result keys were produced');

  for (const date of result.dates) {
    if (date.error) continue;
    for (const key of expectedKeys) {
      const entry = (date.results || {})[key];
      assert.ok(entry, `${date.date} is missing the result for ${key}`);
      assert.ok(
        KNOWN_VERDICTS.has(entry.verdict),
        `${date.date} ${key} carries the unknown verdict "${entry.verdict}"`
      );
    }
  }

  // The roll-up counts the two eras SEPARATELY — the same result key is used
  // by both, and the two have different geometry.
  const eraKeys = Object.keys(result.summary);
  const expectedEra = ERA || result.dates[0].era;
  assert.ok(
    eraKeys.some((key) => key.startsWith(`${expectedEra}|`)),
    `the roll-up has no ${expectedEra}-era bucket`
  );

  console.log('\n=== the numbers (per era, per resolution, per region) ===');
  for (const key of eraKeys.sort()) {
    const bucket = result.summary[key];
    const [region, resolution, decay] = bucket.result_key.split('@');
    const regionResolution = `${region}@${resolution}`;
    console.log(
      `  ${bucket.era}-era  ${regionResolution.padEnd(16)} decay=${decay.padEnd(11)}`
      + ` dates=${String(bucket.dates).padStart(3)}`
      + `  OK=${bucket.verdicts.OK || 0}`
      + `  PARTIAL=${bucket.verdicts.PARTIAL || 0}`
      + `  INVERTED=${bucket.verdicts.INVERTED || 0}`
      + `  no-zero=${bucket.verdicts.NO_ZERO_FRAME || 0}`
      + ` mean spearman=${bucket.mean_spearman}`
      + ` mean best-labelled=${bucket.mean_best_labelled}`
    );
  }
  console.log('\n  A NEGATIVE mean spearman is GOOD: a low rank should carry a high holding count.');
  console.log('  INVERTED means the best zero-holding frame outranks EVERY holding frame.');
});
