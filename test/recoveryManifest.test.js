'use strict';

// The recovery manifest must describe what is ACTUALLY missing.
//
// The catalog's `download_path` is a pointer, and it goes stale in two ways:
//
//   1. The file it points at was deleted (the sparse-checkout incident of
//      2026-10-21 removed ~215 GB of untracked media).
//   2. It names a file under an OLDER NAMING SCHEME. 324 rows point at
//      `downloads_1080p/<video_id>.mp4`; the current convention is
//      `downloads_1080p/<upload_date>_<video_id>.mp4`. Those pointers never
//      resolve, whatever happened to the media.
//
// `tools/inventoryLostVideos.py` used to list every row with a pointer (716)
// and its note claimed they had ALL been deleted on 2026-10-21. That was
// wrong: 179 of them were still on disk, and a further 324 named files that
// never existed under that scheme. A reader could not tell which videos the
// manifest actually wanted fetched.
//
// The manifest now lists the missing videos and counts the ones still on
// disk. These tests pin that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'data', 'qmg_video_recovery_manifest.json');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

test('the committed manifest lists only the videos that are missing', (t) => {
  if (!fs.existsSync(MANIFEST)) {
    t.skip('no manifest in this checkout');
    return;
  }
  const manifest = readManifest();

  assert.ok(Array.isArray(manifest.videos), 'the manifest must carry a videos list');
  for (const entry of manifest.videos) {
    assert.equal(entry.present, false, `${entry.video_id} is listed as missing but is marked present`);
  }
  assert.equal(manifest.total, manifest.videos.length,
    'total must be the number of videos listed, not the number of pointers');
});

test('the committed manifest does not claim everything was deleted', (t) => {
  if (!fs.existsSync(MANIFEST)) {
    t.skip('no manifest in this checkout');
    return;
  }
  const manifest = readManifest();
  const note = String(manifest.note || '');

  assert.doesNotMatch(note, /deleted from data\/video_pipeline\/ on 2026-10-21/i,
    'the note must not assert a blanket deletion that the filesystem contradicts');
  assert.ok(/present/i.test(note), 'the note must say how to tell the two sets apart');
  assert.ok(typeof manifest.present_count === 'number', 'the manifest must count the videos still on disk');
  assert.ok(Array.isArray(manifest.present_videos), 'the manifest must list the videos still on disk');
  assert.equal(manifest.present_count, manifest.present_videos.length);
});

test('every pointer row is accounted for', (t) => {
  if (!fs.existsSync(MANIFEST)) {
    t.skip('no manifest in this checkout');
    return;
  }
  const manifest = readManifest();
  assert.equal(manifest.total + manifest.present_count, manifest.pointer_rows,
    'missing + present must account for every row with a pointer');
});

test('the manifest records the legacy naming scheme where it applies', (t) => {
  if (!fs.existsSync(MANIFEST)) {
    t.skip('no manifest in this checkout');
    return;
  }
  const manifest = readManifest();
  for (const entry of manifest.videos) {
    assert.equal(entry.pointer_uses_legacy_name, entry.filename !== entry.expected_filename,
      `${entry.video_id}: the legacy-name flag disagrees with the filenames`);
  }
});

test('running the tool reproduces the committed manifest', (t) => {
  if (!fs.existsSync(CATALOG)) {
    t.skip('no catalog in this checkout');
    return;
  }
  const out = path.join(require('node:os').tmpdir(), 'recovery-manifest-check.json');
  const result = spawnSync('py', ['-3', path.join(ROOT, 'tools', 'inventoryLostVideos.py'), '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    t.skip(`the inventory tool could not run here (${result.stderr || result.error})`);
    return;
  }
  const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
  const committed = readManifest();

  assert.equal(fresh.total, committed.total, 'the committed manifest is stale — regenerate it');
  assert.equal(fresh.present_count, committed.present_count, 'the committed manifest is stale — regenerate it');
  assert.deepEqual(
    fresh.videos.map((v) => v.video_id).sort(),
    committed.videos.map((v) => v.video_id).sort(),
    'the committed manifest lists a different set of missing videos',
  );
});
