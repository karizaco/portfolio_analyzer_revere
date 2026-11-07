'use strict';

// The tracked catalog must stay SMALL, and this file is what keeps it that way.
//
// WHY THIS EXISTS
//
// `data/video_pipeline/state.sqlite` is the catalog and it is tracked. On
// 2026-11-06 it was 136 MB and `git push` was being refused outright:
//
//   remote: error: File data/video_pipeline/state.sqlite is 136.06 MB;
//            this exceeds GitHub's file size limit of 100.00 MB
//
// The growth was one table. `transcript_segments` -- 698,450 rows for the
// Sevcik channel -- is about 98 MB of that, and it is a CACHE: every row is
// derived from the tracked transcript JSON under
// `data/video_pipeline/transcripts/`, and the tools rebuild it from those
// files. It now lives in `transcript_segments.sqlite`, which is deliberately
// untracked (see `src/transcript/segmentStore.js`).
//
// So the catalog is 33.8 MB again. But nothing PREVENTED it growing past the
// limit -- it just did, and the first anyone heard about it was a failed push.
// A limit nobody enforces is a preference. This is the enforcement.
//
// TWO DIFFERENT LIMITS, AND THE REASON FOR BOTH
//
//   60 MB   the catalog's own budget. Well under GitHub's 100 MB, so the
//           catalog can grow (more signals, more setups) without ever being
//           the thing that breaks a push. If it hits this, something is being
//           put in the catalog that belongs in a cache -- exactly what
//           `transcript_segments` was.
//
//   100 MB  GitHub's hard per-file limit, checked over EVERY tracked file,
//           not just the catalog. A push over this does not fail slowly; it
//           is rejected, and the branch cannot be published at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SEGMENTS_CACHE = path.join(ROOT, 'data', 'video_pipeline', 'transcript_segments.sqlite');

const MB = 1024 * 1024;
const CATALOG_BUDGET_BYTES = 60 * MB;
const GITHUB_PER_FILE_LIMIT = 100 * MB;

test('the tracked catalog stays inside its budget', () => {
  assert.ok(fs.existsSync(CATALOG), `the catalog is missing: ${CATALOG}`);
  const size = fs.statSync(CATALOG).size;
  assert.ok(
    size < CATALOG_BUDGET_BYTES,
    `state.sqlite is ${(size / MB).toFixed(1)} MB, over its ${(CATALOG_BUDGET_BYTES / MB).toFixed(0)} MB budget. `
    + 'GitHub refuses a file over 100 MB, so this would make the branch unpushable. '
    + 'Almost always this means a CACHE is in the catalog -- a table derived from '
    + 'data already in git. It belongs in its own untracked file, the way '
    + 'transcript_segments does; see src/transcript/segmentStore.js.',
  );
});

test('the transcript-segment cache is NOT tracked', () => {
  // The whole point of the split: the segments are derivable from the tracked
  // transcript JSON, so committing them would re-inflate the repo for nothing.
  // The guard is two-sided -- gitignore it AND make sure git is not holding it.
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(
    gitignore,
    /data\/video_pipeline\/\*[\s\S]*!data\/video_pipeline\/state\.sqlite/,
    '.gitignore must ignore data/video_pipeline/ except state.sqlite -- otherwise a '
    + 'cache dropped there gets committed and the catalog bloats again',
  );

  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '--', 'data/video_pipeline/transcript_segments.sqlite'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // No git available (e.g. a source tarball). The size checks above still run.
    return;
  }
  assert.equal(tracked, '',
    'transcript_segments.sqlite is tracked in git. It is a rebuildable cache of the '
    + 'tracked transcript JSON -- untrack it, or the repo grows by ~100 MB for data '
    + 'it already has.');
  if (fs.existsSync(SEGMENTS_CACHE)) {
    // Present on disk and not tracked: exactly the intended state.
    assert.ok(fs.statSync(SEGMENTS_CACHE).size > 0,
      'the segments cache exists but is empty -- run tools/migrateTranscriptSegments.js');
  }
});

test('no tracked file is at or over GitHub\'s 100 MB limit', () => {
  // The blunt one, and the only check that speaks GitHub's language. It covers
  // the catalog AND anything else someone might commit: a video, a model, a
  // database dump.
  let lines;
  try {
    lines = execFileSync('git', ['ls-files', '-s'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * MB,
    }).split('\n').filter(Boolean);
  } catch {
    return; // no git: nothing to check against
  }

  const shas = lines.map((l) => l.split(/\s+/)[1]).filter(Boolean);
  if (!shas.length) return;

  const sizes = execFileSync('git', ['cat-file', '--batch-check=%(objectsize) %(objectname)'], {
    cwd: ROOT, encoding: 'utf8', input: shas.join('\n'), stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * MB,
  }).trim().split('\n');

  const over = [];
  for (const line of sizes) {
    const [sizeStr, sha] = line.split(/\s+/);
    const size = Number(sizeStr);
    if (!Number.isFinite(size) || size < GITHUB_PER_FILE_LIMIT) continue;
    const entry = lines.find((l) => l.split(/\s+/)[1] === sha);
    const name = entry ? entry.split(/\s+/).slice(3).join(' ') : sha;
    over.push(`  ${(size / MB).toFixed(1)} MB  ${name}`);
  }

  assert.deepEqual(over, [],
    'these tracked files are at or over GitHub\'s 100 MB per-file limit, so a push '
    + 'will be REJECTED and the branch cannot be published:\n' + over.join('\n'));
});
