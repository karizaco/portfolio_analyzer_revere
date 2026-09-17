'use strict';

// Run the OCR scanner over every row in data/video_pipeline/state.sqlite whose
// status is `scanning` and whose MP4 exists on disk. Skips rows whose probe log
// already shows status=done in the current RUN_TAG output directory.
//
// Resumability:
//   - Rows whose status in SQLite is already `done` are skipped.
//   - Probe logs whose status is `done` are skipped.
//   - Errors during a single video are logged but do not abort the run, so a
//     flaky yt-dlp output doesn't poison the rest of the batch.
//
// Output:
//   - data/video_scan_<YYYYMMDD>/<run-tag>/ocr_probe/logs/<key>.json
//   - data/video_scan_<YYYYMMDD>/<run-tag>/screenshots/*.png
//
// On completion writes a per-run summary at
//   data/video_scan_<YYYYMMDD>/<run-tag>/run_summary.json
//
// Usage:
//   node tools/runAllOcr.js                       # all scanning rows
//   node tools/runAllOcr.js --limit 5            # first 5
//   node tools/runAllOcr.js --since 20260901     # rows with upload_date >= since
//   RUN_TAG=mvp node tools/runAllOcr.js           # custom run tag

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  classifyVideoType,
  TYPE_BADGE_LABEL,
  TYPE_DESCRIPTION
} = require('../src/normalize/videoTypeClassifier');

const argv = process.argv.slice(2);
const limit = Number(readFlag(argv, '--limit')) || 0;
const since = readFlag(argv, '--since') || null;
const reclassify = argv.includes('--reclassify');
const channelArg = readFlag(argv, '--channel') || process.env.CHANNEL || '';
const prefilterProfileArg = process.env.PREFILTER_PROFILE || 'whiteboard';
const basenameArg = process.env.BASENAME || (channelArg && channelArg !== 'revere' ? channelArg : 'revere');
const effectiveChannel = channelArg || (basenameArg !== 'revere' ? basenameArg : 'revere');

const today = new Date();
const dateStr = `${today.getUTCFullYear()}${pad2(today.getUTCMonth() + 1)}${pad2(today.getUTCDate())}`;
const runTag = process.env.RUN_TAG || `ocr-${dateStr}`;
const outputRoot = path.resolve('data', `video_scan_${dateStr}`, runTag);
const ffmpegBin = process.env.FFMPEG_BIN
  || 'c:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
const probeLogsDir = path.join(outputRoot, 'ocr_probe', 'logs');

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`No catalog SQLite at ${dbPath}. Run 'npm run video:init' and 'video:catalog' first.`);
  process.exit(1);
}

fs.mkdirSync(probeLogsDir, { recursive: true });

const py = process.platform === 'win32' ? 'py' : 'python3';
const script = `
import json, sqlite3, sys
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
filters = ["status = 'scanning'", "download_path IS NOT NULL", "download_path != ''"]
params = []
${since ? `filters.append('upload_date >= ?'); params.append(${JSON.stringify(since)})` : ''}
${effectiveChannel ? `filters.append('channel = ?'); params.append(${JSON.stringify(effectiveChannel)})` : ''}
limit_clause = 'LIMIT ' + str(${limit}) if ${limit} else ''
rows = conn.execute(
    f"SELECT video_id, upload_date, title, download_path FROM videos WHERE {' AND '.join(filters)} "
    f"ORDER BY upload_date ASC, video_id ASC {limit_clause}",
    params
).fetchall()
json.dump([dict(r) for r in rows], sys.stdout)
`;
const result = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const rows = JSON.parse(result.stdout);

const scanLog = [];
console.log(`[run-all-ocr] tag=${runTag} videos=${rows.length}`);

let done = 0;
let skipped = 0;
let errored = 0;
let started = Date.now();

for (const row of rows) {
  const { video_id: videoId, upload_date: uploadDate, title, download_path: downloadPath } = row;
  const probeKey = `${uploadDate || 'unknown'}_${videoId}_whiteboard`;
  const logPath = path.join(probeLogsDir, `${probeKey}.json`);

  if (fs.existsSync(logPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      if (j.status === 'done' && j.captures && j.captures.length > 0) {
        skipped += 1;
        continue;
      }
    } catch { /* fall through and re-run */ }
  }

  if (!fs.existsSync(downloadPath)) {
    console.log(`[run-all-ocr] SKIP ${videoId} (missing ${downloadPath})`);
    skipped += 1;
    continue;
  }

  const start = Date.now();
  console.log(`[run-all-ocr] ${++done}/${rows.length} ${uploadDate} ${videoId} "${(title || '').slice(0, 50)}"`);
  const childArgs = [
    path.resolve('tools/scanVideoWithOcr.js'),
    '--video', downloadPath,
    '--date', uploadDate || 'unknown',
    '--output-root', outputRoot,
    '--run-tag', runTag,
    '--ffmpeg-bin', ffmpegBin,
    '--prefilter-profile', prefilterProfileArg,
    '--basename', basenameArg
  ];
  // Auto-enable chart-stream parser when the prefilter profile asks for it
  // (typical Qullamaggie run). The CHART_STREAM_PARSER=1 env override stays
  // useful when a user wants the parser on a whiteboard-profile run.
  if (prefilterProfileArg === 'chart_stream' || process.env.CHART_STREAM_PARSER === '1') {
    childArgs.push('--chart-stream-parser');
  }
  const r = spawnSync(process.execPath, childArgs, { encoding: 'utf8', stdio: 'inherit' });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  let videoType = null;
  if (r.status !== 0) {
    errored += 1;
    scanLog.push({ video_id: videoId, upload_date: uploadDate, status: 'error', elapsed_s: elapsed });
  } else {
    videoType = stampVideoTypeOnProbeLog(logPath, { title, uploadDate }, reclassify);
    scanLog.push({
      video_id: videoId,
      upload_date: uploadDate,
      status: 'done',
      video_type: videoType,
      elapsed_s: elapsed
    });
  }

  // Update SQLite status: set `scanning` -> `done` if the probe log is non-empty.
  // `error` is NOT NULL in the schema, so pass '' rather than NULL.
  const update = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.execute(
    "UPDATE videos SET status = ?, error = '' WHERE video_id = ? AND status = 'scanning'",
    ('done', ${JSON.stringify(videoId)})
)
conn.commit()
`;
  const updateRes = spawnSync(py, ['-3', '-c', update], { encoding: 'utf8' });
  if (updateRes.status !== 0) {
    console.error(`[run-all-ocr] WARN: failed to update status for ${videoId}: ${(updateRes.stderr || '').trim()}`);
  }

  // Refresh .STATUS.json so a future session can resume or report progress
  // without re-scanning the probe-logs directory.
  writeRunStatus({
    driver: 'runAllOcr.js',
    outputRoot,
    runTag,
    startedAt: new Date(started).toISOString(),
    expectedTotal: rows.length,
    scanLog,
    finishedAt: null,
    nextStep: `continue serial scan; ${rows.length - done - skipped} video(s) remaining after this one`
  });
}

const totalElapsed = ((Date.now() - started) / 1000).toFixed(1);
const typeCounts = scanLog.reduce((acc, row) => {
  const key = row.video_type || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
const summaryPath = path.join(outputRoot, 'run_summary.json');
fs.writeFileSync(summaryPath, JSON.stringify({
  run_tag: runTag,
  output_root: outputRoot,
  started_at: new Date(started).toISOString(),
  ended_at: new Date().toISOString(),
  total_elapsed_s: Number(totalElapsed),
  videos_total: rows.length,
  videos_done: done,
  videos_skipped: skipped,
  videos_errored: errored,
  video_type_counts: typeCounts,
  log: scanLog
}, null, 2));

// Final .STATUS.json write now that we know the wall-clock end + counts.
writeRunStatus({
  driver: 'runAllOcr.js',
  outputRoot,
  runTag,
  startedAt: new Date(started).toISOString(),
  expectedTotal: rows.length,
  scanLog,
  finishedAt: new Date().toISOString(),
  nextStep: 'run npm run video:stamp-types -- --run-tag ' + runTag + ' then node tools/aggregateOcrTimeline.js ' + runTag
});

console.log('');
console.log(`[run-all-ocr] elapsed ${totalElapsed}s · done=${done} skipped=${skipped} errored=${errored}`);
const typeSummary = Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(' ');
if (typeSummary) console.log(`[run-all-ocr] video types: ${typeSummary}`);
console.log(`[run-all-ocr] summary at ${summaryPath}`);

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}

// Maintain data/video_scan_<YYYYMMDD>/<run-tag>/.STATUS.json so a future session
// can pick up where this one left off (or report progress to a reviewer) without
// re-scanning the probe-logs directory. Writes are best-effort and never throw.
function writeRunStatus({ driver, outputRoot, runTag, startedAt, expectedTotal, scanLog, finishedAt, nextStep }) {
  try {
    const probeLogsDir = path.join(outputRoot, 'ocr_probe', 'logs');
    let probeLogCount = 0;
    let lastProbeLog = null;
    try {
      const files = fs.readdirSync(probeLogsDir).filter((f) => f.endsWith('.json'));
      probeLogCount = files.length;
      lastProbeLog = files.sort().slice(-1)[0] || null;
    } catch { /* dir may not exist yet on first call */ }

    const seenKeys = new Set();
    let uniqueVideosDone = 0;
    let erroredCount = 0;
    for (const row of scanLog) {
      const key = `${row.upload_date || 'unknown'}_${row.video_id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (row.status === 'error') {
        erroredCount += 1;
      } else if (row.status === 'done') {
        uniqueVideosDone += 1;
      }
    }

    const statusPath = path.join(outputRoot, '.STATUS.json');
    fs.writeFileSync(statusPath, JSON.stringify({
      run_tag: runTag,
      driver,
      started_at: startedAt,
      finished_at: finishedAt,
      last_update_at: new Date().toISOString(),
      probe_log_count: probeLogCount,
      unique_videos_done: uniqueVideosDone,
      unique_videos_errored: erroredCount,
      expected_total: expectedTotal,
      last_probe_log: lastProbeLog,
      next_step: nextStep
    }, null, 2));
  } catch (e) {
    console.warn(`[run-all-ocr] WARN: failed to write .STATUS.json: ${e.message}`);
  }
}

// Stamp `video_type` (and a couple of display fields) onto the probe log so
// downstream consumers (the timeline aggregator, the viewer) can branch on
// the kind. Idempotent unless --reclassify is passed.
function stampVideoTypeOnProbeLog(logPath, { title, uploadDate }, force) {
  const videoType = classifyVideoType({ title, uploadDate });
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const log = JSON.parse(raw);
    const alreadyTagged = log.video_type && log.video_type_classified_at;
    if (alreadyTagged && !force) {
      return log.video_type;
    }
    log.video_type = videoType;
    log.video_type_label = TYPE_BADGE_LABEL[videoType] || videoType;
    log.video_type_description = TYPE_DESCRIPTION[videoType] || '';
    log.video_type_classified_at = new Date().toISOString();
    log.classification_inputs = {
      title_excerpt: String(title || '').slice(0, 120),
      upload_date: uploadDate || null
    };
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    console.log(`[run-all-ocr]   ${logPath.includes('hires-smoke') ? 'smoke' : 'video'} typed → ${videoType}`);
    return videoType;
  } catch (e) {
    console.warn(`[run-all-ocr] WARN: failed to stamp video_type on ${logPath}: ${e.message}`);
    return videoType;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
