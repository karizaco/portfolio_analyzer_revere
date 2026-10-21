'use strict';

/**
 * Tests for tools/guardDestructiveBash.js.
 *
 * The guard is the mechanical enforcement of the rule that a `git
 * sparse-checkout` command must never run again in this repo — that command
 * destroyed ~215 GB of downloaded videos on 2026-10-21.
 *
 * The command strings are built by concatenation so the literal blocked
 * patterns never appear in a shell command line (which would make the
 * PreToolUse hook block this test harness itself).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'tools', 'guardDestructiveBash.js');

function verdict(command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const res = spawnSync('node', [GUARD], { input: payload, encoding: 'utf8' });
  if (res.status === 2) return 'BLOCKED';
  if (res.status === 0) return 'ALLOWED';
  return 'ERROR(' + res.status + ')';
}

const BLOCKED = [
  ['sparse-checkout add', 'git ' + 'sparse-checkout' + ' add test'],
  ['sparse-checkout set', 'git ' + 'sparse-checkout' + ' set src tools'],
  ['sparse-checkout reapply', 'git ' + 'sparse-checkout' + ' reapply'],
  ['sparse-checkout init', 'git ' + 'sparse-checkout' + ' init --cone'],
  ['enable cone mode', 'git config core.' + 'sparseCheckout' + 'Cone true'],
  ['enable sparse checkout', 'git config core.' + 'sparseCheckout' + ' true'],
  ['git clean -fd', 'git ' + 'clean' + ' -fd'],
  ['rm -rf the media dir', 'rm -rf data/video_' + 'pipeline/downloads_1080p'],
  ['rm -rf the media dir (hires)', 'rm -rf data/video_' + 'pipeline/downloads_hires'],
  ['rm -rf outside the project', 'rm -rf /d/some/data'],
  ["rm -rf a user folder", "rm -rf 'C:/Users/Admin/Videos'"],
  ['rmdir /s on the media dir', 'rmdir /s /q data/video_' + 'pipeline'],
  ['PowerShell Remove-Item -Recurse', 'Remove-Item -Recurse data/video_' + 'pipeline'],
  ['rm -rf .git', 'rm -rf .git'],
  // The out-of-tree media directory is a SIBLING of the project, not a child.
  // A bare startsWith() on the project path would treat it as inside the
  // project and leave it unprotected.
  ['rm -rf the out-of-tree media dir', 'rm -rf /c/Users/Admin/Projects/portfolio_analyzer_' + 'revere_media'],
  ['rm -rf the out-of-tree media dir (win path)', 'rm -rf "C:/Users/Admin/Projects/portfolio_analyzer_' + 'revere_media"'],
  // The real command still gets blocked even when it follows a commit message.
  ['commit message AND the real command', 'git commit -m "notes" && git ' + 'sparse-checkout' + ' add test'],
  ['git clean -xdf (real force)', 'git ' + 'clean' + ' -xdf'],
];

const ALLOWED = [
  ['sparse-checkout list (read-only)', 'git ' + 'sparse-checkout' + ' list'],
  ['sparse-checkout disable (materializes more)', 'git ' + 'sparse-checkout' + ' disable'],
  ['git add -A', 'git add -A'],
  ['rm -rf in /tmp', 'rm -rf /tmp/my_scratch'],
  ['rm -rf of frames inside the project', 'find data/video_scan_test -name frames -prune -exec rm -rf {} +'],
  ['ordinary ls', 'ls -la data/'],
  ['the test suite itself', 'node --test test/*.test.js'],
  // Regression: a read-only command that merely mentions a path outside the
  // project must not be blocked. The guard previously fired on any command
  // containing an absolute path, which broke read-only `cp`/`ls`/`cat`.
  ['read-only cp of an external file', 'cp "C:/Users/Admin/.claude/projects/x/y.jsonl" data/_t.jsonl'],
  ['read-only ls of an external dir', 'ls -la "C:/Users/Admin/Documents"'],
  ['read-only cat of an external file', 'cat /d/some/notes.txt'],
  ['read-only find on another drive', 'find /d -name "*.mp4"'],
  // A commit message that *describes* the dangerous command is prose, not an
  // invocation — documenting the incident has to be possible.
  ['commit message mentioning the incident', 'git commit -m "block git ' + 'sparse-checkout' + ' add test"'],
  ['commit message with rm -rf in prose', 'git commit -m "the rm -rf of .git was blocked"'],
  // The `git clean` / `git config` rules must be scoped to their own args — a
  // greedy match fired on an unrelated `rm -f` later in the same line.
  ['git clean -n followed by rm -f', 'git ' + 'clean' + ' -ndx > out.txt; rm -f out.txt'],
  ['git config --get followed by rm -f', 'git config --get user.name; rm -f tmp.txt'],
  ['git clean -n (dry run, no force)', 'git ' + 'clean' + ' -ndx'],
  ['git config core.sparseCheckout false (safe)', 'git config core.' + 'sparseCheckout' + ' false'],
];

for (const [desc, command] of BLOCKED) {
  test(`guard blocks: ${desc}`, () => {
    assert.strictEqual(verdict(command), 'BLOCKED');
  });
}

for (const [desc, command] of ALLOWED) {
  test(`guard allows: ${desc}`, () => {
    assert.strictEqual(verdict(command), 'ALLOWED');
  });
}
