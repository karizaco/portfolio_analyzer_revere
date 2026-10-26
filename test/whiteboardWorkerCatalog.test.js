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
const { spawnSync, spawn } = require('node:child_process');

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

/** Wait for the fake yt-dlp to record its own pid, then return it. */
async function waitForPid(pidFile, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the fake yt-dlp never reported its pid');
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

    // The run has to say WHICH videos failed, not just how many. yt-dlp
    // prints one "ERROR: [youtube] <id>" line per failed video, and that is
    // the list the next run has to go and fetch -- so it is kept next to
    // the snapshot instead of being discarded with the exit code.
    const stderrPath = json.yt_dlp_stderr_path;
    assert.ok(stderrPath, 'the summary names the file yt-dlp said why in');
    assert.ok(fs.existsSync(stderrPath), 'the stderr file exists');
    assert.match(fs.readFileSync(stderrPath, 'utf8'), /eee555/);

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

  await t.test('a killed yt-dlp still yields the rows it printed', async () => {
    // The harvest path. A long catalog run is worth interrupting — the
    // client set can be tuned, the machine is busy, the user wants it
    // stopped — and the rows yt-dlp already printed are complete records.
    // Killing the yt-dlp child must therefore import them, not discard
    // them the way a non-zero exit used to.
    const pidFile = path.join(tmp, 'fake_pid.txt');
    const file = path.join(tmp, 'fake_yt_dlp_hang.py');
    fs.writeFileSync(file, [
      'import os, sys, time',
      `open(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))`,
      'sys.stdout.write("ggg777\\t20240107\\tSeventh video\\n")',
      'sys.stdout.write("hhh888\\t20240108\\tEighth video\\n")',
      'sys.stdout.flush()',
      'time.sleep(300)',
      '',
    ].join('\n'), 'utf8');

    const worker = spawn(PY.cmd, [...PY.args, WORKER,
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', file,
    ], { cwd: ROOT, encoding: 'utf8' });

    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', (d) => { stdout += d; });
    worker.stderr.on('data', (d) => { stderr += d; });

    // Wait for the fake to say it is running, then kill THAT process — the
    // yt-dlp child, not the worker, which has to survive to do the import.
    const grandchildPid = await waitForPid(pidFile);
    spawnSync('taskkill', ['/PID', String(grandchildPid), '/F'], { encoding: 'utf8' });

    const code = await new Promise((resolve) => worker.on('exit', resolve));

    assert.strictEqual(code, 0, 'the worker finished the import');
    const json = readJson(stdout);
    assert.strictEqual(json.cataloged_rows, 2, 'the rows yt-dlp printed before it was killed');
    assert.strictEqual(json.status, 'partial');
    assert.match(stderr, /importing them/i);

    const videos = readVideos(path.join(pipelineRoot, 'state.sqlite'));
    const ids = videos.map((v) => v[0]);
    assert.ok(ids.includes('ggg777'), 'the rows printed before the kill are imported');
    assert.ok(ids.includes('hhh888'), 'the rows printed before the kill are imported');
  });

  await t.test('fill-dates resolves the dates the catalog could not', () => {
    // The gap-filler: the catalog resolves a channel one video at a time, so
    // the videos it fails on are left with no date at all. fill-dates takes
    // that list and resolves it directly, in parallel batches.
    //
    // Its own pipeline root: the catalog tests above share one, and their
    // rows already have dates, which fill-dates skips.
    const fillRoot = path.join(tmp, 'fill-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_dates.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    if vid == "skip888": continue',   // this one fails, like a blocked video
      '    sys.stdout.write(vid + "\\t20240202\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const input = path.join(tmp, 'wanted.tsv');
    fs.writeFileSync(input, [
      'aaa111\tFirst wanted',
      'bbb222\tSecond wanted',
      'skip888\tWill fail',
      'ccc333\tThird wanted',
      '',
    ].join('\n'), 'utf8');

    const r = runWorker([
      '--pipeline-root', fillRoot, 'init',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const run = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '2',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(run.status, 0, run.stderr);
    const json = readJson(run.stdout);
    assert.strictEqual(json.requested, 4);
    assert.strictEqual(json.dated, 3, 'the three videos the fake resolved');
    assert.strictEqual(json.still_missing_count, 1);
    assert.deepStrictEqual(json.still_missing, ['skip888']);

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const byId = new Map(videos.map((v) => [v[0], v]));
    assert.strictEqual(byId.get('aaa111')[2], 'Filled aaa111', 'the title came from yt-dlp');
    assert.strictEqual(byId.get('aaa111')[1], '20240202', 'the date landed');
    assert.strictEqual(byId.get('aaa111')[3], 'test', 'the channel landed');
  });

  await t.test('fill-dates saves each batch as it lands', () => {
    // A run over thousands of videos is long enough to be worth stopping, so
    // the rows a finished batch produced must already be in the database --
    // not sitting in memory until the very end.
    //
    // The fake dies on the SECOND batch. The first batch's rows must survive
    // that, which they only do if the save happens per batch.
    const fillRoot = path.join(tmp, 'fill-batches-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_batches.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'ids = [l.strip().split("v=")[-1] for l in open(path, encoding="utf-8") if l.strip()]',
      'if ids[0].startswith("bbb"):',
      '    sys.stderr.write("ERROR: [youtube] " + ids[0] + ": Unable to download API page\\n")',
      '    sys.exit(1)',
      'for vid in ids:',
      '    sys.stdout.write(vid + "\\t20240303\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const input = path.join(tmp, 'wanted_batches.tsv');
    fs.writeFileSync(input, [
      'aaa111\tFirst',
      'bbb222\tSecond',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--batch-size', '1',   // one video per batch, so the second batch is the failing one
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.dated, 1, 'the batch that worked was dated');
    assert.deepStrictEqual(json.still_missing, ['bbb222'], 'the batch that failed is reported');

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const byId = new Map(videos.map((v) => [v[0], v]));
    assert.strictEqual(byId.get('aaa111')[1], '20240303',
      'the first batch was saved even though the run went on to fail');
  });

  await t.test('fill-dates skips videos that already have a date', () => {
    // The second pass. A video with a date needs nothing, so a re-run of the
    // same list only fetches the stragglers -- which is what makes the
    // slow fallback client affordable: it runs over the stragglers only.
    const fillRoot = path.join(tmp, 'fill-skip-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_skip.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240505\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const input = path.join(tmp, 'wanted_skip.tsv');
    fs.writeFileSync(input, [
      'aaa111\tFirst',
      'bbb222\tSecond',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const first = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(readJson(first.stdout).dated, 2);

    // Second pass: the fake would resolve both again, but neither is asked.
    const second = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(second.status, 0, second.stderr);
    const json = readJson(second.stdout);
    assert.strictEqual(json.requested, 2, 'both were asked for');
    assert.strictEqual(json.skipped, 2, 'both were skipped');
    assert.strictEqual(json.attempted, 0, 'neither was fetched again');
    assert.strictEqual(json.dated, 0, 'there was nothing left to date');
  });

  await t.test('fill-dates tries the fast client first', () => {
    // `mweb` resolved the same videos far faster than `ios,android,web`
    // (4.2 s vs 123 s per video, measured on the same list), and yt-dlp
    // queries EVERY client in the list, so extra clients cost time on every
    // video -- not only on the ones that fail.
    const fillRoot = path.join(tmp, 'fill-client-pipeline');
    const argvFile = path.join(tmp, 'argv.txt');
    const fake = path.join(tmp, 'fake_yt_dlp_argv.py');
    fs.writeFileSync(fake, [
      'import sys, json',
      'open(' + JSON.stringify(argvFile) + ', "w", encoding="utf-8").write(json.dumps(sys.argv))',
      'sys.exit(0)',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_client.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    const at = argv.indexOf('--extractor-args');
    assert.ok(at >= 0, '--extractor-args reaches yt-dlp');
    const clients = argv[at + 1].replace('youtube:player_client=', '').split(',');
    assert.deepStrictEqual(clients, ['mweb'], 'the fast client is the default, and only it');
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
