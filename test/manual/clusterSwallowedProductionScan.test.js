'use strict';

// The PRODUCTION SCAN under the swallowed-holding rule.
//
// The rule's own numbers cannot be measured from the recorded logs, because
// the log does not carry the clusterer's input (see
// clusterLogInputFidelity.test.js) -- so the rule has to be run through a
// real scan, exactly as the corroboration rule's numbers were.
//
//   node --test test/manual/clusterSwallowedProductionScan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_TAG = 'qmg-easyocr-20261103-swallowed';
const RULE = 'corroborated+swallowed';
const DATES = ['20230522', '20230523', '20230602', '20230605', '20230608', '20230609'];

const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

function logsOf(runTag) {
  const dir = path.join(ROOT, 'data', 'video_scan_test', '_rerun', runTag, 'ocr_probe', 'logs');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      // an unreadable log is a fact about the run, not a reason to stop
    }
  }
  return out;
}

test('the swallowed-holding rule, over a production scan', { timeout: 90 * 60 * 1000 }, () => {
  // The scan, if the logs are not there yet.
  if (!logsOf(RUN_TAG).length) {
    const args = [
      path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
      '--dates', DATES.join(','),
      '--low-cpu',
      '--parallel', '2',
      '--run-tag', RUN_TAG,
      '--cluster-rule', RULE,
    ];
    console.log(`\n=== scanning ${DATES.join(', ')} under \`${RULE}\` ===`);
    const res = spawnSync('node', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    console.log(res.stdout || '(the batch printed nothing)');
    if (res.stderr) console.log(res.stderr);
  }

  const gt = loadQmgGroundTruth();
  const logs = logsOf(RUN_TAG);

  // Per date: the merged list, and the swallowed evidence.
  const byDate = new Map();
  for (const log of logs) {
    const date = log.date_key;
    if (!byDate.has(date)) byDate.set(date, { published: new Set(), evidence: [] });
    const row = byDate.get(date);
    for (const t of (log.merged_position_list || [])) row.published.add(String(t).toUpperCase());
    for (const cluster of (log.merged_raw_token_clusters || [])) {
      for (const e of (cluster.swallowedEvidence || [])) {
        row.evidence.push({ canonical: cluster.canonical, ...e });
      }
    }
  }

  console.log(`\n================ THE PRODUCTION SCAN UNDER \`${RULE}\` ================\n`);
  console.log('date        hits/gt  recall   FP   FP tickers          missed');
  console.log('-'.repeat(80));

  let hits = 0; let fp = 0; let gtTotal = 0;
  for (const date of [...byDate.keys()].sort()) {
    const row = byDate.get(date);
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    const h = [...row.published].filter((t) => held.has(t));
    const f = [...row.published].filter((t) => !held.has(t));
    const m = [...held].filter((t) => !row.published.has(t));
    hits += h.length; fp += f.length; gtTotal += held.size;
    const recall = held.size ? ((100 * h.length) / held.size).toFixed(1) : 'n/a';
    console.log(
      `${date}  ${String(h.length).padStart(4)}/${String(held.size).padEnd(3)}  ${String(recall).padStart(6)}%  ${String(f.length).padStart(3)}   `
      + `${(f.join(' ') || '-').padEnd(18)}  ${m.join(' ') || '-'}`
    );
    if (row.evidence.length) {
      for (const e of row.evidence) {
        console.log(`     swallowed ${e.ticker} (own frames ${e.ownFrames}) -- ${e.published ? 'PUBLISHED' : 'rejected'}`);
      }
    }
  }
  console.log('');
  if (gtTotal) {
    console.log(`TOTAL: ${hits}/${gtTotal} = ${((100 * hits) / gtTotal).toFixed(1)}% recall, ${fp} false positives`);
  }
  console.log('');

  assert.ok(byDate.size > 0, 'the scan produced logs');
});
