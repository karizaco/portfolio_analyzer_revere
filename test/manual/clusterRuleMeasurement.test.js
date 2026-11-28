'use strict';

// The cluster-rule MEASUREMENT.
//
// This is a MANUAL suite, in `test/manual/` because the corpus it measures is
// UNTRACKED -- the probe logs live under gitignored `data/` trees, so a fresh
// clone has nothing to measure and the suite's glob does not reach this file
// anyway.
//
// WHAT IT IS FOR
//
// The clusterer names one canonical per cluster of garbled tokens, and a
// canonical that is a CORRECTION rather than a READING is a name the
// clusterer invented. On 20230605 the cluster {AACO, ARCO} was published as
// `AAPL` -- a holding no frame of that video showed.
//
// Six rules exist to choose that canonical differently, and ALL of them are
// off by default:
//
//   shipped                 the rule the scan tool runs
//   corroborated            a corrected canonical must be within edit distance
//                           1 of a cluster member, or the cluster is DISCARDED
//   supported               the correction the VIDEO actually read, breaking
//                           ties between equally-close candidates
//   supported+corroborated  both
//   video-supported         the correction the VIDEO actually read, whatever
//                           its distance
//   video-supported+corroborated  both
//
// The default stays where it is until a wider measurement says otherwise, and
// THIS is that measurement.
//
// WHY IT REPORTS RATHER THAN ASSERTS
//
// The numbers depend on a corpus that is not in git, so a test asserting
// them would fail on a fresh clone. The assertions here are STRUCTURAL --
// every rule ran, on every corpus, and every run produced the arms it should
// have -- and the NUMBERS are printed for a human to read.
//
//   node --test test/manual/clusterRuleMeasurement.test.js
//
// The same measurement, without the harness, is:
//
//   node tools/evalParserReplay.js --cluster-rule supported --json

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'video_pipeline', 'catalog');

const RULES = [
  'shipped',
  'corroborated',
  'corroborated-strict',
  'supported',
  'supported+corroborated',
  'video-supported',
  'video-supported+corroborated',
  'swallowed',
  'swallowed+corroborated',
];

const CORPORA = [
  { name: 'default', roots: [] },
  { name: 'wide', roots: ['data/video_ocr_probe', 'data/video_scan_test/_rerun'] },
];

function slug(rule) {
  return rule.replace(/\+/g, '_');
}

// Run the replay tool under one rule, on one corpus.
function run(rule, corpus) {
  const args = ['tools/evalParserReplay.js', '--cluster-rule', rule, '--json'];
  for (const root of corpus.roots) args.push(root);
  const res = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || '').slice(0, 4000) };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (e) {
    return {
      ok: false,
      error: `unparsable JSON: ${e.message}\n${res.stdout.slice(0, 500)}`
    };
  }
}

function armOf(data, name) {
  const arm = data.merged && data.merged[name];
  if (!arm) return null;
  return {
    hit: arm.totals.hit,
    gt: arm.totals.gt,
    pred: arm.totals.pred,
    recall: arm.micro_recall,
    precision: arm.micro_precision,
    datesScored: arm.census.datesScored,
    lost: arm.census.datesLostToMissingReading,
  };
}

test('every cluster rule is measured over both corpora', () => {
  const summary = [];
  const failures = [];

  for (const rule of RULES) {
    for (const corpus of CORPORA) {
      const out = run(rule, corpus);
      if (!out.ok) {
        failures.push(`${rule} / ${corpus.name}: ${out.error}`);
        continue;
      }
      const data = out.data;
      summary.push({
        rule,
        corpus: corpus.name,
        capture: {
          hit: data.totals.hit,
          gt: data.totals.gt,
          pred: data.totals.pred,
          recall: data.micro_recall,
          precision: data.micro_precision,
          datesScored: data.census.datesScored,
        },
        arms: {
          recorded: armOf(data, 'recorded'),
          rebuilt: armOf(data, 'rebuilt'),
          rebuilt_current: armOf(data, 'rebuilt_current'),
        },
        census: {
          logsWithRecordedClusterRule: data.merged_census
            ? data.merged_census.logsWithRecordedClusterRule
            : null,
          logsWithDifferentRecordedClusterRule: data.merged_census
            ? data.merged_census.logsWithDifferentRecordedClusterRule
            : null,
        },
      });
    }
  }

  // ---- the report -------------------------------------------------------
  console.log('\n================= CLUSTER RULE MEASUREMENT =================\n');
  for (const corpus of CORPORA) {
    console.log(`--- corpus: ${corpus.name} ---`);
    console.log(
      'rule                           capture h/gt/p rec%  prec%  |  ' +
      'rebuilt h/gt/p rec%  prec%  dates  |  rebuilt_current h/gt/p rec%  prec%  dates'
    );
    for (const line of summary.filter((l) => l.corpus === corpus.name)) {
      const c = line.capture;
      const r = line.arms.rebuilt || {};
      const rc = line.arms.rebuilt_current || {};
      console.log(
        `${line.rule.padEnd(30)}` +
        `${String(c.hit).padStart(4)}/${String(c.gt).padStart(3)}/${String(c.pred).padStart(3)} ` +
        `${String(c.recall).padStart(5)}% ${String(c.precision).padStart(6)}%  |  ` +
        `${String(r.hit).padStart(4)}/${String(r.gt).padStart(3)}/${String(r.pred).padStart(3)} ` +
        `${String(r.recall).padStart(5)}% ${String(r.precision).padStart(6)}% ${String(r.datesScored).padStart(5)}  |  ` +
        `${String(rc.hit).padStart(4)}/${String(rc.gt).padStart(3)}/${String(rc.pred).padStart(3)} ` +
        `${String(rc.recall).padStart(5)}% ${String(rc.precision).padStart(6)}% ${String(rc.datesScored).padStart(5)}`
      );
    }
    console.log('');
  }

  console.log('--- the `recorded` arm: what production published ---');
  for (const line of summary) {
    const rec = line.arms.recorded || {};
    console.log(
      `${line.corpus.padEnd(8)} ${line.rule.padEnd(30)} ` +
      `${rec.hit}/${rec.gt}/${rec.pred} rec ${rec.recall}% prec ${rec.precision}% dates ${rec.datesScored}`
    );
  }
  console.log('\n===============================================================\n');

  // ---- the assertions (structural only) --------------------------------
  assert.equal(
    failures.length,
    0,
    `every rule ran on every corpus:\n${failures.join('\n\n')}`
  );
  assert.equal(
    summary.length,
    RULES.length * CORPORA.length,
    'every rule/corpus produced a summary line'
  );
  for (const line of summary) {
    assert.ok(line.arms.recorded, `${line.rule}/${line.corpus} has a recorded arm`);
    assert.ok(line.arms.rebuilt, `${line.rule}/${line.corpus} has a rebuilt arm`);
    assert.ok(line.arms.rebuilt_current, `${line.rule}/${line.corpus} has a rebuilt_current arm`);
    assert.ok(
      line.capture.datesScored > 0,
      `${line.rule}/${line.corpus} scored at least one date -- the corpus is present`
    );
  }

  // Write the summary next to the catalog, so the numbers survive the run.
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(
      path.join(OUT, 'cluster_rule_measurement.json'),
      JSON.stringify({ generated_by: 'test/manual/clusterRuleMeasurement.test.js', summary }, null, 2)
    );
  } catch (e) {
    console.log(`(could not write the summary file: ${e.message})`);
  }
});
