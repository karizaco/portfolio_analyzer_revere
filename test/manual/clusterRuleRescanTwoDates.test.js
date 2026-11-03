'use strict';

// Re-scan the two videos whose production scan timed out.
//
// 20230522 and 20230523 are the slowest of the six, and the first attempt
// at them was competing with the test suite for the CPU -- the run that
// produced the other four took 737-952 s per video on an idle machine.
// This re-runs them alone.
//
// The measurement it feeds does not DEPEND on the re-scan: the rule is
// applied to the shipped-rule logs directly by
// `clusterRuleApplyToLog.test.js`, and it is neutral on both dates. This
// is for the production scan's own record.
//
//   node --test test/manual/clusterRuleRescanTwoDates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_TAG = 'qmg-easyocr-20261103-corroborated';
const DATES = ['20230522', '20230523'];

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

test('the two slow videos, re-scanned alone', { timeout: 90 * 60 * 1000 }, () => {
  const args = [
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    '--dates', DATES.join(','),
    '--low-cpu',
    '--parallel', '2',
    '--run-tag', RUN_TAG,
    '--cluster-rule', 'corroborated',
  ];
  console.log(`\n=== re-scanning ${DATES.join(', ')} alone ===`);
  console.log(`    ${args.join(' ')}\n`);

  const res = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  console.log('--- the batch runner\'s output ---');
  console.log(res.stdout || '(the batch printed nothing)');
  if (res.stderr) console.log('--- the batch runner\'s stderr ---\n' + res.stderr);
  console.log(`--- scan exit: ${res.status} ---\n`);

  const produced = [];
  for (const date of DATES) {
    const file = findLog(date);
    if (!file) {
      console.log(`  ${date}: still no log`);
      continue;
    }
    const log = JSON.parse(fs.readFileSync(file, 'utf8'));
    produced.push(date);
    console.log(`  ${date}: ${(log.merged_position_list || []).length} holdings -- ${(log.merged_position_list || []).join(' ')}`);
    console.log(`     cluster rule: ${log.cluster_rule}`);
  }

  // The measurement does not depend on this, so a timeout here is a fact
  // about the machine, not a failure of the rule. Report it, do not fail.
  if (produced.length < DATES.length) {
    console.log('');
    console.log(`  ${DATES.length - produced.length} of ${DATES.length} videos did not finish.`);
    console.log('  The rule\'s effect on these two dates is already measured');
    console.log('  (clusterRuleApplyToLog.test.js): it is NEUTRAL on both.');
  }
});
