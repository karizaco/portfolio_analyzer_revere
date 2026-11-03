'use strict';

// Score the EXISTING corroboration-rule production logs.
//
// The scan has already run (test/manual/clusterRuleProductionScan.test.js
// does the scanning; this file only reads what it produced). Re-running
// the scan to score it would cost another 30 minutes and change nothing,
// so this reads the logs on disk.
//
// It also compares against the SHIPPED-rule logs for the same dates, so the
// two rules are compared like for like rather than against the ground
// truth alone.
//
//   node --test test/manual/clusterRuleScoreExisting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

const RULED_RUN = 'qmg-easyocr-20261103-corroborated';
const SHIPPED_RUNS = [
  'qmg-easyocr-20261102-era-prefilter',
  'qmg-crop-20261102-smoke-v2',
  'qmg-crop-20261102-smoke',
];

function logsIn(runTag) {
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

test('the corroboration-rule production logs, scored against the shipped ones', () => {
  const gt = loadQmgGroundTruth();

  const ruled = logsIn(RULED_RUN);
  const shipped = SHIPPED_RUNS.flatMap(logsIn);

  // Per date: the merged list under each rule. A date can have several
  // logs, and the ground truth is the union over its captures -- so the
  // lists are POOLED across a date's logs, exactly as the replay tool
  // pools them.
  const byDate = (logs) => {
    const map = new Map();
    for (const log of logs) {
      const date = log.date_key;
      if (!date) continue;
      if (!map.has(date)) map.set(date, new Set());
      for (const t of (log.merged_position_list || [])) {
        map.get(date).add(String(t).toUpperCase());
      }
    }
    return map;
  };

  const ruledByDate = byDate(ruled);
  const shippedByDate = byDate(shipped);

  console.log(`\n=========== THE PRODUCTION SCAN UNDER \`corroborated\` ===========\n`);
  console.log('date        rule        hits/gt  recall   FP   FP tickers          missed');
  console.log('-'.repeat(88));

  let rHits = 0; let rFp = 0; let rGt = 0;
  let sHits = 0; let sFp = 0; let sGt = 0;
  const rows = [];

  for (const date of [...ruledByDate.keys()].sort()) {
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    const rp = ruledByDate.get(date);
    const sp = shippedByDate.get(date) || new Set();

    const rh = [...rp].filter((t) => held.has(t));
    const rf = [...rp].filter((t) => !held.has(t));
    const rm = [...held].filter((t) => !rp.has(t));
    const sh = [...sp].filter((t) => held.has(t));
    const sf = [...sp].filter((t) => !held.has(t));

    rHits += rh.length; rFp += rf.length; rGt += held.size;
    sHits += sh.length; sFp += sf.length; sGt += held.size;

    const recall = held.size ? ((100 * rh.length) / held.size).toFixed(1) : 'n/a';
    console.log(
      `${date}  ruled    ${String(rh.length).padStart(4)}/${String(held.size).padEnd(3)}  ${String(recall).padStart(6)}%  ${String(rf.length).padStart(3)}   `
      + `${(rf.join(' ') || '-').padEnd(18)}  ${rm.join(' ') || '-'}`
    );
    if (sp.size) {
      const srecall = held.size ? ((100 * sh.length) / held.size).toFixed(1) : 'n/a';
      console.log(
        `${' '.repeat(11)}shipped  ${String(sh.length).padStart(4)}/${String(held.size).padEnd(3)}  ${String(srecall).padStart(6)}%  ${String(sf.length).padStart(3)}   `
        + `${(sf.join(' ') || '-').padEnd(18)}  ${[...held].filter((t) => !sp.has(t)).join(' ') || '-'}`
      );
    }
    rows.push({ date, rh: rh.length, gt: held.size, rf, rm, sh: sh.length, sf, hasShipped: sp.size > 0 });
  }

  console.log('');
  if (rGt) {
    console.log(`RULELED   : ${rHits}/${rGt} = ${((100 * rHits) / rGt).toFixed(1)}% recall, ${rFp} FP`);
    if (sGt) {
      console.log(`SHIPPED   : ${sHits}/${sGt} = ${((100 * sHits) / sGt).toFixed(1)}% recall, ${sFp} FP`);
    }
  }
  console.log('');

  // The rule must not lose a holding the shipped rule published.
  const lost = rows.filter((r) => r.hasShipped && r.sh > r.rh);
  assert.deepEqual(lost.map((r) => r.date), [],
    'the rule must not lose a holding the shipped rule published');
});
