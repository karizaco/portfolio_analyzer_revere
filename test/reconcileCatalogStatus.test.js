'use strict';

// The catalog's `status` column against the filesystem.
//
// `videos.status` is written by three tools that mean three different things
// by 'done' -- the whiteboard scanner (an artifact was written), the OCR
// runner (a pass finished), and the downloader (the media is on disk). The
// downloaders select their work with `status IN ('pending','scanning',
// 'error')`, which EXCLUDES 'done'. So a row that says 'done' while its
// media has been deleted is invisible to every downloader: it is neither
// re-fetched nor reported as missing.
//
// These tests pin the reconciliation that makes those rows visible again.
//
// The rule the whole thing rests on: a pointer is not evidence that a file is
// missing, and not evidence that one is present. Every pointer is resolved
// against the filesystem, and the media is also looked for under the name the
// downloader itself writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  MEDIA_ROOT,
  classifyRow,
  downloaderFileName,
  idForms,
  isRealFile,
  locateMedia,
  planReset,
  reconcile,
  resetStaleClaims,
  unclaimedFiles,
} = require('../tools/reconcileCatalogStatus');

/** A megabyte of "video". */
function bigFile(dir, name, bytes = 2 * 1024 * 1024) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
}

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

function mediaDir(root, dir) {
  return path.join(root, MEDIA_ROOT, dir);
}

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

test('a row that claims done and has no media is a false claim', () => {
  const { root, cleanup } = scratch();
  try {
    const row = {
      video_id: 'abc123', channel: 'revere', upload_date: '20260512',
      status: 'done', download_path: 'data/video_pipeline/downloads/20260512_abc123.mp4',
    };
    const classified = classifyRow(row, { cwd: root });
    assert.equal(classified.classification, 'done-missing');
    assert.equal(classified.stale, true);
    assert.equal(classified.mediaPresent, false);
  } finally { cleanup(); }
});

test('a done row whose media is at the downloader\'s own name still holds up', () => {
  // The pointer names a file that is gone, but the video itself was fetched
  // under the name the downloader writes. The claim holds, so the row must
  // NOT be reset -- resetting it would send the downloader after a video that
  // is already on disk.
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '20260512_abc123.mp4');
    const row = {
      video_id: 'abc123', channel: 'revere', upload_date: '20260512',
      status: 'done', download_path: 'data/video_pipeline/downloads/20260512_abc123.mp4',
    };
    const classified = classifyRow(row, { cwd: root });
    assert.equal(classified.classification, 'done-present');
    assert.equal(classified.stale, false);
    assert.equal(classified.pointerPresent, false, 'the pointer itself is stale');
    assert.equal(classified.ownPresent, true, 'but the media is there');
  } finally { cleanup(); }
});

test('a truncated file is not a video', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '20260512_abc123.mp4', 4096);
    const row = {
      video_id: 'abc123', upload_date: '20260512', status: 'done',
      download_path: 'data/video_pipeline/downloads_hires/20260512_abc123.mp4',
    };
    assert.equal(classifyRow(row, { cwd: root }).classification, 'done-missing',
      'a 4 KB file is a truncated download, not a video');
  } finally { cleanup(); }
});

test('a pending row with its media is active-present, not stale', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '20260512_abc123.mp4');
    const row = {
      video_id: 'abc123', upload_date: '20260512', status: 'pending',
      download_path: 'data/video_pipeline/downloads_hires/20260512_abc123.mp4',
    };
    assert.equal(classifyRow(row, { cwd: root }).classification, 'active-present');
  } finally { cleanup(); }
});

test('isRealFile refuses a path that is not there', () => {
  assert.equal(isRealFile(null), false);
  assert.equal(isRealFile('/no/such/path/at/all.mp4'), false);
});

// ---------------------------------------------------------------------------
// The id spellings
// ---------------------------------------------------------------------------

test('a file name resolves to every id spelling it could mean', () => {
  // A September 2026 download run prepended an underscore to the id, and some
  // Qullamaggie ids start with an underscore themselves -- so `_Vn-EBl95hes`
  // is the video `Vn-EBl95hes` and `__2urSPdZVec` is the video `_2urSPdZVec`.
  assert.deepEqual(idForms('20260512_Vn-EBl95hes.mp4'), ['Vn-EBl95hes']);
  assert.deepEqual(idForms('_Vn-EBl95hes.mp4'), ['_Vn-EBl95hes', 'Vn-EBl95hes']);
  assert.deepEqual(idForms('__2urSPdZVec.mp4'), ['__2urSPdZVec', '_2urSPdZVec']);
  assert.deepEqual(idForms('20260512_bEidyFtV-lY-1080p.mp4'), ['bEidyFtV-lY'],
    'a resolution suffix is stripped');
});

test('the downloader file name is date-qualified', () => {
  assert.equal(downloaderFileName({ video_id: 'abc', upload_date: '20260512' }), '20260512_abc.mp4');
  assert.equal(downloaderFileName({ video_id: 'abc', upload_date: '' }), 'abc.mp4');
  assert.equal(downloaderFileName({ video_id: 'abc', upload_date: 'NA' }), 'abc.mp4');
});

// ---------------------------------------------------------------------------
// The reconciliation as a whole
// ---------------------------------------------------------------------------

test('the reconciliation counts each class and lists the false claims', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '20260512_present.mp4');
    const rows = [
      {
        video_id: 'present', upload_date: '20260512', status: 'done',
        download_path: 'data/video_pipeline/downloads_hires/20260512_present.mp4',
      },
      {
        video_id: 'gone', upload_date: '20260511', status: 'done',
        download_path: 'data/video_pipeline/downloads/20260511_gone.mp4',
      },
      { video_id: 'todo', upload_date: '20260510', status: 'pending', download_path: '' },
    ];
    const report = reconcile(rows, { cwd: root });
    assert.equal(report.counts['done-present'], 1);
    assert.equal(report.counts['done-missing'], 1);
    assert.equal(report.counts['active-missing'], 1);
    assert.deepEqual(report.stale.map((r) => r.video_id), ['gone']);
    assert.equal(report.pointerRows, 2);
    assert.equal(report.pointerResolved, 1);
  } finally { cleanup(); }
});

test('the plan for a reset is exactly the false claims', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '20260512_present.mp4');
    const rows = [
      {
        video_id: 'present', upload_date: '20260512', status: 'done',
        download_path: 'data/video_pipeline/downloads_hires/20260512_present.mp4',
      },
      {
        video_id: 'gone', upload_date: '20260511', status: 'done',
        download_path: 'data/video_pipeline/downloads/20260511_gone.mp4',
      },
    ];
    assert.deepEqual(planReset(rows, { cwd: root }).map((r) => r.video_id), ['gone']);
  } finally { cleanup(); }
});

test('a file on disk that no pointer names is reported, and its id is found', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_1080p'), '20220426_uDfm0ClZ8yE.mp4');
    const rows = [{
      video_id: 'uDfm0ClZ8yE', upload_date: '20220426', status: 'scanning',
      download_path: 'data/video_pipeline/downloads_hires/20220426_uDfm0ClZ8yE.mp4',
    }];
    const unclaimed = unclaimedFiles(rows, { cwd: root });
    assert.equal(unclaimed.length, 1);
    assert.equal(unclaimed[0].file, '20220426_uDfm0ClZ8yE.mp4');
    assert.equal(unclaimed[0].inCatalog, true, 'the video IS in the catalog');
    assert.equal(unclaimed[0].video_id, 'uDfm0ClZ8yE');
  } finally { cleanup(); }
});

test('a file whose video the catalog has never seen is still reported', () => {
  const { root, cleanup } = scratch();
  try {
    bigFile(mediaDir(root, 'downloads_hires'), '_Vn-EBl95hes.mp4');
    const unclaimed = unclaimedFiles([], { cwd: root });
    assert.equal(unclaimed.length, 1);
    assert.equal(unclaimed[0].inCatalog, false);
    assert.ok(unclaimed[0].triedIds.includes('Vn-EBl95hes'),
      'both spellings of the id are tried');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The reset
// ---------------------------------------------------------------------------

test('the reset flips only the false claims and stamps the row', () => {
  const { root, cleanup } = scratch();
  const dbPath = path.join(root, 'state.sqlite');
  // The connection is closed before the scratch directory goes away: on
  // Windows an open handle makes the removal fail with EPERM, and that
  // failure would mask whatever the test was actually asserting.
  let open = null;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT '',
      upload_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      download_path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
    const insert = db.prepare(
      'INSERT INTO videos (video_id, upload_date, status, error, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('present', '20260512', 'done', 'old error', '2026-01-01');
    insert.run('gone', '20260511', 'done', 'old error', '2026-01-01');
    insert.run('todo', '20260510', 'pending', '', '2026-01-01');
    db.close();

    bigFile(mediaDir(root, 'downloads_hires'), '20260512_present.mp4');

    open = new DatabaseSync(dbPath);
    const rows = open.prepare('SELECT video_id, upload_date, status, download_path FROM videos').all();
    const stale = planReset(rows, { cwd: root });
    assert.deepEqual(stale.map((r) => r.video_id), ['gone']);

    const changed = resetStaleClaims(open, stale, '2026-10-29T12:00:00+00:00');
    assert.equal(changed, 1);

    const after = open.prepare('SELECT video_id, status, error, updated_at FROM videos').all();
    const byId = Object.fromEntries(after.map((r) => [r.video_id, r]));
    assert.equal(byId.gone.status, 'pending', 'the false claim is withdrawn');
    assert.equal(byId.gone.error, '', 'the stale error is cleared');
    assert.equal(byId.gone.updated_at, '2026-10-29T12:00:00+00:00');
    assert.equal(byId.present.status, 'done', 'a claim that holds is left alone');
    assert.equal(byId.present.updated_at, '2026-01-01');
    assert.equal(byId.todo.status, 'pending');
  } finally {
    if (open) open.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The shipped catalog
// ---------------------------------------------------------------------------

test('the shipped catalog\'s "done" rows are all backed by media', { skip: fs.existsSync(path.join(__dirname, '..', 'data', 'video_pipeline', 'downloads_hires')) ? false : 'no media in this checkout' }, () => {
  // On 2026-10-29 twenty-one rows were reconciled: they said 'done' while
  // their media had been deleted, which made them invisible to every
  // downloader. They now say 'pending'.
  //
  // The check needs the filesystem, so it is skipped on a fresh clone -- the
  // media is not in git, only `state.sqlite` is. There is nothing to
  // reconcile without the media.
  const root = path.join(__dirname, '..');
  const dbPath = path.join(root, 'data', 'video_pipeline', 'state.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    'SELECT video_id, channel, upload_date, status, download_path FROM videos').all();
  db.close();

  const report = reconcile(rows, { cwd: root });
  assert.deepEqual(report.stale.map((r) => r.video_id), [],
    'every row that claims "done" has the media to back it up');

  // Two rows still point into the deleted `downloads/` directory, and both
  // legitimately claim 'done': their media was fetched into `downloads_hires`
  // under the downloader's own name. The pointer is stale; the claim is not.
  const stalePointers = report.rows.filter(
    (r) => r.status === 'done' && /(^|\/)downloads\//.test(r.download_path));
  for (const row of stalePointers) {
    assert.equal(row.ownPresent, true,
      `${row.video_id} claims "done" and its pointer is stale, so the media has to be elsewhere`);
  }
});

// ---------------------------------------------------------------------------
// The tool itself
// ---------------------------------------------------------------------------

test('the tool reports without changing anything', () => {
  const tool = path.join(__dirname, '..', 'tools', 'reconcileCatalogStatus.js');
  const r = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Catalog status reconciliation \(report only\)/);
  assert.match(r.stdout, /rows carry a download_path/);
  // The false-claim section is either a list of them or the statement that
  // there are none -- which is the state the shipped catalog is in now.
  assert.match(r.stdout, /done, media MISSING|No row claims "done" without having the media/);
});

test('the tool can emit JSON', () => {
  const tool = path.join(__dirname, '..', 'tools', 'reconcileCatalogStatus.js');
  const r = spawnSync(process.execPath, [tool, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(typeof out.rows, 'number');
  assert.equal(typeof out.pointerRows, 'number');
  assert.ok(Array.isArray(out.stale));
  assert.equal(out.executed, false);
});
