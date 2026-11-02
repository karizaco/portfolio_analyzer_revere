'use strict';

// The batch must DRAIN the scan tool's stdout.
//
// The scan tool prints its whole result object to stdout at the very end
// (tools/scanVideoWithOcr.js, the last statement in the `try`). That object is
// the same one the probe log holds -- hundreds of kilobytes -- and a Windows
// pipe holds about 64 KB.
//
// Before the fix, tools/runQmgOcrBatch.js drained stderr ONLY. So the child's
// final `console.log` blocked forever, AFTER the probe log was written and
// BEFORE the scan tool's `finally` block ran. The child never exited, `close`
// never fired, the batch's kill timer fired instead, and the batch recorded a
// TIMEOUT for a video that had in fact been read successfully.
//
// The mechanism is worth stating, because it is invisible from the results:
// every one of the four 2023-era production scans on 2026-11-02 was reported
// as a TIMEOUT, and every one of them had `"status": "done"` in a complete
// probe log.
//
// These tests use a FAKE child -- no OCR, no video, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const { superviseChild, STDOUT_TAIL_CHARS } = require(path.join(ROOT, 'tools', 'runQmgOcrBatch.js'));

function writeFakeChild(dir, body) {
  const file = path.join(dir, 'fake-child.js');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('a child that writes more than a pipe holds to stdout still exits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-batch-stdout-'));
  const script = writeFakeChild(dir, [
    '// Write far more than a Windows pipe holds (64 KB).',
    'const blob = "x".repeat(1024 * 512);',
    'for (let i = 0; i < 8; i++) { process.stdout.write(blob); }',
    'process.stdout.write("\\nDONE\\n");',
  ].join('\n'));

  // A generous timeout: the point is that the child EXITS on its own, so a
  // correct supervisor finishes in well under a second, and a broken one
  // would hang until the timeout and report TIMEOUT.
  const result = await superviseChild(['node', script], process.env, { timeoutMs: 20000 });

  assert.equal(result.status, 'OK', `expected OK, got ${result.status} (stderr: ${result.stderr.slice(0, 200)})`);
  assert.equal(result.code, 0);
  assert.match(result.stdoutTail, /DONE/, 'the tail of stdout should carry the child\'s last output');
});

test('the stdout tail is bounded, however much the child writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-batch-stdout-'));
  const script = writeFakeChild(dir, [
    'const blob = "y".repeat(1024 * 256);',
    'for (let i = 0; i < 12; i++) { process.stdout.write(blob); }',
    'process.stdout.write("MARKER-AT-END");',
  ].join('\n'));

  const result = await superviseChild(['node', script], process.env, { timeoutMs: 20000 });

  assert.equal(result.status, 'OK');
  assert.ok(
    result.stdoutTail.length <= STDOUT_TAIL_CHARS,
    `the tail grew to ${result.stdoutTail.length} chars, past the ${STDOUT_TAIL_CHARS} bound`
  );
  assert.match(result.stdoutTail, /MARKER-AT-END/);
});

test('a child that exceeds the timeout is reported as TIMEOUT, not OK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-batch-stdout-'));
  // Never exits on its own.
  const script = writeFakeChild(dir, 'setInterval(() => {}, 1000);');

  const result = await superviseChild(['node', script], process.env, { timeoutMs: 1500 });

  assert.equal(result.status, 'TIMEOUT');
});

test('a child that exits non-zero is reported as ERROR, with its stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-batch-stdout-'));
  const script = writeFakeChild(dir, [
    'process.stderr.write("boom: the scan failed");',
    'process.exit(3);',
  ].join('\n'));

  const result = await superviseChild(['node', script], process.env, { timeoutMs: 20000 });

  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom: the scan failed/);
});
