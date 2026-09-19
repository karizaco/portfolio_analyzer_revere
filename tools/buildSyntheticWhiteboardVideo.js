'use strict';

// Build a small, committed-friendly synthetic MP4 and a white reference PNG
// that the OCR-first video scanner and the Python whiteboard worker can both
// decode. Used by the local dry-run scripts and the e2e test.
//
// Usage:
//   node tools/buildSyntheticWhiteboardVideo.js
//   FFMPEG_BIN=/path/to/ffmpeg.exe node tools/buildSyntheticWhiteboardVideo.js
//
// Outputs (always relative to the workspace root):
//   test/fixtures/local_20260104_sample_real.mp4
//   test/fixtures/references/reference_board_white.png

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_VIDEO = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'local_20260104_sample_real.mp4');
const FIXTURE_TEXT_HEAVY_VIDEO = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'local_20260104_sample_text_heavy.mp4');
const FIXTURE_REFERENCE = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'references', 'reference_board_white.png');
const FIXTURE_REFERENCE_DIR = path.dirname(FIXTURE_REFERENCE);

const DEFAULT_WIN_FFMPEG_PATHS = [
  'C:/ffmpeg/bin/ffmpeg.exe',
  'C:/Program Files/ffmpeg/bin/ffmpeg.exe'
];

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN;
  }

  const which = require('node:child_process').spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
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

function runFfmpeg(ffmpegBin, args) {
  const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `ffmpeg exited with status ${result.status}`);
  }
}

function buildWhiteboardVideo(ffmpegBin, outputPath) {
  // 4 second clip at 4 fps = 16 near-identical frames of a "whiteboard" with
  // black GRO/TURBO labels so the OCR-first scanner sees a recognizable
  // bright, text-heavy scene.
  const fontFile = resolveFontFile();
  // On Windows the path contains a colon, which collides with drawtext's
  // option separator. Escape it as \\: per ffmpeg drawtext docs.
  const fontOption = fontFile
    ? `fontfile='${fontFile.replace(/:/g, '\\:')}'`
    : null;
  const drawTextFilter = (text, fontsize, y) => {
    const head = fontOption ? `${fontOption}:` : '';
    return `drawtext=${head}text='${text}':fontcolor=black:fontsize=${fontsize}:x=64:y=${y}`;
  };

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=white:s=1280x720:d=4:r=4',
    '-vf', [
      drawTextFilter('GRO RVAB (1.45/1.51) ADD', 59, 118),
      drawTextFilter('TURBO RVAB (0.90/0.95) HOLD', 59, 224),
      drawTextFilter('BOTTOM LINE HEALTHY', 48, 374)
    ].join(','),
    '-frames:v', '16',
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

function buildWhiteReferencePng(ffmpegBin, outputPath) {
  // A near-uniform white 320x180 PNG so the Python whiteboard worker hashes
  // every sampled frame from the synthetic video into the same bucket.
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=white:s=1280x720:d=0.04',
    '-frames:v', '1',
    '-update', '1',
    outputPath
  ];
  runFfmpeg(ffmpegBin, args);
}

// Synthetic Daily-Market-Insight-style clip. 4 seconds at 4 fps = 16 frames
// of a text-heavy page so the OCR-first scanner's text-density scoring has
// a deterministic fixture to exercise. Targets the layout the parser
// couldn't originally recognize: small headers + bullet list + index column
// + one-line GRO/TURBO daily P&L.
function buildTextHeavyVideo(ffmpegBin, outputPath) {
  const fontFile = resolveFontFile();
  const fontOption = fontFile
    ? `fontfile='${fontFile.replace(/:/g, '\\:')}'`
    : null;
  const drawTextFilter = (text, fontsize, x, y) => {
    const head = fontOption ? `${fontOption}:` : '';
    return `drawtext=${head}text='${text}':fontcolor=black:fontsize=${fontsize}:x=${x}:y=${y}`;
  };

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=white:s=1280x720:d=4:r=4',
    '-vf', [
      drawTextFilter('DAILY MARKET INSIGHT', 53, 43, 37),
      drawTextFilter('MARKET STATE UPTREND', 43, 43, 117),
      drawTextFilter('WHAT HAPPENED TODAY', 43, 43, 171),
      drawTextFilter('INDEXES FALL ON TENSIONS', 37, 43, 230),
      drawTextFilter('SPX -0.48 RSP -0.96', 32, 43, 288),
      drawTextFilter('QQQ -0.29 DJIA -0.75', 32, 43, 331),
      drawTextFilter('MAG7 +0.36 RAI100 -0.24', 32, 43, 374),
      drawTextFilter('GRO -0.46 TURBO -0.53', 37, 43, 427),
      drawTextFilter('21/21 T-12 RG8', 32, 43, 480),
      drawTextFilter('BOTTOM LINE HEALTHY', 37, 43, 544),
      drawTextFilter('LEADERS INTACT ADD', 32, 43, 597),
      drawTextFilter('TRIM SMALL CAPS', 32, 43, 640)
    ].join(','),
    '-frames:v', '16',
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

function reportStats(filePath) {
  const size = fs.statSync(filePath).size;
  return { filePath, sizeBytes: size };
}

function main() {
  ensureDir(path.dirname(FIXTURE_VIDEO));
  ensureDir(path.dirname(FIXTURE_TEXT_HEAVY_VIDEO));
  ensureDir(FIXTURE_REFERENCE_DIR);

  const ffmpegBin = resolveFfmpegBin();
  console.log(`Using ffmpeg binary: ${ffmpegBin}`);

  try {
    fs.unlinkSync(FIXTURE_VIDEO);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    fs.unlinkSync(FIXTURE_TEXT_HEAVY_VIDEO);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  buildWhiteboardVideo(ffmpegBin, FIXTURE_VIDEO);
  buildTextHeavyVideo(ffmpegBin, FIXTURE_TEXT_HEAVY_VIDEO);
  buildWhiteReferencePng(ffmpegBin, FIXTURE_REFERENCE);

  const videoStats = reportStats(FIXTURE_VIDEO);
  const textHeavyStats = reportStats(FIXTURE_TEXT_HEAVY_VIDEO);
  const referenceStats = reportStats(FIXTURE_REFERENCE);
  console.log(JSON.stringify({
    ffmpeg: ffmpegBin,
    fixtures: [videoStats, textHeavyStats, referenceStats],
    status: 'ok'
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`buildSyntheticWhiteboardVideo failed: ${error.message}`);
  process.exit(1);
}
