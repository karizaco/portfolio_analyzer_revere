'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { allocateOutputPath } = require('../src/video/ocrScanLogic');

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'allocate_output_path_test_'));
}

test('allocateOutputPath returns YYYYMMDD_ps.png for whiteboard output kind', () => {
  const root = freshRoot();
  try {
    const result = allocateOutputPath(root, 'whiteboard', '20260912');

    assert.equal(result, path.join(root, 'screenshots', '20260912_ps.png'));
    assert.ok(!fs.existsSync(result), 'path should not pre-exist (caller saves it)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateOutputPath appends collision-safe numeric suffix', () => {
  const root = freshRoot();
  try {
    const first = allocateOutputPath(root, 'whiteboard', '20260912');
    fs.writeFileSync(first, 'x');

    const second = allocateOutputPath(root, 'whiteboard', '20260912', 2);
    assert.equal(second, path.join(root, 'screenshots', '20260912_ps_2.png'));

    fs.writeFileSync(second, 'x');
    const third = allocateOutputPath(root, 'whiteboard', '20260912', 3);
    assert.equal(third, path.join(root, 'screenshots', '20260912_ps_3.png'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateOutputPath walks past collisions when no suffix is given', () => {
  const root = freshRoot();
  try {
    fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'screenshots', '20260912_ps.png'), 'x');

    const result = allocateOutputPath(root, 'whiteboard', '20260912');

    assert.equal(result, path.join(root, 'screenshots', '20260912_ps_2.png'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateOutputPath returns revere_YYYYMMDD.png for snapshot output kind', () => {
  const root = freshRoot();
  try {
    const result = allocateOutputPath(root, 'snapshot', '20260912');

    assert.equal(result, path.join(root, 'snapshots', 'revere_20260912.png'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateOutputPath returns snapshot_2.png when suffix=2', () => {
  const root = freshRoot();
  try {
    const first = allocateOutputPath(root, 'snapshot', '20260912');
    fs.writeFileSync(first, 'x');

    const second = allocateOutputPath(root, 'snapshot', '20260912', 2);
    assert.equal(second, path.join(root, 'snapshots', 'revere_20260912_2.png'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateOutputPath creates the screenshots/snapshots directory if missing', () => {
  const root = freshRoot();
  try {
    allocateOutputPath(root, 'whiteboard', '20260912');
    assert.ok(fs.existsSync(path.join(root, 'screenshots')));

    allocateOutputPath(root, 'snapshot', '20260912');
    assert.ok(fs.existsSync(path.join(root, 'snapshots')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
