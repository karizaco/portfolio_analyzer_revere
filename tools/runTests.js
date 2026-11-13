'use strict';

// The test suite, minus the OCR benchmark.
//
// `test/qmgGroundTruth.test.js` is a 23-minute EasyOCR benchmark. node's test
// runner executes the test FILES in parallel, so running it alongside the rest
// of the suite starves both: the benchmark fails on a machine that is busy,
// and the rest of the suite waits 23 minutes for it.
//
// This runs everything else, which takes under two minutes, and leaves the
// benchmark to `npm run test:benchmark`. `npm run test:all` still runs
// everything, benchmark included.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

// THE TEST FILES RUN IN PARALLEL, AND THAT IS A MACHINE PROBLEM.
//
// node's test runner runs one PROCESS per test file. This repository has
// 98 of them, so `node --test <all the files>` starts ~98 node processes
// at once -- a 4x oversubscription of a 24-core machine, at roughly
// 50 MB each. On 2026-11-13 a suite run was observed with 50+ node.exe
// processes alive, and the machine was reported as frozen.
//
// The default here is 8: a third of the cores, so the suite leaves room
// for the rest of the work (an OCR scan, a transcript fetch) rather than
// starving it. Override with TEST_CONCURRENCY.
const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY) || 8);

// The benchmark, and why it is not in the default run.
const EXCLUDED = new Map([
  ['qmgGroundTruth.test.js', 'a 23-minute EasyOCR benchmark; run `npm run test:benchmark` for it'],
]);

const files = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !EXCLUDED.has(name))
  .map((name) => path.join('test', name));

for (const [name, why] of EXCLUDED) {
  console.log(`[runTests] skipping test/${name} -- ${why}`);
}
console.log(`[runTests] running ${files.length} test files, ${CONCURRENCY} at a time.`);

const result = spawnSync(process.execPath, [
  '--test', `--test-concurrency=${CONCURRENCY}`, ...files,
], {
  cwd: ROOT,
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
