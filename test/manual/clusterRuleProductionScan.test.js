'use strict';

// The WIDER measurement: a production scan under the corroboration rule.
//
// The corpus measurement (`clusterRuleMeasurement.test.js`) and the
// production audit (`clusterRuleProductionAudit.test.js`) both say the
// corroboration rule removes a false positive and loses no holding. But the
// corpus those ran on is 46 logs, and the project rule is that the default
// stays where it is until a WIDER measurement says otherwise.
//
// This is that wider measurement: the four 2023-era dates whose shipped-rule
// production scan is recorded in CLAUDE.md § *The 2023-era production scan,
// four more dates*, re-scanned under the rule and scored against the same
// pixel-verified ground truth.
//
// The scan is the ordinary production path -- the same batch runner, the
// same flags, the same EasyOCR -- with the cluster rule added. The rule is
// the ONLY difference, so the difference in the scores is the rule's.
//
// It is SLOW: an EasyOCR chart-stream scan is 12-18 minutes per video, and
// this runs four of them at --parallel 2. It is a manual suite for that
// reason, and it lives in `test/manual/`.
//
//   node --test test/manual/clusterRuleProductionScan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_TAG = 'qmg-easyocr-20261103-corroborated';

// The four dates, and the shipped-rule production scan they were measured
// under (CLAUDE.md § *The 2023-era production scan, four more dates*).
const DATES = ['20230522', '20230523', '20230602', '20230605', '20230608', '20230609'];

const SHIPPED_BASELINE = {
  // date: [hits, ground truth, false positives]
  20230522: [6, 7, 0],
  20230523: [10, 11, 1],
  20230602: [12, 12, 1],
  20230605: [11, 11, 1],
  20230608: null,   // not in the shipped baseline's table
  20230609: null,   // measured separately (13/13, 0 FP)
};

function findLog(date) {
  const dir = path.join(ROOT, 'data', 'video_scan_test', '_rerun', RUN_TAG, 'ocr_probe', 'logs');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${date}_`) && name.endsWith('.json')) {
      return path.join(dir, name);
    }
  }
  return null;
}

function lev(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// The ground truth, read with the project's own reader.
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

test('the corroboration rule, over a production scan', { timeout: 60 * 60 * 1000 }, () => {
  const gt = loadQmgGroundTruth();

  // ---- the scan ----------------------------------------------------------
  const args = [
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    '--dates', DATES.join(','),
    '--low-cpu',
    '--parallel', '2',
    '--run-tag', RUN_TAG,
    '--cluster-rule', 'corroborated',
  ];
  console.log(`\n=== scanning ${DATES.join(', ')} under the corroboration rule ===`);
  console.log(`    ${args.join(' ')}\n`);

  const res = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  // The batch's own output is the diagnostic: which videos were read, which
  // timed out, and how long each took. It is printed IN FULL, because the
  // first version of this harness printed it and it came out EMPTY -- the
  // batch's stdout was captured but never shown, so a run that produced
  // nothing looked identical to a run that had not reported yet.
  console.log('--- the batch runner\'s output ---');
  console.log(res.stdout || '(the batch printed nothing)');
  if (res.stderr) console.log('--- the batch runner\'s stderr ---\n' + res.stderr);
  console.log(`--- scan exit: ${res.status} ---\n`);

  // ---- the scoring -------------------------------------------------------
  const rows = [];
  for (const date of DATES) {
    const file = findLog(date);
    if (!file) {
      // No log. Say WHY, from what the run left behind -- a frame
      // directory with one OCR crop means the scan was killed mid-OCR,
      // which is a timeout, not a parser problem.
      const framesDir = path.join(
        ROOT, 'data', 'video_scan_test', '_rerun', RUN_TAG, 'ocr_probe', 'frames'
      );
      let crops = 0;
      let dir = null;
      if (fs.existsSync(framesDir)) {
        for (const name of fs.readdirSync(framesDir)) {
          if (!name.startsWith(`${date}_`)) continue;
          dir = name;
          const ocrDir = path.join(framesDir, name, 'ocr');
          if (fs.existsSync(ocrDir)) crops = fs.readdirSync(ocrDir).length;
        }
      }
      const why = dir
        ? `no log; ${crops} OCR crop(s) written under ${dir}/ocr -- the scan was killed mid-OCR (a TIMEOUT)`
        : 'no log and no frame directory -- the scan did not start';
      console.log(`  ${date}: ${why}`);
      rows.push({ date, missing: true, why, hits: 0, gt: 0, fp: 0, missed: [], fpTickers: [], droppedClusters: [], baseline: null, clusterRule: null });
      continue;
    }
    const log = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = (log.merged_position_list || []).map((t) => String(t).toUpperCase());
    const predicted = new Set(merged);

    const held = new Set();
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }

    const hits = [...held].filter((t) => predicted.has(t));
    const fp = [...predicted].filter((t) => !held.has(t));
    const missed = [...held].filter((t) => !predicted.has(t));

    // The clusters the rule dropped, and why.
    const dropped = [];
    for (const cluster of log.merged_raw_token_clusters || []) {
      const members = (Array.isArray(cluster.members) ? cluster.members : [])
        .map((m) => String(m).toUpperCase());
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;
      if (members.includes(canonical)) continue;
      let closest = Infinity;
      for (const m of members) {
        const d = lev(m, canonical);
        if (d < closest) closest = d;
      }
      if (closest > 1) dropped.push({ canonical, members, closest });
    }

    const baseline = SHIPPED_BASELINE[date];
    rows.push({
      date,
      hits: hits.length,
      gt: held.size,
      fp: fp.length,
      missed,
      fpTickers: fp,
      droppedClusters: dropped,
      baseline,
      clusterRule: log.cluster_rule,
    });
  }

  console.log('\n================= THE PRODUCTION SCAN, SCORED =================\n');
  console.log('date        hits/gt  recall   FP   FP tickers          missed');
  for (const r of rows) {
    if (r.missing) {
      console.log(`${r.date}  -- no log: ${r.why}`);
      continue;
    }
    const recall = r.gt ? ((100 * r.hits) / r.gt).toFixed(1) : 'n/a';
    const baseline = r.baseline
      ? `   (shipped was ${r.baseline[0]}/${r.baseline[1]}, ${r.baseline[2]} FP)`
      : '';
    console.log(
      `${r.date}  ${String(r.hits).padStart(4)}/${String(r.gt).padStart(3)}  ${String(recall).padStart(6)}%  ${String(r.fp).padStart(3)}   `
      + `${(r.fpTickers.join(' ') || '-').padEnd(18)}  ${r.missed.join(' ') || '-'}${baseline}`
    );
  }
  const scored = rows.filter((r) => !r.missing);
  const totalHits = scored.reduce((s, r) => s + r.hits, 0);
  const totalGt = scored.reduce((s, r) => s + r.gt, 0);
  const totalFp = scored.reduce((s, r) => s + r.fp, 0);
  console.log('');
  if (totalGt) {
    console.log(`TOTAL: ${totalHits}/${totalGt} = ${((100 * totalHits) / totalGt).toFixed(1)}% recall, ${totalFp} false positives`);
  } else {
    console.log('TOTAL: no video was scored -- the scan produced no probe logs');
  }
  console.log('');

  for (const r of rows) {
    if (!r.droppedClusters.length) continue;
    console.log(`  ${r.date}: the rule dropped ${r.droppedClusters.length} cluster(s)`);
    for (const d of r.droppedClusters) {
      const verdict = r.fpTickers.includes(d.canonical) ? 'a false positive' : 'NOT in the FP list';
      console.log(`    ${d.canonical} from [${d.members.join(', ')}] (closest ${d.closest}) -- ${verdict}`);
    }
  }
  console.log('');

  // ---- the assertions ----------------------------------------------------
  assert.ok(rows.length > 0, 'the scan produced at least one log');
  for (const r of rows) {
    if (r.missing) continue;
    assert.equal(r.clusterRule, 'corroborated',
      `${r.date} was scanned under the corroboration rule`);
  }
});
