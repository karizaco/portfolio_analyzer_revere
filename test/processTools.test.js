'use strict';

// Two rules that were learned the hard way on 2026-11-13, and that must
// hold for every session from now on.
//
// 1. "KILL THE NODE PROCESSES" MEANS node.exe AND NOTHING ELSE. Python
//    runs the MCP servers this session's tools depend on, and it runs
//    yt-dlp, which is what the download and metadata jobs are made of.
//    Killing it by accident is not a recoverable nuisance.
//
// 2. A MEASUREMENT MUST NOT BE ABLE TO COUNT ITSELF. A measurement
//    reported "5 yt-dlp processes" once; there were none. The command
//    that counted them matched its OWN command line, because the pattern
//    'yt_dlp' appeared inside the measurement command.
//
// Both are enforced by tools, not by memory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const KILL = path.join(ROOT, 'tools', 'killNodeProcesses.ps1');
const CENSUS = path.join(ROOT, 'tools', 'processCensus.ps1');

function run(script, args = []) {
  const result = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
  ], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Is a process with this PID alive? */
function alive(pid) {
  const result = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue) -ne $null`,
  ], { encoding: 'utf8' });
  return String(result.stdout || '').trim().toLowerCase() === 'true';
}

test('the kill helper kills node.exe and LEAVES PYTHON ALONE', () => {
  // A node process and a python process, started detached so they
  // outlive this test's own shell.
  const node = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { cwd: ROOT, stdio: 'ignore' });
  const python = spawn('python', ['-c', 'import time; time.sleep(30)'], { cwd: ROOT, stdio: 'ignore' });
  try {
    // Give the OS a moment to register them.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !(alive(node.pid) && alive(python.pid))) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
    }
    assert.ok(alive(node.pid), 'the node process is running');
    assert.ok(alive(python.pid), 'the python process is running');

    const result = run(KILL);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /target: node\.exe only/,
      'the helper says what it targets');

    // Give the kill a moment to land.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);

    assert.equal(alive(node.pid), false, 'the node process was killed');
    assert.equal(alive(python.pid), true,
      'THE PYTHON PROCESS MUST SURVIVE -- that is the whole rule');
  } finally {
    for (const child of [node, python]) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
});

test('the kill helper accepts exactly one target, and it is node', () => {
  const source = fs.readFileSync(KILL, 'utf8');
  assert.match(source, /ValidateSet\('node'\)/,
    'the target is a closed set, so a typo cannot widen the blast radius');
  assert.doesNotMatch(source, /\/IM\s+python/i,
    'the script never names python as a kill target');
  // The actual kill invocation must not carry /T (kill the tree). The
  // prose may mention /T -- the comment explains why it is NOT used.
  assert.doesNotMatch(source, /taskkill[^\n]*\/T\b/i,
    'no tree kill: a node worker owns python children (yt-dlp)');
  // And it must protect its own process tree.
  assert.match(source, /Get-SelfTreeIds/,
    'the helper never kills its caller or the tree above it');
});

test('the census excludes its own process tree', () => {
  // The pattern that fooled me: 'yt_dlp' inside the measurement command.
  const result = run(CENSUS, ['-Filter', 'yt.dlp']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /excluded: this measurement's own process tree/);
  // The count must not include the measuring processes.
  const excluded = Number(/(\d+) excluded/.exec(result.stdout)?.[1] || 0);
  assert.ok(excluded > 0, 'the measurement excluded at least its own process');
});

test('the census does not count itself when the pattern matches its own command', () => {
  // The honest test of the rule: a pattern that appears in the
  // measurement's own command line must still report zero.
  const result = run(CENSUS, ['-Filter', 'processCensus']);
  const matched = Number(/(\d+) process\(es\) match/.exec(result.stdout)?.[1] || 0);
  assert.equal(matched, 0,
    'the census cannot see itself, even when the pattern names it');
});
