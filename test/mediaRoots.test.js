'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findMedia,
  findMediaForDate,
  findMediaForVideoId,
  getDownloadDir,
  getMediaRoots,
  media1080SearchDirs,
  mediaSearchDirs,
  resetMediaRootsCache,
  resolveMediaPath,
} = require('../src/video/mediaRoots');

const ROOT = path.resolve(__dirname, '..');

test.afterEach(() => {
  resetMediaRootsCache();
  delete process.env.PORTFOLIO_PIPELINE_ROOT;
  delete process.env.PORTFOLIO_DOWNLOADS_1080P;
  delete process.env.PORTFOLIO_DOWNLOADS_HIRES;
  delete process.env.PORTFOLIO_DOWNLOADS;
  delete process.env.PORTFOLIO_MEDIA_EXTRA_DIRS;
});

test('default roots point under repo data/video_pipeline', () => {
  const roots = getMediaRoots({ force: true, env: {}, config: {} });
  assert.equal(roots.pipelineRoot, path.join(ROOT, 'data', 'video_pipeline'));
  assert.equal(roots.downloads_1080p, path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p'));
  assert.equal(roots.downloads_hires, path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(roots.downloads, path.join(ROOT, 'data', 'video_pipeline', 'downloads'));
  assert.deepEqual(roots.extra_dirs, []);
  assert.equal(roots.usingDefaults, true);
});

test('env pipeline root relocates child dirs', () => {
  const base = path.join(os.tmpdir(), 'pa-media-roots-test');
  const roots = getMediaRoots({
    force: true,
    env: { PORTFOLIO_PIPELINE_ROOT: base },
    config: {},
  });
  assert.equal(roots.pipelineRoot, path.resolve(base));
  assert.equal(roots.downloads_1080p, path.join(path.resolve(base), 'downloads_1080p'));
  assert.equal(roots.usingDefaults, false);
});

test('per-dir env overrides pipeline root', () => {
  const roots = getMediaRoots({
    force: true,
    env: {
      PORTFOLIO_PIPELINE_ROOT: 'D:\\pipeline',
      PORTFOLIO_DOWNLOADS_1080P: 'E:\\only1080',
    },
    config: {},
  });
  assert.equal(roots.downloads_1080p, path.resolve('E:\\only1080'));
  assert.equal(roots.downloads_hires, path.resolve('D:\\pipeline\\downloads_hires'));
});

test('extra_dirs from config and env are merged and de-duplicated', () => {
  const a = path.join(os.tmpdir(), 'pa-extra-a');
  const b = path.join(os.tmpdir(), 'pa-extra-b');
  const roots = getMediaRoots({
    force: true,
    env: { PORTFOLIO_MEDIA_EXTRA_DIRS: `${a};${b}` },
    config: { extra_dirs: [a, 'D:/data/portfolio_analyzer_revere/videos'] },
  });
  assert.ok(roots.extra_dirs.length >= 2);
  const keys = roots.extra_dirs.map((d) => d.replace(/\\/g, '/').toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'no duplicate extra dirs');
  assert.ok(keys.some((k) => k.includes('pa-extra-a')));
  assert.ok(media1080SearchDirs().some((d) => d.replace(/\\/g, '/').toLowerCase().includes('pa-extra-a')));
  assert.ok(mediaSearchDirs().some((d) => d.replace(/\\/g, '/').toLowerCase().includes('pa-extra-a')));
});

test('getDownloadDir kinds', () => {
  getMediaRoots({ force: true, env: {}, config: {} });
  assert.equal(getDownloadDir('1080p'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p'));
  assert.equal(getDownloadDir('hires'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(getDownloadDir('720p'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(getDownloadDir('downloads'), path.join(ROOT, 'data', 'video_pipeline', 'downloads'));
});

test('resolveMediaPath keeps absolute foreign drive paths', () => {
  const abs = 'D:\\data\\portfolio_analyzer_revere\\videos\\20230602_30ksgwzWboo.mp4';
  assert.equal(resolveMediaPath(abs), path.resolve(abs));
});

test('resolveMediaPath rewrites repo-relative and foreign checkout absolute paths', () => {
  const rel = 'data/video_pipeline/downloads_1080p/x.mp4';
  assert.equal(resolveMediaPath(rel), path.join(ROOT, rel.replace(/\//g, path.sep)));
  const foreignAbs = 'C:\\Users\\other\\Projects\\portfolio_analyzer_revere\\data\\video_pipeline\\downloads_1080p\\y.mp4';
  assert.equal(
    resolveMediaPath(foreignAbs),
    path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'y.mp4'),
  );
});

test('findMediaForDate prefers 1080p dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-find-media-'));
  const d1080 = path.join(tmp, '1080');
  const dHires = path.join(tmp, 'hires');
  fs.mkdirSync(d1080);
  fs.mkdirSync(dHires);
  fs.writeFileSync(path.join(d1080, '20230602_abc.mp4'), 'x');
  fs.writeFileSync(path.join(dHires, '20230602_abc.mp4'), 'y');
  const hit = findMediaForDate('20230602', {
    dirs: [d1080, dHires],
  });
  assert.ok(hit);
  assert.equal(hit.dir, d1080);
  assert.equal(hit.file, '20230602_abc.mp4');
});

test('findMediaForDate falls back to catalog downloadPath outside search dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-find-date-path-'));
  const empty = path.join(tmp, 'empty');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(empty);
  fs.mkdirSync(other);
  const file = path.join(other, '20230602_30ksgwzWboo.mp4');
  fs.writeFileSync(file, 'video');
  const hit = findMediaForDate('20230602', {
    dirs: [empty],
    downloadPath: file,
  });
  assert.ok(hit);
  assert.equal(hit.path, path.resolve(file));
  assert.equal(hit.videoId, '30ksgwzWboo');
});

test('findMediaForVideoId can use catalog download_path fallback', () => {
  const abs = 'D:\\data\\portfolio_analyzer_revere\\videos\\x_abcdefghijk.mp4';
  const hit = findMediaForVideoId('abcdefghijk', {
    dirs: [],
    downloadPath: abs,
    exists: (p) => path.resolve(p) === path.resolve(abs),
  });
  assert.ok(hit);
  assert.equal(hit.path, path.resolve(abs));
  assert.equal(hit.videoId, 'abcdefghijk');
});

test('findMedia unified helper uses date then id then downloadPath', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-find-unified-'));
  const dir = path.join(tmp, 'lib');
  fs.mkdirSync(dir);
  const file = path.join(dir, '20230605_C7ZZhSxYYLk.mp4');
  fs.writeFileSync(file, 'v');
  const byDate = findMedia({ dateKey: '20230605', dirs: [dir] });
  assert.equal(byDate && byDate.videoId, 'C7ZZhSxYYLk');
  const byPath = findMedia({
    dateKey: '20990101',
    videoId: 'nope',
    downloadPath: file,
    dirs: [],
  });
  assert.equal(byPath && byPath.path, path.resolve(file));
});
