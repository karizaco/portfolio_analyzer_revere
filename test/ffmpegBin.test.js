'use strict';

// Unit tests for the shared ffmpeg/ffprobe resolver.
//
// The resolver's whole job is to find the binaries on a machine that is not
// the one the code was written on, so the tests are about the ORDER of the
// search and about the two contracts callers depend on:
//
//   * ffmpeg always resolves to something spawnable
//   * ffprobe resolves to null when it cannot be found, because ffprobe is
//     optional and the callers skip a step rather than fail a scan

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveFfmpegBin, resolveFfprobeBin, findOnPath } = require('../src/video/ffmpegBin');

test('an explicit path is returned verbatim', () => {
  const explicit = 'C:/somewhere/else/ffmpeg.exe';
  assert(resolveFfmpegBin(explicit) === explicit);
  assert(resolveFfprobeBin('C:/somewhere/else/ffprobe.exe') === 'C:/somewhere/else/ffprobe.exe');
});

// The literal default names are how the CLI says "no preference". Treating
// them as a preference would defeat the whole search.
test('the bare default names are not treated as an explicit path', () => {
  const resolved = resolveFfmpegBin('ffmpeg');
  assert(resolved !== 'ffmpeg' || process.platform !== 'win32');
  assert(typeof resolveFfprobeBin('ffprobe') === 'string' || resolveFfprobeBin('ffprobe') === null);
});

test('FFMPEG_BIN is honoured when it points at a real file', () => {
  const previous = process.env.FFMPEG_BIN;
  const marker = path.join(os.tmpdir(), `ffmpeg-bin-marker-${process.pid}.exe`);
  fs.writeFileSync(marker, '');
  try {
    process.env.FFMPEG_BIN = marker;
    assert(resolveFfmpegBin(null) === marker);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = previous;
    try { fs.unlinkSync(marker); } catch { /* ignore */ }
  }
});

test('FFPROBE_BIN is honoured when it points at a real file', () => {
  const previous = process.env.FFPROBE_BIN;
  const marker = path.join(os.tmpdir(), `ffprobe-bin-marker-${process.pid}.exe`);
  fs.writeFileSync(marker, '');
  try {
    process.env.FFPROBE_BIN = marker;
    assert(resolveFfprobeBin(null) === marker);
  } finally {
    if (previous === undefined) delete process.env.FFPROBE_BIN;
    else process.env.FFPROBE_BIN = previous;
    try { fs.unlinkSync(marker); } catch { /* ignore */ }
  }
});

test('an env var pointing at a missing file is ignored, not returned', () => {
  const previous = process.env.FFMPEG_BIN;
  try {
    process.env.FFMPEG_BIN = path.join(os.tmpdir(), 'definitely-not-here-ffmpeg.exe');
    const resolved = resolveFfmpegBin(null);
    assert(resolved !== process.env.FFMPEG_BIN);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = previous;
  }
});

test('ffmpeg always resolves to a non-empty string', () => {
  const resolved = resolveFfmpegBin(null);
  assert(typeof resolved === 'string');
  assert(resolved.length > 0);
});

// ffprobe is optional. Returning the bare name 'ffprobe' when nothing was
// found would be a lie: the spawn would fail, and the callers would turn a
// clean "unavailable" into a hard error.
test('ffprobe never returns a bare name it cannot spawn', () => {
  const resolved = resolveFfprobeBin(null);
  if (resolved === null) return;
  assert(resolved !== 'ffprobe', 'a bare "ffprobe" would fail at spawn time');
  assert(fs.existsSync(resolved), `resolved ffprobe does not exist: ${resolved}`);
});

test('whatever ffmpeg resolves to is either a real file or the bare fallback', () => {
  const resolved = resolveFfmpegBin(null);
  if (resolved === 'ffmpeg') return; // the OS may still find it
  assert(fs.existsSync(resolved), `resolved ffmpeg does not exist: ${resolved}`);
});

test('findOnPath returns null for a binary that does not exist', () => {
  assert(findOnPath('definitely-not-a-real-binary-xyz') === null);
});

test('findOnPath returns a path for ffmpeg when it is installed', () => {
  const found = findOnPath('ffmpeg');
  if (found === null) return; // ffmpeg is not installed on this machine
  assert(fs.existsSync(found));
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}
