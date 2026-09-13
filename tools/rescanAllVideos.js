'use strict';

// Re-run the whiteboard scanner against every video in the user's asset
// directory using the trade-line sampling fix in src/video/ocrScanLogic.js.
// Skips already-completed runs in the output tag directory so it can be
// resumed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VIDEO_DIR = 'D:/courses_F/revere_asset/videos';
const OUTPUT_ROOT = path.resolve(__dirname, '..', 'data', 'video_scan_20260912');
const RUN_TAG = 'fix-final';
const FFMPEG_BIN = process.env.FFMPEG_BIN
  || 'c:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
const SCANNER = path.resolve(__dirname, '..', 'tools', 'scanVideoWithOcr.js');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function extractDateFromFilename(filename) {
  const match = filename.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

function probeKeyFor(videoPath, dateKey) {
  const baseName = path.basename(videoPath, path.extname(videoPath))
    .replace(/[^a-z0-9._-]+/gi, '_')
    .toLowerCase();
  return `${dateKey}_${baseName.slice(0, 36)}_whiteboard`;
}

function probeAlreadyComplete(probeLogsDir, probeKey) {
  const logPath = path.join(probeLogsDir, `${probeKey}.json`);
  if (!fs.existsSync(logPath)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return j.status === 'done';
  } catch {
    return false;
  }
}

function listVideos() {
  return fs.readdirSync(VIDEO_DIR)
    .filter((name) => name.toLowerCase().endsWith('.mp4'))
    .sort()
    .map((name) => ({
      filename: name,
      path: path.join(VIDEO_DIR, name)
    }));
}

function summarizeCapture(c) {
  const text = String(c.ocr_text_snippet || '').replace(/\s+/g, ' ').trim();
  return {
    timestamp: c.timestamp,
    score: c.score,
    layout: c.screen_layout,
    hasRVAB: /PORTFOLIO\/RVAB|RVAB\/REBAR/i.test(text),
    hasMBLY: /MBLY|TMDX/i.test(text),
    hasBOTTOM: /BOTTOM LINE/i.test(text),
    snippet: text.slice(0, 200)
  };
}

async function main() {
  const outputRoot = path.join(OUTPUT_ROOT, RUN_TAG);
  const probeLogsDir = path.join(outputRoot, 'ocr_probe', 'logs');
  fs.mkdirSync(probeLogsDir, { recursive: true });

  const videos = listVideos();
  console.log(`Found ${videos.length} videos under ${VIDEO_DIR}`);
  const summary = [];

  for (const video of videos) {
    const dateKey = extractDateFromFilename(video.filename) || 'unknown';
    const probeKey = probeKeyFor(video.path, dateKey);

    if (probeAlreadyComplete(probeLogsDir, probeKey)) {
      console.log(`[skip] ${video.filename}: probe already done at ${RUN_TAG}`);
      const j = JSON.parse(fs.readFileSync(path.join(probeLogsDir, `${probeKey}.json`), 'utf8'));
      summary.push({
        filename: video.filename,
        dateKey,
        ocr_frame_count: j.ocr_frame_count,
        captured_count: j.captured_count,
        status: j.status,
        captures: (j.captures || []).map(summarizeCapture)
      });
      continue;
    }

    console.log(`[scan] ${video.filename}`);
    const args = [
      SCANNER,
      '--video', video.path,
      '--output-root', OUTPUT_ROOT,
      '--run-tag', RUN_TAG,
      '--output-kind', 'whiteboard',
      '--max-captures', '5',
      '--fps', '0.25',
      '--ffmpeg-bin', FFMPEG_BIN
    ];
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(`[error] ${video.filename} exit ${result.status}`);
      continue;
    }

    const logPath = path.join(probeLogsDir, `${probeKey}.json`);
    if (!fs.existsSync(logPath)) {
      console.error(`[error] ${video.filename}: no log written`);
      continue;
    }
    const j = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    summary.push({
      filename: video.filename,
      dateKey,
      ocr_frame_count: j.ocr_frame_count,
      captured_count: j.captured_count,
      status: j.status,
      captures: (j.captures || []).map(summarizeCapture)
    });
  }

  console.log('\n=== SUMMARY ===');
  for (const s of summary) {
    console.log(`\n${s.filename} (date=${s.dateKey}, ocr_frames=${s.ocr_frame_count}, captures=${s.captured_count}, status=${s.status})`);
    for (const c of s.captures) {
      console.log(`  t=${c.timestamp}s score=${c.score} layout=${c.layout} RVAB=${c.hasRVAB} MBLY=${c.hasMBLY} BOTTOM=${c.hasBOTTOM}`);
    }
  }

  const outSummary = path.join(outputRoot, 'rescan_summary.json');
  fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSummary written to ${outSummary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
