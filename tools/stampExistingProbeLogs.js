'use strict';

// One-shot retroactive stamper: walks an existing RUN_TAG output directory,
// joins each probe log filename's <upload_date>_<video_id> to the SQLite
// `videos` row, classifies the title, and writes `video_type` (and friends)
// onto the probe log. Idempotent — passes `--reclassify` to overwrite.
//
// Usage:
//   node tools/stampExistingProbeLogs.js                          # all run tags found
//   node tools/stampExistingProbeLogs.js --run-tag ocr-20260915   # specific
//   node tools/stampExistingProbeLogs.js --reclassify             # overwrite existing tags
//
// Reads:
//   data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>/ocr_probe/logs/*.json
// Writes:
//   same files, in place

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  classifyVideoType,
  TYPE_BADGE_LABEL,
  TYPE_DESCRIPTION
} = require('../src/normalize/videoTypeClassifier');

const argv = process.argv.slice(2);
const runTagArg = readFlag(argv, '--run-tag');
const channelArg = readFlag(argv, '--channel');
const reclassify = argv.includes('--reclassify');
const runTags = runTagArg
  ? String(runTagArg).split(',').map((value) => value.trim()).filter(Boolean)
  : null;

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`No catalog SQLite at ${dbPath}. Run 'npm run video:init' and 'video:catalog' first.`);
  process.exit(1);
}

const py = process.platform === 'win32' ? 'py' : 'python3';
const titleLookupScript = `
import json, sqlite3, sys
c = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
pairs = json.loads(sys.stdin.read())
out = {}
for upload_date, video_id in pairs:
  # Probe logs sometimes lowercase the video_id portion of the filename; the
  # catalog may keep mixed case. Compare case-insensitively so both match.
  row = c.execute(
    "SELECT title FROM videos WHERE LOWER(video_id) = LOWER(?) AND upload_date = ?",
    (video_id, upload_date)
  ).fetchone()
  if row is None:
    row = c.execute(
      "SELECT title FROM videos WHERE LOWER(video_id) = LOWER(?)",
      (video_id,)
    ).fetchone()
  key = f"{upload_date}_{video_id}"
  out[key] = row['title'] if row else None
json.dump(out, sys.stdout)
`;

function listRunTags(scanDateDir) {
  if (!fs.existsSync(scanDateDir)) return [];
  return fs.readdirSync(scanDateDir).filter((name) => {
    const probeRoot = path.join(scanDateDir, name, name, 'ocr_probe', 'logs');
    return fs.existsSync(probeRoot);
  });
}

const parseLogFilename = (filename) => {
  const match = filename.match(/^(\d{8})_(\d{8})_([A-Za-z0-9_-]{6,15})_([a-f0-9]{8})_whiteboard\.json$/);
  if (!match) return null;
  const [, , uploadDate, videoId] = match;
  return { uploadDate, videoId };
};

const scanDateDirs = fs.readdirSync('data')
  .filter((name) => /^video_scan_\d{8}$/.test(name))
  .map((name) => path.resolve('data', name));

let totalStamped = 0;
let totalSkipped = 0;
let totalLogs = 0;

for (const scanDateDir of scanDateDirs) {
  const runTagSet = runTags || listRunTags(scanDateDir);
  for (const runTag of runTagSet) {
    const probeLogsDir = path.join(scanDateDir, runTag, runTag, 'ocr_probe', 'logs');
    if (!fs.existsSync(probeLogsDir)) continue;
    const logFiles = fs.readdirSync(probeLogsDir).filter((f) => f.endsWith('.json'));
    if (logFiles.length === 0) continue;

    // Collect all (uploadDate, videoId) pairs we need titles for.
    const pairs = [];
    for (const file of logFiles) {
      const parsed = parseLogFilename(file);
      if (parsed) pairs.push([parsed.uploadDate, parsed.videoId]);
    }
    if (pairs.length === 0) continue;

    const titleRes = spawnSync(py, ['-3', '-c', titleLookupScript], {
      encoding: 'utf8',
      input: JSON.stringify(pairs)
    });
    if (titleRes.status !== 0) {
      console.error(`[stamp] WARN: SQLite lookup failed for ${runTag}: ${titleRes.stderr}`);
      continue;
    }
    const titlesByKey = JSON.parse(titleRes.stdout);

    let stampedInRun = 0;
    let skippedInRun = 0;
    const typeCounts = Object.create(null);
    for (const file of logFiles) {
      totalLogs += 1;
      const parsed = parseLogFilename(file);
      if (!parsed) continue;
      const { uploadDate, videoId } = parsed;
      const logPath = path.join(probeLogsDir, file);
      let log;
      try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); }
      catch (e) {
        console.warn(`[stamp] WARN: failed to parse ${logPath}: ${e.message}`);
        continue;
      }
      if (channelArg) {
        // Filter on log content (not filename). Older probe logs don't carry
        // `basename`; default them to 'revere' so a single-channel filter
        // doesn't accidentally drop them.
        const logChannel = log.basename && log.basename !== 'revere' ? log.basename : 'revere';
        if (logChannel !== channelArg) {
          continue;
        }
      }
      if (log.video_type && log.video_type_classified_at && !reclassify) {
        skippedInRun += 1;
        totalSkipped += 1;
        typeCounts[log.video_type] = (typeCounts[log.video_type] || 0) + 1;
        continue;
      }
      const key = `${uploadDate}_${videoId}`;
      const title = titlesByKey[key] || log.title || '';
      const videoType = classifyVideoType({ title, uploadDate });
      log.video_type = videoType;
      log.video_type_label = TYPE_BADGE_LABEL[videoType] || videoType;
      log.video_type_description = TYPE_DESCRIPTION[videoType] || '';
      log.video_type_classified_at = new Date().toISOString();
      log.classification_inputs = {
        title_excerpt: String(title || '').slice(0, 120),
        upload_date: uploadDate,
        retroactive: true
      };
      try {
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
        stampedInRun += 1;
        totalStamped += 1;
        typeCounts[videoType] = (typeCounts[videoType] || 0) + 1;
      } catch (e) {
        console.warn(`[stamp] WARN: failed to write ${logPath}: ${e.message}`);
      }
    }
    const summary = Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[stamp] ${runTag}: stamped ${stampedInRun}, skipped ${skippedInRun} → ${summary}`);
  }
}

console.log('');
console.log(`[stamp] DONE — total logs scanned=${totalLogs}, stamped=${totalStamped}, skipped=${totalSkipped}`);
console.log('[stamp] Next: node tools/aggregateOcrTimeline.js <run-tag> to refresh timeline.json');

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
