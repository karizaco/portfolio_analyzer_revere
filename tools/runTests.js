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
console.log(`[runTests] running ${files.length} test files.`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
