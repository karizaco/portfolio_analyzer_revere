'use strict';

// The OCR downloaders must only ever fetch the OCR channels' media.
//
// The catalog is shared: the transcript sources (davidsevcik, t3live,
// benzinga) live in the same `videos` table and leave their rows 'pending'
// forever, because their pipeline never downloads the video. Neither
// downloader filtered on the channel, so both took transcript rows first --
// measured on 2026-11-11, all 30 of the worker's first 30 picks were T3Live
// rows, and 16 of the 720p batcher's first 30 were T3Live or Sevcik rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const { buildDownloadCandidateSql } = require('../src/video/downloadCandidates');
const { OCR_CHANNELS } = require('../src/video/videoStatus');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'tools', 'whiteboard_worker.py');

const PY = (() => {
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
})();

const ROWS = [
  ['rev1', 'revere', '20260101'],
  ['qmg1', 'qullamaggie', '20230101'],
  ['old1', '', '20200101'],
  ['t3l1', 't3live', '20110101'],
  ['sev1', 'davidsevcik', '20260201'],
  ['bzg1', 'benzinga', '20261101'],
  ['bzg2', 'benzinga', ''],
];

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-scope-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  const insert = db.prepare(
    "INSERT INTO videos (video_id, video_url, upload_date, channel, status, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, 'pending', 'x', 'x')",
  );
  for (const [id, channel, date] of ROWS) insert.run(id, `https://www.youtube.com/watch?v=${id}`, date, channel);
  db.close();
  return { dir, dbPath };
}

test('the 720p batcher query selects only OCR-channel rows', () => {
  const { dbPath } = makeDb();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ids = db.prepare(buildDownloadCandidateSql()).all().map((r) => r.video_id).sort();
  db.close();
  assert.deepEqual(ids, ['old1', 'qmg1', 'rev1']);
});

test('the worker download queue selects only OCR-channel rows', { skip: !PY && 'no python' }, () => {
  const { dbPath } = makeDb();
  const script = [
    'import sqlite3, sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})`,
    'import whiteboard_worker as w',
    'c = sqlite3.connect(sys.argv[1]); c.row_factory = sqlite3.Row',
    "print(json.dumps(sorted(r['video_id'] for r in w.select_videos_for_download(c, limit=50, video_id=''))))",
  ].join('\n');
  const r = spawnSync(PY.cmd, [...PY.args, '-c', script, dbPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['old1', 'qmg1', 'rev1']);
});

test('the Python and JavaScript OCR channel lists agree', () => {
  const source = fs.readFileSync(WORKER, 'utf8');
  const match = /^OCR_CHANNELS = \(([^)]*)\)/m.exec(source);
  assert.ok(match, 'OCR_CHANNELS tuple not found in whiteboard_worker.py');
  const python = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(python, [...OCR_CHANNELS]);
});

test('catalog refuses to label an unrecognised YouTube URL as revere', { skip: !PY && 'no python' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-guard-'));
  const run = (...args) => spawnSync(PY.cmd, [...PY.args, WORKER, '--pipeline-root', root, ...args], { encoding: 'utf8' });
  assert.equal(run('init').status, 0);
  const r = run('catalog', '--source-url', 'https://www.youtube.com/playlist?list=PLbenzingaShow', '--yt-dlp-bin', 'definitely-not-yt-dlp');
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /pass --channel explicitly/);
});

test('a known handle is still inferred without --channel', { skip: !PY && 'no python' }, () => {
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})`,
    'import whiteboard_worker as w',
    "print(w.infer_channel_from_url('https://www.youtube.com/@Benzinga/streams'))",
    "print(w.CHANNEL_SOURCE_URLS['benzinga'])",
  ].join('\n');
  const r = spawnSync(PY.cmd, [...PY.args, '-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], 'benzinga');
  assert.equal(lines[1], 'https://www.youtube.com/@Benzinga/streams');
});
