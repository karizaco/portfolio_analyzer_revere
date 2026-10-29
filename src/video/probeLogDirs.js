'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Where a scan run keeps its probe logs.
//
// THREE layouts exist, and which one a run used depends on how it was
// launched:
//
//   1. flat    data/video_scan_<date>/<tag>/ocr_probe/logs
//   2. doubled data/video_scan_<date>/<tag>/<tag>/ocr_probe/logs
//              — the parallelOcrScan.py layout, where the run tag appears
//              twice because the tag directory contains a directory named
//              after itself
//   3. root    data/video_scan_<date>/ocr_probe/logs
//              — the pre-Qullamaggie layout, from before runs were tagged
//
// WHY THIS IS A SEPARATE MODULE
// tools/aggregateScanResults.js probed all three. tools/aggregateOcrTimeline.js
// probed only the first, so it could not find the logs of any run that used
// the doubled layout — which is every run that has a committed timeline.json.
// The two tools drifted apart because the list was copied rather than shared,
// and the copy is what went stale.
//
// On disk: the doubled layout holds 12 run tags (including all six with a
// committed timeline.json) and the flat layout holds 8 (fix-final, fields-v1,
// fields-v2, qmg_720p, qmg_1080p, qmg_1080p_target, v2-keep,
// qmg-table-e2e). The root layout is the pre-Qullamaggie one.

/**
 * The candidate log directories for a run tag, in the order they should be
 * probed. A directory that does not exist is simply skipped by the caller.
 *
 * @param {string} scanDateDir - e.g. data/video_scan_20260917
 * @param {string} runTag - the run tag, e.g. qmg-ocr-20260917-v2
 * @returns {string[]} candidate directories
 */
function buildLogsDirectories(scanDateDir, runTag) {
  return [
    path.join(scanDateDir, runTag, 'ocr_probe', 'logs'),          // flat
    path.join(scanDateDir, runTag, runTag, 'ocr_probe', 'logs'),   // doubled
    path.join(scanDateDir, 'ocr_probe', 'logs'),                   // legacy root
  ];
}

/**
 * The first candidate log directory that exists, or null.
 *
 * @param {string} scanDateDir - e.g. data/video_scan_20260917
 * @param {string} runTag - the run tag
 * @param {(p: string) => boolean} [exists] - existence check, injectable for tests
 * @returns {string|null}
 */
function resolveLogsDirectory(scanDateDir, runTag, exists = fs.existsSync) {
  for (const dir of buildLogsDirectories(scanDateDir, runTag)) {
    if (exists(dir)) return dir;
  }
  return null;
}

module.exports = { buildLogsDirectories, resolveLogsDirectory };
