'use strict';

// Download a Revere video at a chosen yt-dlp height floor, OCR-scan it, and
// emit a side-by-side diff against the existing 360p probe log (if present).
//
// Usage:
//   node tools/reocrAtResolution.js <video_id> <upload_date> <title> <min_height>
//   min_height = 720 | 1080 | 1440 ...
//
// Outputs:
//   data/video_pipeline/downloads_hires/<date>_<video_id>_<height>p.<ext>
//   data/video_scan_<YYYYMMDD>/pilot-<height>p/ocr_probe/...
//   data/video_scan_<YYYYMMDD>/pilot-<height>p/diff_<date>_<video_id>.txt
//
// Example:
//   node tools/reocrAtResolution.js M0pV73RV2qo 20260509 "Weekend Review" 720

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [, , videoId, uploadDateArg, ...rest] = process.argv;
const minHeight = rest[rest.length - 1];
if (!videoId || !uploadDateArg || !/^\d{3,4}$/.test(minHeight)) {
  console.error('Usage: node tools/reocrAtResolution.js <video_id> <upload_date> <title...> <min_height>');
  process.exit(1);
}
const title = rest.slice(0, -1).join(' ') || videoId;
const uploadDate = uploadDateArg;

const today = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = `${today.getUTCFullYear()}${pad2(today.getUTCMonth() + 1)}${pad2(today.getUTCDate())}`;
const runTag = `pilot-${minHeight}p`;
const outputRoot = path.resolve('data', `video_scan_${dateKey}`, runTag);
const probeLogsDir = path.join(outputRoot, 'ocr_probe', 'logs');
fs.mkdirSync(probeLogsDir, { recursive: true });

const ytDlpBin = 'py';
const dlDir = path.resolve('data', 'video_pipeline', 'downloads_hires');
fs.mkdirSync(dlDir, { recursive: true });
const dlOutTemplate = path.join(dlDir, `${uploadDate}_${videoId}.%(ext)s`);

const ffmpegBin = process.env.FFMPEG_BIN
  || 'c:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';

const formatSel = `bv*[height>=${minHeight}]+ba/b[height>=${minHeight}]`;

console.log(`[pilot] video=${videoId} upload=${uploadDate} min_height=${minHeight}p`);
console.log(`[pilot] downloading to ${dlDir}`);

// yt-dlp format selection. The mediaconnect client negotiates DASH and exposes
// the full height ladder (formats 18=360, 134=360mp4, 135=480, 136=720, 137=1080).
// The android,web_safari,web client combo only exposes 360p reliably today
// (YouTube SABR-only streaming experiment). Use mediaconnect for higher res.
const formatCode = (() => {
  if (minHeight === '360') return '18';
  if (minHeight === '480') return '135';
  if (minHeight === '720') return '136';
  if (minHeight === '1080') return '137';
  return formatSel;
})();

const dlRes = spawnSync(ytDlpBin, [
  '-3', '-m', 'yt_dlp',
  '--no-playlist',
  '-f', formatCode,
  '--js-runtimes', 'node',
  '--extractor-args', 'youtube:player_client=mediaconnect',
  '-o', dlOutTemplate,
  '--write-info-json',
  `https://www.youtube.com/watch?v=${videoId}`
], { encoding: 'utf8', stdio: 'inherit' });

if (dlRes.status !== 0) {
  console.error(`[pilot] yt-dlp failed with code ${dlRes.status}; aborting OCR.`);
  process.exit(dlRes.status);
}

const dlFile = (() => {
  const candidates = fs.readdirSync(dlDir).filter((f) => f.startsWith(`${uploadDate}_${videoId}`) && !f.endsWith('.info.json') && !f.endsWith('.part'));
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(path.join(dlDir, b)).size - fs.statSync(path.join(dlDir, a)).size);
  return path.join(dlDir, candidates[0]);
})();
if (!dlFile) {
  console.error(`[pilot] could not locate downloaded file in ${dlDir}`);
  process.exit(2);
}
const dlSizeMb = (fs.statSync(dlFile).size / 1024 / 1024).toFixed(1);
console.log(`[pilot] downloaded ${dlFile} (${dlSizeMb} MB)`);

console.log(`[pilot] OCR scan → ${outputRoot}`);
const scanRes = spawnSync(process.execPath, [
  path.resolve('tools/scanVideoWithOcr.js'),
  '--video', dlFile,
  '--date', uploadDate,
  '--output-root', outputRoot,
  '--run-tag', runTag,
  '--ffmpeg-bin', ffmpegBin
], { encoding: 'utf8', stdio: 'inherit' });

if (scanRes.status !== 0) {
  console.error(`[pilot] OCR scanner failed with code ${scanRes.status}`);
  process.exit(scanRes.status);
}

const probeKey = `${uploadDate}_${videoId}_whiteboard`;
const newProbePath = path.join(probeLogsDir, `${probeKey}.json`);
if (!fs.existsSync(newProbePath)) {
  console.error(`[pilot] probe log not found at ${newProbePath}`);
  process.exit(3);
}

// Find the 360p probe log on disk
const oldProbeDirs = [
  path.resolve('data', 'video_scan_20260914', 'ocr-20260914', 'ocr-20260914', 'ocr_probe', 'logs'),
  path.resolve('data', 'video_scan_20260914', 'full-20260914', 'full-20260914', 'ocr_probe', 'logs')
];
const oldProbePath = oldProbeDirs.map((d) => path.join(d, `${uploadDate}_${uploadDate}_${videoId.toLowerCase()}_*_whiteboard.json`))
  .flatMap((g) => globSync(g))
  .find((p) => fs.existsSync(p)) || null;

const oldTextConcat = oldProbePath ? concatCaptureTexts(oldProbePath) : '';
const newTextConcat = concatCaptureTexts(newProbePath);

const diffOut = path.join(outputRoot, `diff_${uploadDate}_${videoId}.txt`);
fs.writeFileSync(diffOut, renderDiff({
  videoId,
  uploadDate,
  minHeight,
  oldProbePath,
  newProbePath,
  oldTextConcat,
  newTextConcat,
  dlFile,
  dlSizeMb
}));
console.log(`[pilot] wrote diff to ${diffOut}`);

if (oldProbePath) {
  const oldStats = computeStats(oldTextConcat);
  const newStats = computeStats(newTextConcat);
  console.log(`[pilot] 360p -> ${minHeight}p:`);
  console.log(`         chars: ${oldStats.chars} -> ${newStats.chars}`);
  console.log(`         ticker-matches: ${oldStats.tickers} -> ${newStats.tickers}`);
  console.log(`         digit-bearing lines: ${oldStats.digitLines} -> ${newStats.digitLines}`);
} else {
  console.log(`[pilot] no 360p probe log found to compare against; diff has the new text only.`);
}

function concatCaptureTexts(probeLogPath) {
  const probe = JSON.parse(fs.readFileSync(probeLogPath, 'utf8'));
  return (probe.captures || [])
    .map((c) => `[ts=${c.timestamp_hms} score=${c.score} layout=${c.screen_layout}]\n${c.ocr_text || ''}`)
    .join('\n\n---\n\n');
}

function computeStats(text) {
  if (!text) return { chars: 0, tickers: 0, digitLines: 0 };
  const tickers = (text.match(/\b[A-Z]{2,5}\b/g) || []).filter((t) => !['RVAB', 'GRO', 'TURBO', 'NEWS', 'TODAY', 'INDEXES', 'TNX', 'TYX', 'ETF', 'SMA', 'ATH', 'PRICE', 'LEVELS'].includes(t));
  const digitLines = text.split('\n').filter((l) => /\d/.test(l)).length;
  return { chars: text.length, tickers: new Set(tickers).size, digitLines };
}

function renderDiff({ videoId, uploadDate, minHeight, oldProbePath, newProbePath, oldTextConcat, newTextConcat, dlFile, dlSizeMb }) {
  return [
    `Resolution pilot diff`,
    `======================`,
    `video_id:    ${videoId}`,
    `upload_date: ${uploadDate}`,
    `resolution:  ${minHeight}p`,
    `dl_file:     ${dlFile}`,
    `dl_size:     ${dlSizeMb} MB`,
    `old_probe:   ${oldProbePath || '(none — only the new run)'}`,
    `new_probe:   ${newProbePath}`,
    ``,
    `--- 360p OCR (existing) ---`,
    oldTextConcat || '(no 360p probe log)',
    ``,
    `--- ${minHeight}p OCR (new) ---`,
    newTextConcat,
    ``
  ].join('\n');
}

function globSync(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const starIdx = base.indexOf('*');
  if (starIdx === -1 || !fs.existsSync(dir)) return [];
  const prefix = base.slice(0, starIdx);
  const suffix = base.slice(starIdx + 1);
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => path.join(dir, f));
}
