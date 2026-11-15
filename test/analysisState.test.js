'use strict';

// videos.analysis_state is the deletion flag, and it is not videos.status.
//
// `done` already means two things and the downloaders exclude it, so a
// deletion flag living there would hide a deleted file from every
// re-fetch. These tests pin the rule the column exists to express:
// a file is disposable only when a done scan names THIS video AND the
// date is pinned. A pinned date does not take its siblings with it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const {
  ANALYSIS_STATE,
  catalogDateOf,
  decideAnalysisState,
  videoIdFromMediaPath,
} = require('../src/video/analysisState');
const { writeAnalysisState } = require('../src/video/analysisStateStore');
const { classifyRows, doneScansFromLogs } = require('../tools/reportDeletableVideos');

const ROOT = path.resolve(__dirname, '..');

test('a file is disposable only when THIS video was scanned and the date is pinned', () => {
  assert.equal(decideAnalysisState({ scannedDone: false, datePinned: false }), '');
  assert.equal(decideAnalysisState({ scannedDone: false, datePinned: true }), '',
    'a pin without a scan of this video is not a licence to delete it');
  assert.equal(decideAnalysisState({ scannedDone: true, datePinned: false }), ANALYSIS_STATE.SCANNED,
    'a scan that is not pixel-verified keeps the file');
  assert.equal(decideAnalysisState({ scannedDone: true, datePinned: true }), ANALYSIS_STATE.DISPOSABLE);
});

test('a date suffix does not invent a different day, and the id survives a leading underscore', () => {
  assert.equal(catalogDateOf('20220606b'), '20220606');
  assert.equal(catalogDateOf(''), '');
  assert.equal(videoIdFromMediaPath('D:/x/20220606__9o5_4iZ0zjI.mp4'), '_9o5_4iZ0zjI');
  assert.equal(videoIdFromMediaPath('downloads_1080p/20220113_OM75fh5W6GA.mp4'), 'OM75fh5W6GA');
  assert.equal(videoIdFromMediaPath('downloads_1080p/Vn-EBl95hes.mp4'), 'Vn-EBl95hes');
});

test('a pinned date does not make the upload the scan did not read disposable', () => {
  // 20220606 is three uploads. The scan read one of them.
  const rows = [
    { video_id: 'aaIlqb7HUJQ', upload_date: '20220606' },
    { video_id: 'Axs8VyUKFRk', upload_date: '20220606' },
    { video_id: 'ST8lvpOVjeM', upload_date: '20220606' },
  ];
  const done = new Map([['aaIlqb7HUJQ', { date: '20220606' }]]);
  const pinned = new Set(['20220606']);
  const classified = classifyRows(rows, done, pinned);
  const byId = new Map(classified.map((row) => [row.video_id, row.analysis_state]));
  assert.equal(byId.get('aaIlqb7HUJQ'), 'disposable');
  assert.equal(byId.get('Axs8VyUKFRk'), '', 'the sibling was not the file the scan read');
  assert.equal(byId.get('ST8lvpOVjeM'), '');
});

test('a done log with no video path does not flag the date', () => {
  const logs = ['a.json', 'b.json'];
  const files = {
    'a.json': JSON.stringify({ status: 'done', date_key: '20220606' }),
    'b.json': JSON.stringify({
      status: 'done',
      date_key: '20220412',
      video_path: 'C:/x/20220412_WHXexample1.mp4',
    }),
  };
  const done = doneScansFromLogs(logs, (file) => files[file]);
  assert.equal(done.has(''), false);
  assert.equal(done.size, 1);
  assert.equal(done.get('WHXexample1').date, '20220412');
});

test('a log that did not succeed does not flag the video', () => {
  const done = doneScansFromLogs(['a.json'], () => JSON.stringify({
    status: 'error',
    date_key: '20220412',
    video_path: 'C:/x/20220412_WHXexample1.mp4',
  }));
  assert.equal(done.size, 0);
});

test('the writer refuses a value the vocabulary does not have, and adds the column', () => {
  const dbPath = path.join(os.tmpdir(), `analysis-state-${process.pid}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE videos (
      video_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'scanning'
    )`);
    db.prepare('INSERT INTO videos (video_id) VALUES (?)').run('abc');
    assert.throws(() => writeAnalysisState(db, 'abc', 'done'),
      /not one of/, 'status vocabulary must not be writable as the deletion flag');
    assert.equal(writeAnalysisState(db, 'abc', 'disposable'), 1);
    const row = db.prepare('SELECT analysis_state FROM videos WHERE video_id = ?').get('abc');
    assert.equal(row.analysis_state, 'disposable');
    assert.equal(db.prepare('SELECT status FROM videos WHERE video_id = ?').get('abc').status, 'scanning',
      'writing the flag does not touch status');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('the report never deletes, and a missing column is added rather than assumed', () => {
  const report = fs.readFileSync(path.join(ROOT, 'tools', 'reportDeletableVideos.js'), 'utf8');
  assert.doesNotMatch(report, /unlink|rmSync|fs\.rm\(|fs\.unlink/);
  assert.match(report, /ensureAnalysisStateColumn/);
  const store = fs.readFileSync(path.join(ROOT, 'src', 'video', 'analysisStateStore.js'), 'utf8');
  assert.match(store, /ALTER TABLE videos ADD COLUMN analysis_state/);
  const scan = fs.readFileSync(path.join(ROOT, 'tools', 'scanVideoWithOcr.js'), 'utf8');
  assert.match(scan, /if \(status === 'done'\) recordAnalysisFlag/);
});
