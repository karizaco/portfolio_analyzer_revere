'use strict';

// Launches the Qullamaggie rescan for the dates that the earlier run lost,
// and WAITS for it.
//
// The earlier attempt spawned the batch `detached: true` and returned at once.
// That opened a console window on the user's desktop, and when the launcher
// exited the console closed and every scan child died with 0xC000013A
// (STATUS_CONTROL_C_EXIT). Two lessons, both encoded here:
//
//   1. Do NOT detach. A Windows detached child gets its own console window.
//   2. Do NOT return early. The console closing is what kills the children.
//
// So this awaits the child's exit, and the caller runs it in the background.
//
//   node --test test/manual/qmgLaunchRescan.test.js
//
// It is a launcher, not a test: it asserts only that the child started.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG = 'C:/tmp/qmg_resume2.log';
const RUN_TAG = 'qmg-easyocr-20261106-aliases-resume2';
const DATES = process.env.QMG_RESCAN_DATES || '20220608,20220413,20230522,20231215';

test('the rescan runs to completion', { timeout: 0 }, async () => {
  fs.mkdirSync('C:/tmp', { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn('node', [
    'tools/runQmgOcrBatch.js',
    '--dates', DATES,
    '--low-cpu',
    '--parallel', '2',
    '--timeout-minutes', '90',
    '--run-tag', RUN_TAG,
  ], {
    cwd: ROOT,
    // No GPU: the low-CPU rule already caps the thread pools, and CUDA on a
    // busy machine is what makes the whole box unresponsive.
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
    stdio: ['ignore', out, out],
  });
  console.log(`\nlaunched pid ${child.pid} -> ${LOG}`);
  console.log(`dates ${DATES} | run tag ${RUN_TAG}`);
  assert.ok(child.pid > 0, 'the child was started');

  const code = await new Promise((resolve) => child.on('close', resolve));
  console.log(`the batch finished with code ${code}`);
  assert.equal(code, 0, `the batch exited ${code}; see ${LOG}`);
});
