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
const support = require(path.join(ROOT, 'tools', 'qmg_scan_daemon_support.js'));
const { superviseChild, STDOUT_TAIL_CHARS } = support;
// The batch re-exports the shared helper, so a test that reaches it through
// the batch is exercising the SAME function the three sibling daemons use.
const batch = require(path.join(ROOT, 'tools', 'runQmgOcrBatch.js'));

/**
 * Strip comments so a file that only NAMES the scan tool in prose is not
 * mistaken for one that spawns it. Block comments go first; the `[^:]` guard
 * keeps a `//` inside a URL from swallowing the rest of the line.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

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

test('a command that cannot be spawned at all is an ERROR, not a crash', async () => {
  // The `error` event path: spawn itself fails, so `close` never fires.
  // scanAllGtVideos.js maps a null exit code to -1, so this has to be a
  // resolvable ERROR rather than an unhandled rejection.
  const result = await superviseChild(
    [path.join(os.tmpdir(), 'definitely-not-a-real-binary-4f2a91')],
    process.env,
    { timeoutMs: 5000 }
  );

  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, null);
  assert.ok(result.stderr.length > 0, 'the spawn failure should say why');
});

test('the batch re-exports the SHARED supervisor, so the two cannot drift apart', () => {
  assert.equal(batch.superviseChild, support.superviseChild);
  assert.equal(batch.STDOUT_TAIL_CHARS, support.STDOUT_TAIL_CHARS);
});

test('the batch report uses the result dateKey when scoring completed logs', () => {
  // runScan returns { dateKey, status, log }. Using r.date in the report
  // silently skipped every successful result and printed Overall 0/0, even
  // though all probe logs had completed successfully.
  const source = fs.readFileSync(
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    'utf8'
  );
  assert.match(source, /const gtEntry = gt\[r\.dateKey\]/);
  assert.match(source, /\$\{r\.dateKey\}: recall=/);
  assert.match(source, /miss=\$\{s\.missTickers/);
  assert.doesNotMatch(source, /gt\[r\.date\]/);
});


test('batch scoring handles object-form capture ground truth without counting crop coordinates', () => {
  const scoreResult = batch.scoreResult;
  const result = scoreResult(
    { merged_position_list: ['BOIL', 'X', 'JNUG'] },
    {
      '0': { tickers: ['BOIL', 'JNUG'], crop: [1766, 705, 1911, 906] },
      '1': { tickers: ['X'], crop: [1766, 705, 1911, 906] },
    }
  );
  assert.equal(result.hit, 3);
  assert.equal(result.miss, 0);
  assert.equal(result.fp, 0);
  assert.equal(result.recall, '3/3');
});


test('every tool that spawns the scan tool drains its stdout', () => {
  // The deadlock is a property of the SCAN TOOL's stdout volume, not of any
  // one consumer: the tool prints its whole result object at the end, and a
  // Windows pipe holds about 64 KB. So every tool that spawns it must either
  // drain the pipe (superviseChild does) or hand the child the parent's own
  // stdout (stdio: 'inherit' — no pipe, so no deadlock).
  //
  // This is a STATIC check, so a tool added later with a piped, undrained
  // stdout is caught before it burns a 40-minute budget per video.
  const toolsDir = path.join(ROOT, 'tools');
  const spawners = [];
  const offenders = [];

  for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js'))) {
    const code = stripComments(fs.readFileSync(path.join(toolsDir, file), 'utf8'));
    if (!code.includes('scanVideoWithOcr.js')) continue;

    spawners.push(file);
    const drains = /superviseChild\s*\(/.test(code);
    const inherits = /stdio\s*:\s*'inherit'/.test(code);
    if (!drains && !inherits) offenders.push(file);
  }

  assert.ok(
    spawners.length >= 8,
    `expected to survey the known spawners, found only ${spawners.length}: ${spawners.join(', ')}`
  );
  assert.deepEqual(
    offenders,
    [],
    `these tools spawn the scan tool without draining its stdout: ${offenders.join(', ')}`
  );
});
