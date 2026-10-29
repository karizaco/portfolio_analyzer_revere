'use strict';

// Regression tests for the probe-log directory resolution in
// src/video/probeLogDirs.js.
//
// A run's probe logs live under one of THREE layouts:
//
//   flat     data/video_scan_<date>/<tag>/ocr_probe/logs
//   doubled  data/video_scan_<date>/<tag>/<tag>/ocr_probe/logs
//   root     data/video_scan_<date>/ocr_probe/logs
//
// tools/aggregateScanResults.js probed all three. tools/aggregateOcrTimeline.js
// probed only the flat one, so it could not find the logs of any run that used
// the doubled layout — which is every run that has a committed timeline.json.
// The tool exited 1 with "No probe logs found" before writing anything, so
// none of the six committed timeline.json files could be reproduced.
//
// The list now lives in one shared module, so the two aggregators cannot
// drift apart again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildLogsDirectories, resolveLogsDirectory } = require('../src/video/probeLogDirs');

const ROOT = path.resolve(__dirname, '..');

test('the three layouts are probed in order', () => {
  const dirs = buildLogsDirectories('data/video_scan_20260917', 'ocr-20260917');
  assert.equal(dirs.length, 3);
  assert.match(dirs[0], /ocr-20260917[\\/]ocr_probe[\\/]logs$/);
  assert.match(dirs[1], /ocr-20260917[\\/]ocr-20260917[\\/]ocr_probe[\\/]logs$/);
  assert.match(dirs[2], /video_scan_20260917[\\/]ocr_probe[\\/]logs$/);
});

test('the flat layout wins when it exists', () => {
  const existing = new Set([
    path.join('d', 'tag', 'ocr_probe', 'logs'),
    path.join('d', 'tag', 'tag', 'ocr_probe', 'logs'),
    path.join('d', 'ocr_probe', 'logs'),
  ]);
  const resolved = resolveLogsDirectory('d', 'tag', (p) => existing.has(p));
  assert.equal(resolved, path.join('d', 'tag', 'ocr_probe', 'logs'));
});

test('the doubled layout is used when the flat one is missing', () => {
  // The parallelOcrScan.py layout — the tag directory contains a directory
  // named after itself.
  const doubled = path.join('d', 'tag', 'tag', 'ocr_probe', 'logs');
  const resolved = resolveLogsDirectory('d', 'tag', (p) => p === doubled);
  assert.equal(resolved, doubled);
});

test('the legacy root layout is used when neither tagged one exists', () => {
  const root = path.join('d', 'ocr_probe', 'logs');
  const resolved = resolveLogsDirectory('d', 'tag', (p) => p === root);
  assert.equal(resolved, root);
});

test('no layout present resolves to null', () => {
  assert.equal(resolveLogsDirectory('d', 'tag', () => false), null);
});

// ---------------------------------------------------------------------------
// The data-driven check: every committed timeline.json must be reproducible.
// ---------------------------------------------------------------------------

function trackedTimelines() {
  const out = execFileSync('git', ['ls-files', 'data/video_scan_*/**/timeline.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('every committed timeline.json can find its probe logs', (t) => {
  const timelines = trackedTimelines();
  if (!timelines.length) {
    t.skip('no tracked timeline.json in this checkout');
    return;
  }

  for (const timeline of timelines) {
    // git always reports forward slashes, on every platform.
    const parts = timeline.split('/');
    // data/video_scan_<date>/<tag>/timeline.json
    const tag = parts[parts.length - 2];
    const scanDateDir = path.join(ROOT, 'data', parts[1]);

    const resolved = resolveLogsDirectory(scanDateDir, tag);
    assert.ok(resolved,
      `${timeline}: no probe-log directory found for tag '${tag}' — the timeline cannot be reproduced`);

    const logs = fs.readdirSync(resolved).filter((f) => f.endsWith('.json'));
    assert.ok(logs.length > 0, `${timeline}: resolved to ${resolved}, which holds no probe logs`);
  }
});

test('every committed timeline.json needs the doubled layout (the flat-only bug)', (t) => {
  const timelines = trackedTimelines();
  if (!timelines.length) {
    t.skip('no tracked timeline.json in this checkout');
    return;
  }

  const flatOnlyMisses = [];
  for (const timeline of timelines) {
    const parts = timeline.split('/');
    const tag = parts[parts.length - 2];
    const scanDateDir = path.join(ROOT, 'data', parts[1]);

    // The old behaviour: probe ONLY the flat layout.
    const flat = path.join(scanDateDir, tag, 'ocr_probe', 'logs');
    if (!fs.existsSync(flat)) flatOnlyMisses.push(`${timeline} (flat: ${path.relative(ROOT, flat)})`);
  }

  // This is the regression guard: the shared module must stay WIDER than the
  // old flat-only resolution. If someone narrows it back to one layout, the
  // timeline tool goes back to exiting 1 with "No probe logs found" on every
  // run whose logs live in the doubled layout.
  assert.ok(flatOnlyMisses.length > 0,
    'no committed timeline needs a non-flat layout — the resolution may have been narrowed back to flat');
});
