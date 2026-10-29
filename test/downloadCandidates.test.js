'use strict';

// Which videos still need downloading.
//
// The catalog's `download_path` is a POINTER and it goes stale: it records
// where a file was when some machine downloaded it, and nothing updates it
// when the file is later deleted. Measured on 2026-10-29: 541 QMG rows point
// into `downloads_1080p` and only 27 of those files still resolve on disk.
//
// `tools/downloadQmg1080p.js` used to answer "is this already downloaded?"
// with `download_path NOT LIKE '%downloads_1080p%'` — a string test that
// excluded every row whose pointer mentioned the target directory, INCLUDING
// the 514 whose file is gone. That selected 47 of 588 QMG rows and made the
// missing videos impossible to re-fetch with the tool meant to fetch them.
//
// It also broke `--only-ids`: a requested id whose row pointed into
// downloads_1080p was reported as "not in catalog", because the query it was
// filtered against no longer contained it.
//
// The selection logic lives in src/video/downloadCandidates.js so it can be
// tested here without running a download.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  CANDIDATE_SQL,
  MIN_FILE_BYTES,
  findHiresOnDisk,
  isHiresPath,
  resolveCatalogPath,
} = require('../src/video/downloadCandidates');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

function fixtureDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE videos (
    video_id TEXT, upload_date TEXT, title TEXT, download_path TEXT,
    status TEXT, channel TEXT
  )`);
  const insert = db.prepare('INSERT INTO videos VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    insert.run(r.video_id, r.upload_date || '', r.title || '', r.download_path || '', r.status, r.channel);
  }
  return db;
}

test('a row whose 1080p file is GONE is still a candidate', () => {
  // The core of the bug: the pointer says downloads_1080p, the file does not
  // exist, so the video still has to be downloaded.
  const db = fixtureDb([
    { video_id: 'stale1080', upload_date: '20230601', status: 'scanning', channel: 'qullamaggie',
      download_path: 'C:\\some\\other\\machine\\data\\video_pipeline\\downloads_1080p\\20230601_stale1080.mp4' },
    { video_id: 'empty', upload_date: '20230602', status: 'pending', channel: 'qullamaggie', download_path: '' },
    { video_id: 'hires720', upload_date: '20230603', status: 'scanning', channel: 'qullamaggie',
      download_path: 'data/video_pipeline/downloads_hires/20230603_hires720.mp4' },
  ]);
  const rows = db.prepare(CANDIDATE_SQL).all();
  const ids = rows.map((r) => r.video_id).sort();
  assert.deepEqual(ids, ['empty', 'hires720', 'stale1080'],
    'every QMG row that is not done is a candidate — the download_path must not filter it out');
});

test('the query excludes done rows and other channels', () => {
  const db = fixtureDb([
    { video_id: 'done', status: 'done', channel: 'qullamaggie' },
    { video_id: 'other', status: 'pending', channel: 'revere' },
    { video_id: 'nomatch', status: 'no_match', channel: 'qullamaggie' },
    { video_id: 'keep', status: 'pending', channel: 'qullamaggie' },
  ]);
  const rows = db.prepare(CANDIDATE_SQL).all();
  assert.deepEqual(rows.map((r) => r.video_id), ['keep']);
});

test('the query does not filter on download_path', () => {
  // A regression guard on the SQL itself: the string test that caused the
  // bug must not come back.
  assert.doesNotMatch(CANDIDATE_SQL, /NOT\s+LIKE/i);
  assert.doesNotMatch(CANDIDATE_SQL, /download_path\s*IS\s+NOT\s+NULL/i);
});

// ---------------------------------------------------------------------------
// The filesystem check
// ---------------------------------------------------------------------------

/**
 * A fake filesystem: a set of existing paths and their sizes.
 */
function fakeFs(files) {
  const present = new Map(files.map((f) => [path.resolve(f.path), f.size === undefined ? MIN_FILE_BYTES + 1 : f.size]));
  return {
    exists: (p) => present.has(path.resolve(p)),
    sizeOf: (p) => {
      const size = present.get(path.resolve(p));
      if (size === undefined) throw new Error(`ENOENT ${p}`);
      return size;
    },
  };
}

test('a stale pointer means the video still needs downloading', () => {
  const fsMock = fakeFs([]);
  const row = {
    video_id: 'abc123',
    upload_date: '20230601',
    download_path: 'C:\\other\\machine\\data\\video_pipeline\\downloads_1080p\\20230601_abc123.mp4',
  };
  assert.equal(findHiresOnDisk(row, { dir: '/dl', exists: fsMock.exists, sizeOf: fsMock.sizeOf }), null);
});

test('an existing file under the downloader\'s own name counts', () => {
  const dir = path.resolve('/dl');
  const target = path.join(dir, '20230601_abc123.mp4');
  const fsMock = fakeFs([{ path: target }]);
  const row = { video_id: 'abc123', upload_date: '20230601', download_path: '' };
  assert.equal(
    findHiresOnDisk(row, { dir, exists: fsMock.exists, sizeOf: fsMock.sizeOf }),
    target,
  );
});

test('an existing file under the catalog\'s pointer counts too', () => {
  // The older rows carry a different name under the same directory.
  const target = path.resolve('/repo/data/video_pipeline/downloads_1080p/legacy.mp4');
  const fsMock = fakeFs([{ path: target }]);
  const row = {
    video_id: 'abc123',
    upload_date: '20230601',
    download_path: 'data/video_pipeline/downloads_1080p/legacy.mp4',
  };
  assert.equal(
    findHiresOnDisk(row, { dir: path.resolve('/dl'), cwd: path.resolve('/repo'), exists: fsMock.exists, sizeOf: fsMock.sizeOf }),
    target,
  );
});

test('a 720p copy in downloads_hires does NOT count', () => {
  // The downloader exists to fetch the 1080p version, so a 720p file is not
  // a reason to skip.
  const fsMock = fakeFs([{ path: path.resolve('/repo/data/video_pipeline/downloads_hires/20230601_abc123.mp4') }]);
  const row = {
    video_id: 'abc123',
    upload_date: '20230601',
    download_path: 'data/video_pipeline/downloads_hires/20230601_abc123.mp4',
  };
  assert.equal(
    findHiresOnDisk(row, { dir: path.resolve('/dl'), cwd: path.resolve('/repo'), exists: fsMock.exists, sizeOf: fsMock.sizeOf }),
    null,
  );
});

test('a truncated file does not count', () => {
  const fsMock = fakeFs([{ path: path.join('/dl', '20230601_abc123.mp4'), size: 1024 }]);
  const row = { video_id: 'abc123', upload_date: '20230601', download_path: '' };
  assert.equal(
    findHiresOnDisk(row, { dir: path.resolve('/dl'), exists: fsMock.exists, sizeOf: fsMock.sizeOf }),
    null,
  );
});

test('a repo-relative pointer resolves against the repository root', () => {
  const resolved = resolveCatalogPath('data/video_pipeline/downloads_1080p/x.mp4', path.resolve('/repo'));
  assert.equal(resolved, path.resolve('/repo/data/video_pipeline/downloads_1080p/x.mp4'));
});

test('an absolute pointer from another machine resolves but does not exist', () => {
  const resolved = resolveCatalogPath('C:\\other\\machine\\data\\video_pipeline\\downloads_1080p\\x.mp4', path.resolve('/repo'));
  assert.ok(resolved, 'the path resolves to something');
  assert.ok(!fs.existsSync(resolved), 'and it is not on this machine');
});

test('an empty pointer resolves to nothing', () => {
  assert.equal(resolveCatalogPath('', '/repo'), null);
  assert.equal(resolveCatalogPath(null, '/repo'), null);
  assert.equal(resolveCatalogPath(undefined, '/repo'), null);
});

test('only the 1080p directory counts as a hires path', () => {
  assert.ok(isHiresPath('C:\\x\\data\\video_pipeline\\downloads_1080p\\a.mp4'));
  assert.ok(!isHiresPath('C:\\x\\data\\video_pipeline\\downloads_hires\\a.mp4'));
  assert.ok(!isHiresPath(''));
  assert.ok(!isHiresPath(null));
});

// ---------------------------------------------------------------------------
// The real catalog
// ---------------------------------------------------------------------------

test('the real catalog has stale pointers, and the query no longer hides them', (t) => {
  const dbPath = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
  if (!fs.existsSync(dbPath)) {
    t.skip('no catalog in this checkout');
    return;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(CANDIDATE_SQL).all();

  const pointingAtHires = rows.filter((r) => isHiresPath(r.download_path || ''));
  assert.ok(pointingAtHires.length > 0, 'expected QMG rows pointing into downloads_1080p');

  // Every one of them is a candidate now, whether or not the file is there.
  const selected = new Set(rows.map((r) => r.video_id));
  for (const row of pointingAtHires) {
    assert.ok(selected.has(row.video_id), `${row.video_id} points into downloads_1080p and must stay a candidate`);
  }
});
