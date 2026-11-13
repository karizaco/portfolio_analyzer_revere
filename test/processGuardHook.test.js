'use strict';

// The process-count guard (`.claude/hooks/limit-processes.ps1`) has to be
// TESTED, because the first version of it was broken in a way that made
// it a silent no-op for a week.
//
// The first version was one long `powershell -NoProfile -Command "..."`
// string in .claude/settings.json. The harness runs a hook command
// through the shell, so bash expanded `$inc`, `$_`, `$a`, `$p` and `$t`
// to empty strings before PowerShell saw them. The script then failed to
// parse, exited 1 instead of 2 -- and a hook that exits with anything
// other than 2 is a NON-BLOCKING error in Claude Code.
//
// So the rule was in the repository the whole time, and it did nothing.
// The second version is a file, and it had a second bug of its own:
// `$input` is a RESERVED PowerShell automatic variable, so reading the
// hook's input into it silently produced nothing.
//
// These tests drive the script the way the harness does and assert the
// exit codes, because the exit code IS the behaviour: 2 blocks, and
// anything else does not.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, '.claude', 'hooks', 'limit-processes.ps1');

/**
 * Run the hook the way the harness does: the tool input arrives on
 * stdin as JSON, and the exit code decides everything.
 *
 * @param {string} command
 * @returns {{status: number, stderr: string}}
 */
function runHook(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const result = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK,
  ], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr || '' };
}

test('the hook script exists and is wired into the settings', () => {
  assert.ok(fs.existsSync(HOOK), '.claude/hooks/limit-processes.ps1 exists');
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const hooks = settings.hooks?.PreToolUse || [];
  const command = hooks[0]?.hooks?.[0]?.command || '';
  assert.match(command, /limit-processes\.ps1/,
    'the hook runs the script, not an inline command');
  assert.doesNotMatch(command, /-Command\s+"/,
    'an inline -Command is what the shell mangled');
});

test('`npm test` is BLOCKED, because it starts a process per test file', () => {
  for (const command of [
    'npm test',
    'npm test 2>&1 | grep -E "pass|fail"',
    'npm run test',
    'npm run test:all',
  ]) {
    const { status, stderr } = runHook(command);
    assert.equal(status, 2, `"${command}" must be blocked (exit 2)`);
    assert.match(stderr, /BLOCKED/);
  }
});

test('the benchmark is ALLOWED -- it is one file, so one process', () => {
  const { status } = runHook('npm run test:benchmark');
  assert.equal(status, 0, 'the benchmark is slow, not wide');
});

test('an ordinary command is allowed', () => {
  for (const command of [
    'node tools/runTests.js',
    'git status --short',
    'py -3 tools/whiteboard_worker.py catalog --channel benzinga',
    'npm run asym:catalog:dry',
  ]) {
    const { status } = runHook(command);
    assert.equal(status, 0, `"${command}" must be allowed`);
  }
});

test('the hook reads its input from stdin, so it sees the command', () => {
  // The bug that cost a week: the input has to reach the script, and
  // `$input` is not a variable name it can use to read it.
  const { status, stderr } = runHook('npm test');
  assert.equal(status, 2);
  assert.match(stderr, /npm test/,
    'the message names the command it refused');
});

test('the cleanup commands are always allowed', () => {
  // A guard that blocks the command that fixes the situation it complains
  // about is a deadlock: its own message says "kill the orphans" and then
  // refuses the kill.
  for (const command of [
    'taskkill //IM node.exe //F',
    'tasklist //FI "IMAGENAME eq node.exe" //FO CSV',
    "powershell -NoProfile -Command \"Stop-Process -Name node\"",
  ]) {
    const { status } = runHook(command);
    assert.equal(status, 0, `"${command}" must be allowed`);
  }
});

test('the count branch blocks when the project already has too many processes', () => {
  // The branch that fires while OTHER work is running. The processes are
  // started detached so they outlive this test's own shell, and they are
  // killed at the end whether the assertion passed or not.
  const children = [];
  for (let i = 0; i < 6; i += 1) {
    children.push(spawn('node', ['-e', 'setTimeout(()=>{},20000)'], {
      cwd: ROOT,
      detached: false,
      stdio: 'ignore',
    }));
  }
  try {
    // Give the OS a moment to register them.
    const deadline = Date.now() + 10000;
    let count = 0;
    while (Date.now() < deadline) {
      const result = spawnSync('powershell', [
        '-NoProfile', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\").Count",
      ], { encoding: 'utf8' });
      count = Number((result.stdout || '').trim()) || 0;
      if (count >= 6) break;
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
    }
    assert.ok(count >= 6, `expected at least 6 live node processes, saw ${count}`);

    const { status, stderr } = runHook('git status --short');
    assert.equal(status, 2, 'an ordinary command is blocked while the project is busy');
    assert.match(stderr, /process-count guard/);
  } finally {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
});

test('the script never uses a reserved automatic variable for its input', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(source, /\$input\s*=/,
    '`$input` is a reserved PowerShell automatic variable');
});
