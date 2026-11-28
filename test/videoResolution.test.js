'use strict';

// The resolution of the media the OCR pipeline reads.
//
// CLAUDE.md: "**Never infer resolution from filesize.** … Always use ffprobe to
// check actual resolution … Never delete a video because it seems 'too small to
// be FullHD' — this reasoning has caused data loss." and "**480p/360p = never,
// under any circumstance.**"
//
// The rule is only as good as the moment it is applied. It is normally applied
// by hand, right before a scan, and a hand-applied rule is the kind that gets
// skipped under time pressure. This test applies it mechanically to every
// video the pipeline actually reads.
//
// What it asserts is a FLOOR, and the floor is the one CLAUDE.md states: no
// video is below 720p. The floor is on the HEIGHT, because that is what
// "480p/360p" is about.
//
// It is deliberately NOT a floor on the width, because the corpus does not
// have one width and a made-up threshold would be a made-up rule. Measured on
// this machine (215 videos, 2026-11-02):
//
//   1280x720 x91   1112x720 x53   1920x1080 x50   1152x720 x14
//   1670x1080 x2   1114x720 x1    1278x720 x1    1728x1080 x1
//   1918x1080 x1   1280x718 x1
//
// The narrower-than-1280 frames are Revere's screen captures, which are not
// 16:9 (1112x720 is a 1.54 aspect). They are still 720p, and the pipeline
// reads them — the whiteboard path finds its window from pixels rather than
// from a fixed geometry.
//
// Nothing above the floor is asserted, because the directory names are NOT a
// claim about the resolution. `downloads_1080p` has held 720p files and
// `downloads_hires` has held 1080p files, and the catalog's pointers are not
// evidence either (see CLAUDE.md § 'The recovery manifest').
//
// It also PRINTS what it found, because the check exists to be read, not only
// to pass: a file that is 1280x720 in `downloads_1080p` is worth knowing about
// before a scan reads it.
//
// The media is not in git, so on a fresh clone there is nothing to check and
// the test SKIPS rather than fails. ffprobe is optional in the same way — the
// shared resolver reports its absence as null.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');

const { resolveFfprobeBin } = require('../src/video/ffmpegBin');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE_DIR = path.join(ROOT, 'data', 'video_pipeline');

// The directories the pipeline reads media from. `downloads_1080p` is where the
// chart-stream path's 1920x1080 sources live; `downloads_hires` holds the
// mixed set.
const VIDEO_DIRS = [
  path.join(PIPELINE_DIR, 'downloads_1080p'),
  path.join(PIPELINE_DIR, 'downloads_hires'),
];

// The floor: 720p. Encoders round the frame height, so a 720p frame can come
// out 718 tall — measured on `20261002_ODc07iRusRI.mp4`, which is 1280x718.
// Two pixels of tolerance covers that without covering a different
// resolution class.
const MIN_HEIGHT = 720;
const HEIGHT_TOLERANCE = 2;

// How many ffprobe processes at once. 215 spawns serially took 14 s; the
// suite's budget is ~20 s in total, so they are run concurrently.
const CONCURRENCY = 8;

/** ffprobe one file and return `{ width, height }`, or null on failure. */
function probeResolution(ffprobe, file) {
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', file],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const stream = JSON.parse(stdout).streams.find((s) => s.width && s.height);
          resolve(stream ? { width: stream.width, height: stream.height } : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

test('every video the pipeline reads is at least 720p', async (t) => {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) {
    t.skip('ffprobe is not available on this machine');
    return;
  }

  const present = VIDEO_DIRS.filter((dir) => fs.existsSync(dir));
  if (!present.length) {
    t.skip('no pipeline media on this machine (the media is not tracked in git)');
    return;
  }

  const files = [];
  for (const dir of present) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.mp4')) files.push({ name, path: path.join(dir, name) });
    }
  }
  if (!files.length) {
    t.skip('no .mp4 files in the pipeline directories');
    return;
  }

  const tooSmall = [];
  const unreadable = [];
  const bySize = new Map();

  // Run the probes with a bounded concurrency, so the suite's wall clock does
  // not grow with the size of the media library.
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];
      const resolution = await probeResolution(ffprobe, file.path);
      if (!resolution) {
        unreadable.push(file.name);
        continue;
      }
      const key = `${resolution.width}x${resolution.height}`;
      bySize.set(key, (bySize.get(key) || 0) + 1);
      if (resolution.height < MIN_HEIGHT - HEIGHT_TOLERANCE) {
        tooSmall.push(`${file.name} (${key})`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker())
  );

  const census = [...bySize.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([size, count]) => `${size} x${count}`)
    .join(', ');
  console.log(`  probed ${files.length} video(s): ${census || 'none readable'}`);
  if (unreadable.length) {
    console.log(`  unreadable by ffprobe: ${unreadable.join(', ')}`);
  }

  assert.deepEqual(
    tooSmall,
    [],
    `these videos are below ${MIN_HEIGHT}p, and the pipeline's geometry is stated for 720p and above: `
    + tooSmall.join(', ')
  );
});

test('the 1080p directory really is 1920x1080', async (t) => {
  // The chart-stream path's geometry is stated for a 1920x1080 source: the
  // measured panel columns (source x 1585-1812), the row pitches, and the
  // EasyOCR crop width of 1345 px are all that width. A 720p file in this
  // directory would be read at 895 px, which is a different configuration
  // with its own measurements — and `positionTableScan.js` refuses anything
  // below 1600 px wide outright.
  //
  // So the directory name IS a claim here, and this test is what makes it
  // true: the name is checked against the pixels, and a file that does not
  // match it is reported rather than assumed.
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) {
    t.skip('ffprobe is not available on this machine');
    return;
  }

  const dir = path.join(PIPELINE_DIR, 'downloads_1080p');
  if (!fs.existsSync(dir)) {
    t.skip('no downloads_1080p directory on this machine (the media is not tracked in git)');
    return;
  }

  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mp4'));
  if (!files.length) {
    t.skip('no .mp4 files in downloads_1080p');
    return;
  }

  const mismatched = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const name = files[cursor++];
      const resolution = await probeResolution(ffprobe, path.join(dir, name));
      if (!resolution) {
        mismatched.push(`${name} (unreadable by ffprobe)`);
        continue;
      }
      if (resolution.width !== 1920 || resolution.height !== 1080) {
        mismatched.push(`${name} (${resolution.width}x${resolution.height})`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker())
  );

  console.log(`  probed ${files.length} file(s) in downloads_1080p against 1920x1080`);
  assert.deepEqual(
    mismatched,
    [],
    'these files are in downloads_1080p but are not 1920x1080 — the chart-stream crop\'s measured '
    + 'geometry is stated for that width, so each one needs its own measurement: '
    + mismatched.join(', ')
  );
});
