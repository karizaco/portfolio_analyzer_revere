'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findMediaForDate,
  findMediaForVideoId,
  getDownloadDir,
  getMediaRoots,
  resetMediaRootsCache,
  resolveMediaPath,
} = require('../src/video/mediaRoots');

const ROOT = path.resolve(__dirname, '..');

test('getMediaRoots defaults to repo data/video_pipeline', () => {
  resetMediaRootsCache();
  const roots = getMediaRoots({ env: {}, config: {}, force: true });
  assert.equal(roots.pipelineRoot, path.join(ROOT, 'data', 'video_pipeline'));
  assert.equal(roots.downloads_1080p, path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p'));
  assert.equal(roots.downloads_hires, path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(roots.downloads, path.join(ROOT, 'data', 'video_pipeline', 'downloads'));
  assert.equal(roots.usingDefaults, true);
});

test('PORTFOLIO_PIPELINE_ROOT moves all download dirs', () => {
  resetMediaRootsCache();
  const pipe = path.join('D:', 'portfolio_media', 'video_pipeline');
  const roots = getMediaRoots({
    env: { PORTFOLIO_PIPELINE_ROOT: pipe },
    config: {},
    force: true,
  });
  assert.equal(roots.pipelineRoot, path.resolve(pipe));
  assert.equal(roots.downloads_1080p, path.join(path.resolve(pipe), 'downloads_1080p'));
  assert.equal(roots.downloads_hires, path.join(path.resolve(pipe), 'downloads_hires'));
  assert.equal(roots.usingDefaults, false);
});

test('per-dir env overrides beat pipeline_root', () => {
  resetMediaRootsCache();
  const pipe = path.join('D:', 'portfolio_media', 'video_pipeline');
  const custom1080 = path.join('E:', 'media', 'qmg1080');
  const roots = getMediaRoots({
    env: {
      PORTFOLIO_PIPELINE_ROOT: pipe,
      PORTFOLIO_DOWNLOADS_1080P: custom1080,
    },
    config: {},
    force: true,
  });
  assert.equal(roots.downloads_1080p, path.resolve(custom1080));
  assert.equal(roots.downloads_hires, path.join(path.resolve(pipe), 'downloads_hires'));
});

test('config file pipeline_root works when env empty', () => {
  resetMediaRootsCache();
  const pipe = 'D:/other/video_pipeline';
  const roots = getMediaRoots({
    env: {},
    config: { pipeline_root: pipe },
    force: true,
  });
  assert.equal(roots.pipelineRoot, path.resolve(pipe.replace(/\//g, path.sep)));
  assert.equal(
    roots.downloads_1080p,
    path.join(path.resolve(pipe.replace(/\//g, path.sep)), 'downloads_1080p')
  );
});

test('getDownloadDir kinds', () => {
  resetMediaRootsCache();
  getMediaRoots({ env: {}, config: {}, force: true });
  assert.equal(getDownloadDir('1080p'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p'));
  assert.equal(getDownloadDir('hires'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(getDownloadDir('720p'), path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires'));
  assert.equal(getDownloadDir('downloads'), path.join(ROOT, 'data', 'video_pipeline', 'downloads'));
});

test('resolveMediaPath keeps absolute foreign drive paths', () => {
  const abs = 'D:\\portfolio_media\\video_pipeline\\downloads_1080p\\20220101_abcdefghijk.mp4';
  assert.equal(resolveMediaPath(abs), path.resolve(abs));
});

test('resolveMediaPath rewrites repo-relative and foreign checkout absolute paths', () => {
  const rel = 'data/video_pipeline/downloads_1080p/20220101_abcdefghijk.mp4';
  assert.equal(resolveMediaPath(rel), path.join(ROOT, rel.replace(/\//g, path.sep)));

  const foreignAbs = 'C:\\OtherUser\\Projects\\portfolio_analyzer_revere\\data\\video_pipeline\\downloads_1080p\\x.mp4';
  assert.equal(
    resolveMediaPath(foreignAbs),
    path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'x.mp4')
  );
});

test('findMediaForDate prefers 1080p dir', () => {
  const dirs = [
    path.join('fake', 'downloads_1080p'),
    path.join('fake', 'downloads_hires'),
  ];
  const files = {
    [dirs[0]]: ['20230602_30ksgwzWboo.mp4'],
    [dirs[1]]: ['20230602_30ksgwzWboo.mp4'],
  };
  const hit = findMediaForDate('20230602', {
    dirs,
    exists: (p) => Boolean(files[p]),
    readdir: (p) => files[p] || [],
  });
  assert.ok(hit);
  assert.equal(hit.dir, dirs[0]);
  assert.equal(hit.resolution, '1080p');
  assert.equal(hit.videoId, '30ksgwzWboo');
});

test('findMediaForVideoId can use catalog download_path fallback', () => {
  const abs = path.join('D:', 'media', '20220101_abcdefghijk.mp4');
  const hit = findMediaForVideoId('abcdefghijk', {
    dirs: [],
    exists: (p) => p === path.resolve(abs),
    readdir: () => [],
    downloadPath: abs,
  });
  assert.ok(hit);
  assert.equal(hit.path, path.resolve(abs));
  assert.equal(hit.videoId, 'abcdefghijk');
});

test.after(() => {
  resetMediaRootsCache();
});
