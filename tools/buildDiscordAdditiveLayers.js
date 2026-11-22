'use strict';

/**
 * One-shot additive rebuild for improvements 1–5 (does not rebuild core Discord tables).
 *
 *   node tools/buildDiscordAdditiveLayers.js
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const steps = [
  'buildDiscordAttachmentHints.js',
  'buildClementFocusEpisodes.js',
  'buildRegimeBookJoin.js',
  'buildTraderExposures.js', // last so it can project focus episodes
];

function run(script) {
  console.error(`[additive] ${script}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`${script} exited ${r.status}`);
  }
}

for (const s of steps) run(s);
console.error('[additive] done');
