'use strict';

// Build a small synthetic MP4 that mimics a Qullamaggie chart-streaming
// session: a dark candlestick grid filling the frame, with a small
// "position list" overlay in the bottom-right corner that changes across
// frames so the OCR / pHash / ticker pipeline can be exercised end-to-end.
//
// Usage:
//   node tools/buildSyntheticChartStreamVideo.js
//   FFMPEG_BIN=/path/to/ffmpeg.exe node tools/buildSyntheticChartStreamVideo.js
//
// Outputs (relative to the workspace root):
//   test/fixtures/local_20260104_sample_chart_stream.mp4

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_VIDEO = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'local_20260104_sample_chart_stream.mp4');

const DEFAULT_WIN_FFMPEG_PATHS = [
  'C:/ffmpeg/bin/ffmpeg.exe',
  'C:/Program Files/ffmpeg/bin/ffmpeg.exe'
];

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN;
  }

  const which = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout) {
    const first = which.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) {
      return first;
    }
  }

  for (const candidate of DEFAULT_WIN_FFMPEG_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
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
    if (matches.length) {
      return matches[matches.length - 1];
    }
  }

  return 'ffmpeg';
}

function resolveFontFile() {
  if (process.env.REVERE_FONT_FILE && fs.existsSync(process.env.REVERE_FONT_FILE)) {
    return process.env.REVERE_FONT_FILE;
  }
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/consola.ttf'
      ]
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/Library/Fonts/Arial.ttf'
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function runFfmpeg(ffmpegBin, args) {
  const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `ffmpeg exited with status ${result.status}`);
  }
}

// Render one synthetic chart-stream frame:
//   - Dark canvas (480×270) with a faint candlestick grid.
//   - "POSITION LIST" box in the bottom-right at x=336, y=216, w=128, h=48.
//   - Three tickers + dollar prices drawn over the box per frame, sourced
//     from `rows[frameIndex]` so each of the 16 frames sees a different list.
//   - The position-list box is bright-on-dark so the OCR pipeline can read
//     it; the chart canvas itself stays dark so the chart_stream prefilter
//     profile (darkRatio target 0.55) finds the frames.
function buildChartStreamVideo(ffmpegBin, outputPath, rows) {
  const fontFile = resolveFontFile();
  const fontOption = fontFile
    ? `fontfile='${fontFile.replace(/:/g, '\\:')}'`
    : null;

  // Build the full video filter graph. Input is a dark color source; the
  // grid is part of -vf (not the -i spec) so ffmpeg's lavfi parser accepts it.
  const drawTextFilters = [];
  // Static POSITION LIST chrome (box + border + label) applies to all frames.
  // Scale coordinates from 480x270 → 1280x720 (2.67x).
  drawTextFilters.push(
    `drawgrid=w=160:h=160:t=1:c=0x1f2933@0.6`,
    `drawbox=x=896:y=576:w=342:h=128:color=0x111827@0.95:t=fill`,
    `drawbox=x=896:y=576:w=342:h=128:color=0xe5e7eb@0.8:t=2`,
    `drawtext=${fontOption ? fontOption + ':' : ''}text='POSITION LIST':fontcolor=white:fontsize=27:x=918:y=592`
  );
  // Per-frame ticker rows. Use enable='eq(n\,N)' so each filter only paints
  // one frame — this is how we get the position list to change across the
  // 16 frames so the pHash_overlay test sees different overlay hashes.
  rows.forEach((row, frameIndex) => {
    row.forEach((cell, rowIdx) => {
      const yOffset = 619 + rowIdx * 27;
      drawTextFilters.push(
        `drawtext=${fontOption ? fontOption + ':' : ''}text='${cell}':fontcolor=white:fontsize=24:` +
          `x=918:y=${yOffset}:enable='eq(n\\,${frameIndex})'`
      );
    });
  });

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=0x0d1117:s=1280x720:d=4:r=4',
    '-frames:v', '16',
    '-vf', drawTextFilters.join(','),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath
  ];
  runFfmpeg(ffmpegBin, args);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function reportStats(filePath) {
  return { filePath, sizeBytes: fs.statSync(filePath).size };
}

function buildRows() {
  // 16 frames, each frame has 3 ticker rows. The first row always has a
  // dollar price so `hasPriceNear` in parseChartStream.js fires. The ticker
  // set intentionally overlaps the Qullamaggie recurring lexicon
  // (RIVN, CRWD, SPOT, NET, DDOG, PANW, MARA, RIOT, TSLA, NVDA, AAPL, MSFT)
  // so the parser's seed-lex membership check passes.
  const rotation = [
    [['NVDA $134.20', 'RIVN $13.05', 'SPOT $402.10']],
    [['CRWD $362.80', 'DDOG $128.40', 'NET $112.20']],
    [['PANW $389.60', 'MARA $21.30', 'RIOT $9.85']],
    [['TSLA $248.10', 'NVDA $134.20', 'NET $112.20']],
    [['AAPL $229.85', 'MSFT $425.60', 'CRWD $362.80']],
    [['RIVN $13.05', 'SPOT $402.10', 'PANW $389.60']],
    [['DDOG $128.40', 'MARA $21.30', 'NVDA $134.20']],
    [['NET $112.20', 'TSLA $248.10', 'AAPL $229.85']],
    [['MSFT $425.60', 'RIOT $9.85', 'CRWD $362.80']],
    [['SPOT $402.10', 'DDOG $128.40', 'RIVN $13.05']],
    [['PANW $389.60', 'NVDA $134.20', 'MARA $21.30']],
    [['AAPL $229.85', 'TSLA $248.10', 'NET $112.20']],
    [['RIOT $9.85', 'MSFT $425.60', 'SPOT $402.10']],
    [['CRWD $362.80', 'PANW $389.60', 'DDOG $128.40']],
    [['MARA $21.30', 'RIVN $13.05', 'AAPL $229.85']],
    [['NVDA $134.20', 'TSLA $248.10', 'MSFT $425.60']]
  ];
  // Each row in `rotation` is a list-of-lists — one list per frame index.
  // Flatten the outer wrapper so each frame has exactly one ticker block.
  return rotation.map((frame) => frame[0]);
}

function main() {
  ensureDir(path.dirname(FIXTURE_VIDEO));
  const ffmpegBin = resolveFfmpegBin();
  console.log(`Using ffmpeg binary: ${ffmpegBin}`);

  try {
    fs.unlinkSync(FIXTURE_VIDEO);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const rows = buildRows();
  buildChartStreamVideo(ffmpegBin, FIXTURE_VIDEO, rows);
  console.log(JSON.stringify({
    ffmpeg: ffmpegBin,
    fixture: reportStats(FIXTURE_VIDEO),
    frame_count: rows.length,
    status: 'ok'
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`buildSyntheticChartStreamVideo failed: ${error.message}`);
  process.exit(1);
}
