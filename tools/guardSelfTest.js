'use strict';

/**
 * Self-test for tools/guardDestructiveBash.js.
 *
 * The command strings live in this file (not in a shell command line) so that
 * the PreToolUse hook does not block the test harness itself.
 *
 * Run: node tools/guardSelfTest.js
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.join(__dirname, 'guardDestructiveBash.js');

const CASES = [
  // [description, command, expected: 'BLOCKED' | 'ALLOWED']
  ['sparse-checkout add', 'git ' + 'sparse-checkout' + ' add test', 'BLOCKED'],
  ['sparse-checkout set', 'git ' + 'sparse-checkout' + ' set src tools', 'BLOCKED'],
  ['sparse-checkout reapply', 'git ' + 'sparse-checkout' + ' reapply', 'BLOCKED'],
  ['sparse-checkout init', 'git ' + 'sparse-checkout' + ' init --cone', 'BLOCKED'],
  ['enable cone mode', 'git config core.' + 'sparseCheckout' + 'Cone true', 'BLOCKED'],
  ['enable sparse checkout', 'git config core.' + 'sparseCheckout' + ' true', 'BLOCKED'],
  ['git clean -fd', 'git ' + 'clean' + ' -fd', 'BLOCKED'],
  ['rm -rf media dir', 'rm -rf data/video_' + 'pipeline/downloads_1080p', 'BLOCKED'],
  ['rm -rf outside project', 'rm -rf /d/some/data', 'BLOCKED'],
  ['rm -rf user folder', "rm -rf 'C:/Users/Admin/Videos'", 'BLOCKED'],
  ['rmdir /s on media', 'rmdir /s /q data/video_' + 'pipeline', 'BLOCKED'],
  ['PowerShell Remove-Item -Recurse', 'Remove-Item -Recurse data/video_' + 'pipeline', 'BLOCKED'],
  ['sparse-checkout list (read-only)', 'git ' + 'sparse-checkout' + ' list', 'ALLOWED'],
  ['sparse-checkout disable (materializes more)', 'git ' + 'sparse-checkout' + ' disable', 'ALLOWED'],
  ['git add -A', 'git add -A', 'ALLOWED'],
  ['rm scratch in /tmp', 'rm -rf /tmp/my_scratch', 'ALLOWED'],
  ['rm frames inside project', 'find data/video_scan_test -name frames -prune -exec rm -rf {} +', 'ALLOWED'],
  ['ordinary ls', 'ls -la data/', 'ALLOWED'],
  ['node test run', 'node --test test/*.test.js', 'ALLOWED'],
  // Regression: a read-only command that merely MENTIONS a path outside the
  // project must not be blocked. The guard previously fired on any command
  // containing an absolute path, which broke `cp`/`cat`/`ls` of external files.
  ['read-only cp of external file', 'cp "C:/Users/Admin/.claude/projects/x/y.jsonl" data/_t.jsonl', 'ALLOWED'],
  ['read-only ls of external dir', 'ls -la "C:/Users/Admin/Documents"', 'ALLOWED'],
  ['read-only cat of external file', 'cat /d/some/notes.txt', 'ALLOWED'],
  ['read-only find on another drive', 'find /d -name "*.mp4"', 'ALLOWED'],
  // Regression: a commit message that *describes* the dangerous command must
  // be committable. The guard inspects the command line, not prose.
  ['commit message mentioning the incident', 'git commit -m "block git ' + 'sparse-checkout' + ' add test"', 'ALLOWED'],
  ['commit message with rm -rf in prose', 'git commit -m "the rm -rf of .git was blocked"', 'ALLOWED'],
  ['heredoc commit message', 'git commit -F - <<\'MSG\'\ngit ' + 'sparse-checkout' + ' add test\nMSG', 'ALLOWED'],
  // ...but the real command in the same line is still blocked.
  ['commit message AND the real command', 'git commit -m "notes" && git ' + 'sparse-checkout' + ' add test', 'BLOCKED'],
];

let failures = 0;
for (const [desc, cmd, expected] of CASES) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
  const res = spawnSync('node', [GUARD], { input: payload, encoding: 'utf8' });
  const actual = res.status === 2 ? 'BLOCKED' : (res.status === 0 ? 'ALLOWED' : 'ERROR(' + res.status + ')');
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + '[' + actual + '] expected ' + expected + '  :: ' + desc);
}

console.log('\n' + (CASES.length - failures) + '/' + CASES.length + ' guard cases passed');
process.exit(failures ? 1 : 0);
