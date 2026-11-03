'use strict';

// Run the 2022-era scan AFTER the current one finishes.
//
// The two EasyOCR scans must NOT run at the same time: the machine's cores
// are what EasyOCR needs, and a scan competing with another scan is how the
// first attempt at this ran -- 38 minutes to reach the FIRST OCR frame, and
// then every video killed at the 40-minute timeout with no probe log at all.
//
// So this WAITS for the running scan to finish, and only then starts.
//
//   node --test test/manual/qmg2022EraScanChained.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUN_TAG = 'qmg-easyocr-20261103-era2022';
const RULE = 'corroborated';
const WAIT_FOR = 'qmg-easyocr-20261103-swallowed';

// The 2022-era dates with a ground truth and a video on disk.
const DATES = [
  '20220218', '20220222', '20220301', '20220302', '20220318', '20220321',
  '20220323', '20220330', '20220331', '20220405', '20220406', '20220412',
  '20220413', '20220414', '20220418', '20220419', '20220421', '20220425',
  '20220426', '20220427', '20220428', '20220429', '20220506', '20220510',
  '20220517', '20220606', '20220607', '20220608', '20220614', '20221104',
  '20221117', '20230126',
];

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

// Is any EasyOCR still running? On Windows the python process is the OCR
// engine and the node process is the scan tool.
function ocrRunning() {
  const res = spawnSync('tasklist', [], { encoding: 'utf8', shell: false });
  if (res.status !== 0) return false;
  const lines = res.stdout.split(/\r?\n/);
  // A python process is EasyOCR's. Count the node processes that are NOT
  // this one -- the batch runner and the scan tool are both node.
  const python = lines.filter((l) => /python\.exe/i.test(l)).length;
  return python > 0;
}

test('the 2022-era scan, chained after the swallowed scan', { timeout: 12 * 60 * 60 * 1000 }, () => {
  console.log(`\n===== THE 2022-ERA SCAN, CHAINED =====\n`);
  console.log(`waiting for ${WAIT_FOR} to finish, then scanning ${DATES.length} dates`);
  console.log('');

  // Wait for the other scan to finish. The check is bounded, so a stuck
  // scan cannot hold this one forever.
  const DEADLINE_MS = 4 * 60 * 60 * 1000;
  const started = Date.now();
  let waited = 0;
  while (ocrRunning() && Date.now() - started < DEADLINE_MS) {
    // A synchronous sleep, because this is a background job and there is
    // nothing else to do meanwhile.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { shell: false });
    waited += 15;
    if (waited % 60 === 0) {
      const done = logsOf(WAIT_FOR).length;
      console.log(`  ... ${Math.round(waited / 60)} min waited; ${WAIT_FOR} has ${done} log(s)`);
    }
  }
  console.log(`the other scan is done (waited ${waited} s; ${logsOf(WAIT_FOR).length} log(s))`);
  console.log('');

  const already = new Set(logsOf(RUN_TAG).map((l) => l.date_key));
  const wanted = DATES.filter((d) => !already.has(d));

  const CHUNK = 4;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    console.log(`--- chunk ${i / CHUNK + 1}/${Math.ceil(wanted.length / CHUNK)}: ${chunk.join(', ')} ---`);
    const args = [
      path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
      '--dates', chunk.join(','),
      '--low-cpu',
      '--parallel', '2',
      '--run-tag', RUN_TAG,
      '--cluster-rule', RULE,
    ];
    const res = spawnSync('node', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    console.log(res.stdout || '(the batch printed nothing)');
    if (res.stderr) console.log(res.stderr);
    console.log(`--- chunk exit: ${res.status} ---`);
  }

  const logs = logsOf(RUN_TAG);
  console.log(`\nlogs produced: ${logs.length} of ${DATES.length}`);
  for (const log of logs.sort((a, b) => String(a.date_key).localeCompare(String(b.date_key)))) {
    console.log(`  ${log.date_key}  ${(log.merged_position_list || []).length} holdings  (${log.cluster_rule || 'shipped'})`);
  }
  console.log('');

  assert.ok(logs.length > 0, 'the scan produced at least one log');
});
