'use strict';

// The batch runner's per-video OCR budget.
//
// 20230601 hit the batch's 40-minute kill timer on 2026-11-04 and wrote no
// probe log, so the only way to retry it with a smaller budget was to build
// the scan tool's command by hand. `--max-frames` and `--max-captures` make
// that a runner flag.
//
// No scan, no OCR, no video: these tests read the flag list the runner would
// hand to the scan tool.
//
//   node --test test/qmgBatchBudget.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { flagsForDate, parseArgs } = require(path.join(ROOT, 'tools', 'runQmgOcrBatch.js'));

function valueOf(flags, flag) {
  const i = flags.indexOf(flag);
  return i === -1 ? undefined : flags[i + 1];
}

test('the default budget is unchanged: 12 frames, 3 captures', () => {
  const flags = flagsForDate('20230601');
  assert.equal(valueOf(flags, '--prefilter-max-frames'), '12');
  assert.equal(valueOf(flags, '--max-captures'), '3');
});

test('a budget lowers the frame and capture counts, and only those', () => {
  const base = flagsForDate('20230601');
  const small = flagsForDate('20230601', 'corroborated+swallowed', { maxFrames: 6, maxCaptures: 1 });

  assert.equal(valueOf(small, '--prefilter-max-frames'), '6');
  assert.equal(valueOf(small, '--max-captures'), '1');
  assert.equal(small.length, base.length, 'no flag was added or removed');

  // Every other flag is exactly what the default run uses.
  const strip = (flags) => flags.filter((_, i) => {
    const prev = flags[i - 1];
    return prev !== '--prefilter-max-frames' && prev !== '--max-captures'
      && flags[i] !== '--prefilter-max-frames' && flags[i] !== '--max-captures';
  });
  assert.deepEqual(strip(small), strip(base));
});

test('either half of the budget can be set alone', () => {
  const framesOnly = flagsForDate('20230601', 'corroborated+swallowed', { maxFrames: 6 });
  assert.equal(valueOf(framesOnly, '--prefilter-max-frames'), '6');
  assert.equal(valueOf(framesOnly, '--max-captures'), '3');

  const capturesOnly = flagsForDate('20230601', 'corroborated+swallowed', { maxCaptures: 1 });
  assert.equal(valueOf(capturesOnly, '--prefilter-max-frames'), '12');
  assert.equal(valueOf(capturesOnly, '--max-captures'), '1');
});

test('batch snapshots stay off for the 2022 era too', () => {
  // The window around the prefilter's best frame replaced the spread, and
  // on 20220421 that was 8 OCR'd frames and 1 capture of a list that changes
  // during the video. The same flag is already off for the sidebar era.
  const flags = flagsForDate('20220421');
  assert.ok(!flags.includes('--batch-snapshots'));
  assert.ok(!flags.includes('--temporal-decay'), 'a 2022 date keeps the tool default decay');
});

test('the budget does not disturb the era flags or the cluster rule', () => {
  const small = flagsForDate('20230601', 'corroborated', { maxFrames: 6, maxCaptures: 1 });
  assert.equal(valueOf(small, '--temporal-decay'), '0', 'the 2023 sidebar era keeps its decay');
  assert.ok(small.includes('--no-cluster-swallowed-holdings'), 'the named cluster rule still applies');
  assert.ok(!small.includes('--batch-snapshots'), 'batch snapshots stay off for the sidebar era');
});

test('the CLI parses --max-frames and --max-captures', () => {
  const args = parseArgs(['--dates', '20230601', '--max-frames', '6', '--max-captures', '1']);
  assert.equal(args.maxFrames, 6);
  assert.equal(args.maxCaptures, 1);

  const none = parseArgs(['--dates', '20230601']);
  assert.equal(none.maxFrames, null, 'not mentioned is not the same as zero');
  assert.equal(none.maxCaptures, null);
});

test('a budget that is not a positive integer is a usage error, not a silent default', () => {
  for (const bad of ['0', '-2', '1.5', 'six', '']) {
    assert.throws(
      () => parseArgs(['--dates', '20230601', '--max-frames', bad]),
      /--max-frames needs a positive integer/,
      `--max-frames ${JSON.stringify(bad)} should be refused`
    );
  }
  assert.throws(
    () => parseArgs(['--dates', '20230601', '--max-captures']),
    /--max-captures needs a positive integer/
  );
});
