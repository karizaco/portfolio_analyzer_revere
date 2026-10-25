'use strict';

// The catalog worker's import decision.
//
// A full Qullamaggie catalog is ~700 metadata requests and takes ~3.5 hours.
// The worker used to check yt-dlp's exit code BEFORE looking at what yt-dlp
// printed, so a DNS blip near the end of a long run made it throw away every
// row it had already collected -- three hours of good per-video metadata, gone.
//
// These tests drive the real worker (tools/whiteboard_worker.py) with a FAKE
// yt-dlp, so the behaviour is exercised without touching YouTube. The fake is
// a .py file because build_command_prefix() resolves a .py path to
// [sys.executable, path], which works the same on Windows and POSIX.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'tools', 'whiteboard_worker.py');

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

/**
 * A fake yt-dlp. `rows` are printed to stdout as `id\tdate\ttitle`;
 * `exitCode` is what it exits with.
 */
function writeFakeYtDlp(dir, rows, exitCode, stderrText) {
  const file = path.join(dir, 'fake_yt_dlp.py');
  const lines = ['import sys'];
  for (const r of rows) {
    const row = r[0] + '\t' + r[1] + '\t' + r[2] + '\n';
    lines.push('sys.stdout.write(' + JSON.stringify(row) + ')');
  }
  if (stderrText) lines.push('sys.stderr.write(' + JSON.stringify(stderrText) + ')');
  lines.push('sys.exit(' + exitCode + ')', '');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function runWorker(args, cwd) {
  return spawnSync(PY.cmd, [...PY.args, WORKER, ...args], {
    cwd: cwd || ROOT,
    encoding: 'utf8',
  });
}

function readJson(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function readVideos(dbPath) {
  // A script FILE, not `python -c`: Windows argv does not survive embedded
  // newlines in an argument.
  const script = path.join(path.dirname(dbPath), 'read_videos.py');
  if (!fs.existsSync(script)) {
    fs.writeFileSync(script, [
      'import sqlite3, json, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'rows = c.execute("select video_id, upload_date, title, channel from videos order by video_id").fetchall()',
      'print(json.dumps(rows))',
      '',
    ].join('\n'), 'utf8');
  }
  const r = spawnSync(PY.cmd, [...PY.args, script, dbPath], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test('the catalog worker', { skip: PY ? false : 'no python launcher available' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-catalog-'));
  const pipelineRoot = path.join(tmp, 'pipeline');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  await t.test('init creates the schema', () => {
    const r = runWorker(['--pipeline-root', pipelineRoot, 'init']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(pipelineRoot, 'state.sqlite')));
  });

  await t.test('imports every row when yt-dlp succeeds', () => {
    const fake = writeFakeYtDlp(tmp, [
      ['aaa111', '20240101', 'First video'],
      ['bbb222', '20240102', 'Second video'],
    ], 0);
    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.cataloged_rows, 2);
    assert.strictEqual(json.inserted, 2);
    assert.strictEqual(json.status, 'ok');
    assert.strictEqual(json.yt_dlp_returncode, 0);
  });

  await t.test('keeps the rows it did get when yt-dlp fails part way', () => {
    // The regression: yt-dlp printed two good rows and then hit a network
    // error on the third video. Those two rows are complete records for two
    // videos -- a failure on video 3 does not invalidate videos 1 and 2.
    const fake = writeFakeYtDlp(tmp, [
      ['ccc333', '20240103', 'Third video'],
      ['ddd444', '20240104', 'Fourth video'],
    ], 1, 'ERROR: [youtube] eee555: Unable to download API page\n');

    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
    ]);

    // The import happened, so the run is a success with a caveat, not a
    // failure that throws the work away.
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.cataloged_rows, 2);
    assert.strictEqual(json.status, 'partial');
    assert.strictEqual(json.yt_dlp_returncode, 1);
    assert.match(r.stderr, /importing them/i);

    const videos = readVideos(path.join(pipelineRoot, 'state.sqlite'));
    const ids = videos.map((v) => v[0]);
    assert.ok(ids.includes('ccc333'), 'the rows yt-dlp did print are imported');
    assert.ok(ids.includes('ddd444'), 'the rows yt-dlp did print are imported');
  });

  await t.test('imports nothing and fails when yt-dlp produced no rows', () => {
    const fake = writeFakeYtDlp(tmp, [], 1, 'ERROR: [youtube] Unable to resolve www.youtube.com\n');
    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
    ]);
    assert.notStrictEqual(r.status, 0, 'a catalog with no rows is a failure');
    assert.match(r.stderr, /Unable to resolve/);

    const videos = readVideos(path.join(pipelineRoot, 'state.sqlite'));
    assert.strictEqual(videos.length, 4, 'the four good rows from earlier runs are still there');
  });

  await t.test('--sleep-requests reaches yt-dlp', () => {
    const fake = writeFakeYtDlp(tmp, [['fff666', '20240106', 'Sixth video']], 0);
    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
      '--sleep-requests', '2.5',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    const cmd = json.yt_dlp_command;
    const at = cmd.indexOf('--sleep-requests');
    assert.ok(at >= 0, '--sleep-requests is in the yt-dlp command');
    assert.strictEqual(cmd[at + 1], '2.5');
  });
});
