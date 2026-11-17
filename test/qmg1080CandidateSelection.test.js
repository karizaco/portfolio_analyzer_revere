'use strict';

// Which videos the 1080p downloader still has to fetch.
//
// THE BUG THIS PINS
//
// `tools/downloadQmg1080p.js` used to ask the CHECKPOINT before it asked the
// FILESYSTEM:
//
//     if (checkpoint.done.some(...)) { skippedCheckpoint += 1; continue; }
//     const onDisk = findHiresOnDisk(row, { dir: dlDir });
//
// `checkpoint.done` records "a download run finished this id". It says
// nothing about whether the file is still on disk -- and the files do go
// away (a library gets moved, cleaned, or pruned).
//
// Measured on 2026-11-17: of the 457 ids in the QMG 1080p checkpoint, 181
// had no file anywhere on disk (D:, downloads_1080p, downloads_hires,
// downloads, Recycle Bin). Every one of the 181 was skipped forever: never
// re-fetched, never reported missing, catalog status stuck at 'scanning'
// with a download_path pointing into a directory that no longer held the
// file.
//
// The fix is the ORDER. The filesystem answers "is it already downloaded?";
// the checkpoint only answers "did we already try?".
//
// The selection logic lives in src/video/downloadCandidates.js so it can be
// tested here without running a download.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectDownloadCandidates,
} = require('../src/video/downloadCandidates');

const {
  KNOWN_720P_ONLY_IDS,
  isKnown720pOnly,
  known720pOnlyCount,
} = require('../src/video/known720pOnly');

const ROOT = path.resolve(__dirname, '..');

// A fake disk: a set of file names that "exist", each bigger than
// MIN_FILE_BYTES so findHiresOnDisk accepts it.
function fakeDisk(files) {
  const present = new Set(files.map((f) => path.basename(f)));
  return {
    exists: (p) => present.has(path.basename(p)),
    sizeOf: () => 10 * 1024 * 1024,
  };
}

function row(videoId, uploadDate = '20230101') {
  return { video_id: videoId, upload_date: uploadDate, title: videoId, status: 'scanning', download_path: '' };
}

// ---------------------------------------------------------------------------
// The core bug
// ---------------------------------------------------------------------------

test('a checkpoint "done" id whose file is GONE is downloaded again', () => {
  const disk = fakeDisk([]);
  const r = selectDownloadCandidates([row('stranded')], { done: ['stranded'] }, { dir: 'D:/lib', ...disk });

  assert.equal(r.todo.length, 1, 'the stranded id must be in the todo list');
  assert.equal(r.todo[0].video_id, 'stranded');
  assert.equal(r.stranded.length, 1, 'and it must be reported as stranded');
});

test('a checkpoint "done" id whose file IS there is not downloaded again', () => {
  const disk = fakeDisk(['20230101_present.mp4']);
  const r = selectDownloadCandidates([row('present')], { done: ['present'] }, { dir: 'D:/lib', ...disk });

  assert.equal(r.todo.length, 0, 'the file is present, so there is nothing to do');
  assert.equal(r.satisfied.length, 1);
  assert.equal(r.stranded.length, 0, 'a present file is not stranded');
  assert.equal(r.satisfied[0].alreadyInCheckpoint, true);
});

test('the order is the filesystem, not the checkpoint', () => {
  // Three ids, all recorded as done. Only one still has its file.
  const disk = fakeDisk(['20230101_here.mp4']);
  const rows = [row('here'), row('goneA'), row('goneB')];
  const checkpoint = { done: ['here', 'goneA', 'goneB'] };

  const r = selectDownloadCandidates(rows, checkpoint, { dir: 'D:/lib', ...disk });

  assert.deepEqual(r.todo.map((x) => x.video_id), ['goneA', 'goneB']);
  assert.deepEqual(r.stranded.map((x) => x.video_id), ['goneA', 'goneB']);
  assert.deepEqual(r.satisfied.map((x) => x.row.video_id), ['here']);
});

test('a satisfied id the checkpoint had never seen is reported as not-in-checkpoint', () => {
  const disk = fakeDisk(['20230101_new.mp4']);
  const r = selectDownloadCandidates([row('new')], { done: [] }, { dir: 'D:/lib', ...disk });

  assert.equal(r.satisfied.length, 1);
  assert.equal(r.satisfied[0].alreadyInCheckpoint, false,
    'the caller uses this to add the id to the checkpoint');
});

// ---------------------------------------------------------------------------
// The other buckets still work
// ---------------------------------------------------------------------------

test('an errored id is skipped unless retryErrored is set', () => {
  const disk = fakeDisk([]);
  const checkpoint = { done: [], errored: { broke: { last_error_at: 'x' } } };

  const skip = selectDownloadCandidates([row('broke')], checkpoint, { dir: 'D:/lib', ...disk });
  assert.equal(skip.todo.length, 0);
  assert.equal(skip.skippedErrored, 1);

  const retry = selectDownloadCandidates([row('broke')], checkpoint, { dir: 'D:/lib', ...disk, retryErrored: true });
  assert.equal(retry.todo.length, 1);
  assert.equal(retry.skippedErrored, 0);
});

test('a blocked id is skipped', () => {
  const disk = fakeDisk([]);
  const r = selectDownloadCandidates([row('nope')], { done: [], blocked: ['nope'] }, { dir: 'D:/lib', ...disk });
  assert.equal(r.todo.length, 0);
  assert.equal(r.skippedBlocked, 1);
});

test('a file on disk satisfies the id even when the error bucket mentions it', () => {
  // The old code checked errored BEFORE the disk, so a stale error entry could
  // make the tool re-download a file it already had.
  const disk = fakeDisk(['20230101_good.mp4']);
  const checkpoint = { done: [], errored: { good: { last_error_at: 'x' } } };
  const r = selectDownloadCandidates([row('good')], checkpoint, { dir: 'D:/lib', ...disk });

  assert.equal(r.todo.length, 0);
  assert.equal(r.satisfied.length, 1);
});

test('excluded ids are never in the todo list', () => {
  const disk = fakeDisk([]);
  const r = selectDownloadCandidates([row('skipme'), row('takeme')], { done: [] },
    { dir: 'D:/lib', ...disk, excludeIds: ['skipme'] });

  assert.deepEqual(r.todo.map((x) => x.video_id), ['takeme']);
  assert.equal(r.skippedExcluded, 1);
});

test('checkpoint entries may be objects or strings', () => {
  const disk = fakeDisk([]);
  const checkpoint = { done: [{ id: 'obj' }, 'str'] };
  const r = selectDownloadCandidates([row('obj'), row('str'), row('fresh')], checkpoint, { dir: 'D:/lib', ...disk });

  assert.deepEqual(r.todo.map((x) => x.video_id), ['obj', 'str', 'fresh'],
    'both shapes must be recognised as done');
  assert.equal(r.stranded.length, 2);
});

// ---------------------------------------------------------------------------
// The known 720p-only list
// ---------------------------------------------------------------------------

test('the 720p-only list has 39 unique ids', () => {
  assert.equal(known720pOnlyCount(), 39);
  assert.equal(new Set(KNOWN_720P_ONLY_IDS).size, 39, 'no duplicates');
});

test('isKnown720pOnly is case-insensitive and rejects unknown ids', () => {
  assert.equal(isKnown720pOnly('0Ew3DImAZlw'), true);
  assert.equal(isKnown720pOnly('0ew3dimazlw'), true);
  assert.equal(isKnown720pOnly(' 0Ew3DImAZlw '), true);
  assert.equal(isKnown720pOnly('someRandomId'), false);
  assert.equal(isKnown720pOnly(null), false);
  assert.equal(isKnown720pOnly(''), false);
});

test('the 39 720p-only ids are never attempted by the 1080p pass', () => {
  const disk = fakeDisk([]);
  const r = selectDownloadCandidates(KNOWN_720P_ONLY_IDS.map((id) => row(id)), { done: [] },
    { dir: 'D:/lib', ...disk, excludeIds: KNOWN_720P_ONLY_IDS });

  assert.equal(r.todo.length, 0, 'none of them may be in the 1080p todo list');
  assert.equal(r.skippedExcluded, 39);
});

// ---------------------------------------------------------------------------
// The tool uses the fixed order
// ---------------------------------------------------------------------------

test('the downloader no longer consults the checkpoint before the filesystem', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'downloadQmg1080p.js'), 'utf8');
  assert.ok(src.includes('selectDownloadCandidates('), 'the tool must use the shared selection');
  assert.ok(!src.includes('checkpoint.done.some('),
    'the buggy "checkpoint first" skip must not come back');
});

test('the checkpoint file is per-height, so a 720p pass cannot poison the 1080p one', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'downloadQmg1080p.js'), 'utf8');
  assert.ok(src.includes('_qmg_${height}p_checkpoint.json'), 'the checkpoint name must carry the height');
});
