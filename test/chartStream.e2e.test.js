'use strict';

// End-to-end tests for the Qullamaggie chart-stream scanner. Mirrors
// test/scanVideoWithOcr.e2e.test.js but uses the chart-stream synthetic
// fixture (local_20260104_sample_chart_stream.mp4) and exercises the
// --prefilter-profile chart_stream, --basename qmg, and --chart-stream-parser
// flags end-to-end.
//
// Auto-skips when the chart-stream fixture or a working ffmpeg binary is
// not available. To run:
//   1. node tools/buildSyntheticChartStreamVideo.js   # one-off
//   2. node --test test/chartStream.e2e.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_VIDEO = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'local_20260104_sample_chart_stream.mp4');

function detectFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN;
  }
  const candidates = [
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe'
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const wingetRoot = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetRoot)) {
    const matches = fs.readdirSync(wingetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Gyan.FFmpeg'))
      .flatMap((entry) => {
        const vendorRoot = path.join(wingetRoot, entry.name);
        return fs.readdirSync(vendorRoot, { withFileTypes: true })
          .filter((child) => child.isDirectory())
          .map((child) => path.join(vendorRoot, child.name, 'bin', 'ffmpeg.exe'));
      })
      .filter((candidate) => fs.existsSync(candidate))
      .sort();
    if (matches.length) return matches[matches.length - 1];
  }
  return null;
}

function freshOutputRoot(label) {
  return fs.mkdtempSync(path.join(WORKSPACE_ROOT, 'data', `video_ocr_chart_e2e_${label}_`));
}

function runScanCli({ outputRoot, outputKind, ffmpegBin, videoPath, extraArgs = [] }) {
  const args = [
    'tools/scanVideoWithOcr.js',
    '--video', videoPath,
    '--output-root', outputRoot,
    '--output-kind', outputKind,
    '--fps', '1',
    '--prefilter-threshold', '6',
    '--prefilter-min-frames', '1',
    '--prefilter-max-frames', '4',
    '--progress-interval', '1',
    '--top-candidates', '3',
    '--keep-frames',
    '--skip-keyframes',
    '--confusion-radius', '1',
    '--prefilter-profile', 'chart_stream',
    '--basename', 'qmg',
    '--chart-stream-parser',
    ...extraArgs
  ];
  if (ffmpegBin) args.push('--ffmpeg-bin', ffmpegBin);
  return spawnSync('node', args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024
  });
}

function findProbeLog(outputRoot, outputKind) {
  const logsDirectory = path.join(outputRoot, 'ocr_probe', 'logs');
  if (!fs.existsSync(logsDirectory)) return null;
  const candidates = fs.readdirSync(logsDirectory).filter((name) => name.endsWith(`_${outputKind}.json`));
  if (!candidates.length) return null;
  const probeLogPath = path.join(logsDirectory, candidates[0]);
  return JSON.parse(fs.readFileSync(probeLogPath, 'utf8'));
}

const ffmpegBin = detectFfmpeg();
const fixtureAvailable = fs.existsSync(FIXTURE_VIDEO);

test('end-to-end chart-stream scan produces a qmg_YYYYMMDD.png snapshot', { skip: !ffmpegBin || !fixtureAvailable }, () => {
  assert.ok(ffmpegBin, 'ffmpeg binary must be resolvable for this test to run');
  assert.ok(fixtureAvailable, `Synthetic chart-stream fixture missing: ${FIXTURE_VIDEO}. Run: node tools/buildSyntheticChartStreamVideo.js`);

  const outputRoot = freshOutputRoot('snapshot');
  try {
    const result = runScanCli({ outputRoot, outputKind: 'snapshot', ffmpegBin, videoPath: FIXTURE_VIDEO });
    assert.equal(result.status, 0, `scan CLI failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const probeLog = findProbeLog(outputRoot, 'snapshot');
    assert.ok(probeLog, `expected a probe log under ${outputRoot}/ocr_probe/logs/`);
    assert.ok(['done', 'review'].includes(probeLog.status), `expected done|review, got ${probeLog.status}`);
    assert.equal(probeLog.output_kind, 'snapshot');
    assert.equal(probeLog.prefilter_profile, 'chart_stream');
    assert.equal(probeLog.basename, 'qmg');
    assert.equal(probeLog.chart_stream_parser, true);

    // Snapshot must be saved under snapshots/ with the qmg_ prefix.
    assert.ok(probeLog.output_path, 'status:done must include an output_path');
    assert.ok(fs.existsSync(probeLog.output_path), `output_path file missing: ${probeLog.output_path}`);
    const expectedSnapPath = path.join(outputRoot, 'snapshots', 'qmg_20260104.png');
    assert.equal(probeLog.output_path, expectedSnapPath);

    // Per-capture invariants: each capture must have a region-cropped phash.
    assert.ok(Array.isArray(probeLog.captures), 'expected captures array');
    assert.ok(probeLog.captures.length >= 1, `expected at least one capture, got ${probeLog.captures.length}`);
    for (const capture of probeLog.captures) {
      assert.ok(typeof capture.phash === 'string' && capture.phash.length === 16,
        `phash must be 16-char hex, got ${capture.phash}`);
      assert.ok(typeof capture.phash_overlay === 'string' && capture.phash_overlay.length === 16,
        `phash_overlay must be 16-char hex, got ${capture.phash_overlay}`);
      assert.ok(capture.phash_region, 'capture must include phash_region');
      assert.ok(capture.chart_stream, 'capture must include chart_stream payload');
      // chart_stream payload includes position_list + price_action + parse_status.
      assert.ok(Array.isArray(capture.chart_stream.position_list),
        'chart_stream.position_list must be an array');
      assert.ok(typeof capture.chart_stream.parse_status === 'string',
        'chart_stream.parse_status must be a string');
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
