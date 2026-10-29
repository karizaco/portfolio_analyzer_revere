'use strict';

// The committed analysis artifact must not name one machine's directories.
//
// THE DEFECT
// A probe log records the absolute paths of the files it touched. The logs
// are committed, and `data/analysis.json` is committed, so those strings
// ended up inside a tracked file:
//
//   "output_path": "C:\\Users\\admin\\Projects\\portfolio_analyzer_revere\\data\\video_scan_20260912\\fix-final\\screenshots\\20260912_ps_36.png"
//
// The committed artifact held 1,185 absolute paths -- 1,175 of them
// pointing into this repository, and therefore expressible relative to its
// root. The other ten point at `D:\\courses_F\\revere_asset\\videos`, which
// is outside the repository entirely, and stay absolute: there is no honest
// relative form for a file that lives somewhere else.
//
// Two things were wrong with it:
////
//   1. A reader on another machine got paths that resolve to nothing.
//   2. The artifact could not be regenerated from a fresh clone, because the
//      probe logs it reads carry the paths of the machine that wrote them.
//
// The repository already has a rule for this -- a path inside the repository
// is stored relative to its root, a path outside keeps its absolute form --
// in `src/video/downloadCandidates.js` and `tools/whiteboard_worker.py`.
// `src/video/portablePaths.js` applies it to the paths that come out of the
// probe logs, which have the extra difficulty of having been written by
// another machine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const {
  findAbsolutePathValues,
  isAbsolutePath,
  isPathKey,
  portabilizePaths,
  toPortableArtifactPath
} = require('../src/video/portablePaths');

const ANALYSIS_JSON = path.join(ROOT, 'data', 'analysis.json');
const ANALYSIS_MD = path.join(ROOT, 'data', 'analysis.md');

test('toPortableArtifactPath', async (t) => {
  await t.test('a path under this checkout becomes relative to the repository root', () => {
    const absolute = path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires', 'x.mp4');
    assert.strictEqual(
      toPortableArtifactPath(absolute, { repoRoot: ROOT }),
      'data/video_pipeline/downloads_hires/x.mp4',
    );
  });

  await t.test('the separators are normalised, so the artifact is identical whichever machine wrote it', () => {
    const absolute = path.join(ROOT, 'data', 'video_scan_20260912', 'fix-final', 'screenshots', 'a.png');
    const converted = toPortableArtifactPath(absolute, { repoRoot: ROOT });
    assert.ok(!converted.includes('\\'), `expected forward slashes, got ${converted}`);
  });

  await t.test('a path under ANOTHER checkout of this repository also becomes relative', () => {
    // The usual case for a committed probe log: it was written on a
    // different machine, and that machine's checkout is not this one.
    const foreign = 'D:\\somebody\\else\\portfolio_analyzer_revere\\data\\video_pipeline\\downloads_hires\\x.mp4';
    assert.strictEqual(
      toPortableArtifactPath(foreign, { repoRoot: ROOT }),
      'data/video_pipeline/downloads_hires/x.mp4',
    );
  });

  await t.test('a foreign checkout is recognised by the repository data directory, not by its root', () => {
    const foreign = 'C:\\Users\\someone\\Projects\\somewhere-else\\data\\video_scan_20260914\\full-20260914\\screenshots\\a.png';
    assert.strictEqual(
      toPortableArtifactPath(foreign, { repoRoot: ROOT }),
      'data/video_scan_20260914/full-20260914/screenshots/a.png',
    );
  });

  await t.test('a scan directory is recognised even when this checkout has no such directory', () => {
    // A scan directory is named after its date, so one written by another
    // machine need not exist here. Its name is still unambiguous.
    const foreign = 'C:\\elsewhere\\data\\video_scan_20261231\\run\\screenshots\\a.png';
    assert.strictEqual(
      toPortableArtifactPath(foreign, { repoRoot: ROOT }),
      'data/video_scan_20261231/run/screenshots/a.png',
    );
  });

  await t.test('a foreign path whose data directory this repository does not have keeps its absolute form', () => {
    // The guard. `D:\\my\\data\\videos\\x.mp4` is not inside this repository,
    // and truncating it to `data/videos/x.mp4` would point at a file that
    // does not exist.
    const foreign = 'D:\\my\\data\\videos\\x.mp4';
    assert.strictEqual(toPortableArtifactPath(foreign, { repoRoot: ROOT }), foreign);
  });

  await t.test('a path outside the repository keeps its absolute form', () => {
    const external = 'D:\\courses_F\\revere_asset\\videos\\Some Video.mp4';
    assert.strictEqual(toPortableArtifactPath(external, { repoRoot: ROOT }), external);
  });

  await t.test('a `data` that is not a whole segment is not a marker', () => {
    const external = 'D:\\mydata\\videos\\x.mp4';
    assert.strictEqual(toPortableArtifactPath(external, { repoRoot: ROOT }), external);
  });

  await t.test('a relative path is already portable and is left alone', () => {
    assert.strictEqual(
      toPortableArtifactPath('data/video_scan_20260912/a.png', { repoRoot: ROOT }),
      'data/video_scan_20260912/a.png',
    );
    assert.strictEqual(
      toPortableArtifactPath('data\\video_scan_20260912\\a.png', { repoRoot: ROOT }),
      'data/video_scan_20260912/a.png',
    );
  });

  await t.test('nothing in, nothing out', () => {
    assert.strictEqual(toPortableArtifactPath(null, { repoRoot: ROOT }), null);
    assert.strictEqual(toPortableArtifactPath(undefined, { repoRoot: ROOT }), undefined);
    assert.strictEqual(toPortableArtifactPath('', { repoRoot: ROOT }), '');
  });
});

test('isAbsolutePath', async (t) => {
  await t.test('it recognises the forms of absolute path that turn up', () => {
    assert.ok(isAbsolutePath('C:\\Users\\admin\\x.mp4'));
    assert.ok(isAbsolutePath('D:/x.mp4'));
    assert.ok(isAbsolutePath('/home/user/x.mp4'));
    assert.ok(isAbsolutePath('\\\\server\\share\\x.mp4'));
  });

  await t.test('it does not mistake a relative path or a URL for one', () => {
    assert.ok(!isAbsolutePath('data/x.mp4'));
    assert.ok(!isAbsolutePath('https://example.com/x.mp4'));
    assert.ok(!isAbsolutePath(''));
    assert.ok(!isAbsolutePath(null));
  });
});

test('isPathKey', async (t) => {
  await t.test('it recognises the keys that name a path', () => {
    for (const key of ['path', 'output_path', 'video_path', 'frame_path', 'log_path', 'output_root', 'screenshots_directory']) {
      assert.ok(isPathKey(key), `${key} should name a path`);
    }
  });

  await t.test('it leaves the keys that do not', () => {
    for (const key of ['ocr_text', 'ocr_text_snippet', 'screen_layout', 'phash', 'score', 'crop']) {
      assert.ok(!isPathKey(key), `${key} should not name a path`);
    }
  });
});

test('portabilizePaths', async (t) => {
  await t.test('it rewrites the paths and leaves everything else alone', () => {
    const tree = {
      video_path: 'C:\\elsewhere\\data\\video_pipeline\\downloads_hires\\x.mp4',
      captures: [
        { output_path: 'C:\\elsewhere\\data\\video_scan_20260912\\screenshots\\a.png' },
        { ocr_text: 'Ticker AAPL 190.00 C:\\Users\\admin\\not-a-path' }
      ],
      tickers: ['AAPL']
    };
    portabilizePaths(tree, { repoRoot: ROOT });
    assert.strictEqual(tree.video_path, 'data/video_pipeline/downloads_hires/x.mp4');
    assert.strictEqual(tree.captures[0].output_path, 'data/video_scan_20260912/screenshots/a.png');
    // OCR text is not a path, whatever it happens to contain.
    assert.strictEqual(tree.captures[1].ocr_text, 'Ticker AAPL 190.00 C:\\Users\\admin\\not-a-path');
    assert.deepStrictEqual(tree.tickers, ['AAPL']);
  });

  await t.test('a missing value stays missing', () => {
    const tree = { output_path: undefined, video_path: null };
    portabilizePaths(tree, { repoRoot: ROOT });
    assert.strictEqual(tree.output_path, undefined);
    assert.strictEqual(tree.video_path, null);
  });
});

test('findAbsolutePathValues', async (t) => {
  await t.test('it finds absolute values and says where they are', () => {
    const tree = {
      a: 'C:\\x\\y.mp4',
      b: { c: ['D:\\z.mp4', 'not absolute'] }
    };
    const found = findAbsolutePathValues(tree);
    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].keyPath, 'a');
    assert.strictEqual(found[1].keyPath, 'b.c[0]');
  });
});

test('the committed analysis artifact holds no path into this machine', async (t) => {
  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'));

  await t.test('no absolute value points into the repository', () => {
    const hits = findAbsolutePathValues(analysis);
    const intoRepo = hits.filter((hit) => {
      const normalised = hit.value.replace(/\\/g, '/');
      return normalised.includes('/data/') || normalised.toLowerCase().startsWith(`${ROOT.replace(/\\/g, '/').toLowerCase()}/`);
    });
    assert.deepStrictEqual(
      intoRepo.map((hit) => `${hit.keyPath} -> ${hit.value}`),
      [],
      'every path into the repository has to be stored relative to its root',
    );
  });

  await t.test('the three top-level path fields are relative to the repository root', () => {
    for (const key of ['output_root', 'probe_directory', 'screenshots_directory']) {
      assert.ok(!isAbsolutePath(analysis[key]), `${key} is absolute: ${analysis[key]}`);
    }
    assert.strictEqual(analysis.output_root, 'data');
  });

  await t.test('the capture paths are relative to the repository root', () => {
    const outputs = analysis.videos.flatMap((video) => video.captures.map((capture) => capture.output_path));
    assert.ok(outputs.length > 0, 'the artifact has captures');
    for (const output of outputs) {
      assert.ok(!isAbsolutePath(output), `output_path is absolute: ${output}`);
    }
  });

  await t.test('the paths that stay absolute point outside the repository', () => {
    // Ten source videos live outside it, on the drive the course library was
    // captured to. They keep their absolute form -- there is no honest
    // relative form for a file that is not in this repository.
    const hits = findAbsolutePathValues(analysis);
    for (const hit of hits) {
      assert.ok(
        hit.value.toLowerCase().startsWith('d:\\courses_f\\'),
        `unexpected absolute path: ${hit.keyPath} -> ${hit.value}`,
      );
    }
  });
});

test('the committed analysis markdown holds no path into this machine', () => {
  const markdown = fs.readFileSync(ANALYSIS_MD, 'utf8');
  const absolute = markdown.match(/[A-Za-z]:[\\/][^\s)"]*/g) || [];
  assert.deepStrictEqual(absolute, [], 'the report links to files by a path that resolves on another machine');
});

test('the committed analysis is reproducible from a fresh clone', async (t) => {
  // The strongest form of the claim: the artifact is exactly what the
  // committed code and the committed probe logs produce, on any machine, at
  // any path. A copy of the tracked files is the only input available, so an
  // untracked log or a hardcoded path would show up here as a difference.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-fresh-clone-'));
  const clone = path.join(tmp, 'clone');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const committed = fs.readFileSync(ANALYSIS_JSON, 'utf8');

  await t.test('the clone holds the tracked files and nothing else', () => {
    const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
    assert.strictEqual(listed.status, 0, 'git ls-files failed');
    const files = listed.stdout.toString('utf8').split('\0').filter(Boolean);
    assert.ok(files.length > 100, `expected a real tree, got ${files.length} files`);
    for (const file of files) {
      const target = path.join(clone, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
    }
    // `src/video/imageHash.js` requires `sharp` at module load, and `sharp`
    // is a native module a fresh clone does not have. The aggregator only
    // uses `hammingDistance` from that module and never calls sharp, so a
    // stub is enough -- and it keeps the clone free of anything untracked.
    fs.mkdirSync(path.join(clone, 'node_modules', 'sharp'), { recursive: true });
    fs.writeFileSync(
      path.join(clone, 'node_modules', 'sharp', 'index.js'),
      "module.exports = function sharpStub() { throw new Error('sharp is stubbed in this test'); };\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(clone, 'node_modules', 'sharp', 'package.json'),
      JSON.stringify({ name: 'sharp', version: '0.0.0-test-stub', main: 'index.js' }),
      'utf8',
    );
  });

  await t.test('the aggregator reproduces the committed artifact exactly', () => {
    const run = spawnSync(
      process.execPath,
      [path.join('tools', 'aggregateScanResults.js')],
      { cwd: clone, encoding: 'utf8' },
    );
    assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const produced = JSON.parse(fs.readFileSync(path.join(clone, 'data', 'analysis.json'), 'utf8'));
    const expected = JSON.parse(committed);
    // The generation timestamp is the one thing that moves between two runs.
    delete produced.generated_at;
    delete expected.generated_at;
    assert.deepStrictEqual(produced, expected, 'the committed artifact is not what the committed inputs produce');
  });

  await t.test('and the report it writes carries no absolute path either', () => {
    const markdown = fs.readFileSync(path.join(clone, 'data', 'analysis.md'), 'utf8');
    const absolute = markdown.match(/[A-Za-z]:[\\/][^\s)"]*/g) || [];
    assert.deepStrictEqual(absolute, []);
  });
});
