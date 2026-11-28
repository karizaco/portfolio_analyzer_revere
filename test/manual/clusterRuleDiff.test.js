'use strict';

// The per-date DIFF between the shipped cluster rule and each alternative.
//
// The aggregate measurement (`clusterRuleMeasurement.test.js`) shows that the
// six rules produce the SAME hit count on both corpora, and that only the
// prediction count moves. That aggregate is not enough to decide: two rules
// can have the same total and still differ on WHICH dates they changed, and a
// rule that removes a false positive on one date while losing a holding on
// another is not a win.
//
// So this harness diffs per DATE, for the `rebuilt_current` arm (the current
// parser end to end -- the arm whose denominator matches the capture-level
// one) and for the `rebuilt` arm (the cluster rule in isolation).
//
//   node --test test/manual/clusterRuleDiff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const CORPORA = [
  { name: 'default', roots: [] },
  { name: 'wide', roots: ['data/video_ocr_probe', 'data/video_scan_test/_rerun'] },
];

const ALTERNATIVES = [
  'corroborated',
  'corroborated-strict',
  'supported',
  'supported+corroborated',
  'video-supported',
  'video-supported+corroborated',
];

function run(rule, corpus) {
  const args = ['tools/evalParserReplay.js', '--cluster-rule', rule, '--json'];
  for (const root of corpus.roots) args.push(root);
  const res = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function rowsOf(data, arm) {
  const out = new Map();
  const a = data.merged && data.merged[arm];
  if (!a || !Array.isArray(a.per_date)) return out;
  for (const row of a.per_date) out.set(row.date, row);
  return out;
}

test('each alternative rule differs from shipped, date by date', () => {
  const report = [];

  for (const corpus of CORPORA) {
    const base = run('shipped', corpus);
    assert.ok(base, `the shipped rule ran on ${corpus.name}`);

    for (const arm of ['rebuilt_current', 'rebuilt']) {
      const baseRows = rowsOf(base, arm);
      console.log(`\n--- ${corpus.name} / ${arm} : shipped vs the alternatives ---`);
      console.log('rule                           dates changed   hits      preds    detail');

      for (const rule of ALTERNATIVES) {
        const alt = run(rule, corpus);
        assert.ok(alt, `${rule} ran on ${corpus.name}`);
        const altRows = rowsOf(alt, arm);

        const changed = [];
        let baseHits = 0;
        let altHits = 0;
        let basePred = 0;
        let altPred = 0;
        for (const [date, b] of baseRows) {
          const a = altRows.get(date);
          if (!a) continue;
          baseHits += b.hit;
          altHits += a.hit;
          basePred += b.pred;
          altPred += a.pred;
          const same = b.hit === a.hit
            && b.pred === a.pred
            && JSON.stringify(b.missed) === JSON.stringify(a.missed)
            && JSON.stringify(b.fp) === JSON.stringify(a.fp);
          if (same) continue;
          changed.push(
            `      ${date}: shipped hit=${b.hit} pred=${b.pred} `
            + `missed=[${b.missed.join(' ')}] fp=[${b.fp.join(' ')}]  ->  `
            + `${rule} hit=${a.hit} pred=${a.pred} `
            + `missed=[${a.missed.join(' ')}] fp=[${a.fp.join(' ')}]`
          );
        }

        const hitsDelta = altHits - baseHits;
        const predDelta = altPred - basePred;
        console.log(
          `${rule.padEnd(30)} ${String(changed.length).padStart(6)}   `
          + `${String(hitsDelta).padStart(+6)}   ${String(predDelta).padStart(+6)}`
          + (changed.length ? '' : '     (no date changed)')
        );
        for (const line of changed) console.log(line);

        report.push({ corpus: corpus.name, arm, rule, changedDates: changed.length, hitsDelta, predDelta });
      }
      console.log('');
    }
  }

  console.log('\n--- summary ---');
  for (const r of report) {
    console.log(
      `${r.corpus.padEnd(8)} ${r.arm.padEnd(18)} ${r.rule.padEnd(30)} `
      + `dates ${r.changedDates}  hits ${r.hitsDelta >= 0 ? '+' : ''}${r.hitsDelta}  preds ${r.predDelta >= 0 ? '+' : ''}${r.predDelta}`
    );
  }
  console.log('');

  try {
    const out = path.join(ROOT, 'data', 'video_pipeline', 'catalog');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'cluster_rule_diff.json'),
      JSON.stringify(report, null, 2)
    );
  } catch (e) {
    console.log(`(could not write the diff file: ${e.message})`);
  }
});
