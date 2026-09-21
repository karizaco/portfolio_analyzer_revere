'use strict';

// One-shot re-run: scan every video in the user's asset directory with the
// current ocrScanLogic.js (which now emits the full per-capture field set:
// observed_date, score_breakdown, is_intro_card, whiteboard_segments,
// ocr_text, parsed_observations, prefilter_stats, tickers, phash,
// low_res_frame_path, timestamp_hms, confusion_with_nearby,
// nearest_ffmpeg_keyframe_ts, plus ocr_engine_metadata and
// top_rejected_candidates at the probe-log level). Mirrors
// tools/rescanAllVideos.js but writes into a fresh directory so the earlier
// `data/video_scan_20260912/analysis.json` and
// `data/video_scan_20260913/fields-v1/analysis.json` stay as baselines for
// before/after comparison.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VIDEO_DIR = 'D:/courses_F/revere_asset/videos';
const OUTPUT_ROOT = path.resolve(__dirname, '..', 'data', 'video_scan_20260914');
const RUN_TAG = 'fields-v2';
const FFMPEG_BIN = process.env.FFMPEG_BIN
  || 'c:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
const SCANNER = path.resolve(__dirname, '..', 'tools', 'scanVideoWithOcr.js');

function listVideos() {
  return fs.readdirSync(VIDEO_DIR)
    .filter((name) => name.toLowerCase().endsWith('.mp4'))
    .sort()
    .map((name) => ({ filename: name, path: path.join(VIDEO_DIR, name) }));
}

function extractDateFromFilename(filename) {
  const match = filename.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

async function main() {
  const outputRoot = path.join(OUTPUT_ROOT, RUN_TAG);
  const probeLogsDir = path.join(outputRoot, 'ocr_probe', 'logs');
  fs.mkdirSync(probeLogsDir, { recursive: true });

  const videos = listVideos();
  console.log(`Found ${videos.length} videos under ${VIDEO_DIR}`);

  for (const video of videos) {
    const dateKey = extractDateFromFilename(video.filename) || 'unknown';
    const probeKey = `${dateKey}_${video.filename.replace(/[^a-z0-9._-]+/gi, '_').toLowerCase().slice(0, 36)}_whiteboard`;
    const logPath = path.join(probeLogsDir, `${probeKey}.json`);

    if (fs.existsSync(logPath)) {
      const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      if (parsed.status === 'done' || parsed.status === 'review') {
        console.log(`[skip] ${video.filename}: status=${parsed.status}`);
        continue;
      }
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
    }
  }

  console.log('\n[rerun] complete. Run tools/aggregateScanResults.js against the new directory.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});