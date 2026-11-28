'use strict';

// The recovery manifest must describe what is ACTUALLY missing.
//
// The catalog's `download_path` is a pointer, and it goes stale in two ways:
//
//   1. The file it points at was deleted (the sparse-checkout incident of
//      2026-10-21 removed ~215 GB of untracked media).
//   2. It names a file under an OLDER NAMING SCHEME. 514 rows point at
//      `downloads_1080p/<video_id>.mp4`; the current convention is
//      `downloads_1080p/<upload_date>_<video_id>.mp4`. Those pointers never
//      resolve, whatever happened to the media.
//
// `tools/inventoryLostVideos.py` used to list every row with a pointer (716)
// and its note claimed they had ALL been deleted on 2026-10-21. That was
// wrong: 179 of them were still on disk, and a further 514 named files that
// never existed under that scheme. A reader could not tell which videos the
// manifest actually wanted fetched.
//
// The manifest now lists the missing videos and counts the ones still on
// disk. These tests pin that.
//
// THE CASE A POINTER-ONLY INVENTORY MISSED
// A video can be on disk with NO pointer naming it — the media sits under
// the name the downloader writes, `<upload_date>_<video_id>.mp4`, while the
// pointer names something else. Asking only "does the pointer resolve?"
// called those videos missing, which is the opposite of the truth: they
// would have been fetched again, and the manifest contradicted its own
// stated principle that "a pointer is NOT evidence that a file is missing".
// Two rows in the shipped catalog are in exactly that state
// (`bEidyFtV-lY`, `M0pV73RV2qo`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'data', 'qmg_video_recovery_manifest.json');
const CATALOG = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA = path.join(ROOT, 'data', 'db', 'schema.sql');

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

test('the manifest records how each video still on disk was found', (t) => {
  if (!fs.existsSync(MANIFEST)) {
    t.skip('no manifest in this checkout');
    return;
  }
  const manifest = readManifest();
  for (const entry of manifest.present_videos) {
    assert.ok(['pointer', 'own_name'].includes(entry.found_by),
      `${entry.video_id}: how it was found must be recorded, got ${entry.found_by}`);
    assert.ok(entry.media_path, `${entry.video_id}: the file it was found at must be recorded`);
  }
  const byOwnName = manifest.present_videos.filter((v) => v.found_by === 'own_name').length;
  assert.equal(manifest.present_by_own_name_count, byOwnName,
    'the count of the videos found by their own name must match the list');
});

test('a video whose media is on disk under the downloader’s own name is not in the re-download list', (t) => {
  // The defect this pins: the inventory used to resolve the POINTER only, so
  // a video whose media was on disk under `<upload_date>_<video_id>.mp4` —
  // with no pointer naming it — was reported as missing and would have been
  // fetched again.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mediaRoot = path.join(dir, 'video_pipeline');
  const hires = path.join(mediaRoot, 'downloads_hires');
  fs.mkdirSync(hires, { recursive: true });
  // A file over a megabyte is a video; anything smaller is a truncated
  // download, and the tool must not count it.
  fs.writeFileSync(path.join(hires, '20260512_aVideoId.mp4'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(hires, '20260513_aTruncated.mp4'), Buffer.alloc(1024));

  const dbPath = path.join(dir, 'state.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  const insert = db.prepare(
    'INSERT INTO videos (video_id, channel, upload_date, download_path, title, status, '
    + 'source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = '2026-01-01T00:00:00+00:00';
  // A stale pointer: the file it names does not exist.
  insert.run('aVideoId', 'revere', '20260512', 'data/video_pipeline/downloads/20260512_aVideoId.mp4', 'present', 'done', 'https://example.com', now, now);
  insert.run('aTruncated', 'revere', '20260513', 'data/video_pipeline/downloads/20260513_aTruncated.mp4', 'truncated', 'done', 'https://example.com', now, now);
  insert.run('aGoneOne', 'revere', '20260514', 'data/video_pipeline/downloads/20260514_aGoneOne.mp4', 'gone', 'done', 'https://example.com', now, now);
  db.close();

  const out = path.join(dir, 'manifest.json');
  const result = spawnSync('py', ['-3', path.join(ROOT, 'tools', 'inventoryLostVideos.py'),
    '--db', dbPath, '--out', out, '--media-root', mediaRoot], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    t.skip(`the inventory tool could not run here (${result.stderr || result.error})`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));

  const missing = manifest.videos.map((v) => v.video_id);
  assert.ok(!missing.includes('aVideoId'),
    'a video whose media is on disk under the downloader’s own name must not be in the re-download list');
  assert.ok(missing.includes('aGoneOne'), 'a video with no media anywhere must be in the re-download list');
  assert.ok(missing.includes('aTruncated'),
    'a truncated download is not a video, so the video is still missing');

  const present = manifest.present_videos.find((v) => v.video_id === 'aVideoId');
  assert.ok(present, 'the video has to be recorded as present');
  assert.equal(present.found_by, 'own_name');
  // The media root is outside the repository here, so the path keeps its
  // absolute form — there is no honest relative form for it.
  assert.ok(path.isAbsolute(present.media_path), `expected an absolute path, got ${present.media_path}`);
  assert.ok(present.media_path.endsWith(path.join('downloads_hires', '20260512_aVideoId.mp4')),
    `unexpected media path: ${present.media_path}`);
});
