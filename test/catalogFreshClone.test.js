'use strict';

// The gap-fill has to work from a FRESH CLONE.
//
// The script that built the work list lived in %TEMP%, so the gap-fill was a
// dead end for anyone who cloned the repository: there was no way to find the
// videos whose upload_date was still missing. `fill-dates --build-listing`
// fixed that -- the channel listing and the database are the only two inputs,
// and both are in the repository.
//
// This test is the proof. It copies the TRACKED files into a scratch
// directory -- nothing else, no untracked file, nothing left over from an
// earlier run -- and runs the gap-fill there against a fake yt-dlp. If the
// gap-fill ever needs a file that is not in git, this test fails.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

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

/** Every path git tracks, NUL-separated so a name with a space survives. */
function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

/** Copy exactly the tracked files into `dest`. Nothing else. */
function copyTrackedFiles(dest) {
  const files = trackedFiles();
  const dirs = new Set();
  for (const f of files) {
    let d = path.dirname(f);
    while (d && d !== '.' && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const d of dirs) fs.mkdirSync(path.join(dest, d), { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
  return files;
}

function runPython(script, args) {
  return spawnSync(PY.cmd, [...PY.args, script, ...args], { encoding: 'utf8' });
}

test('the gap-fill runs from a fresh clone', { skip: PY ? false : 'no python launcher available' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-fresh-clone-'));
  const clone = path.join(tmp, 'clone');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  await t.test('the clone holds the tracked files and nothing else', () => {
    fs.mkdirSync(clone, { recursive: true });
    const copied = copyTrackedFiles(clone);
    assert.ok(copied.length > 100, `expected a real tree, copied ${copied.length}`);
    assert.ok(
      fs.existsSync(path.join(clone, 'tools', 'whiteboard_worker.py')),
      'the worker is there',
    );
    assert.ok(
      fs.existsSync(path.join(clone, 'data', 'db', 'schema.sql')),
      'the schema is there',
    );
    assert.ok(
      fs.existsSync(path.join(clone, 'data', 'video_pipeline', 'state.sqlite')),
      'the catalog is there',
    );
    // The whole point: nothing untracked is available to the run.
    assert.ok(
      !fs.existsSync(path.join(clone, 'data', 'catalog_flat')),
      'the local listing cache is not in the clone',
    );
  });

  await t.test('the gap-fill resolves a missing date with only those files', () => {
    // Seed the clone's catalog with one video that already has a date, so the
    // listing has something to skip.
    const seed = path.join(tmp, 'seed_db.py');
    fs.writeFileSync(seed, [
      'import sqlite3, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'c.execute("insert into videos (video_id, upload_date, title, channel, source_url, created_at, updated_at) values (?,?,?,?,?,?,?)",',
      '    ("known111", "20260101", "Known video", "freshclone", "https://www.youtube.com/@freshclone/videos", "2026-01-01 00:00:00", "2026-01-01 00:00:00"))',
      'c.commit()',
      '',
    ].join('\n'), 'utf8');
    const seeded = runPython(seed, [path.join(clone, 'data', 'video_pipeline', 'state.sqlite')]);
    assert.strictEqual(seeded.status, 0, seeded.stderr);

    // A fake yt-dlp that answers both questions the worker asks: what does the
    // channel contain, and when was this video uploaded.
    const fake = path.join(tmp, 'fake_yt_dlp.py');
    fs.writeFileSync(fake, [
      'import sys',
      'args = sys.argv[1:]',
      'if "--batch-file" in args:',
      '    path = args[args.index("--batch-file") + 1]',
      '    for line in open(path, encoding="utf-8"):',
      '        url = line.strip()',
      '        if not url: continue',
      '        vid = url.split("v=")[-1]',
      '        sys.stdout.write(vid + "\\t20260202\\tDated " + vid + "\\n")',
      'else:',
      '    sys.stdout.write("known111\\tKnown video\\n")',
      '    sys.stdout.write("new222\\tBrand new video\\n")',
      '',
    ].join('\n'), 'utf8');

    const worker = path.join(clone, 'tools', 'whiteboard_worker.py');
    const r = spawnSync(PY.cmd, [...PY.args, worker,
      'fill-dates',
      '--channel', 'freshclone',
      '--source-url', 'https://www.youtube.com/@freshclone/videos',
      '--build-listing',
      '--jobs', '1',
      '--yt-dlp-bin', fake,
    ], { cwd: clone, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /Listed 2 videos/, 'the listing was fetched inside the clone');

    const check = path.join(tmp, 'check_db.py');
    fs.writeFileSync(check, [
      'import sqlite3, json, sys',
      'c = sqlite3.connect(sys.argv[1])',
      'c.row_factory = sqlite3.Row',
      'rows = {r["video_id"]: dict(r) for r in c.execute("select video_id, upload_date, title from videos")}',
      'runs = [dict(r) for r in c.execute("select raw_output_path, kind from catalog_runs order by run_id")]',
      'print(json.dumps({"videos": rows, "runs": runs}))',
      '',
    ].join('\n'), 'utf8');
    const read = runPython(check, [path.join(clone, 'data', 'video_pipeline', 'state.sqlite')]);
    assert.strictEqual(read.status, 0, read.stderr);
    const state = JSON.parse(read.stdout.trim());

    assert.ok(state.videos.new222, 'the new video was added');
    assert.strictEqual(state.videos.new222.upload_date, '20260202', 'and dated');
    // The title comes from the per-video resolution, not from the listing. The
    // listing is a lossy copy (the Windows console codepage drops emoji), so
    // the fresher metadata wins.
    assert.strictEqual(state.videos.new222.title, 'Dated new222');
    assert.strictEqual(state.videos.known111.upload_date, '20260101', 'the dated one was left alone');

    // The clone carries the committed run history, so the new run is the last
    // one rather than the only one.
    assert.ok(state.runs.length >= 1, 'the run was recorded');
    const last = state.runs[state.runs.length - 1];
    assert.strictEqual(last.kind, 'live');
    assert.ok(
      !path.isAbsolute(last.raw_output_path),
      `the pointer is relative to the clone, got ${last.raw_output_path}`,
    );
    assert.ok(
      last.raw_output_path.startsWith('data/video_pipeline/catalog/'),
      `the pointer points inside the clone, got ${last.raw_output_path}`,
    );
  });
});
