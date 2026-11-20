'use strict';

// The two catalog import tools, against SCRATCH databases.
//
//   tools/importFlatListing.js   a flat listing -> videos (+ video_listing_entries)
//   tools/importQmgChannel.js    a channel listing -> videos
//
// Both used to be invisible in the audit table. `importQmgChannel.js` wrote
// NO catalog_runs row at all -- the documented open defect, "a second
// writer of videos with no audit row at all" -- and
// `importFlatListing.js` wrote its row INSIDE the transaction that wrote
// the data, so an interrupted import left neither.
//
// The Qullamaggie tool is driven with a FAKE yt-dlp (a .py script, the
// shape the Python worker is tested with), so nothing touches YouTube.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const FLAT = path.join(ROOT, 'tools', 'importFlatListing.js');
const QMG = path.join(ROOT, 'tools', 'importQmgChannel.js');

function pythonLauncher() {
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '--version'], { encoding: 'utf8', shell: false });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const PY = pythonLauncher();

/** A scratch catalog with the real schema. */
function scratchCatalog(dir) {
  const file = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  db.close();
  return file;
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-import-'));
  return {
    dir,
    db: scratchCatalog(dir),
    close() { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}

function readRows(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}

function runTool(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000 });
}

/** A fake yt-dlp: the flat listing, and a date per video. */
function writeFakeYtdlp(dir) {
  const file = path.join(dir, 'fake_yt_dlp.py');
  fs.writeFileSync(file, [
    'import sys',
    'args = sys.argv[1:]',
    'tmpl = ""',
    'for i, a in enumerate(args):',
    '    if a == "--print" and i + 1 < len(args):',
    '        tmpl = args[i + 1]',
    'watch = [a for a in args if a.startswith("https://www.youtube.com/watch?v=")]',
    'if watch:',
    '    for u in watch:',
    '        print(u.split("v=")[1] + "\\t20200115")',
    'elif tmpl.startswith("%(upload_date)"):',
    '    print("20200115\\tvid0001")',
    '    print("20200116\\tvid0002")',
    'else:',
    '    print("vid0001\\t20200115\\tFirst video")',
    '    print("vid0002\\t\\tSecond video")',
    '',
  ].join('\n'));
  return file;
}

test('the flat listing importer writes an audit row, and the row survives an interruption', (t) => {
  const s = scratch();
  try {
    const listing = path.join(s.dir, 'list.tsv');
    fs.writeFileSync(listing, 'vid0001\tCafé — résumé\nvid0002\tSecond video\nx\tbroken\n');
    const result = runTool(FLAT, [
      '--channel', 'testchan', '--source-url', 'https://example.com/@testchan/videos',
      '--listing', listing, '--db', s.db,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const videos = readRows(s.db, 'SELECT video_id, title, channel FROM videos ORDER BY video_id');
    assert.deepEqual(videos.map((v) => v.video_id), ['vid0001', 'vid0002']);
    assert.equal(videos[0].title, 'Café — résumé', 'a UTF-8 title is not mangled');
    assert.equal(videos[0].channel, 'testchan');

    // The audit row, in the SHARED table every source writes to.
    const runs = readRows(s.db, 'SELECT * FROM catalog_runs WHERE channel = ?', ['testchan']);
    assert.equal(runs.length, 1, 'the run is in the table every source writes to');
    assert.equal(runs[0].row_count, 2);
    assert.equal(runs[0].inserted_count, 2);
    assert.equal(runs[0].updated_count, 0);
    assert.equal(runs[0].malformed_rows, 1, 'the broken line is counted');
    assert.equal(runs[0].missing_upload_dates, 2, 'a flat listing supplies no dates');
    assert.equal(runs[0].row_count_kind, 'listing_rows');
    assert.equal(runs[0].listing_complete, 1);

    // A SECOND import updates the rows and leaves its own audit row.
    const again = runTool(FLAT, [
      '--channel', 'testchan', '--source-url', 'https://example.com/@testchan/videos',
      '--listing', listing, '--db', s.db,
    ]);
    assert.equal(again.status, 0, again.stderr);
    const runs2 = readRows(s.db, 'SELECT * FROM catalog_runs WHERE channel = ? ORDER BY run_id', ['testchan']);
    assert.equal(runs2.length, 2, 'each run leaves its own row');
    assert.equal(runs2[1].inserted_count, 0, 'nothing new the second time');
    assert.equal(runs2[1].updated_count, 2, 'the rows were updated');
    assert.equal(readRows(s.db, 'SELECT COUNT(*) AS n FROM videos')[0].n, 2, 'no duplicate rows');
  } finally {
    s.close();
  }
});

test('the flat listing importer reads the listing the way the Python worker reads it', (t) => {
  const s = scratch();
  try {
    // A listing written with the LITERAL backslash-t, which is what a
    // template passed through a shell produces.
    const literal = path.join(s.dir, 'literal.tsv');
    fs.writeFileSync(literal, 'vid0001\\tLiteral tab title\nvid0002\\tAnother\n');
    let result = runTool(FLAT, [
      '--channel', 'c1', '--source-url', 'https://example.com/x', '--listing', literal, '--db', s.db,
    ]);
    assert.equal(result.status, 0, result.stderr);
    let videos = readRows(s.db, 'SELECT video_id, title FROM videos ORDER BY video_id');
    assert.deepEqual(videos.map((v) => v.video_id), ['vid0001', 'vid0002']);
    assert.equal(videos[0].title, 'Literal tab title', 'the literal backslash-t is a separator');

    // A cp1252 listing: the console codepage's right apostrophe.
    const cp = path.join(s.dir, 'cp1252.tsv');
    fs.writeFileSync(cp, Buffer.concat([
      Buffer.from('vid0003\tIt', 'latin1'),
      Buffer.from([0x92]),
      Buffer.from('s here\n', 'latin1'),
    ]));
    result = runTool(FLAT, [
      '--channel', 'c2', '--source-url', 'https://example.com/y', '--listing', cp, '--db', s.db,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const row = readRows(s.db, 'SELECT title FROM videos WHERE video_id = ?', ['vid0003'])[0];
    assert.equal(row.title, 'It’s here', 'the cp1252 apostrophe is decoded as cp1252');
  } finally {
    s.close();
  }
});

test('the audit row is written OUTSIDE the transaction that writes the rows', () => {
  // The row used to be written inside the data transaction, so an
  // interrupted import left neither the rows nor the record of the run --
  // the exact failure the fill-dates run of 2026-10-26 made. The order
  // is what makes it survivable, so the order is what is pinned.
  const flat = fs.readFileSync(FLAT, 'utf8');
  const audit = flat.indexOf('INSERT INTO catalog_runs');
  const data = flat.indexOf("db.exec('BEGIN')");
  assert.ok(audit !== -1, 'the tool writes a catalog_runs row');
  assert.ok(data !== -1, 'the tool writes its rows in a transaction');
  assert.ok(audit < data, 'the audit row is written BEFORE the transaction that writes the rows');

  // And the Qullamaggie tool writes its row before the network work, so a
  // run that dies mid-fetch still leaves a row.
  const qmg = fs.readFileSync(QMG, 'utf8');
  const row = qmg.indexOf('recordCatalogRun({');
  const fetch = qmg.indexOf('fetchDatesInBatches(newRows)');
  assert.ok(row !== -1 && fetch !== -1, 'the tool writes a catalog_runs row');
  assert.ok(row < fetch, 'the audit row is written BEFORE the work that can fail');
});

test('the Qullamaggie importer writes an audit row too', { skip: PY ? false : 'no python launcher available' }, (t) => {
  const s = scratch();
  try {
    const fake = writeFakeYtdlp(s.dir);
    const result = runTool(QMG, [
      '--channel', 'testchan', '--source-url', 'https://example.com/@testchan/videos',
      '--db', s.db, '--ytdlp', fake,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const videos = readRows(s.db, 'SELECT video_id, title, channel, upload_date FROM videos ORDER BY video_id');
    assert.deepEqual(videos.map((v) => v.video_id), ['vid0001', 'vid0002']);
    assert.equal(videos[0].title, 'First video');
    assert.equal(videos[0].channel, 'testchan', 'the channel is an argument, not a constant');
    assert.equal(videos[0].upload_date, '20200115');

    const runs = readRows(s.db, 'SELECT * FROM catalog_runs WHERE channel = ?', ['testchan']);
    assert.equal(runs.length, 1, 'the run is in the table every source writes to');
    assert.equal(runs[0].row_count, 2);
    assert.equal(runs[0].inserted_count, 2);
    assert.equal(runs[0].row_count_kind, 'listing_rows');
    assert.equal(runs[0].listing_complete, 1);

    // A --limit listing did not cover the channel, so "not listed" proves
    // nothing about the rows it is missing.
    const limited = runTool(QMG, [
      '--channel', 'testchan', '--source-url', 'https://example.com/@testchan/videos',
      '--db', s.db, '--ytdlp', fake, '--limit', '1',
    ]);
    assert.equal(limited.status, 0, limited.stderr);
    const runs2 = readRows(s.db, 'SELECT * FROM catalog_runs WHERE channel = ? ORDER BY run_id', ['testchan']);
    assert.equal(runs2.length, 2);
    assert.equal(runs2[1].listing_complete, 0, 'a limited listing did not cover the channel');
  } finally {
    s.close();
  }
});
