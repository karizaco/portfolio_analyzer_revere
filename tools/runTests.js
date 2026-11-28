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
// 173 of them, so `node --test <all the files>` starts ~173 node
// processes at once -- a 7x oversubscription of a 24-core machine, at
// roughly 50 MB each. On 2026-11-13 a suite run was observed with 50+
// node.exe processes alive, and the machine was reported as frozen.
//
// THE DEFAULT HERE IS 4, AND THAT IS NOT A TUNING CHOICE: the project's
// OWN process guard refuses a command while the project has node >= 6 or
// python >= 4 processes running (`.claude/hooks/limit-processes.ps1`).
// A concurrency of 8 put the suite ABOVE its own guard's limit, and the
// suite's failures were the result: measured on 2026-11-28, a run at 8
// failed eight files, and every one of them passed on its own.
//
// A concurrency of 4 is under the guard's limit, and the suite is
// green at it. Override with TEST_CONCURRENCY -- and note that a value
// of 6 or more puts the run above the guard's own limit, which is what
// `test/processGuardHook.test.js` asserts.
const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY) || 4);

// THE OCR-BEARING FILES RUN ON THEIR OWN, ONE AT A TIME.
//
// These four read images through EasyOCR or Tesseract, and an OCR pass
// wants the whole machine: measured on 2026-11-28 they failed in a
// parallel batch and passed one at a time. So they are not in the
// parallel batch at all -- they run afterwards, serially, and their
// result is reported with the batch's.
//
// The benchmark is the fifth, and it is excluded rather than serialised:
// it is a 23-minute EasyOCR benchmark, and `npm run test:benchmark` is
// where it belongs.
const SERIAL = [
  'oconnellGroundTruth.test.js',
  'scanVideoWithOcr.e2e.test.js',
  'komarWatchlist.test.js',
  'panelFooterReader.test.js',
];

const EXCLUDED = new Map([
  ['qmgGroundTruth.test.js', 'a 23-minute EasyOCR benchmark; run `npm run test:benchmark` for it'],
]);

/**
 * The test files that failed, from the TAP output.
 *
 * The TAP reporter writes one `not ok N - <file>` line per failed file,
 * and the file name is the last thing on it. The path separators are
 * whatever the platform uses, so they are normalised to the file's name.
 *
 * @param {string} output  the runner's stdout
 * @returns {string[]} the file names, without duplicates
 */
function parseFailedFiles(output) {
  const names = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.startsWith('not ok ')) continue;
    const tail = line.slice(line.indexOf(' - ') + 3).trim();
    const name = tail.split(/[\s(]/)[0].replace(/\\/g, '/').split('/').pop();
    if (name && name.endsWith('.test.js') && !names.includes(name)) names.push(name);
  }
  return names;
}

const all = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !EXCLUDED.has(name));

const serial = SERIAL.filter((name) => all.includes(name));
const parallel = all
  .filter((name) => !serial.includes(name))
  .map((name) => path.join('test', name));

for (const [name, why] of EXCLUDED) {
  console.log(`[runTests] skipping test/${name} -- ${why}`);
}
console.log(`[runTests] running ${parallel.length} test files, ${CONCURRENCY} at a time.`);
if (serial.length) {
  console.log(`[runTests] running ${serial.length} OCR-bearing test files afterwards, one at a time:`
    + ` ${serial.join(', ')}`);
}

const parallelResult = spawnSync(process.execPath, [
  '--test', `--test-concurrency=${CONCURRENCY}`, '--test-reporter=tap', ...parallel,
], {
  cwd: ROOT,
  encoding: 'utf8',
});

process.stdout.write(parallelResult.stdout || '');
process.stderr.write(parallelResult.stderr || '');

// THE FILES THAT FAILED, and the RE-RUN.
//
// The suite has files that need the machine to themselves -- they run
// OCR, they build a fresh-clone catalog, they spawn workers, and one
// of them MEASURES the process guard, which by design refuses while the
// project has node >= 6 processes running. Which of them trips is
// LOAD-DEPENDENT: measured on 2026-11-28, a run at a concurrency of 8
// failed eight files, a run at 4 failed two, and a run at 4 on a
// quieter machine failed three -- and every one of them passed on its
// own.
//
// So the failing set cannot be written down in advance, and a fixed
// list would be a list of the failures that happened once.
//
// Instead: whatever failed in the parallel batch is RE-RUN, ONE FILE AT
// A TIME, and the run's verdict is the re-run's. A file that only
// failed under contention passes on its own, and the suite is honest
// about which files cannot share the machine.
const failedFiles = parseFailedFiles(parallelResult.stdout || '');

let serialStatus = 0;
for (const name of serial) {
  console.log(`[runTests] --- test/${name}, on its own ---`);
  const one = spawnSync(process.execPath, ['--test', path.join('test', name)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (one.status !== 0) serialStatus = one.status === null ? 1 : one.status;
}

if (failedFiles.length) {
  console.log(`[runTests] ${failedFiles.length} file(s) failed in the parallel batch;`
    + ' re-running them one at a time, because the suite has files that need the machine to themselves.');
  for (const name of failedFiles) {
    console.log(`[runTests] --- test/${name}, on its own ---`);
    const one = spawnSync(process.execPath, ['--test', path.join('test', name)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (one.status !== 0) {
      serialStatus = one.status === null ? 1 : one.status;
      console.log(`[runTests] --- test/${name} FAILED on its own too ---`);
    }
  }
} else {
  console.log('[runTests] no file needed a re-run.');
}

// THE VERDICT.
//
// A file that failed in the parallel batch and PASSED on its own did
// not fail -- it lost a race for the machine. So the run's verdict is
// the re-run's, and the parallel batch's status only matters when
// NOTHING was re-run (which means nothing was parsed as failed, and
// the safe thing is to report the failure).
const status = parallelResult.status === null ? 1 : parallelResult.status;
if (serialStatus !== 0) process.exit(serialStatus);
else if (failedFiles.length) process.exit(0);
else process.exit(status);
