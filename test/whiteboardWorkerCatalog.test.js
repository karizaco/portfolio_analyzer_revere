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
      'rows = c.execute("select video_id, upload_date, title, channel, source_url from videos order by video_id").fetchall()',
      'print(json.dumps(rows))',
      '',
    ].join('\n'), 'utf8');
  }
  const r = spawnSync(PY.cmd, [...PY.args, script, dbPath], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

/** The catalog's audit table: one row per run, with its pointer and its kind. */
function readRuns(dbPath) {
  const script = path.join(path.dirname(dbPath), 'read_runs.py');
  fs.writeFileSync(script, [
    'import sqlite3, json, sys',
    'c = sqlite3.connect(sys.argv[1])',
    'c.row_factory = sqlite3.Row',
    'rows = [dict(r) for r in c.execute("select source_url, channel, raw_output_path, kind from catalog_runs")]',
    'print(json.dumps(rows))',
    '',
  ].join('\n'), 'utf8');
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

  await t.test('fill-dates never builds a channel URL from the channel name', () => {
    // The channel slug is NOT the YouTube handle and the two do not
    // round-trip: 'revere' is listed at @revereasset, and @revere is a
    // DIFFERENT channel that returns completely disjoint video IDs. A
    // source_url built by interpolating the slug therefore points every
    // row at the wrong channel.
    const fillRoot = path.join(tmp, 'fill-url-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_url.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240606\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const input = path.join(tmp, 'wanted_url.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'revere',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const row = videos.find((v) => v[0] === 'aaa111');
    assert.ok(row, 'the video was written');
    assert.strictEqual(row[4], 'https://www.youtube.com/@revereasset/videos',
      'the row carries the channel\'s real URL, not one built from the slug');
    assert.ok(!String(row[4]).includes('@revere/videos'),
      'the unrelated @revere channel is never used');
  });

  await t.test('fill-dates keeps the source_url a row already has', () => {
    // An empty source_url must not blank the one a row already carries --
    // the upsert is non-destructive for source_url the same way it is for
    // status and download_path.
    const fillRoot = path.join(tmp, 'fill-keep-url-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_keep.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240707\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const input = path.join(tmp, 'wanted_keep.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    // A row that already knows where it came from.
    const seed = path.join(tmp, 'seed_keep.py');
    fs.writeFileSync(seed, [
      'import sqlite3, sys',
      'c = sqlite3.connect(sys.argv[1])',
      "c.execute(\"insert into videos (video_id, source_url, video_url, title, upload_date, channel, status, created_at, updated_at) values ('aaa111', 'https://www.youtube.com/@somewhereelse/videos', 'https://www.youtube.com/watch?v=aaa111', 'Old', '', 'other', 'pending', '2024-01-01', '2024-01-01')\")",
      'c.commit()',
      '',
    ].join('\n'), 'utf8');
    const seeded = spawnSync(PY.cmd, [...PY.args, seed, path.join(fillRoot, 'state.sqlite')], { encoding: 'utf8' });
    assert.strictEqual(seeded.status, 0, seeded.stderr);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'not-a-known-channel',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const row = videos.find((v) => v[0] === 'aaa111');
    assert.strictEqual(row[4], 'https://www.youtube.com/@somewhereelse/videos',
      'the source_url the row already had was not blanked');
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

  // ---------------------------------------------------------------------
  // The gap-fill has to be runnable from a fresh clone.
  //
  // It used to need a work-list file that only existed on the machine that
  // made it -- the script that built it lived in the temp directory, not in
  // the repository -- so `fill-dates --input` was a dead end for anyone else.
  // The listing and the database are the only two inputs, and both are
  // reproducible, so the work list is now derived from them.
  // ---------------------------------------------------------------------

  await t.test('fill-dates reads a listing whose separator is a literal backslash-t', () => {
    // The listing in CLAUDE.md is produced through a shell, and the shell hands
    // yt-dlp the two characters backslash-t, which yt-dlp prints verbatim. A
    // reader that splits on a real tab sees one field per line, so the whole
    // line -- id AND title -- becomes the video_id, and every fetch is a miss.
    const fillRoot = path.join(tmp, 'fill-literal-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_literal.py');
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

    const listing = path.join(tmp, 'listing_literal.tsv');
    fs.writeFileSync(listing, [
      'aaa111\\tFirst listed',
      'bbb222\\tSecond listed',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--from-listing', listing,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.requested, 2, 'both listed videos were wanted');
    assert.strictEqual(json.dated, 2, 'both were dated');

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const byId = new Map(videos.map((v) => [v[0], v]));
    assert.strictEqual(byId.get('aaa111')[0], 'aaa111', 'the id was split off the title');
    assert.strictEqual(byId.get('aaa111')[1], '20240505');
  });

  await t.test('fill-dates derives the work list from a listing and the database', () => {
    // A video that already has a date needs nothing. The work list is the
    // listing minus the dated videos -- the listing is the channel's ground
    // truth of what exists, the database is the record of what is resolved.
    const fillRoot = path.join(tmp, 'fill-derive-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_derive.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240606\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    // Seed the database with one video that already has a date.
    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);
    const seed = path.join(tmp, 'seed_dated.py');
    fs.writeFileSync(seed, [
      'import sqlite3, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'c.execute("insert into videos (video_id, source_url, video_url, title, upload_date, channel, status, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)",',
      '  ("dated111", "https://example.com/x", "https://example.com/x", "Already dated", "20240101", "test", "pending", "2024-01-01", "2024-01-01"))',
      'c.commit()',
      '',
    ].join('\n'), 'utf8');
    const seedRun = spawnSync(PY.cmd, [...PY.args, seed, path.join(fillRoot, 'state.sqlite')], { encoding: 'utf8' });
    assert.strictEqual(seedRun.status, 0, seedRun.stderr);

    const listing = path.join(tmp, 'listing_derive.tsv');
    fs.writeFileSync(listing, [
      'dated111\tAlready dated',
      'new111\tNeeds a date',
      'new222\tAlso needs a date',
      '',
    ].join('\n'), 'utf8');

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--from-listing', listing,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.requested, 2, 'the dated video was not wanted again');
    assert.strictEqual(json.dated, 2);
  });

  await t.test('fill-dates builds the listing itself when told to', () => {
    // The whole point: with --build-listing the gap-fill needs nothing but the
    // channel and the database, so it runs on a fresh clone.
    const fillRoot = path.join(tmp, 'fill-build-listing-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_build_listing.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'if "--batch-file" in args:',
      '    path = args[args.index("--batch-file") + 1]',
      '    for line in open(path, encoding="utf-8"):',
      '        url = line.strip()',
      '        if not url: continue',
      '        vid = url.split("v=")[-1]',
      '        sys.stdout.write(vid + "\\t20240707\\tFilled " + vid + "\\n")',
      'else:',
      '    sys.stdout.write("lst111\\tListed one\\n")',
      '    sys.stdout.write("lst222\\tListed two\\n")',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--build-listing',
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.requested, 2, 'both listed videos were wanted');
    assert.strictEqual(json.dated, 2);

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const byId = new Map(videos.map((v) => [v[0], v]));
    assert.strictEqual(byId.get('lst111')[1], '20240707');
  });

  await t.test('fill-dates keeps the title of a video it could not date', () => {
    // An age-restricted video is still a video, and the listing knows its
    // title. If the title is thrown away, the one fact about that video lives
    // only in a scratch file that is not in version control.
    const fillRoot = path.join(tmp, 'fill-title-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_no_title.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    if vid == "blocked999": continue',
      '    sys.stdout.write(vid + "\\t20240808\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    const listing = path.join(tmp, 'listing_title.tsv');
    fs.writeFileSync(listing, [
      'ok111\tFine video',
      'blocked999\tThe blocked one',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--from-listing', listing,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.still_missing_count, 1);
    assert.strictEqual(json.titles_written, 1, 'the undated video kept its title');

    const videos = readVideos(path.join(fillRoot, 'state.sqlite'));
    const byId = new Map(videos.map((v) => [v[0], v]));
    assert.strictEqual(byId.get('blocked999')[2], 'The blocked one', 'the title was stored');
    assert.strictEqual(byId.get('blocked999')[1], '', 'and it still has no date');
  });

  await t.test('fill-dates records the run in the catalog history', () => {
    // The campaign that built the catalog left no run row, so the audit table
    // described a run that was not the one that did the work. Every fill-dates
    // run records itself, the same way a catalog run does.
    const fillRoot = path.join(tmp, 'fill-history-pipeline');
    const fake = path.join(tmp, 'fake_yt_dlp_history.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240909\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(runWorker(['--pipeline-root', fillRoot, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_history.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const r = runWorker([
      '--pipeline-root', fillRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const script = path.join(fillRoot, 'read_runs.py');
    fs.writeFileSync(script, [
      'import sqlite3, json, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'rows = c.execute("select channel, row_count, inserted_count, updated_count, missing_upload_dates from catalog_runs").fetchall()',
      'print(json.dumps(rows))',
      '',
    ].join('\n'), 'utf8');
    const read = spawnSync(PY.cmd, [...PY.args, script, path.join(fillRoot, 'state.sqlite')], { encoding: 'utf8' });
    assert.strictEqual(read.status, 0, read.stderr);
    const runs = JSON.parse(read.stdout.trim());
    assert.strictEqual(runs.length, 1, 'the run was recorded');
    assert.strictEqual(runs[0][0], 'test');
    assert.strictEqual(runs[0][1], 1, 'one video was requested');
    assert.strictEqual(runs[0][4], 0, 'and none was left without a date');
  });

  // A fake yt-dlp that fills in every video it is given.
  function writeFillingFake(name) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, [
      'import sys',
      'args = sys.argv[1:]',
      'path = args[args.index("--batch-file") + 1]',
      'for line in open(path, encoding="utf-8"):',
      '    url = line.strip()',
      '    if not url: continue',
      '    vid = url.split("v=")[-1]',
      '    sys.stdout.write(vid + "\\t20240909\\tFilled " + vid + "\\n")',
      '',
    ].join('\n'), 'utf8');
    return file;
  }

  await t.test('a run inside the repository records a repository-relative path', () => {
    // `catalog_runs.raw_output_path` held an absolute Windows path, so every
    // pointer in the audit table resolved on the machine that made the run and
    // nowhere else. A path inside the repository is now stored relative to the
    // repository root, so it means the same thing on every machine.
    const inRepo = path.join(ROOT, 'data', 'video_pipeline', '_test_portable_path');
    t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));

    const fake = writeFillingFake('fake_yt_dlp_portable.py');
    assert.strictEqual(runWorker(['--pipeline-root', inRepo, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_portable.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const r = runWorker([
      '--pipeline-root', inRepo, 'fill-dates',
      '--channel', 'test',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const runs = readRuns(path.join(inRepo, 'state.sqlite'));
    assert.strictEqual(runs.length, 1);
    const stored = runs[0].raw_output_path;
    assert.ok(!path.isAbsolute(stored), `expected a relative path, got ${stored}`);
    assert.ok(
      stored.startsWith('data/video_pipeline/_test_portable_path/'),
      `expected a path inside the repository, got ${stored}`,
    );
    assert.strictEqual(runs[0].kind, 'live');
  });

  await t.test('a run outside the repository keeps its absolute path', () => {
    // There is no relative form for a path outside the repository. Converting
    // it would only make it wrong in a different way, so it is left alone.
    const outsideRoot = path.join(tmp, 'pipeline-outside');
    const fake = writeFillingFake('fake_yt_dlp_outside.py');
    assert.strictEqual(runWorker(['--pipeline-root', outsideRoot, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_outside.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const r = runWorker([
      '--pipeline-root', outsideRoot, 'fill-dates',
      '--channel', 'test',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const runs = readRuns(path.join(outsideRoot, 'state.sqlite'));
    assert.strictEqual(runs.length, 1);
    assert.ok(
      path.isAbsolute(runs[0].raw_output_path),
      `expected an absolute path, got ${runs[0].raw_output_path}`,
    );
  });

  await t.test('a run that is not a channel is marked as a fixture', () => {
    // The worker's own fixtures point at example.com/mock-playlist. They were
    // self-labelling, but they still made up a sixth of the audit table, and a
    // reader had to know that to discount them.
    const fixtureRoot = path.join(tmp, 'pipeline-fixture');
    const fake = writeFillingFake('fake_yt_dlp_fixture.py');
    assert.strictEqual(runWorker(['--pipeline-root', fixtureRoot, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_fixture.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const r = runWorker([
      '--pipeline-root', fixtureRoot, 'fill-dates',
      '--channel', 'test',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const runs = readRuns(path.join(fixtureRoot, 'state.sqlite'));
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].kind, 'fixture');
    assert.strictEqual(runs[0].source_url, '');
  });

  await t.test('a run reports the catalog rows its listing did not contain', () => {
    // A channel's `/videos` listing is the channel's ground truth of what it
    // currently shows, so a row the catalog holds and the listing does not is
    // worth reporting. It is NOT proof of deletion -- a video that became a
    // Short, a livestream or members-only content is not listed there either
    // -- so nothing is deleted. The run says which rows it did not list.
    const fake = writeFakeYtDlp(tmp, [['aaa111', '20240101', 'First video']], 0);
    const before = readVideos(path.join(pipelineRoot, 'state.sqlite')).map((v) => v[0]).sort();
    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.not_listed_count, 6,
      'every row the listing did not contain is reported');
    assert.deepStrictEqual(
      json.not_listed_video_ids.slice().sort(),
      ['bbb222', 'ccc333', 'ddd444', 'fff666', 'ggg777', 'hhh888'],
      'and they are the right ones: every row of the catalog except the one the listing had',
    );
    assert.strictEqual(json.listing_complete, true, 'an untruncated run with no errors saw everything');

    // Nothing was deleted, and the count is in the audit row too.
    const videos = readVideos(path.join(pipelineRoot, 'state.sqlite'));
    assert.deepStrictEqual(videos.map((v) => v[0]).sort(), before,
      'every row is still there -- a row missing from a listing is an observation, not a deletion');

    const script = path.join(pipelineRoot, 'read_not_listed.py');
    fs.writeFileSync(script, [
      'import sqlite3, json, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'rows = c.execute("select not_listed_count, listing_complete from catalog_runs order by run_id desc limit 1").fetchall()',
      'print(json.dumps(rows))',
      '',
    ].join('\n'), 'utf8');
    const read = spawnSync(PY.cmd, [...PY.args, script, path.join(pipelineRoot, 'state.sqlite')], { encoding: 'utf8' });
    assert.strictEqual(read.status, 0, read.stderr);
    const audit = JSON.parse(read.stdout.trim())[0];
    assert.strictEqual(audit[0], 6, 'the audit row records the count');
    assert.strictEqual(audit[1], 1,
      'and records that the listing covered the whole channel, so the count can be read');
  });

  await t.test('a truncated run says its listing may be incomplete', () => {
    // `--limit` truncates the listing, so a row the run did not list proves
    // nothing about whether the channel still has it. The report has to say
    // the listing cannot be shown to be complete.
    const fake = writeFakeYtDlp(tmp, [['aaa111', '20240101', 'First video']], 0);
    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--limit', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.strictEqual(json.listing_complete, false,
      'a --limit run cannot prove it saw the whole channel');
    assert.ok(json.not_listed_count > 0, 'the rows it did not list are still reported');
  });

  await t.test('a listing with no title does not blank the title a row has', () => {
    // The upsert is non-destructive for the fields a listing may not carry.
    // An empty title from a partial listing must not erase a good one.
    const fake = path.join(tmp, 'fake_yt_dlp_empty_title.py');
    fs.writeFileSync(fake, [
      'import sys',
      'sys.stdout.write("aaa111\\t20240101\\t\\n")',
      '',
    ].join('\n'), 'utf8');

    const r = runWorker([
      '--pipeline-root', pipelineRoot, 'catalog',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--channel', 'test',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const videos = readVideos(path.join(pipelineRoot, 'state.sqlite'));
    const row = videos.find((v) => v[0] === 'aaa111');
    assert.strictEqual(row[2], 'First video', 'the title the row already had survived');
  });

  await t.test('status reports a run path you can open', () => {
    // The stored path is relative to the repository, so it means the same
    // thing on every machine. The status report resolves it back, because the
    // person reading it wants to open the file.
    const inRepo = path.join(ROOT, 'data', 'video_pipeline', '_test_status_path');
    t.after(() => fs.rmSync(inRepo, { recursive: true, force: true }));

    const fake = writeFillingFake('fake_yt_dlp_status.py');
    assert.strictEqual(runWorker(['--pipeline-root', inRepo, 'init']).status, 0);

    const input = path.join(tmp, 'wanted_status.tsv');
    fs.writeFileSync(input, 'aaa111\tFirst\n', 'utf8');

    const filled = runWorker([
      '--pipeline-root', inRepo, 'fill-dates',
      '--channel', 'test',
      '--source-url', 'https://www.youtube.com/@test/videos',
      '--input', input,
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ]);
    assert.strictEqual(filled.status, 0, filled.stderr);

    const r = runWorker(['--pipeline-root', inRepo, 'status']);
    assert.strictEqual(r.status, 0, r.stderr);
    const json = readJson(r.stdout);
    assert.ok(json.latest_catalog_run, 'the run is reported');
    assert.strictEqual(json.latest_catalog_run.kind, 'live');
    assert.ok(
      path.isAbsolute(json.latest_catalog_run.raw_output_path),
      `expected a path you can open, got ${json.latest_catalog_run.raw_output_path}`,
    );
    assert.ok(
      json.latest_catalog_run.raw_output_path.includes('_test_status_path'),
      json.latest_catalog_run.raw_output_path,
    );
  });

  await t.test('the migration repairs a run table written by an older worker', () => {
    // A database written before this change has no `kind` column and holds
    // absolute paths. Opening it has to fix both -- otherwise the committed
    // catalog keeps pointers that resolve on no other machine, and a reader
    // has to know that the mock rows are not real runs.
    const legacyRoot = path.join(tmp, 'pipeline-legacy');
    fs.mkdirSync(legacyRoot, { recursive: true });
    const legacyDb = path.join(legacyRoot, 'state.sqlite');

    const inRepoPath = path.join(ROOT, 'data', 'video_pipeline', 'catalog', 'catalog_20260101T000000Z.tsv');
    const outsidePath = path.join(tmp, 'elsewhere', 'catalog_20260102T000000Z.tsv');

    const mk = path.join(tmp, 'make_legacy_db.py');
    fs.writeFileSync(mk, [
      'import sqlite3, json, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'c.execute("create table catalog_runs (run_id integer primary key autoincrement, source_url text not null, channel text not null default \'\', command_json text not null, raw_output_path text not null, row_count integer not null, inserted_count integer not null, updated_count integer not null, missing_upload_dates integer not null, malformed_rows integer not null, created_at text not null)")',
      'c.executemany("insert into catalog_runs (source_url, channel, command_json, raw_output_path, row_count, inserted_count, updated_count, missing_upload_dates, malformed_rows, created_at) values (?,?,?,?,?,?,?,?,?,?)", json.loads(sys.argv[2]))',
      'c.commit()',
      '',
    ].join('\n'), 'utf8');

    const rows = [
      ['https://example.com/mock-playlist', 'revere', '[]', inRepoPath, 1, 1, 0, 0, 0, '2026-01-01 00:00:00'],
      ['https://www.youtube.com/@revereasset/videos', 'revere', '[]', outsidePath, 1, 1, 0, 0, 0, '2026-01-01 00:00:00'],
    ];
    const made = spawnSync(PY.cmd, [...PY.args, mk, legacyDb, JSON.stringify(rows)], { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);

    const r = runWorker(['--pipeline-root', legacyRoot, '--db-path', legacyDb, 'init']);
    assert.strictEqual(r.status, 0, r.stderr);

    const runs = readRuns(legacyDb);
    assert.strictEqual(runs.length, 2);
    const fixture = runs.find((x) => x.source_url.includes('example.com'));
    const live = runs.find((x) => x.source_url.includes('youtube.com'));
    assert.strictEqual(fixture.kind, 'fixture');
    assert.strictEqual(live.kind, 'live');
    assert.strictEqual(
      fixture.raw_output_path,
      'data/video_pipeline/catalog/catalog_20260101T000000Z.tsv',
      'a path inside the repository became relative',
    );
    assert.strictEqual(
      live.raw_output_path,
      outsidePath,
      'a path outside it was left alone',
    );
  });
});
