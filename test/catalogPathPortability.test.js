'use strict';

// The catalog's stored paths have to survive being committed.
//
// `data/video_pipeline/state.sqlite` is tracked in git, and `videos.download_path`
// is the catalog's record of where a download landed. 392 of its 716 pointers
// were absolute Windows paths, so they resolved on the machine that wrote them
// and nowhere else -- the same defect that was fixed on the smaller
// `catalog_runs.raw_output_path` column, on a column eight times the size.
//
// The fix has two halves that have to agree, because the column is written
// from two languages:
//
//   * `portable_stored_path()` in tools/whiteboard_worker.py (Python)
//   * `toPortablePath()` in src/video/downloadCandidates.js (JavaScript)
//
// Both store a path inside the repository relative to its root, and both
// resolve it back the same way. A path outside the repository keeps its
// absolute form in both, because there is no honest relative form for it.
//
// These tests check the two halves against each other, check that the shipped
// catalog has actually been converted, and check that a fresh clone's schema
// matches the shipped table -- a column order that differs between the two
// means a fresh clone is not the database the tooling was written against.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { resolveCatalogPath, toPortablePath } = require('../src/video/downloadCandidates');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'tools', 'whiteboard_worker.py');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/** A python launcher, mirroring tools/runWhiteboardWorker.js. */
function pythonLauncher() {
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '--version'], { encoding: 'utf8', shell: false });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

const PY = pythonLauncher();

/** Run a snippet inside the worker module and return its JSON. */
function runPython(snippet, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-'));
  try {
    const file = path.join(dir, 'snippet.py');
    fs.writeFileSync(file, [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})`,
      'import whiteboard_worker as ww',
      snippet,
      '',
    ].join('\n'), 'utf8');
    const r = spawnSync(PY.cmd, [...PY.args, file, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The JavaScript half
// ---------------------------------------------------------------------------

test('a path inside the repository is stored relative to its root', () => {
  const stored = toPortablePath(path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'x.mp4'), ROOT);
  assert.equal(stored, 'data/video_pipeline/downloads_1080p/x.mp4');
  assert.ok(!path.isAbsolute(stored));
});

test('a path outside the repository keeps its absolute form', () => {
  // There is no relative form for it. Converting it would only make it wrong
  // in a different way.
  const outside = path.resolve('C:/somewhere/else/video.mp4');
  const stored = toPortablePath(outside, ROOT);
  assert.ok(path.isAbsolute(stored), `expected an absolute path, got ${stored}`);
});

test('a path that is already relative is left alone', () => {
  const stored = toPortablePath('data/video_pipeline/downloads_hires/x.mp4', ROOT);
  assert.equal(stored, 'data/video_pipeline/downloads_hires/x.mp4');
});

test('storing and resolving are inverses', () => {
  const original = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'round.mp4');
  const stored = toPortablePath(original, ROOT);
  assert.equal(resolveCatalogPath(stored, ROOT), path.resolve(original));
});

test('an empty pointer stays empty', () => {
  assert.equal(toPortablePath(''), '');
  assert.equal(toPortablePath(null), null);
});

// ---------------------------------------------------------------------------
// The Python half
// ---------------------------------------------------------------------------

test('the Python helper agrees with the JavaScript one', { skip: PY ? false : 'no python launcher available' }, () => {
  const inRepo = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'x.mp4');
  const outside = path.resolve('C:/somewhere/else/video.mp4');
  const out = runPython([
    'print(json.dumps({',
    '  "in_repo": ww.portable_stored_path(sys.argv[1]),',
    '  "outside": ww.portable_stored_path(sys.argv[2]),',
    '  "relative": ww.portable_stored_path("data/video_pipeline/x.mp4"),',
    '  "resolved": ww.resolve_portable_path(ww.portable_stored_path(sys.argv[1])),',
    '}))',
  ].join('\n'), [inRepo, outside]);

  assert.equal(out.in_repo, toPortablePath(inRepo, ROOT),
    'both languages store the same form for a path inside the repository');
  assert.equal(out.outside, toPortablePath(outside, ROOT),
    'both languages keep the absolute form for a path outside it');
  assert.equal(out.relative, 'data/video_pipeline/x.mp4');
  assert.equal(path.resolve(out.resolved), path.resolve(inRepo),
    'resolving the stored path gives back the file it came from');
});

test('the migration rewrites the pointers an older catalog holds', { skip: PY ? false : 'no python launcher available' }, () => {
  // A database written before this change holds absolute paths. Opening it
  // has to convert them -- otherwise the committed catalog keeps pointers
  // that resolve on no other machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-legacy-'));
  try {
    const legacyDb = path.join(dir, 'state.sqlite');
    const inRepo = path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires', 'legacy.mp4');
    const outside = path.resolve('C:/other/machine/legacy.mp4');

    // Build the old database here rather than in Python: a CREATE TABLE
    // written inside a Python string literal inside a JavaScript string is
    // three levels of quoting, and one misplaced paren is invisible.
    const legacy = new DatabaseSync(legacyDb);
    legacy.exec(`CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, source_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      upload_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      download_path TEXT NOT NULL DEFAULT '', output_path TEXT NOT NULL DEFAULT '',
      selected_timestamp REAL, selected_score REAL,
      review_reason TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '', transcript_path TEXT NOT NULL DEFAULT '',
      transcript_segment_count INTEGER NOT NULL DEFAULT 0,
      transcript_fetched_at TEXT NOT NULL DEFAULT ''
    )`);
    legacy.exec(`CREATE TABLE worker_settings (
      setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy.exec(`CREATE TABLE catalog_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL,
      command_json TEXT NOT NULL, raw_output_path TEXT NOT NULL,
      row_count INTEGER NOT NULL, inserted_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL, missing_upload_dates INTEGER NOT NULL,
      malformed_rows INTEGER NOT NULL, created_at TEXT NOT NULL
    )`);
    const insertVideo = legacy.prepare(
      'INSERT INTO videos (video_id, created_at, updated_at, download_path) VALUES (?, ?, ?, ?)');
    insertVideo.run('inrepo', '2026-01-01', '2026-01-01', inRepo);
    insertVideo.run('outside', '2026-01-01', '2026-01-01', outside);
    legacy.prepare('INSERT INTO worker_settings VALUES (?, ?, ?)')
      .run('pipeline_root', path.join(ROOT, 'data', 'video_pipeline'), '2026-01-01');
    legacy.close();

    // Opening the database is what applies the migration: the schema is
    // loaded and then the version-gated backfills run.
    const out = runPython([
      'import sqlite3',
      'conn = sqlite3.connect(sys.argv[1])',
      'conn.row_factory = sqlite3.Row',
      'ww.initialize_schema(conn)',
      'rows = {r["video_id"]: r["download_path"] for r in conn.execute("select video_id, download_path from videos")}',
      'settings = {r["setting_key"]: r["setting_value"] for r in conn.execute("select setting_key, setting_value from worker_settings")}',
      'versions = [r["version"] for r in conn.execute("select version from schema_version order by version")]',
      'print(json.dumps({"rows": rows, "settings": settings, "versions": versions}))',
      '',
    ].join('\n'), [legacyDb]);

    assert.equal(out.rows.inrepo, 'data/video_pipeline/downloads_hires/legacy.mp4',
      'a path inside the repository became relative');
    assert.equal(out.rows.outside, outside,
      'a path outside it was left alone');
    assert.equal(out.settings.pipeline_root, 'data/video_pipeline',
      'the settings row became relative too');
    assert.ok(out.versions.includes(3), 'the migration recorded its version');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The shipped catalog
// ---------------------------------------------------------------------------

test('the shipped catalog holds no absolute pointer', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT video_id, download_path FROM videos WHERE download_path <> ''").all();
  const absolute = rows.filter((r) => path.isAbsolute(r.download_path) || /^[A-Za-z]:[\\/]/.test(r.download_path));
  assert.deepEqual(
    absolute.map((r) => r.video_id),
    [],
    'every pointer is relative to the repository root, so it means the same thing on every machine',
  );
  db.close();
});

test('the shipped settings hold no absolute path', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT setting_key, setting_value FROM worker_settings").all();
  const pathKeys = rows.filter((r) => r.setting_key === 'pipeline_root'
    || r.setting_key.startsWith('path_')
    || r.setting_key.endsWith('_path'));
  for (const row of pathKeys) {
    assert.ok(!path.isAbsolute(row.setting_value),
      `${row.setting_key} holds an absolute path: ${row.setting_value}`);
  }
  db.close();
});

test('the shipped catalog records the migration', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
  assert.ok(versions.includes(3), `expected version 3 among ${versions.join(', ')}`);
  db.close();
});

test('every relative pointer that resolves points at a file that is there', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  // A pointer that resolves to nothing is a stale pointer, and the recovery
  // manifest counts those. What must NOT happen is a pointer that resolves to
  // the wrong place -- that would be a silent corruption.
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT video_id, download_path FROM videos WHERE download_path <> ''").all();
  let checked = 0;
  for (const row of rows) {
    const resolved = resolveCatalogPath(row.download_path, ROOT);
    if (!resolved || !fs.existsSync(resolved)) continue;
    checked++;
    assert.ok(resolved.startsWith(path.resolve(ROOT)),
      `${row.video_id} resolves outside the repository: ${resolved}`);
    assert.ok(path.basename(resolved).includes(row.video_id),
      `${row.video_id} resolves to a file named for a different video: ${resolved}`);
  }
  assert.ok(checked > 0, 'expected at least one pointer to resolve to a real file');
  db.close();
});

test('the migration says what each old run row_count counts', { skip: PY ? false : 'no python launcher available' }, () => {
  // `row_count` means two different things depending on the run: the rows a
  // channel listing yielded, or the videos in a work list. A reader of the
  // audit table could not tell which. The old rows are reconstructed from the
  // artifact each run wrote -- its file name says which kind of run it was --
  // rather than guessed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-rowkind-'));
  try {
    const legacyDb = path.join(dir, 'state.sqlite');
    const legacy = new DatabaseSync(legacyDb);
    legacy.exec(`CREATE TABLE catalog_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL,
      command_json TEXT NOT NULL, raw_output_path TEXT NOT NULL,
      row_count INTEGER NOT NULL, inserted_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL, missing_upload_dates INTEGER NOT NULL,
      malformed_rows INTEGER NOT NULL, created_at TEXT NOT NULL
    )`);
    const insert = legacy.prepare(
      'INSERT INTO catalog_runs (source_url, command_json, raw_output_path, row_count,'
      + ' inserted_count, updated_count, missing_upload_dates, malformed_rows, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const addRun = (artifact, rowCount) => insert.run(
      'https://x', '[]', artifact, rowCount, 1, 0, 0, 0, '2026-01-01');
    addRun('catalog_20260101T000000Z.tsv', 10);
    addRun('listing_20260101T000000Z.tsv', 20);
    addRun('fill_dates_20260101T000000Z.tsv', 30);
    addRun('something_else.tsv', 40);
    legacy.close();

    const out = runPython([
      'import sqlite3',
      'conn = sqlite3.connect(sys.argv[1])',
      'conn.row_factory = sqlite3.Row',
      'ww.initialize_schema(conn)',
      'rows = [(r["row_count"], r["row_count_kind"]) for r in conn.execute("select row_count, row_count_kind from catalog_runs order by row_count")]',
      'versions = [r["version"] for r in conn.execute("select version from schema_version order by version")]',
      'print(json.dumps({"rows": rows, "versions": versions}))',
      '',
    ].join('\n'), [legacyDb]);

    assert.deepEqual(out.rows, [
      [10, 'listing_rows'],
      [20, 'work_list_videos'],
      [30, 'work_list_videos'],
      [40, ''],
    ], 'each row says what it counts, and an unrecognised artifact says nothing');
    assert.ok(out.versions.includes(6), `expected version 6 among ${out.versions.join(', ')}`);
  } finally {
    // `maxRetries` matters on Windows: the SQLite handle the worker opened
    // can still be closing when the test's cleanup runs, and a busy directory
    // is a transient failure rather than a real one.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// The schema and the shipped table
// ---------------------------------------------------------------------------

/** The column names of a CREATE TABLE block in schema.sql, in order. */
function schemaColumns(sql, table) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  assert.ok(start >= 0, `schema.sql has no ${table} table`);
  const open = sql.indexOf('(', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = sql.slice(open + 1, end);
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name && name.toUpperCase() !== 'PRIMARY' && name.toUpperCase() !== 'FOREIGN'
      && name.toUpperCase() !== 'UNIQUE' && name.toUpperCase() !== 'CHECK' && name.toUpperCase() !== 'CONSTRAINT');
}

test('a fresh clone gets the same videos table as the shipped catalog', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  // The shipped table had `channel` at index 14 and the transcript columns
  // at 15-17, because they were added by ALTER TABLE; schema.sql had them at
  // index 6 and 13-15. Nothing reads the table positionally, but a fresh
  // clone that is not the database the tooling was written against is a trap
  // for whoever hits it next.
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const fromSchema = schemaColumns(sql, 'videos');

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const fromShipped = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  db.close();

  assert.deepEqual(fromSchema, fromShipped,
    'data/db/schema.sql and the shipped catalog describe the same table');
});

test('a fresh clone gets the same catalog_runs table as the shipped catalog', { skip: fs.existsSync(DB_PATH) ? false : 'no catalog in this checkout' }, () => {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const fromSchema = schemaColumns(sql, 'catalog_runs');

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const fromShipped = db.prepare('PRAGMA table_info(catalog_runs)').all().map((c) => c.name);
  db.close();

  assert.deepEqual(fromSchema, fromShipped);
});
